import { readFileSync } from 'node:fs';
import {
  BRIEF_SCHEMA_ID,
  DEFAULT_BRIEF_SECTIONS,
  PUBLISHED_CLAIM_STATUSES,
  briefConfirmToken,
  claimsHashOf,
  parseClaimSafe,
  type BriefState,
  type Claim,
  type ProjectConfig,
  type RepoSnapshot,
  type StoredClaim,
} from '@turbine-hall/turbine-contracts';
import type { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import { getSkill, runSkill } from '@turbine-hall/turbine-skills';
import type { ModelAdapter } from '@turbine-hall/turbine-models';
import { ensureDefaultMock, getModel } from '@turbine-hall/turbine-models';
import { publishClaim, reverifyOnCommit } from './claims.js';
import { listTree, resolveCommit } from './git-read.js';
import { CommitReader } from './verify.js';
import { parseClaimIdsFromSection, readBriefMarker, writeBriefFiles, briefPaths } from './brief-render.js';
import { contextPaths } from './render.js';
import { existsSync } from 'node:fs';

export type BriefConfig = {
  sections: string[];
  sampleFileCap: number;
};

export function briefConfigOf(config: ProjectConfig): BriefConfig {
  const b = config.context?.brief;
  return {
    sections: [...(b?.sections?.length ? b.sections : DEFAULT_BRIEF_SECTIONS)],
    sampleFileCap: b?.sampleFileCap ?? 40,
  };
}

/** Key files for drafting: package manifests, READMEs, entry points, root configs — capped and reported. */
export function sampleKeyFiles(snapshot: RepoSnapshot, repoRoot: string, commit: string, cap: number): Array<{ path: string; blob: string; text: string }> {
  const tree = listTree(repoRoot, commit);
  const byPath = new Map(tree.filter((e) => e.type === 'blob').map((e) => [e.path, e]));
  const ranked: string[] = [];
  const push = (p: string) => {
    if (byPath.has(p) && !ranked.includes(p)) ranked.push(p);
  };
  push('package.json');
  push('README.md');
  push('readme.md');
  for (const f of snapshot.facts) {
    if (f.category === 'entry-point' || f.category === 'package' || f.category === 'command' || f.category === 'script') push(f.source.path);
  }
  for (const e of tree) {
    if (e.type !== 'blob') continue;
    const base = e.path.slice(e.path.lastIndexOf('/') + 1);
    if (/^readme(\.|$)/i.test(base) || base === 'package.json' || /^tsconfig(\..+)?\.json$/.test(base)) push(e.path);
  }
  const picked = ranked.slice(0, cap);
  const reader = new CommitReader(repoRoot, commit);
  const out: Array<{ path: string; blob: string; text: string }> = [];
  for (const path of picked) {
    const entry = byPath.get(path)!;
    const t = reader.text(path);
    if (!t.ok) continue;
    // Cap each excerpt so the model context stays bounded.
    out.push({ path, blob: entry.id, text: t.text.length > 4000 ? `${t.text.slice(0, 4000)}\n…` : t.text });
  }
  return out;
}

function factsDigest(snapshot: RepoSnapshot): string {
  return snapshot.facts
    .slice(0, 80)
    .map((f) => `- [${f.category}] ${f.statement} (${f.source.path}@${f.source.blob.slice(0, 8)})`)
    .join('\n');
}

async function proposeSection(input: {
  model: ModelAdapter;
  factoryRoot: string;
  section: string;
  commit: string;
  snapshot: RepoSnapshot;
  samples: Array<{ path: string; blob: string; text: string }>;
}): Promise<unknown[]> {
  const skill = getSkill(input.factoryRoot, 'core/draft-project-brief');
  const sampleBlock = input.samples
    .map((s) => `### FILE path=${s.path} blob=${s.blob}\n\`\`\`\n${s.text}\n\`\`\``)
    .join('\n\n');
  const context = [
    `## SECTION\n${input.section}`,
    `## COMMIT\n${input.commit}`,
    `## LAYER1_FACTS\n${factsDigest(input.snapshot)}`,
    `## SAMPLED_FILES (cap reported separately)\n${sampleBlock || '_none_'}`,
  ].join('\n\n');
  const result = await runSkill({
    skill,
    model: input.model,
    workId: 'context-brief',
    roleId: 'requirements-analyst',
    context,
    schemaId: BRIEF_SCHEMA_ID,
    maxOutputTokens: 4000,
    grantedCapabilities: ['none'],
  });
  const content = result.content as { claims?: unknown };
  return Array.isArray(content?.claims) ? content.claims : [];
}

export type EnsureBriefResult = {
  commit: string;
  claimsHash: string;
  approved: boolean;
  modelCalls: number;
  sectionsDrafted: string[];
  sectionsReverified: string[];
  published: number;
  rejected: number;
  samplePaths: string[];
  sampleCap: number;
  written: string[];
  confirmToken: string;
};

/**
 * After Layer 1 is fresh at HEAD: re-verify when the frontier moved, draft only sections that need it,
 * render brief files. No model calls when the published set is already current and no section needs redraft.
 */
export async function ensureBrief(input: {
  store: WorkStore;
  projectRoot: string;
  repoRoot: string;
  repoPath: string;
  snapshot: RepoSnapshot;
  config: BriefConfig;
  factoryRoot: string;
  model?: ModelAdapter;
  /** Restrict drafting to these sections (e.g. after withdrawals). Default: all configured. */
  forceSections?: string[];
}): Promise<EnsureBriefResult> {
  const commit = resolveCommit(input.repoRoot, 'HEAD');
  if (!commit) throw new Error('HEAD does not resolve to a commit');
  if (commit !== input.snapshot.commit) throw new Error(`snapshot commit ${input.snapshot.commit} is not HEAD ${commit}`);

  const sections = input.config.sections;
  let sectionsReverified: string[] = [];
  const frontier = input.store.getClaimFrontier(input.repoPath);
  if (frontier && frontier !== commit) {
    const r = reverifyOnCommit(input.store, input.repoRoot, input.repoPath, frontier, commit);
    sectionsReverified = r.sections;
  }

  const published = () => input.store.listClaims(input.repoPath, { statuses: [...PUBLISHED_CLAIM_STATUSES], commit });
  const existing = published();
  const hasAnyPublished = existing.length > 0 || input.store.getBriefState(input.repoPath) !== null;

  const needDraft = new Set<string>();
  if (!hasAnyPublished) {
    for (const s of sections) needDraft.add(s);
  }
  for (const s of sectionsReverified) {
    if (sections.includes(s)) needDraft.add(s);
  }
  for (const s of input.forceSections ?? []) {
    if (sections.includes(s)) needDraft.add(s);
  }
  // Apply human edits: claim markers removed from a section file → withdraw those claims and redraft.
  const editWithdrawn = applyHumanSectionEdits(input.store, input.projectRoot, input.repoPath, sections, existing);
  for (const s of editWithdrawn) needDraft.add(s);

  let modelCalls = 0;
  let publishedCount = 0;
  let rejectedCount = 0;
  const sectionsDrafted: string[] = [];
  let samplePaths: string[] = input.store.getBriefState(input.repoPath)?.samplePaths ?? [];
  const sampleCap = input.config.sampleFileCap;

  if (needDraft.size) {
    const samples = sampleKeyFiles(input.snapshot, input.repoRoot, commit, sampleCap);
    samplePaths = samples.map((s) => s.path);
    ensureDefaultMock();
    const model = input.model ?? getModel('mock-default');
    for (const section of sections.filter((s) => needDraft.has(s))) {
      modelCalls++;
      sectionsDrafted.push(section);
      const proposals = await proposeSection({
        model,
        factoryRoot: input.factoryRoot,
        section,
        commit,
        snapshot: input.snapshot,
        samples,
      });
      for (const raw of proposals) {
        // Force section + commit/blob alignment when the model is close but not exact.
        const normalized = normalizeProposal(raw, section, commit, samples);
        const out = publishClaim(input.store, input.repoRoot, input.repoPath, normalized);
        if (out.published) publishedCount++;
        else rejectedCount++;
      }
    }
  }

  const finalClaims = published();
  const claimsHash = claimsHashOf(finalClaims);
  const prev = input.store.getBriefState(input.repoPath);
  const stillApproved = prev?.approvedHash === claimsHash ? prev : null;
  const state: BriefState = {
    repoPath: input.repoPath,
    commit,
    claimsHash,
    approvedHash: stillApproved?.approvedHash ?? null,
    approvedBy: stillApproved?.approvedBy ?? null,
    approvedAt: stillApproved?.approvedAt ?? null,
    sampleCap,
    samplePaths,
    updatedAt: new Date().toISOString(),
  };

  const projectPath = contextPaths(input.projectRoot).project;
  const existingProject = existsSync(projectPath) ? readFileSync(projectPath, 'utf8') : undefined;
  const marker = existingProject ? readBriefMarker(existingProject) : undefined;
  const filesCurrent =
    marker?.commit === commit &&
    marker?.claims === claimsHash &&
    sections.every((s) => existsSync(briefPaths(input.projectRoot).section(s)));
  const unchanged =
    modelCalls === 0 &&
    sectionsDrafted.length === 0 &&
    sectionsReverified.length === 0 &&
    prev?.commit === commit &&
    prev?.claimsHash === claimsHash &&
    filesCurrent;

  if (!unchanged) {
    input.store.saveBriefState(state);
  }

  const written = unchanged ? [] : writeBriefFiles(input.projectRoot, sections, finalClaims, state, existingProject);

  return {
    commit,
    claimsHash,
    approved: state.approvedHash === state.claimsHash,
    modelCalls,
    sectionsDrafted,
    sectionsReverified,
    published: publishedCount,
    rejected: rejectedCount,
    samplePaths,
    sampleCap,
    written,
    confirmToken: briefConfirmToken(claimsHash),
  };
}

function normalizeProposal(
  raw: unknown,
  section: string,
  commit: string,
  samples: Array<{ path: string; blob: string }>,
): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const o: Record<string, unknown> = { ...(raw as Record<string, unknown>), section };
  if (Array.isArray(o.evidence)) {
    o.evidence = (o.evidence as unknown[]).map((e) => {
      if (!e || typeof e !== 'object') return e;
      const ev: Record<string, unknown> = { ...(e as Record<string, unknown>), commit };
      const path = typeof ev.path === 'string' ? ev.path : undefined;
      const sample = path ? samples.find((s) => s.path === path) : undefined;
      if (sample) ev.blob = sample.blob;
      return ev;
    });
  }
  return o;
}

/** Withdraw published claims whose markers a human removed from the section markdown. */
function applyHumanSectionEdits(
  store: WorkStore,
  projectRoot: string,
  repoPath: string,
  sections: string[],
  published: StoredClaim[],
): string[] {
  const withdrawnSections: string[] = [];
  const paths = briefPaths(projectRoot);
  for (const section of sections) {
    const file = paths.section(section);
    if (!existsSync(file)) continue;
    let body: string;
    try {
      body = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const inSection = published.filter((p) => p.claim.section === section && (PUBLISHED_CLAIM_STATUSES as readonly string[]).includes(p.status));
    if (!inSection.length) continue;
    const keep = new Set(parseClaimIdsFromSection(body));
    // A section cleared of every claim marker (or missing some) withdraws the removed published claims.
    for (const c of inSection) {
      if (!keep.has(c.claim.id)) {
        store.withdrawClaim(repoPath, c.claim.id, 'removed by human edit of the brief section markdown');
        if (!withdrawnSections.includes(section)) withdrawnSections.push(section);
      }
    }
  }
  return withdrawnSections;
}

/** Show the current brief claim set for approval / display. */
export function briefDiff(store: WorkStore, repoPath: string): {
  state: BriefState | null;
  claims: StoredClaim[];
  confirmToken: string | null;
} {
  const state = store.getBriefState(repoPath);
  const claims = store.listClaims(repoPath, { statuses: [...PUBLISHED_CLAIM_STATUSES] });
  return { state, claims, confirmToken: state ? briefConfirmToken(state.claimsHash) : null };
}

/** Parse a human-supplied claim and publish only if the verifier passes (approve path never bypasses this). */
export function tryPublishRawClaim(store: WorkStore, repoRoot: string, repoPath: string, raw: unknown) {
  return publishClaim(store, repoRoot, repoPath, raw);
}

export function parseRawClaim(raw: unknown): { ok: true; claim: Claim } | { ok: false; reason: string } {
  return parseClaimSafe(raw);
}
