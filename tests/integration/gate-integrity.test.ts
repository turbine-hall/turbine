/**
 * Phase 1 gate-integrity mutation tests (framework assumption A-09): change something
 * after it was approved and assert every affected gate blocks.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { openContext } from '../../apps/cli/src/engine/project.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { packetPaths } from '../../apps/cli/src/engine/packet.js';
import { cleanup, commitIn, tempProject as makeProject } from './fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));
const tempProject = () => makeProject('turbine-gates-', dirs);

const AC = (statement: string) => [
  { id: 'ac_1', statement, kind: 'behavioral' as const, status: 'confirmed' as const },
];

async function toRequirementsReview(engine: Engine) {
  const work = engine.createTask({ title: 'Export report', text: '# Export report\n\nUsers export a CSV.', type: 'feature' });
  await engine.assess(work.id);
  engine.editRequirements(work.id, { acceptanceCriteria: AC('User can export CSV'), unknowns: [] });
  return engine.ctx.store.getWork(work.id);
}

async function toPlanApproved(engine: Engine) {
  const work = await toRequirementsReview(engine);
  const spec = engine.ctx.store.getLatestArtifact(work.id, 'specification')!;
  engine.approveRequirements(work.id, spec.contentHash, 'tester');
  await engine.plan(work.id);
  const plan = engine.ctx.store.getLatestArtifact(work.id, 'plan')!;
  engine.approvePlan(work.id, plan.contentHash, 'tester');
  return engine.ctx.store.getWork(work.id);
}

const commitInWorktree = (wt: string, file: string) => commitIn(wt, file);

async function toHumanAcceptance(engine: Engine) {
  const work = await toPlanApproved(engine);
  const executed = await engine.execute(work.id);
  const head = commitInWorktree(executed.result.worktreePath!, 'feature.txt');
  await engine.syncFromMarkdown(work.id); // captures the real commit → AI_REVIEW
  await engine.aiReview(work.id);
  engine.humanReview(work.id, 'tester', 'approve', undefined, { commit: head });
  await engine.verify(work.id);
  return { work: engine.ctx.store.getWork(work.id), head, wt: executed.result.worktreePath! };
}

describe('G2: approvals are bound to the exact revision', () => {
  it('rejects approving requirements with a stale hash', async () => {
    const engine = new Engine(openContext(tempProject()));
    const work = await toRequirementsReview(engine);
    expect(() => engine.approveRequirements(work.id, 'sha256:stale', 'tester')).toThrow(/Expected/);
    engine.ctx.store.close();
  });

  it('decide() refuses a confirmation code that does not match the pending revision', async () => {
    const engine = new Engine(openContext(tempProject()));
    const work = await toRequirementsReview(engine);
    expect(() =>
      engine.decide(work.id, { action: 'approve', reviewer: 'Ana', confirmToken: 'deadbeef', presence: 'test' }),
    ).toThrow(/does not match/);
    const pending = engine.pendingApproval(work.id);
    const res = engine.decide(work.id, {
      action: 'approve',
      reviewer: 'Ana',
      confirmToken: pending.confirmToken,
      presence: 'test',
    });
    expect(res.work.currentState).toBe('REQUIREMENTS_APPROVED');
    const d = engine.ctx.store.listDecisions(work.id).find((x) => x.gate === 'requirements')!;
    expect(d.presence).toBe('test');
    engine.ctx.store.close();
  });

  it('changing requirements after plan approval blocks execution until both are re-approved', async () => {
    const engine = new Engine(openContext(tempProject()));
    const work = await toPlanApproved(engine);
    const oldPlan = engine.ctx.store.getLatestArtifact(work.id, 'plan')!;

    engine.editRequirements(work.id, { acceptanceCriteria: AC('User can export CSV and XLSX'), unknowns: [] });
    expect(engine.ctx.store.getWork(work.id).currentState).toBe('REQUIREMENTS_REVIEW');
    await expect(engine.execute(work.id)).rejects.toThrow();

    const shown = engine.contractShow(work.id).evaluated.obligations;
    const req = shown.find((o) => o.id === 'obl_requirements_approval')!;
    expect(req.derivedStatus).toBe('stale');

    // Re-approve the NEW spec, re-plan, and the old plan hash can no longer be approved
    const spec2 = engine.ctx.store.getLatestArtifact(work.id, 'specification')!;
    engine.approveRequirements(work.id, spec2.contentHash, 'tester');
    await engine.plan(work.id);
    const plan2 = engine.ctx.store.getLatestArtifact(work.id, 'plan')!;
    if (plan2.contentHash !== oldPlan.contentHash) {
      expect(() => engine.approvePlan(work.id, oldPlan.contentHash, 'tester')).toThrow(/Expected/);
    }
    engine.approvePlan(work.id, plan2.contentHash, 'tester');

    // Stale markers are not sticky: after re-approval the obligations pass again
    const after = engine.contractShow(work.id).evaluated.obligations;
    expect(after.find((o) => o.id === 'obl_requirements_approval')!.derivedStatus).toBe('satisfied');
    expect(after.find((o) => o.id === 'obl_plan_approval')!.derivedStatus).toBe('satisfied');
    engine.ctx.store.close();
  });

  it('code review approval must name the commit under review', async () => {
    const engine = new Engine(openContext(tempProject()));
    const work = await toPlanApproved(engine);
    const executed = await engine.execute(work.id);
    const head = commitInWorktree(executed.result.worktreePath!, 'a.txt');
    await engine.syncFromMarkdown(work.id);
    await engine.aiReview(work.id);
    expect(() => engine.humanReview(work.id, 'tester', 'approve', undefined, { commit: 'abc' })).toThrow();
    expect(() => engine.humanReview(work.id, 'tester', 'approve', undefined, { commit: head.slice(0, 3) })).toThrow();
    expect(() =>
      engine.humanReview(work.id, 'tester', 'approve', undefined, { commit: '0000000000' }),
    ).toThrow(/must name the commit/);
    engine.ctx.store.close();
  });
});

describe('G1: markdown cannot approve anything', () => {
  it('sync ignores "Approved: yes" written into the requirements file', async () => {
    const dir = tempProject();
    const engine = new Engine(openContext(dir));
    const work = await toRequirementsReview(engine);
    const p = packetPaths(dir, work.id).requirements;
    writeFileSync(p, readFileSync(p, 'utf8') + '\nApproved: yes\nReviewer: totally-a-human\n');
    const res = await engine.syncFromMarkdown(work.id);
    expect(res.work.currentState).toBe('REQUIREMENTS_REVIEW');
    expect(engine.ctx.store.listDecisions(work.id).filter((d) => d.gate === 'requirements')).toHaveLength(0);
    engine.ctx.store.close();
  });

  it('sync that edits requirements creates a new revision and never approves it', async () => {
    const dir = tempProject();
    const engine = new Engine(openContext(dir));
    const work = await toRequirementsReview(engine);
    const before = engine.ctx.store.getLatestArtifact(work.id, 'specification')!.contentHash;
    const p = packetPaths(dir, work.id).requirements;
    const edited = readFileSync(p, 'utf8').replace(
      /## Non-goals[\s\S]*?(?=\n## )/,
      '## Non-goals\n\n- No PDF export\n\n',
    );
    writeFileSync(p, edited + '\nApproved: yes\n');
    const res = await engine.syncFromMarkdown(work.id);
    expect(res.action).toBe('requirements.edit');
    expect(engine.ctx.store.getLatestArtifact(work.id, 'specification')!.contentHash).not.toBe(before);
    expect(res.work.currentState).toBe('REQUIREMENTS_REVIEW');
    expect(engine.ctx.store.listDecisions(work.id).filter((d) => d.gate === 'requirements')).toHaveLength(0);
    engine.ctx.store.close();
  });

  it('sync at human gates only reports that a human must decide', async () => {
    const dir = tempProject();
    const engine = new Engine(openContext(dir));
    const work = await toRequirementsReview(engine);
    const spec = engine.ctx.store.getLatestArtifact(work.id, 'specification')!;
    engine.approveRequirements(work.id, spec.contentHash, 'tester');
    await engine.plan(work.id);
    const p = packetPaths(dir, work.id).plan;
    writeFileSync(p, readFileSync(p, 'utf8') + '\nApproved: yes\n');
    const res = await engine.syncFromMarkdown(work.id);
    expect(res.action).toBe('awaiting-human');
    expect(res.work.currentState).toBe('PLAN_REVIEW');
    engine.ctx.store.close();
  });
});

describe('G5/G6: acceptance fails closed', () => {
  it('blocks acceptance when no code changed (head == base), like the TS7 pilot task', async () => {
    const engine = new Engine(openContext(tempProject()));
    const work = await toPlanApproved(engine);
    await engine.execute(work.id); // supervised handoff only, no commit
    const gate = engine.gateDecision(work.id);
    expect(gate.decision).toBe('FAIL');
    const impl = gate.blocking.find((b) => b.id === 'obl_implementation')!;
    expect(impl.reason).toMatch(/no code changed/);
    engine.ctx.store.close();
  });

  it('acceptance needs Expected and Actual observations and the current commit', async () => {
    const engine = new Engine(openContext(tempProject()));
    const { work, head } = await toHumanAcceptance(engine);
    expect(() =>
      engine.accept(work.id, 'qa', { expected: 'csv', actual: '', result: 'passed' }, { commit: head }),
    ).toThrow(/Expected and Actual/);
    expect(() =>
      engine.accept(work.id, 'qa', { expected: 'csv', actual: 'csv', result: 'passed' }, { commit: 'ffffffff' }),
    ).toThrow(/must name the commit/);
    const ok = engine.accept(work.id, 'qa', { expected: 'csv', actual: 'csv', result: 'passed' }, { commit: head });
    expect(ok.work.currentState).toBe('ACCEPTED');
    engine.ctx.store.close();
  });

  it('a new commit after review makes review, checks and SQA stale and blocks acceptance', async () => {
    const engine = new Engine(openContext(tempProject()));
    const { work, wt } = await toHumanAcceptance(engine);
    commitInWorktree(wt, 'sneaky.txt');
    const res = await engine.syncFromMarkdown(work.id); // detects the new head automatically
    expect(res.action).toBe('code.changed');
    expect(res.work.currentState).toBe('AI_REVIEW'); // re-review before a human sees it
    const gate = engine.gateDecision(work.id);
    expect(gate.decision).toBe('FAIL');
    const ids = gate.blocking.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(['obl_code_review', 'obl_automated_checks', 'obl_manual_sqa']));
    engine.ctx.store.close();
  });

  it('unmet obligations block acceptance unless a named human waives them (gate stays FAIL)', async () => {
    const engine = new Engine(openContext(tempProject()));
    const { work, head } = await toHumanAcceptance(engine);
    // Remove passing unit evidence for the current commit by recording a failure
    engine.ctx.store.saveEvidence({
      id: 'ev_fail_unit',
      workId: work.id,
      kind: 'unit',
      result: 'failed',
      commitSha: head,
      observedAt: new Date(Date.now() + 1000).toISOString(),
      limitations: [],
    });
    expect(() =>
      engine.accept(work.id, 'qa', { expected: 'csv', actual: 'csv', result: 'passed' }, { commit: head }),
    ).toThrow(/obl_automated_checks/);
    // A blocked acceptance records nothing
    expect(engine.ctx.store.listDecisions(work.id).some((d) => d.gate === 'sqa-acceptance')).toBe(false);
    expect(engine.ctx.store.getWork(work.id).currentState).toBe('HUMAN_ACCEPTANCE');

    // Waivers need a reason and a future expiry
    expect(() =>
      engine.waive(work.id, { obligationIds: ['obl_automated_checks'], reason: 'flaky', expiresAt: '2000-01-01', reviewer: 'lead', presence: 'test' }),
    ).toThrow(/future expiry/);
    engine.waive(work.id, {
      obligationIds: ['obl_automated_checks'],
      reason: 'Known flaky test, tracked in OPS-9',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reviewer: 'lead',
      presence: 'test',
    });
    const ok = engine.accept(work.id, 'qa', { expected: 'csv', actual: 'csv', result: 'passed' }, { commit: head });
    expect(ok.work.currentState).toBe('ACCEPTED');
    const gate = engine.gateDecision(work.id);
    expect(gate.decision).toBe('FAIL'); // derived decision never becomes PASS through a waiver
    expect(gate.waived.map((w) => w.id)).toContain('obl_automated_checks');
    engine.ctx.store.close();
  });
});

describe('a fix committed at code review is re-reviewed before a human can approve', () => {
  it('moves back to AI_REVIEW, refuses approval on the stale review, then reviews the new commit', async () => {
    const engine = new Engine(openContext(tempProject()));
    const work = await toPlanApproved(engine);
    const executed = await engine.execute(work.id);
    const wt = executed.result.worktreePath!;
    commitInWorktree(wt, 'a.txt');
    await engine.syncFromMarkdown(work.id); // capture
    await engine.aiReview(work.id); // → HUMAN_CODE_REVIEW
    const fix = commitInWorktree(wt, 'fix.txt'); // agent commits a fix without any human rejection
    const res = await engine.syncFromMarkdown(work.id);
    expect(res.action).toBe('code.changed');
    expect(res.work.currentState).toBe('AI_REVIEW');
    expect(engine.aiReviewIsCurrent(work.id)).toBe(false);
    await engine.syncFromMarkdown(work.id); // AI review of the fix
    expect(engine.ctx.store.getWork(work.id).currentState).toBe('HUMAN_CODE_REVIEW');
    expect(engine.aiReviewIsCurrent(work.id)).toBe(true);
    expect(engine.pendingApproval(work.id).subject).toBe(fix);
    engine.ctx.store.close();
  });
});

describe('after the PR is merged and the worktree removed', () => {
  it('status, gate and documents still work from the stored change facts', async () => {
    const engine = new Engine(openContext(tempProject()));
    const { work, head, wt } = await toHumanAcceptance(engine);
    engine.accept(work.id, 'qa', { expected: 'csv', actual: 'csv', result: 'passed' }, { commit: head });
    const { spawnSync } = await import('node:child_process');
    const root = engine.ctx.projectRoot;
    spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: root });
    spawnSync('git', ['branch', '-D', `turbine/${work.id}`], { cwd: root });
    expect(() => engine.gateDecision(work.id)).not.toThrow();
    const gate = engine.gateDecision(work.id);
    expect(gate.acceptable).toBe(true); // required evidence still satisfied from stored facts
    expect(gate.blocking).toEqual([]);
    expect(() => engine.render(work.id)).not.toThrow();
    expect(engine.traceFor(work.id).length).toBeGreaterThan(0);
    engine.ctx.store.close();
  });
});

describe('PR approval layer (optional)', () => {
  it('requires an approved PR at the exact commit when humanGates.requirePrApproval is on', async () => {
    const engine = new Engine(openContext(tempProject()));
    engine.ctx.config.humanGates.requirePrApproval = true;
    const work = await toPlanApproved(engine);
    const executed = await engine.execute(work.id);
    const head = commitInWorktree(executed.result.worktreePath!, 'pr.txt');
    await engine.syncFromMarkdown(work.id);
    await engine.aiReview(work.id);
    const calls: string[] = [];
    engine.prApprovalChecker = ({ branch, headCommit }) => {
      calls.push(`${branch}@${headCommit.slice(0, 8)}`);
      return { approved: false, detail: 'PR review decision is REVIEW_REQUIRED' };
    };
    const token = engine.pendingApproval(work.id).confirmToken;
    expect(() =>
      engine.decide(work.id, { action: 'approve', reviewer: 'Ana', confirmToken: token, presence: 'test' }),
    ).toThrow(/GitHub PR approval required/);
    expect(calls[0]).toBe(`turbine/${work.id}@${head.slice(0, 8)}`);
    engine.prApprovalChecker = () => ({ approved: true, detail: 'ok' });
    const res = engine.decide(work.id, { action: 'approve', reviewer: 'Ana', confirmToken: token, presence: 'test' });
    expect(res.work.currentState).toBe('VERIFYING');
    engine.ctx.store.close();
  });
});
