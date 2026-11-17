/**
 * Phase 4 — risk selection and lineage:
 *  G7  profiles never go down; roles decide which skills run and with which grants
 *  G11 upload / untrusted input / new dependency triggers; dependency audit obligation
 *  G8  invalidation walks the dependency graph; a missing link falls back conservatively
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { selectRoles } from '../../packages/core/dist/index.js';
import type { WorkPackage } from '../../packages/contracts/dist/index.js';
import { openContext } from '../../apps/cli/src/engine/project.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { cleanup, commitIn, git, tempProject } from './fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

const base: WorkPackage = {
  id: 'work_x', frameworkId: 'turbine', frameworkVersion: '0.5.0', type: 'bug', title: '', objective: '',
  sourceRefs: [], acceptanceCriteria: [{ id: 'FR-001', statement: 'x', kind: 'technical', status: 'confirmed' }],
  constraints: [], nonGoals: [], unknowns: [], assumptions: [], risk: { profile: 'standard', reasons: [] },
  selectedRoles: [], currentState: 'IMPORTED', currentRevision: 1, aliases: [], createdAt: '', updatedAt: '',
};
const ids = (r: { roles: Array<{ id: string }> }) => r.roles.map((x) => x.id);

describe('G7: selection never lowers risk', () => {
  it('a human minimum is never downgraded (old bug: forced comprehensive bug became lightweight)', () => {
    const r = selectRoles({ work: { ...base, title: 'Fix typo in log message' }, forceProfile: 'comprehensive' });
    expect(r.profile).toBe('comprehensive');
    expect(r.profileSource).toBe('human-minimum');
    expect(ids(r)).toContain('security-reviewer');
  });

  it('the model can raise but not lower; rules win when higher', () => {
    expect(selectRoles({ work: { ...base, title: 'Fix typo' }, modelProfile: 'comprehensive' }).profile).toBe('comprehensive');
    expect(selectRoles({ work: { ...base, title: 'Fix login redirect' }, modelProfile: 'lightweight' }).profile).toBe('comprehensive');
  });

  it('word boundaries: "build" is not "ui", "authority" in prose is not auth', () => {
    const r = selectRoles({ work: { ...base, title: 'Fix the build script output', objective: 'quick fix' } });
    expect(ids(r)).not.toContain('frontend-developer');
    expect(r.profile).toBe('lightweight');
    expect(selectRoles({ work: { ...base, title: 'Document the tax authority rules' } }).hardTriggers).toEqual([]);
  });
});

describe('G11: new triggers', () => {
  it('file upload / spreadsheet parsing is a hard trigger with security + test-case SQA', () => {
    const r = selectRoles({
      work: { ...base, type: 'feature', title: 'LinkedIn sources: upload a spreadsheet and extract drafts' },
    });
    expect(r.hardTriggers).toContain('file-upload');
    expect(r.profile).toBe('comprehensive');
    expect(ids(r)).toEqual(expect.arrayContaining(['security-reviewer', 'test-case-sqa']));
  });

  it('"add doc file for instructions" is an upload (the campaigns pilot task missed this)', () => {
    const r = selectRoles({ work: { ...base, type: 'feature', title: 'Campaign instructions', objective: 'Should be able to add doc file for instructions' } });
    expect(r.hardTriggers).toContain('file-upload');
    expect(ids(r)).toContain('security-reviewer');
  });

  it('a model risk hint counts like a trigger; deletion and untrusted input add specialists', () => {
    const hinted = selectRoles({ work: { ...base, type: 'feature', title: 'Import partner feed' }, modelHints: ['file-upload'] });
    expect(hinted.hardTriggers).toContain('file-upload');
    const del = selectRoles({ work: { ...base, type: 'feature', title: 'Delete a source from the inbox' } });
    expect(del.softTriggers).toContain('data-deletion');
    expect(ids(del)).toContain('test-case-sqa');
    const hook = selectRoles({ work: { ...base, type: 'feature', title: 'Handle Stripe-like webhooks from partners' } });
    expect(ids(hook)).toContain('security-reviewer');
  });
});

async function toImplementing(engine: Engine, title: string, type: 'feature' | 'maintenance' = 'maintenance') {
  const work = engine.createTask({ title, text: `# ${title}\n\nShorten noisy log lines.`, type });
  await engine.assess(work.id);
  engine.editRequirements(work.id, {
    acceptanceCriteria: [{ id: 'FR-001', statement: 'WHEN x THE SYSTEM SHALL y', kind: 'technical', status: 'confirmed', priority: 'P0' }],
    unknowns: [],
  });
  const spec = engine.ctx.store.getLatestArtifact(work.id, 'specification')!;
  engine.approveRequirements(work.id, spec.contentHash, 'pm');
  await engine.plan(work.id);
  engine.approvePlan(work.id, engine.ctx.store.getLatestArtifact(work.id, 'plan')!.contentHash, 'lead');
  const ex = await engine.execute(work.id);
  return { id: work.id, wt: ex.result.worktreePath! };
}

describe('G7: roles decide which skills run', () => {
  it('records each run with grants from the role manifest; refuses role/skill mismatches and unselected roles', async () => {
    const engine = new Engine(openContext(tempProject('turbine-p4-', dirs)));
    const { id, wt } = await toImplementing(engine, 'Tidy log output');
    const work = engine.ctx.store.getWork(id);
    expect(work.risk.profile).not.toBe('comprehensive');
    const runs = engine.ctx.store.listRoleRuns(id);
    expect(runs.map((r) => r.roleId)).toEqual(expect.arrayContaining(['requirements-analyst', 'spec-writer']));
    const analyst = runs.find((r) => r.roleId === 'requirements-analyst')!;
    expect(analyst.status).toBe('succeeded');
    expect(analyst.toolCapabilityGrants).toEqual(['issue.read', 'repo.read', 'none']);
    expect(() => engine.roleGrants(work, 'code-reviewer', 'core/plan-change')).toThrow(/not allowed to run skill/);
    expect(() => engine.roleGrants(work, 'release-engineer', 'core/review-change')).toThrow();

    // Without security-reviewer selected, there is no security lens
    commitIn(wt, 'src/log.js');
    await engine.syncFromMarkdown(id);
    const { review } = await engine.aiReview(id);
    expect(review.lenses).toEqual(['spec-compliance', 'tests']);
    engine.ctx.store.close();
  });

  it('project tool policy removes grants: denying git.diff makes the review fail closed', async () => {
    const engine = new Engine(openContext(tempProject('turbine-p4-', dirs)));
    const { id, wt } = await toImplementing(engine, 'Tidy log output');
    engine.ctx.config.tools.denied.push('git.diff');
    commitIn(wt, 'src/log.js');
    await engine.syncFromMarkdown(id);
    await expect(engine.aiReview(id)).rejects.toThrow(/requires capability git.diff/);
    expect(engine.ctx.store.listRoleRuns(id).some((r) => r.roleId === 'code-reviewer' && r.status === 'failed')).toBe(true);
    engine.ctx.store.close();
  });

  it('raising risk adds reviewers; lowering is refused', async () => {
    const engine = new Engine(openContext(tempProject('turbine-p4-', dirs)));
    const work = engine.createTask({ title: 'Tidy log output', text: '# Tidy\n\nShorten noisy log lines.', type: 'maintenance' });
    await engine.assess(work.id);
    const raised = engine.raiseRisk(work.id, 'comprehensive', 'touches the audit log used by finance');
    expect(raised.risk.profile).toBe('comprehensive');
    expect(raised.risk.minimum).toBe('comprehensive');
    expect(raised.selectedRoles.map((r) => r.id)).toContain('security-reviewer');
    expect(() => engine.raiseRisk(work.id, 'standard', 'nah')).toThrow(/downgrades are disabled/);
    engine.ctx.store.close();
  });
});

describe('G11: a dependency added by the code raises risk and requires an audit', () => {
  it('reselects roles on capture, runs the audit at verify, and blocks acceptance until it passes or is waived', async () => {
    const dir = tempProject('turbine-p4-', dirs);
    const engine = new Engine(openContext(dir));
    engine.ctx.config.quality.dependencyAudit = 'node audit.mjs';
    const { id, wt } = await toImplementing(engine, 'Tidy log output');
    expect(engine.ctx.store.getWork(id).selectedRoles.map((r) => r.id)).not.toContain('security-reviewer');

    writeFileSync(join(wt, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.3.0' } }));
    writeFileSync(join(wt, 'audit.mjs'), 'process.exit(1);\n'); // audit finds a problem
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'add left-pad');
    await engine.syncFromMarkdown(id); // capture → observed new dependency
    const work = engine.ctx.store.getWork(id);
    expect(work.selectedRoles.map((r) => r.id)).toContain('security-reviewer');
    expect(work.risk.reasons).toContain('new-dependency');
    const { review } = await engine.aiReview(id);
    expect(review.lenses).toContain('security');

    const head = git(wt, 'rev-parse', 'HEAD').stdout.trim();
    engine.humanReview(id, 'dev', 'approve', undefined, { commit: head });
    const v = await engine.verify(id);
    expect(v.failed).toBe(false); // audit does not bounce the task back…
    expect(v.audits.map((a) => `${a.command}:${a.passed}`)).toEqual(['node audit.mjs:false']);
    const gate = engine.gateDecision(id, ['obl_manual_sqa']);
    expect(gate.blocking.map((b) => b.id)).toContain('obl_dependency_audit'); // …but blocks acceptance
    engine.waive(id, {
      obligationIds: ['obl_dependency_audit'],
      reason: 'Advisory is dev-only, tracked in SEC-12',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reviewer: 'lead',
      presence: 'test',
    });
    expect(engine.gateDecision(id, ['obl_manual_sqa']).acceptable).toBe(true);
    engine.ctx.store.close();
  });
});

describe('G8: invalidation follows the dependency graph', () => {
  async function reviewed(engine: Engine) {
    const { id, wt } = await toImplementing(engine, 'Tidy log output');
    commitIn(wt, 'src/log.js');
    await engine.syncFromMarkdown(id);
    await engine.aiReview(id);
    engine.humanReview(id, 'dev', 'approve', undefined, { commit: git(wt, 'rev-parse', 'HEAD').stdout.trim() });
    return { id, wt };
  }

  it('a requirements change reaches the code review through plan → change revisions → review', async () => {
    const engine = new Engine(openContext(tempProject('turbine-p4-', dirs)));
    const { id } = await reviewed(engine);
    engine.editRequirements(id, {
      acceptanceCriteria: [{ id: 'FR-001', statement: 'WHEN x THE SYSTEM SHALL z', kind: 'technical', status: 'confirmed', priority: 'P0' }],
      unknowns: [],
    });
    const invalidated = engine.ctx.store.listDecisions(id).filter((d) => d.invalidatedAt).map((d) => d.gate).sort();
    expect(invalidated).toEqual(['code-review', 'plan', 'requirements']);
    const inv = engine.ctx.store.listInvalidations(id).at(-1)!;
    expect(engine.ctx.store.getLatestRecoveryPlan(id)!.status).toBe('proposed'); // graph was complete
    expect(inv.affectedArtifactIds.length).toBeGreaterThanOrEqual(3);
    engine.ctx.store.close();
  });

  it('a missing link makes impact unknown: conservative invalidation and a blocked recovery plan', async () => {
    const engine = new Engine(openContext(tempProject('turbine-p4-', dirs)));
    const { id } = await reviewed(engine);
    // Simulate lost lineage: drop the plan → change edge
    const db = engine.ctx.store.db;
    for (const e of engine.ctx.store.listEdges(id).filter((x) => x.reason === 'plan-to-implementation')) {
      db.prepare('DELETE FROM artifact_dependency_edges WHERE id = ?').run(e.id);
    }
    engine.editRequirements(id, {
      acceptanceCriteria: [{ id: 'FR-001', statement: 'WHEN x THE SYSTEM SHALL w', kind: 'technical', status: 'confirmed', priority: 'P0' }],
      unknowns: [],
    });
    // The graph alone cannot reach the code review, but the conservative fallback still invalidates it
    expect(engine.ctx.store.listDecisions(id).find((d) => d.gate === 'code-review')!.invalidatedAt).toBeTruthy();
    const recovery = engine.ctx.store.getLatestRecoveryPlan(id)!;
    expect(recovery.status).toBe('blocked');
    expect(recovery.unknownImpactIds.length).toBeGreaterThan(0);
    engine.ctx.store.close();
  });
});
