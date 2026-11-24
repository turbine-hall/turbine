import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openContext } from '../../apps/cli/src/engine/project.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { approvePolicy, pendingPolicyApproval } from '../../apps/cli/src/engine/lane-policy.js';
import { createMockModelAdapter, registerModel } from '../../packages/models/dist/index.js';
import { createGitHubAdapter, type GitHubFixtureState } from '../../packages/adapter-github/dist/index.js';
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
  'gates: [requirements, plan, acceptance]',
  'tools: [pr.create, pr.merge]',
  '',
].join('\n');

export const DUAL_ROUTINE_POLICY = ROUTINE_POLICY.replace(
  'gates: [requirements, plan, acceptance]',
  'gates: [requirements, plan, codeReview, acceptance]\nreviewers: [review-primary, review-secondary]',
);

export function writePolicy(dir: string, name: string, yaml: string): string {
  const policies = join(dir, '.turbine', 'policies');
  mkdirSync(policies, { recursive: true });
  const path = join(policies, `${name}.yaml`);
  writeFileSync(path, yaml);
  return path;
}

export function approve(engine: Engine, name: string, reviewer = 'Ana') {
  const profiles = engine.ctx.config.models.profiles;
  const pending = pendingPolicyApproval(engine.ctx.store, engine.ctx.projectRoot, name, profiles);
  return approvePolicy(engine.ctx.store, engine.ctx.projectRoot, {
    name,
    confirmToken: pending.confirmToken,
    reviewer,
    presence: 'test',
    profiles,
  });
}

/** A project with the routine policy on disk; approved unless `approved: false`. */
export function laneProject(dirs: string[], opts: { policy?: string; approved?: boolean } = {}) {
  const dir = tempProject('turbine-lane-', dirs);
  const engine = new Engine(openContext(dir));
  engine.ctx.config.models.profiles['review-primary'] = { provider: 'mock', model: 'mock-review-primary', maxOutputTokens: 3000 };
  engine.ctx.config.models.profiles['review-secondary'] = { provider: 'mock', model: 'mock-review-secondary', maxOutputTokens: 3000 };
  registerModel(createMockModelAdapter('mock-review-primary'));
  registerModel(createMockModelAdapter('mock-review-secondary'));
  engine.ctx.config.tools.allow.push('pr.create', 'pr.merge');
  engine.ctx.config.tools.denied = engine.ctx.config.tools.denied.filter((capability) => capability !== 'pr.merge');
  const github: GitHubFixtureState = {
    pullRequests: {},
    statuses: {},
    protections: { 'fixture/project:main': { mergeQueueRequired: true, requiredStatuses: ['turbine/gate'] } },
  };
  engine.lanePrTarget = {
    adapter: createGitHubAdapter({ fixtures: github }),
    owner: 'fixture',
    repo: 'project',
    baseBranch: 'main',
  };
  writePolicy(dir, 'routine', opts.policy ?? ROUTINE_POLICY);
  if (opts.approved !== false) approve(engine, 'routine');
  return { dir, engine, github };
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
    if (w.currentState === 'HUMAN_CODE_REVIEW' || w.currentState === 'VERIFYING') break;
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
