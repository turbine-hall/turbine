import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openContext } from '../../apps/cli/src/engine/project.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { cleanup, commitIn, tempProject as makeProject } from './fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));
const tempProject = () => makeProject('turbine-r1-', dirs);

async function toPlanApproved(engine: Engine, title: string) {
  const work = engine.createTask({
    title,
    text: `${title}\n\nImplement with auth permissions checks.`,
    type: 'feature',
  });
  await engine.assess(work.id);
  engine.editRequirements(work.id, {
    acceptanceCriteria: [
      {
        id: 'ac_1',
        statement: 'Feature works for authorized users',
        kind: 'behavioral',
        status: 'confirmed',
      },
    ],
    unknowns: [],
  });
  const spec = engine.ctx.store.getLatestArtifact(work.id, 'specification')!;
  engine.approveRequirements(work.id, spec.contentHash, 'tester');
  await engine.plan(work.id);
  const plan = engine.ctx.store.getLatestArtifact(work.id, 'plan')!;
  engine.approvePlan(work.id, plan.contentHash, 'tester');
  return engine.ctx.store.getWork(work.id);
}

describe('R1 flow', () => {
  it('execute → ai review → human review → verify → accept; stale commit blocks', async () => {
    const dir = tempProject();
    const ctx = openContext(dir);
    const engine = new Engine(ctx);

    const work = await toPlanApproved(engine, 'Leave approval');
    expect(work.currentState).toBe('PLAN_APPROVED');

    const executed = await engine.execute(work.id);
    expect(executed.work.currentState).toBe('IMPLEMENTING');
    expect(executed.result.worktreePath).toContain('.turbine/worktrees');
    const wt = executed.result.worktreePath!;

    // Sync without a commit stays in IMPLEMENTING
    expect((await engine.syncFromMarkdown(work.id)).action).toBe('waiting-for-commits');
    // Uncommitted work also stays in IMPLEMENTING
    writeFileSync(join(wt, 'wip.txt'), 'wip\n');
    const dirty = await engine.syncFromMarkdown(work.id);
    expect(dirty.action).toBe('waiting-for-commits');
    expect(String((dirty.detail as { reason: string }).reason)).toMatch(/Uncommitted/);
    // Commit → captured with the real head
    const head = commitIn(wt, 'wip.txt');
    const captured = await engine.syncFromMarkdown(work.id);
    expect(captured.action).toBe('implementation.captured');
    expect(captured.work.currentState).toBe('AI_REVIEW');

    const reviewed = await engine.aiReview(work.id);
    expect(reviewed.work.currentState).toBe('HUMAN_CODE_REVIEW');

    // Approval must name the commit under review
    expect(() => engine.humanReview(work.id, 'tester', 'approve')).toThrow(/must name the commit/);
    const human = engine.humanReview(work.id, 'tester', 'approve', undefined, { commit: head.slice(0, 8) });
    expect(human.work.currentState).toBe('VERIFYING');

    const verified = await engine.verify(work.id);
    expect(verified.failed).toBe(false);
    expect(verified.work.currentState).toBe('HUMAN_ACCEPTANCE');

    expect(engine.gateDecision(work.id).blocking.map((b) => b.id)).toEqual(['obl_manual_sqa']);
    const accepted = engine.accept(
      work.id,
      'tester',
      {
        expected: 'Authorized approval works',
        actual: 'Authorized approval works',
        result: 'passed',
      },
      { commit: head },
    );
    expect(accepted.accepted).toBe(true);
    expect(accepted.work.currentState).toBe('ACCEPTED');

    // A bogus commit cannot be recorded
    expect(() => engine.markCommitChanged(work.id, 'deadbeefcafebabe')).toThrow(/not a commit/);

    // A new commit after acceptance → detected on sync, back to code review
    commitIn(wt, 'later.txt');
    const changed = (await engine.syncFromMarkdown(work.id)).work;
    expect(changed.currentState).toBe('AI_REVIEW');
    // Approval is refused until the AI review has run on the new commit
    await engine.syncFromMarkdown(work.id); // AI review → HUMAN_CODE_REVIEW
    expect(engine.ctx.store.getWork(work.id).currentState).toBe('HUMAN_CODE_REVIEW');
    const decisions = engine.ctx.store.listDecisions(work.id);
    expect(decisions.some((d) => d.gate === 'code-review' && d.invalidatedAt)).toBe(true);
    const invalidations = engine.ctx.store.listInvalidations(work.id);
    expect(invalidations.length).toBeGreaterThan(0);

    // Cannot invent success from AI narration — evidence freshness uses commit binding
    const shown = engine.contractShow(work.id);
    const staleish = shown.evaluated.obligations.filter((o) =>
      ['obl_code_review', 'obl_automated_checks', 'obl_manual_sqa'].includes(o.id),
    );
    expect(staleish.some((o) => o.derivedStatus === 'stale' || o.derivedStatus === 'unsatisfied')).toBe(
      true,
    );

    engine.ctx.store.close();
  });
});
