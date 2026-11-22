import { readFileSync } from 'node:fs';
import {
  BRIEF_SCHEMA_ID,
  DEFAULT_BRIEF_SECTIONS,
  PUBLISHED_CLAIM_STATUSES,
  briefConfirmToken,
  claimsHashOf,
  contentHashText,
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
import {
  briefPaths,
  parseClaimIdsFromSection,
  readBriefMarker,
  renderBriefProjectBody,
  renderClaimBullet,
  renderSectionBody,
  writeBriefFiles,
} from './brief-render.js';
import { contextPaths, HeadMovedError } from './render.js';
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

export type SyncBriefResult = {
  ok: boolean;
  commit: string;
  rewritten: boolean;
  withdrawn: number;
  reason?: string;
};

/**
 * Carry published brief claims to HEAD and rewrite brief pages when anything was withdrawn.
 * Deterministic: no model calls. Used by task next / task start so agents never see stale verified text.
 * On failure (`ok: false`), callers must omit brief links from the handoff.
 */
export function syncBriefClaimsToHead(input: {
  store: WorkStore;
  projectRoot: string;
  repoRoot: string;
  repoPath: string;
  sections: string[];
}): SyncBriefResult {
  try {
    const commit = resolveCommit(input.repoRoot, 'HEAD');
    if (!commit) return { ok: false, commit: '', rewritten: false, withdrawn: 0, reason: 'HEAD does not resolve' };

    const prev = input.store.getBriefState(input.repoPath);
    // Honour human section edits before reverify/rewrite so task next cannot restore a deleted claim block.
    const before = input.store.listClaims(input.repoPath, { statuses: [...PUBLISHED_CLAIM_STATUSES] });
    const editWithdrawn = applyHumanSectionEdits(input.store, input.projectRoot, input.repoPath, input.sections, before);

    let withdrawn = 0;
    const pending = new Set<string>([...(prev?.pendingSections ?? []), ...editWithdrawn]);
    const frontier = input.store.getClaimFrontier(input.repoPath);
    if (frontier && frontier !== commit) {
      const r = reverifyOnCommit(input.store, input.repoRoot, input.repoPath, frontier, commit);
      withdrawn = r.withdrawn.length;
      for (const s of r.sections) pending.add(s);
    }

    // Pin the published set to this commit; refuse if HEAD/frontier moved mid-flight.
    const headNow = resolveCommit(input.repoRoot, 'HEAD');
    const frontierNow = input.store.getClaimFrontier(input.repoPath);
    if (!headNow || headNow !== commit || (frontierNow && frontierNow !== commit)) {
      return { ok: false, commit, rewritten: false, withdrawn, reason: 'HEAD or claim frontier moved during brief sync' };
    }

    const published = input.store.listClaims(input.repoPath, { statuses: [...PUBLISHED_CLAIM_STATUSES], commit });
    const claimsHash = claimsHashOf(published);
    if (!prev && published.length === 0 && pending.size === 0) return { ok: true, commit, rewritten: false, withdrawn };

    const stillApproved = prev?.approvedHash === claimsHash ? prev : null;
    const state: BriefState = {
      repoPath: input.repoPath,
      commit,
      claimsHash,
      approvedHash: stillApproved?.approvedHash ?? null,
      approvedBy: stillApproved?.approvedBy ?? null,
      approvedAt: stillApproved?.approvedAt ?? null,
      sampleCap: prev?.sampleCap ?? 40,
      samplePaths: prev?.samplePaths ?? [],
      pendingSections: [...pending].sort(),
      updatedAt: new Date().toISOString(),
    };

    const projectPath = contextPaths(input.projectRoot).project;
    const existingProject = existsSync(projectPath) ? readFileSync(projectPath, 'utf8') : undefined;
    const marker = existingProject ? readBriefMarker(existingProject) : undefined;
    const bySection = new Map<string, StoredClaim[]>();
    for (const s of input.sections) bySection.set(s, []);
    for (const c of published) {
      const list = bySection.get(c.claim.section);
      if (list) list.push(c);
    }
    const expectedProjectBody = renderBriefProjectBody(input.sections, bySection, state);
    const filesCurrent =
      marker?.commit === commit &&
      marker?.claims === claimsHash &&
      marker?.content === contentHashText(expectedProjectBody) &&
      input.sections.every((s) => {
        const file = briefPaths(input.projectRoot).section(s);
        if (!existsSync(file)) return false;
        return readFileSync(file, 'utf8') === renderSectionBody(s, bySection.get(s) ?? [], state);
      });

    const unchanged =
      withdrawn === 0 &&
      editWithdrawn.length === 0 &&
      (prev?.pendingSections?.length ?? 0) === state.pendingSections.length &&
      prev?.commit === commit &&
      prev?.claimsHash === claimsHash &&
      filesCurrent;
    if (unchanged) return { ok: true, commit, rewritten: false, withdrawn: 0 };

    // Validate + write pages first; only then seal brief_state so a render failure cannot leave state ahead of files.
    writeBriefFiles(input.projectRoot, input.sections, published, state, existingProject);
    input.store.saveBriefState(state);
    return { ok: true, commit, rewritten: true, withdrawn };
  } catch (e) {
    return {
      ok: false,
      commit: resolveCommit(input.repoRoot, 'HEAD') ?? '',
      rewritten: false,
      withdrawn: 0,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

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
  const prevState = input.store.getBriefState(input.repoPath);
  const published = () => input.store.listClaims(input.repoPath, { statuses: [...PUBLISHED_CLAIM_STATUSES], commit });

  // Apply human edits against the pre-reverify claim set so a rebind of citations is not mistaken for an edit.
  const existingBefore = input.store.listClaims(input.repoPath, { statuses: [...PUBLISHED_CLAIM_STATUSES] });
  const editWithdrawn = applyHumanSectionEdits(input.store, input.projectRoot, input.repoPath, sections, existingBefore);

  let sectionsReverified: string[] = [];
  const frontier = input.store.getClaimFrontier(input.repoPath);
  if (frontier && frontier !== commit) {
    const r = reverifyOnCommit(input.store, input.repoRoot, input.repoPath, frontier, commit);
    sectionsReverified = r.sections;
  }

  const needDraft = new Set<string>();
  // No brief_state yet (first draft or interrupted before save): finish every configured section.
  if (prevState === null) {
    for (const s of sections) needDraft.add(s);
  } else {
    // A newly configured section has no page yet — draft it without re-drafting completed empty sections.
    for (const s of sections) {
      if (!existsSync(briefPaths(input.projectRoot).section(s))) needDraft.add(s);
    }
    for (const s of prevState.pendingSections) {
      if (sections.includes(s)) needDraft.add(s);
    }
  }
  for (const s of sectionsReverified) {
    if (sections.includes(s)) needDraft.add(s);
  }
  for (const s of input.forceSections ?? []) {
    if (sections.includes(s)) needDraft.add(s);
  }
  for (const s of editWithdrawn) needDraft.add(s);

  let modelCalls = 0;
  let publishedCount = 0;
  let rejectedCount = 0;
  const sectionsDrafted: string[] = [];
  let samplePaths: string[] = prevState?.samplePaths ?? [];
  const sampleCap = input.config.sampleFileCap;

  if (needDraft.size) {
    const samples = sampleKeyFiles(input.snapshot, input.repoRoot, commit, sampleCap);
    samplePaths = samples.map((s) => s.path);
    ensureDefaultMock();
    const model = input.model ?? getModel('mock-default');
    // Collect every proposal before publishing so a mid-run model failure leaves no partial draft.
    const batches: Array<{ section: string; proposals: unknown[] }> = [];
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
      batches.push({ section, proposals });
    }

    const headAfterPropose = resolveCommit(input.repoRoot, 'HEAD');
    if (!headAfterPropose || headAfterPropose !== commit) {
      throw new HeadMovedError('HEAD changed while the project brief was being drafted; nothing was published. Run again.');
    }
    const frontierNow = input.store.getClaimFrontier(input.repoPath);
    if (frontierNow && frontierNow !== commit) {
      throw new HeadMovedError('Claim frontier moved while the project brief was being drafted; nothing was published. Run again.');
    }

    for (const { section, proposals } of batches) {
      for (const raw of proposals) {
        const normalized = normalizeProposal(raw, section, commit, samples);
        const out = publishClaim(input.store, input.repoRoot, input.repoPath, normalized);
        if (out.published) publishedCount++;
        else rejectedCount++;
      }
    }
  }

  // Publication boundary: refuse a stale HEAD before saving and rendering.
  const headAtPublish = resolveCommit(input.repoRoot, 'HEAD');
  if (!headAtPublish || headAtPublish !== commit) {
    throw new HeadMovedError('HEAD changed before the project brief was published; nothing was saved. Run again.');
  }

  // Final claim-set read immediately before persist/render (do not reuse a value computed earlier).
  const finalClaims = published();
  const claimsHash = claimsHashOf(finalClaims);
  const prev = input.store.getBriefState(input.repoPath);
  const stillApproved = prev?.approvedHash === claimsHash ? prev : null;
  // Pending sections that were drafted this run are cleared; any other pending entries remain.
  const drafted = new Set(sectionsDrafted);
  const pendingSections = (prev?.pendingSections ?? []).filter((s) => sections.includes(s) && !drafted.has(s));
  for (const s of sectionsReverified) {
    if (sections.includes(s) && !drafted.has(s) && !pendingSections.includes(s)) pendingSections.push(s);
  }
  const state: BriefState = {
    repoPath: input.repoPath,
    commit,
    claimsHash,
    approvedHash: stillApproved?.approvedHash ?? null,
    approvedBy: stillApproved?.approvedBy ?? null,
    approvedAt: stillApproved?.approvedAt ?? null,
    sampleCap,
    samplePaths,
    pendingSections,
    updatedAt: new Date().toISOString(),
  };

  const projectPath = contextPaths(input.projectRoot).project;
  const existingProject = existsSync(projectPath) ? readFileSync(projectPath, 'utf8') : undefined;
  const marker = existingProject ? readBriefMarker(existingProject) : undefined;
  const bySection = new Map<string, StoredClaim[]>();
  for (const s of sections) bySection.set(s, []);
  for (const c of finalClaims) {
    const list = bySection.get(c.claim.section);
    if (list) list.push(c);
  }
  const expectedProjectBody = renderBriefProjectBody(sections, bySection, state);
  const filesCurrent =
    marker?.commit === commit &&
    marker?.claims === claimsHash &&
    marker?.content === contentHashText(expectedProjectBody) &&
    sections.every((s) => {
      const file = briefPaths(input.projectRoot).section(s);
      if (!existsSync(file)) return false;
      return readFileSync(file, 'utf8') === renderSectionBody(s, bySection.get(s) ?? [], state);
    });
  const unchanged =
    modelCalls === 0 &&
    sectionsDrafted.length === 0 &&
    sectionsReverified.length === 0 &&
    prev?.commit === commit &&
    prev?.claimsHash === claimsHash &&
    filesCurrent;

  // Recheck once more immediately before write; a concurrent withdraw must not be sealed as current.
  const claimsAtWrite = published();
  const hashAtWrite = claimsHashOf(claimsAtWrite);
  if (hashAtWrite !== claimsHash) {
    throw new HeadMovedError('Published claims changed before the project brief was written; nothing was sealed. Run again.');
  }

  // Write pages before sealing state so a render failure cannot leave brief_state ahead of the files.
  const written = unchanged ? [] : writeBriefFiles(input.projectRoot, sections, claimsAtWrite, state, existingProject);
  if (!unchanged) {
    input.store.saveBriefState(state);
  }

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the section file still contains the exact rendered claim block (markers + assertion). */
function claimBlockIntact(body: string, stored: StoredClaim): boolean {
  const id = stored.claim.id;
  const re = new RegExp(
    `<!-- claim id=${escapeRegExp(id)} kind=[^\\n]*-->\\r?\\n[\\s\\S]*?\\r?\\n<!-- /claim id=${escapeRegExp(id)} -->`,
  );
  const m = body.match(re);
  if (!m) return false;
  return m[0].replace(/\r\n/g, '\n') === renderClaimBullet(stored).replace(/\r\n/g, '\n');
}

/** Withdraw published claims whose markers a human removed, or whose assertion text no longer matches. */
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
    for (const c of inSection) {
      if (!keep.has(c.claim.id)) {
        store.withdrawClaim(repoPath, c.claim.id, 'removed by human edit of the brief section markdown');
        if (!withdrawnSections.includes(section)) withdrawnSections.push(section);
        continue;
      }
      if (!claimBlockIntact(body, c)) {
        store.withdrawClaim(repoPath, c.claim.id, 'human edit changed the claim assertion text; claim must be verified again');
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
