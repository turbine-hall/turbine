import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createId, err, type WorkPackage } from '@turbine-hall/turbine-contracts';
import type { Capability, ToolAdapter } from '@turbine-hall/turbine-tools';
import { configAllows, type LanePrTarget } from './lane-pr.js';

export type DecompositionSubtask = {
  id: string;
  title: string;
  description: string;
  requirementIds: string[];
  files: string[];
  branchName: string;
  pr?: { number: number; url: string; head: string; headSha: string };
};

export type TaskDecomposition = {
  planHash: string;
  summary: string;
  subtasks: DecompositionSubtask[];
};

type InvokeResult<T> = { data: T; externalOperationId?: string };

async function invoke(
  target: LanePrTarget,
  capability: Capability,
  workId: string,
  args: Record<string, unknown>,
): Promise<InvokeResult<unknown>> {
  if (!target.adapter.capabilities.includes(capability)) {
    throw err('E_MISSING_CAPABILITY', `GitHub adapter does not support ${capability}`);
  }
  return target.adapter.invoke({
    capability,
    workId,
    arguments: { owner: target.owner, repo: target.repo, ...args },
    correlationId: createId('corr'),
  });
}

function branchSuffix(raw: unknown, fallbackId: string): string {
  const text = typeof raw === 'string' && raw.trim() ? raw.trim() : `st-${fallbackId}`;
  return text
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `st-${fallbackId.toLowerCase()}`;
}

/** Keep the proposed name when unique; otherwise append a deterministic `-2`, `-3`, … suffix. */
function uniqueBranchNames(preferred: string[]): string[] {
  const used = new Set<string>();
  return preferred.map((name) => {
    let candidate = name;
    let n = 2;
    while (used.has(candidate)) {
      const base = name.slice(0, Math.max(1, 48 - `-${n}`.length));
      candidate = `${base}-${n}`;
      n += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

export function normalizeDecomposition(content: unknown, planHash: string): TaskDecomposition {
  const body = (content && typeof content === 'object' ? content : {}) as {
    summary?: unknown;
    subtasks?: unknown;
  };
  const raw = Array.isArray(body.subtasks) ? body.subtasks : [];
  if (raw.length === 0) {
    throw err('E_INVALID_CONFIG', 'task-decomposer produced no subtasks');
  }
  const drafted = raw.map((entry, index) => {
    const row = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `ST${index + 1}`;
    const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : `Subtask ${id}`;
    const description =
      typeof row.description === 'string' && row.description.trim()
        ? row.description.trim()
        : `Subtask ${id}`;
    const requirementIds = Array.isArray(row.requirementIds)
      ? row.requirementIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
    const files = Array.isArray(row.files)
      ? row.files.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
    return {
      id,
      title,
      description,
      requirementIds,
      files,
      preferredBranch: branchSuffix(row.branchName, id),
    };
  });
  const branches = uniqueBranchNames(drafted.map((d) => d.preferredBranch));
  const subtasks: DecompositionSubtask[] = drafted.map((d, i) => ({
    id: d.id,
    title: d.title,
    description: d.description,
    requirementIds: d.requirementIds,
    files: d.files,
    branchName: branches[i]!,
  }));
  return {
    planHash,
    summary: typeof body.summary === 'string' && body.summary.trim() ? body.summary.trim() : 'Task decomposition',
    subtasks,
  };
}

export function renderDecompositionMarkdown(work: WorkPackage, decomposition: TaskDecomposition): string {
  const lines = [
    `# Decomposition — ${work.title}`,
    '',
    `Parent task: \`${work.id}\``,
    '',
    decomposition.summary,
    '',
    '| Subtask | Title | Requirements | PR |',
    '|---|---|---|---|',
  ];
  for (const st of decomposition.subtasks) {
    const pr = st.pr ? `[#${st.pr.number}](${st.pr.url})` : '_pending_';
    lines.push(
      `| ${st.id} | ${st.title.replace(/\|/g, '/')} | ${st.requirementIds.join(', ') || '—'} | ${pr} |`,
    );
  }
  lines.push('', '## Subtask details', '');
  for (const st of decomposition.subtasks) {
    lines.push(`### ${st.id}: ${st.title}`, '', st.description, '');
    if (st.files.length) lines.push(`Files: ${st.files.map((f) => `\`${f}\``).join(', ')}`, '');
    lines.push(`Branch: \`${st.branchName}\``, '');
  }
  return lines.join('\n');
}

/**
 * Contract: Engine.execute fail-closes when PR/branch capabilities are unavailable.
 * Do not skip decomposition silently.
 */
export function assertPrCreateAllowed(tools: { allow: string[]; denied: string[] }): void {
  if (!configAllows(tools, 'pr.create')) {
    throw err(
      'E_MISSING_CAPABILITY',
      'task-decomposer requires pr.create in project tools.allow before execute (fail closed)',
    );
  }
  if (tools.denied.includes('git.branch.create') || (tools.allow.length > 0 && !tools.allow.includes('git.branch.create'))) {
    throw err(
      'E_MISSING_CAPABILITY',
      'task-decomposer requires git.branch.create in project tools.allow before execute (fail closed)',
    );
  }
}

/** Resolve a PR target; under Vitest, attach an in-memory GitHub fixture when origin is missing. */
export function resolveDecomposerPrTarget(input: {
  lanePrTarget?: LanePrTarget;
  resolveFromGit: () => LanePrTarget | undefined;
  createFixtureAdapter: () => ToolAdapter;
  baseBranch: string;
  setLanePrTarget: (target: LanePrTarget) => void;
}): LanePrTarget {
  const existing = input.lanePrTarget ?? input.resolveFromGit();
  if (existing) return existing;
  if (process.env.VITEST === 'true') {
    const target: LanePrTarget = {
      adapter: input.createFixtureAdapter(),
      owner: 'fixture',
      repo: 'project',
      baseBranch: input.baseBranch,
    };
    input.setLanePrTarget(target);
    return target;
  }
  throw err(
    'E_INVALID_CONFIG',
    'task-decomposer could not resolve a GitHub PR target (set origin to a github.com remote, or inject lanePrTarget)',
  );
}

export function currentHeadSha(projectRoot: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw err('E_ADAPTER', 'task-decomposer could not read HEAD for PR headSha');
  }
  return result.stdout.trim();
}

/** Best-effort local branch for the subtask; remote prep is separate. */
export function ensureLocalSubtaskBranch(projectRoot: string, branch: string, headSha: string): void {
  spawnSync('git', ['branch', '-f', branch, headSha], { cwd: projectRoot, encoding: 'utf8' });
}

/** Publish the branch tip to the remote (or fixture) so pr.create can reference it. */
export async function ensureRemoteSubtaskBranch(input: {
  target: LanePrTarget;
  workId: string;
  branch: string;
  headSha: string;
}): Promise<void> {
  await invoke(input.target, 'git.branch.create', input.workId, {
    branch: input.branch,
    sha: input.headSha,
  });
}

export function prBodyForSubtask(work: WorkPackage, subtask: DecompositionSubtask): string {
  const reqs = subtask.requirementIds.length
    ? subtask.requirementIds.map((id) => `- ${id}`).join('\n')
    : '- (none listed)';
  return [
    `Turbine task \`${work.id}\` — subtask **${subtask.id}**`,
    '',
    subtask.description,
    '',
    '### Requirements',
    reqs,
    '',
    subtask.files.length ? `### Files\n${subtask.files.map((f) => `- \`${f}\``).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function openSubtaskPrs(input: {
  work: WorkPackage;
  decomposition: TaskDecomposition;
  target: LanePrTarget;
  projectRoot: string;
  /** Re-check ownership before each remote write; throw to refuse stale completion. */
  assertStillOwns: () => void;
  /** Persist after each PR so a mid-loop failure can resume without re-calling the model. */
  persistProgress: (decomposition: TaskDecomposition) => void;
}): Promise<TaskDecomposition> {
  const headSha = currentHeadSha(input.projectRoot);
  const subtasks: DecompositionSubtask[] = [];
  for (const st of input.decomposition.subtasks) {
    if (st.pr?.number && st.pr.url) {
      subtasks.push(st);
      continue;
    }
    input.assertStillOwns();
    // Flat name: must not nest under `turbine/<workId>/…` or git refuses the worktree branch `turbine/<workId>`.
    const head = st.branchName.startsWith(`turbine/${input.work.id}-`)
      ? st.branchName
      : `turbine/${input.work.id}-${st.branchName}`;
    ensureLocalSubtaskBranch(input.projectRoot, head, headSha);
    await ensureRemoteSubtaskBranch({
      target: input.target,
      workId: input.work.id,
      branch: head,
      headSha,
    });
    input.assertStillOwns();
    const created = (await invoke(input.target, 'pr.create', input.work.id, {
      head,
      headSha,
      base: input.target.baseBranch,
      title: st.title,
      body: prBodyForSubtask(input.work, st),
    })) as InvokeResult<{ number: number; url: string; head: string; headSha: string; base: string }>;
    const next: DecompositionSubtask = {
      ...st,
      branchName: head,
      pr: {
        number: created.data.number,
        url: created.data.url,
        head: created.data.head,
        headSha: created.data.headSha,
      },
    };
    subtasks.push(next);
    // Keep unfinished trailing subtasks from the original list when persisting mid-loop.
    input.persistProgress({
      ...input.decomposition,
      subtasks: input.decomposition.subtasks.map((orig, i) => subtasks[i] ?? orig),
    });
  }
  return { ...input.decomposition, subtasks };
}

export function writeDecompositionPacket(projectRoot: string, workId: string, markdown: string): string {
  const path = join(projectRoot, '.turbine', 'tasks', workId, 'DECOMPOSITION.md');
  writeFileSync(path, markdown, 'utf8');
  return path;
}

export function decompositionIsCurrent(
  existing: TaskDecomposition | undefined,
  planHash: string,
): existing is TaskDecomposition {
  return Boolean(
    existing &&
      existing.planHash === planHash &&
      existing.subtasks.length > 0 &&
      existing.subtasks.every((st) => st.pr?.number && st.pr.url),
  );
}

/** Same plan hash with at least one subtask — resume PR opens without another model call. */
export function decompositionCanResume(
  existing: TaskDecomposition | undefined,
  planHash: string,
): existing is TaskDecomposition {
  return Boolean(existing && existing.planHash === planHash && existing.subtasks.length > 0);
}
