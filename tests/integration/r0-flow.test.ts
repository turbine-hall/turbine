import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { factoryRoot } from '../../apps/cli/src/paths.js';
import { initProject, openContext } from '../../apps/cli/src/engine/project.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-'));
  dirs.push(dir);
  // minimal git repo for executor paths
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir });
  initProject({ projectPath: dir, nonInteractive: true });
  return dir;
}

describe('R0 flow', () => {
  it('AT-001 init is idempotent', () => {
    const dir = tempProject();
    const again = initProject({ projectPath: dir, nonInteractive: true });
    expect(again.paths.configPath).toContain('.turbine');
  });

  it('text intake → assess → approve requirements → plan → approve plan + invalidation', async () => {
    const dir = tempProject();
    const request = join(dir, 'request.md');
    writeFileSync(
      request,
      '# Leave approval API\n\nManagers approve leave with existing auth permissions.\n',
    );

    // Ensure factory root discovery works from this package layout
    expect(factoryRoot()).toBeTruthy();

    const ctx = openContext(dir);
    const engine = new Engine(ctx);

    const work = engine.createTask({
      title: 'Leave approval API',
      file: request,
      type: 'feature',
    });
    expect(work.currentState).toBe('IMPORTED');
    expect(work.sourceRefs[0]?.snapshotHash).toMatch(/^sha256:/);

    const assessed = await engine.assess(work.id);
    expect(['REQUIREMENTS_REVIEW', 'NEEDS_CLARIFICATION']).toContain(assessed.work.currentState);
    expect(assessed.roles.hardTriggers).toContain('auth-permissions');

    // Clear unknowns and confirm criteria for approval
    engine.editRequirements(work.id, {
      acceptanceCriteria: [
        {
          id: 'ac_1',
          statement: 'Authorized manager can approve leave',
          kind: 'behavioral',
          status: 'confirmed',
        },
        {
          id: 'ac_2',
          statement: 'Unauthorized caller gets 403',
          kind: 'behavioral',
          status: 'confirmed',
        },
      ],
      unknowns: [],
    });

    const spec = engine.ctx.store.getLatestArtifact(work.id, 'specification')!;
    const approved = engine.approveRequirements(work.id, spec.contentHash, 'tester');
    expect(approved.work.currentState).toBe('REQUIREMENTS_APPROVED');
    expect(approved.decision.identityAssurance).toBe('local-attestation');

    // stale hash rejected
    expect(() => engine.approveRequirements(work.id, 'sha256:dead', 'tester')).toThrow();

    const planned = await engine.plan(work.id);
    expect(planned.work.currentState).toBe('PLAN_REVIEW');
    const planArt = engine.ctx.store.getLatestArtifact(work.id, 'plan')!;
    const planApproved = engine.approvePlan(work.id, planArt.contentHash, 'tester');
    expect(planApproved.work.currentState).toBe('PLAN_APPROVED');

    const validation = engine.contractValidate(work.id);
    expect(validation.ok).toBe(true);

    // Change requirements after plan approval → invalidate plan
    engine.editRequirements(work.id, {
      acceptanceCriteria: [
        {
          id: 'ac_1',
          statement: 'Authorized manager can approve leave AND add note',
          kind: 'behavioral',
          status: 'confirmed',
        },
      ],
      unknowns: [],
    });
    const after = engine.ctx.store.getWork(work.id);
    const decisions = engine.ctx.store.listDecisions(work.id);
    expect(decisions.some((d) => d.gate === 'plan' && d.invalidatedAt)).toBe(true);
    expect(engine.ctx.store.listInvalidations(work.id).length).toBeGreaterThan(0);
    const recovery = engine.recoverDryRun(work.id);
    expect(recovery.requiredApprovalGates).toContain('plan');
    expect(after.currentState).toBe('REQUIREMENTS_REVIEW');

    // Jira fixture intake uses same pipeline
    const fixture = join(factoryRoot(), 'examples/jira-readonly/OPS-123.json');
    const jiraWork = await engine.takeoverJiraAsync('OPS-123', {
      'OPS-123': JSON.parse(readFileSync(fixture, 'utf8')),
    });
    expect(jiraWork.aliases).toContain('OPS-123');
    expect(jiraWork.sourceRefs[0]?.provider).toBe('jira');

    engine.ctx.store.close();
  });
});
