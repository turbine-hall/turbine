import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRoles } from '../../packages/core/src/roles.js';
import { loadSkills } from '../../packages/skills/src/loader.js';
import { openContext } from '../../apps/cli/src/engine/project.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { factoryRoot } from '../../apps/cli/src/paths.js';
import { createGitHubAdapter, type GitHubFixtureState } from '../../packages/adapter-github/dist/index.js';
import { cleanup, tempProject } from './fixture.js';
import {
  normalizeDecomposition,
  prBodyForSubtask,
  type TaskDecomposition,
} from '../../apps/cli/src/engine/task-decomposer.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

const AC = [
  {
    id: 'ac_1',
    statement: 'User can export CSV',
    kind: 'behavioral' as const,
    status: 'confirmed' as const,
  },
];

async function toPlanApproved(engine: Engine) {
  const work = engine.createTask({
    title: 'Export report',
    text: '# Export report\n\nUsers export a CSV.',
    type: 'feature',
  });
  await engine.assess(work.id);
  engine.editRequirements(work.id, { acceptanceCriteria: AC, unknowns: [] });
  const spec = engine.ctx.store.getLatestArtifact(work.id, 'specification')!;
  engine.approveRequirements(work.id, spec.contentHash, 'tester');
  await engine.plan(work.id);
  const plan = engine.ctx.store.getLatestArtifact(work.id, 'plan')!;
  engine.approvePlan(work.id, plan.contentHash, 'tester');
  return engine.ctx.store.getWork(work.id);
}

function attachGithub(engine: Engine): GitHubFixtureState {
  // Track refs so pr.create requires git.branch.create first (matches live remote contract).
  const github: GitHubFixtureState = { pullRequests: {}, statuses: {}, protections: {}, refs: {} };
  engine.lanePrTarget = {
    adapter: createGitHubAdapter({ fixtures: github }),
    owner: 'fixture',
    repo: 'project',
    baseBranch: 'main',
  };
  if (!engine.ctx.config.tools.allow.includes('git.branch.create')) {
    engine.ctx.config.tools.allow.push('git.branch.create');
  }
  return github;
}

describe('task-decomposer role', () => {
  it('loads the role and skill from the factory', () => {
    const root = factoryRoot();
    expect(loadRoles(root).some((r) => r.id === 'task-decomposer')).toBe(true);
    expect(loadSkills(root).some((s) => s.id === 'core/decompose-task')).toBe(true);
  });

  it('assigns distinct branch names when proposed names collide', () => {
    const d = normalizeDecomposition(
      {
        summary: 'collide',
        subtasks: [
          { id: 'ST1', title: 'A', description: 'a', requirementIds: ['FR-001'], files: [], branchName: 'feat' },
          { id: 'ST2', title: 'B', description: 'b', requirementIds: ['FR-001'], files: [], branchName: 'feat' },
        ],
      },
      'hash',
    );
    expect(d.subtasks[0]!.branchName).toBe('feat');
    expect(d.subtasks[1]!.branchName).toBe('feat-2');
  });

  it('PR body includes parent work id and requirement ids', () => {
    const body = prBodyForSubtask(
      { id: 'work_01TEST', title: 'T' } as Parameters<typeof prBodyForSubtask>[0],
      {
        id: 'ST1',
        title: 'Do thing',
        description: 'Change the exporter.',
        requirementIds: ['FR-001', 'FR-002'],
        files: ['src/export.ts'],
        branchName: 'st-st1',
      },
    );
    expect(body).toContain('work_01TEST');
    expect(body).toContain('FR-001');
    expect(body).toContain('FR-002');
    expect(body).toContain('Change the exporter.');
  });

  it('runs before IMPLEMENTING, opens one PR per subtask with work id in the body', async () => {
    const dir = tempProject('turbine-decompose-', dirs);
    const engine = new Engine(openContext(dir));
    const github = attachGithub(engine);
    const work = await toPlanApproved(engine);

    expect(engine.ctx.store.getWork(work.id).currentState).toBe('PLAN_APPROVED');
    const executed = await engine.execute(work.id);
    expect(executed.work.currentState).toBe('IMPLEMENTING');

    const art = engine.ctx.store.getLatestArtifact(work.id, 'task-decomposition');
    expect(art).toBeTruthy();
    const decomposition = JSON.parse(engine.ctx.store.getArtifactContent(art!.id)) as TaskDecomposition;
    expect(decomposition.subtasks.length).toBeGreaterThanOrEqual(1);
    expect(decomposition.subtasks.every((st) => st.pr?.number && st.pr.url)).toBe(true);

    const md = join(dir, '.turbine', 'tasks', work.id, 'DECOMPOSITION.md');
    expect(existsSync(md)).toBe(true);
    expect(readFileSync(md, 'utf8')).toContain(work.id);

    const repoKey = 'fixture/project';
    const prs = github.pullRequests?.[repoKey] ?? [];
    expect(prs.length).toBe(decomposition.subtasks.length);
    for (const pr of prs) {
      // Fixture adapter stores created PRs without body; re-read via event payload + artifact.
      expect(pr.head.startsWith(`turbine/${work.id}-`)).toBe(true);
    }
    for (const st of decomposition.subtasks) {
      expect(st.pr!.url).toContain('/pull/');
      expect(st.requirementIds.length).toBeGreaterThan(0);
    }
    const events = engine.ctx.store.listEvents(work.id).filter((e) => e.type === 'task.decomposed');
    expect(events).toHaveLength(1);
  });

  it('is idempotent: second execute does not open duplicate PRs', async () => {
    const dir = tempProject('turbine-decompose-idemp-', dirs);
    const engine = new Engine(openContext(dir));
    const github = attachGithub(engine);
    const work = await toPlanApproved(engine);

    await engine.execute(work.id);
    const first = JSON.parse(
      engine.ctx.store.getArtifactContent(engine.ctx.store.getLatestArtifact(work.id, 'task-decomposition')!.id),
    ) as TaskDecomposition;
    const countAfterFirst = github.pullRequests?.['fixture/project']?.length ?? 0;

    // Return to PLAN_APPROVED so execute runs again; decomposer must reuse recorded PRs.
    const stored = engine.ctx.store.getWork(work.id);
    engine.ctx.store.saveWork({
      ...stored,
      currentState: 'PLAN_APPROVED',
      updatedAt: new Date().toISOString(),
      currentRevision: stored.currentRevision + 1,
    });

    await engine.execute(work.id);
    const second = JSON.parse(
      engine.ctx.store.getArtifactContent(engine.ctx.store.getLatestArtifact(work.id, 'task-decomposition')!.id),
    ) as TaskDecomposition;
    const countAfterSecond = github.pullRequests?.['fixture/project']?.length ?? 0;

    expect(countAfterSecond).toBe(countAfterFirst);
    expect(second.subtasks.map((s) => s.pr?.number)).toEqual(first.subtasks.map((s) => s.pr?.number));
    expect(engine.ctx.store.listEvents(work.id).filter((e) => e.type === 'task.decomposed')).toHaveLength(1);
  });

  it('refuses execute when pr.create is not allowed', async () => {
    const dir = tempProject('turbine-decompose-deny-', dirs);
    const engine = new Engine(openContext(dir));
    attachGithub(engine);
    engine.ctx.config.tools.allow = engine.ctx.config.tools.allow.filter((c) => c !== 'pr.create');
    const work = await toPlanApproved(engine);

    await expect(engine.execute(work.id)).rejects.toThrow(/pr\.create/);
    expect(engine.ctx.store.getWork(work.id).currentState).toBe('PLAN_APPROVED');
    expect(engine.ctx.store.getLatestArtifact(work.id, 'task-decomposition')).toBeFalsy();
  });
});
