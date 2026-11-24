import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openContext } from '../../apps/cli/src/engine/project.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { approvePolicy, pendingPolicyApproval } from '../../apps/cli/src/engine/lane-policy.js';
import { commitIn, tempProject } from './fixture.js';

export const ROUTINE_POLICY = [
  'name: routine',
  'maxRiskProfile: standard',
  'labels: [bug]',
  'deniedTriggers: [auth-permissions, payments, sensitive-data, data-migration, file-upload, untrusted-input, new-dependency]',
  'maxChangedLines: 40',
  'maxChangedFiles: 4',
  'allowDependencyChanges: false',
  'maxRepos: 1',
  'deniedPaths:',
  '  - "apps/cli/src/human-gate.ts"',
  '  - ".cursor/**"',
  '  - ".github/**"',
  '  - ".turbine/**"',
  'gates: [requirements, plan, codeReview, acceptance]',
  '',
].join('\n');

export function writePolicy(dir: string, name: string, yaml: string): string {
  const policies = join(dir, '.turbine', 'policies');
  mkdirSync(policies, { recursive: true });
  const path = join(policies, `${name}.yaml`);
  writeFileSync(path, yaml);
  return path;
}

export function approve(engine: Engine, name: string, reviewer = 'Ana') {
  const pending = pendingPolicyApproval(engine.ctx.store, engine.ctx.projectRoot, name);
  return approvePolicy(engine.ctx.store, engine.ctx.projectRoot, { name, confirmToken: pending.confirmToken, reviewer, presence: 'test' });
}

/** A project with the routine policy on disk; approved unless `approved: false`. */
export function laneProject(dirs: string[], opts: { policy?: string; approved?: boolean } = {}) {
  const dir = tempProject('turbine-lane-', dirs);
  const engine = new Engine(openContext(dir));
  writePolicy(dir, 'routine', opts.policy ?? ROUTINE_POLICY);
  if (opts.approved !== false) approve(engine, 'routine');
  return { dir, engine };
}

export const P0 = [{ id: 'FR-001', statement: 'The README heading reads "fixture fixed"', kind: 'behavioral' as const, status: 'confirmed' as const, priority: 'P0' as const }];

/** Create a small bug task and bring it to REQUIREMENTS_REVIEW (no sync after the edit). */
export async function toRequirementsGate(engine: Engine, opts: { labels?: string[]; title?: string } = {}) {
  const title = opts.title ?? 'Fix README heading';
  const work = engine.createTask({ title, text: `# ${title}\n\nThe README heading has a typo.`, type: 'bug', labels: opts.labels ?? ['bug'] });
  await engine.syncFromMarkdown(work.id); // assess
  engine.editRequirements(work.id, { acceptanceCriteria: P0, unknowns: [] });
  return engine.ctx.store.getWork(work.id);
}

/** Drive a task through the lane up to HUMAN_CODE_REVIEW, committing `files` in the worktree. */
export async function toCodeReview(engine: Engine, files: Record<string, string> = { 'README.md': '# fixture fixed\n' }, opts: { labels?: string[] } = {}) {
  const work = await toRequirementsGate(engine, opts);
  for (let i = 0; i < 8; i++) {
    const w = engine.ctx.store.getWork(work.id);
    if (w.currentState === 'HUMAN_CODE_REVIEW') break;
    if (w.currentState === 'IMPLEMENTING') {
      const wt = engine.repoStates(work.id)[0]!.worktreePath;
      for (const [file, content] of Object.entries(files)) commitIn(wt, file, content);
    }
    await engine.syncFromMarkdown(work.id);
  }
  return engine.ctx.store.getWork(work.id);
}

export const laneEvents = (engine: Engine, workId: string) =>
  engine.ctx.store.listEvents(workId).filter((e) => e.type.startsWith('lane.'));
