import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig, WorkPackage } from '@turbine-hall/turbine-contracts';
import { ToolBroker, type Capability, type ToolAdapter } from '@turbine-hall/turbine-tools';
import { packetPaths } from './packet.js';

/** Max characters for the whole mirror body (GitHub soft limit is higher; keep room for truncation notice). */
export const MIRROR_BODY_BUDGET = 55_000;
/** Per-section cap before truncation notice. */
export const MIRROR_SECTION_BUDGET = 12_000;

export const MIRROR_MARKER_PREFIX = '<!-- turbine-packet-mirror:';

export type LinkedIssue =
  | { provider: 'github'; owner: string; repo: string; number: number; key: string }
  | { provider: 'jira'; key: string };

export type MirrorTargetResult = {
  provider: 'github' | 'jira';
  key: string;
  status: 'mirrored' | 'skipped' | 'failed';
  reason?: string;
  commentId?: string;
};

export type MirrorRunResult = {
  at: string;
  workId: string;
  targets: MirrorTargetResult[];
};

export type MirrorAdapters = {
  github?: ToolAdapter;
  jira?: ToolAdapter;
};

const GH_URL =
  /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/gi;
const GH_ALIAS = /^github:([^/#\s]+)\/([^/#\s]+)#(\d+)$/i;
const JIRA_ALIAS = /^jira:([A-Z][A-Z0-9]+-\d+)$/i;
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

export function mirrorMarker(workId: string): string {
  return `${MIRROR_MARKER_PREFIX}${workId} -->`;
}

/** Supported link forms: sourceRefs provider github|jira, aliases github:owner/repo#n / jira:KEY / bare KEY, and github.com/.../issues/N URLs in text. */
export function resolveLinkedIssues(work: WorkPackage, extraText = ''): LinkedIssue[] {
  const found = new Map<string, LinkedIssue>();
  const add = (link: LinkedIssue) => {
    found.set(`${link.provider}:${link.key}`, link);
  };

  for (const ref of work.sourceRefs ?? []) {
    const p = (ref.provider ?? '').toLowerCase();
    if (p === 'jira' && ref.externalId) {
      const key = ref.externalId.replace(/^jira:/i, '');
      if (JIRA_KEY.test(key)) add({ provider: 'jira', key });
    }
    if (p === 'github') {
      const fromUrl = ref.url ? [...ref.url.matchAll(GH_URL)][0] : undefined;
      if (fromUrl) {
        add({
          provider: 'github',
          owner: fromUrl[1]!,
          repo: fromUrl[2]!,
          number: Number(fromUrl[3]),
          key: `${fromUrl[1]}/${fromUrl[2]}#${fromUrl[3]}`,
        });
      } else if (ref.externalId) {
        const m = ref.externalId.match(/^([^/]+)\/([^#]+)#(\d+)$/);
        if (m) {
          add({
            provider: 'github',
            owner: m[1]!,
            repo: m[2]!,
            number: Number(m[3]),
            key: `${m[1]}/${m[2]}#${m[3]}`,
          });
        }
      }
    }
  }

  for (const alias of work.aliases ?? []) {
    const gh = alias.match(GH_ALIAS);
    if (gh) {
      add({
        provider: 'github',
        owner: gh[1]!,
        repo: gh[2]!,
        number: Number(gh[3]),
        key: `${gh[1]}/${gh[2]}#${gh[3]}`,
      });
      continue;
    }
    const jira = alias.match(JIRA_ALIAS);
    if (jira) {
      add({ provider: 'jira', key: jira[1]! });
      continue;
    }
    if (JIRA_KEY.test(alias)) add({ provider: 'jira', key: alias });
  }

  const haystack = [work.objective ?? '', extraText].join('\n');
  for (const m of haystack.matchAll(GH_URL)) {
    add({
      provider: 'github',
      owner: m[1]!,
      repo: m[2]!,
      number: Number(m[3]),
      key: `${m[1]}/${m[2]}#${m[3]}`,
    });
  }

  return [...found.values()];
}

function truncate(text: string, budget: number, packetHint: string): string {
  if (text.length <= budget) return text;
  const keep = Math.max(0, budget - 120);
  return `${text.slice(0, keep)}\n\n_…truncated (${text.length} chars). Full packet: \`${packetHint}\`._`;
}

function readSection(path: string, missing: string): string {
  if (!existsSync(path)) return missing;
  return readFileSync(path, 'utf8');
}

export function buildMirrorBody(input: {
  work: WorkPackage;
  projectRoot: string;
}): string {
  const paths = packetPaths(input.projectRoot, input.work.id);
  const hint = `.turbine/tasks/${input.work.id}/`;
  const sections: Array<[string, string]> = [
    ['Status', readSection(paths.status, '_STATUS.md not generated yet._')],
    ['Spec', readSection(paths.spec, '_SPEC.md not generated yet._')],
    ['Plan', readSection(paths.planDoc, '_PLAN.md not generated yet._')],
    ['Executive summary', readSection(paths.executiveSummary, '_EXECUTIVE-SUMMARY.md not generated yet._')],
    ['Review', readSection(paths.review, '_REVIEW.md not generated yet._')],
    ['Context', readSection(paths.context, '_CONTEXT.md not generated yet._')],
  ];

  const parts = [
    mirrorMarker(input.work.id),
    '',
    `# Turbine packet mirror — ${input.work.title}`,
    '',
    `Work \`${input.work.id}\` · state \`${input.work.currentState}\` · local packet \`${hint}\``,
    '',
    '_Generated from the Turbine task packet (not free-form agent prose). Sticky comment: edits replace this body._',
    '',
  ];

  for (const [title, body] of sections) {
    parts.push(`## ${title}`, '', truncate(body.trim(), MIRROR_SECTION_BUDGET, hint), '');
  }

  let out = parts.join('\n');
  if (out.length > MIRROR_BODY_BUDGET) {
    out = `${out.slice(0, MIRROR_BODY_BUDGET - 100)}\n\n_…mirror truncated to ${MIRROR_BODY_BUDGET} chars. See \`${hint}\`._`;
  }
  return out;
}

type MirrorStateFile = {
  comments: Record<string, string>; // `${provider}:${key}` → commentId
};

function statePath(projectRoot: string, workId: string): string {
  return join(packetPaths(projectRoot, workId).evidenceDir, 'issue-mirror.json');
}

export function loadMirrorState(projectRoot: string, workId: string): MirrorStateFile {
  const p = statePath(projectRoot, workId);
  if (!existsSync(p)) return { comments: {} };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as MirrorStateFile;
    return { comments: raw.comments ?? {} };
  } catch {
    return { comments: {} };
  }
}

function saveMirrorState(projectRoot: string, workId: string, state: MirrorStateFile): void {
  const paths = packetPaths(projectRoot, workId);
  mkdirSync(paths.evidenceDir, { recursive: true });
  writeFileSync(statePath(projectRoot, workId), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function capabilityAllowed(config: ProjectConfig, cap: Capability): { ok: true } | { ok: false; reason: string } {
  const deny = new Set(config.tools.denied as Capability[]);
  const allow = new Set(config.tools.allow as Capability[]);
  if (deny.has(cap)) return { ok: false, reason: `capability denied by policy: ${cap}` };
  if (allow.size > 0 && !allow.has(cap)) return { ok: false, reason: `capability not in allowlist: ${cap}` };
  return { ok: true };
}

/**
 * Mirror packet docs onto linked GitHub/Jira issues (sticky comment).
 * Never throws to callers: failures become target results + persisted state notes.
 */
export async function mirrorLinkedIssues(input: {
  projectRoot: string;
  work: WorkPackage;
  config: ProjectConfig;
  sourceText?: string;
  adapters?: MirrorAdapters;
  /** When true, fixture adapters may run without allowNetwork. */
  fixtureMode?: boolean;
}): Promise<MirrorRunResult> {
  const at = new Date().toISOString();
  const links = resolveLinkedIssues(input.work, input.sourceText ?? '');
  if (!links.length) {
    return { at, workId: input.work.id, targets: [] };
  }

  const persistLast = (targets: MirrorTargetResult[]): MirrorRunResult => {
    const result = { at, workId: input.work.id, targets };
    const paths = packetPaths(input.projectRoot, input.work.id);
    mkdirSync(paths.evidenceDir, { recursive: true });
    writeFileSync(join(paths.evidenceDir, 'issue-mirror-last.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
    return result;
  };

  const cap = capabilityAllowed(input.config, 'issue.comment');
  if (!cap.ok) {
    return persistLast(
      links.map((l) => ({
        provider: l.provider,
        key: l.key,
        status: 'skipped' as const,
        reason: cap.reason,
      })),
    );
  }

  const networkOk = input.config.execution.allowNetwork || input.fixtureMode === true;
  if (!networkOk) {
    return persistLast(
      links.map((l) => ({
        provider: l.provider,
        key: l.key,
        status: 'skipped' as const,
        reason: 'execution.allowNetwork is false (and no fixtureMode)',
      })),
    );
  }

  const body = buildMirrorBody({ work: input.work, projectRoot: input.projectRoot });
  const state = loadMirrorState(input.projectRoot, input.work.id);
  const broker = new ToolBroker({
    allow: input.config.tools.allow,
    deny: input.config.tools.denied,
  });
  if (input.adapters?.github) broker.register(input.adapters.github);
  if (input.adapters?.jira) broker.register(input.adapters.jira);

  const grants: Capability[] = ['issue.comment'];
  const targets: MirrorTargetResult[] = [];

  for (const link of links) {
    const stateKey = `${link.provider}:${link.key}`;
    const commentId = state.comments[stateKey];
    try {
      if (link.provider === 'github') {
        if (!input.adapters?.github) {
          targets.push({ provider: 'github', key: link.key, status: 'skipped', reason: 'no github adapter registered' });
          continue;
        }
        const result = await broker.invoke({
          adapterId: 'github',
          capability: 'issue.comment',
          workId: input.work.id,
          grants,
          arguments: {
            owner: link.owner,
            repo: link.repo,
            number: link.number,
            body,
            ...(commentId ? { commentId } : {}),
          },
        });
        const id = String((result.data as { id?: string })?.id ?? result.externalOperationId ?? '');
        if (id) state.comments[stateKey] = id;
        targets.push({ provider: 'github', key: link.key, status: 'mirrored', commentId: id || undefined });
      } else {
        if (!input.adapters?.jira) {
          targets.push({ provider: 'jira', key: link.key, status: 'skipped', reason: 'no jira adapter registered' });
          continue;
        }
        const result = await broker.invoke({
          adapterId: 'jira',
          capability: 'issue.comment',
          workId: input.work.id,
          grants,
          arguments: {
            key: link.key,
            body,
            ...(commentId ? { commentId } : {}),
          },
        });
        const id = String((result.data as { id?: string })?.id ?? result.externalOperationId ?? '');
        if (id) state.comments[stateKey] = id;
        targets.push({ provider: 'jira', key: link.key, status: 'mirrored', commentId: id || undefined });
      }
    } catch (e) {
      targets.push({
        provider: link.provider,
        key: link.key,
        status: 'failed',
        reason: (e as Error).message,
      });
    }
  }

  saveMirrorState(input.projectRoot, input.work.id, state);
  return persistLast(targets);
}

/** Parse GitHub issue URLs from intake text into sourceRefs + aliases for createTask. */
export function githubLinksFromText(text: string): Array<{
  sourceRef: { provider: 'github'; externalId: string; url: string; snapshotHash: string };
  alias: string;
}> {
  const out: Array<{
    sourceRef: { provider: 'github'; externalId: string; url: string; snapshotHash: string };
    alias: string;
  }> = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(GH_URL)) {
    const owner = m[1]!;
    const repo = m[2]!;
    const number = m[3]!;
    const key = `${owner}/${repo}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const url = `https://github.com/${owner}/${repo}/issues/${number}`;
    out.push({
      sourceRef: {
        provider: 'github',
        externalId: key,
        url,
        snapshotHash: 'pending',
      },
      alias: `github:${key}`,
    });
  }
  return out;
}
