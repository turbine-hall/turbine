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

async function invokePrCreate(
  target: LanePrTarget,
  workId: string,
  args: Record<string, unknown>,
): Promise<InvokeResult<{ number: number; url: string; head: string; headSha: string; base: string }>> {
  const capability: Capability = 'pr.create';
  if (!target.adapter.capabilities.includes(capability)) {
    throw err('E_MISSING_CAPABILITY', `GitHub adapter does not support ${capability}`);
  }
  return target.adapter.invoke({
    capability,
    workId,
    arguments: { owner: target.owner, repo: target.repo, ...args },
    correlationId: createId('corr'),
  }) as Promise<InvokeResult<{ number: number; url: string; head: string; headSha: string; base: string }>>;
}

function branchSuffix(raw: unknown, fallbackId: string): string {
  const text = typeof raw === 'string' && raw.trim() ? raw.trim() : `st-${fallbackId}`;
  return text
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `st-${fallbackId.toLowerCase()}`;
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
  const subtasks: DecompositionSubtask[] = raw.map((entry, index) => {
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
      branchName: branchSuffix(row.branchName, id),
    };
  });
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

export function assertPrCreateAllowed(tools: { allow: string[]; denied: string[] }): void {
  if (!configAllows(tools, 'pr.create')) {
    throw err(
      'E_MISSING_CAPABILITY',
      'task-decomposer requires pr.create in project tools.allow before execute (fail closed)',
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

/** Best-effort local branch for the subtask; PR create still uses the given headSha. */
export function ensureLocalSubtaskBranch(projectRoot: string, branch: string, headSha: string): void {
  spawnSync('git', ['branch', '-f', branch, headSha], { cwd: projectRoot, encoding: 'utf8' });
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
}): Promise<TaskDecomposition> {
  const headSha = currentHeadSha(input.projectRoot);
  const subtasks: DecompositionSubtask[] = [];
  for (const st of input.decomposition.subtasks) {
    if (st.pr) {
      subtasks.push(st);
      continue;
    }
    // Flat name: must not nest under `turbine/<workId>/…` or git refuses the worktree branch `turbine/<workId>`.
    const head = `turbine/${input.work.id}-${st.branchName}`;
    ensureLocalSubtaskBranch(input.projectRoot, head, headSha);
    const created = await invokePrCreate(input.target, input.work.id, {
      head,
      headSha,
      base: input.target.baseBranch,
      title: st.title,
      body: prBodyForSubtask(input.work, st),
    });
    subtasks.push({
      ...st,
      branchName: head,
      pr: {
        number: created.data.number,
        url: created.data.url,
        head: created.data.head,
        headSha: created.data.headSha,
      },
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
