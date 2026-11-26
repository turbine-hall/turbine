import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../apps/cli/src/engine/engine.js';
import { packetPaths } from '../../apps/cli/src/engine/packet.js';
import { cleanup, git, makeRepo } from './fixture.js';
import { ROUTINE_POLICY, laneEvents, laneProject, toCodeReview, toRequirementsGate } from './lane-fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

const policyDecisions = (engine: Engine, workId: string) =>
  engine.ctx.store.listDecisions(workId).filter((d) => d.actorType === 'policy');
const lastReasons = (engine: Engine, workId: string) => (laneEvents(engine, workId).at(-1)?.payload.reasons ?? []) as string[];

/** Human code review, then a human puts the task back in the lane. */
function humanReviewAndRetry(engine: Engine, workId: string) {
  const pending = engine.pendingApproval(workId);
  engine.decide(workId, { action: 'approve', reviewer: 'Rae', confirmToken: pending.confirmToken, presence: 'test' });
  engine.laneRetry(workId, { actor: 'Rae', confirmToken: engine.pendingLaneRetry(workId).confirmToken, presence: 'test' });
}

describe('policy passes (FR-A6, FR-A11, AC4)', () => {
  it('eligible task passes by policy', async () => {
    const { dir, engine } = laneProject(dirs);
    const approval = engine.ctx.store.getLanePolicy('routine')!;
    const work = await toRequirementsGate(engine);

    const req = await engine.syncFromMarkdown(work.id);
    expect(req.action).toBe('lane.passed');
    expect(req.work.currentState).toBe('REQUIREMENTS_APPROVED');
    const plan = await engine.syncFromMarkdown(work.id);
    expect(plan.action).toBe('lane.passed');
    expect(plan.work.currentState).toBe('PLAN_APPROVED');

    const decisions = policyDecisions(engine, work.id);
    expect(decisions.map((d) => d.gate).sort()).toEqual(['plan', 'requirements']);
    for (const d of decisions) {
      expect(d).toMatchObject({
        actorType: 'policy',
        actorId: 'policy:routine',
        policyId: 'routine',
        policyHash: approval.contentHash,
        policyApprovalDecisionId: approval.approvedDecisionId,
      });
      expect(d.evaluationHash).toMatch(/^sha256:/);
    }
    // No human decision was invented on the way.
    expect(engine.ctx.store.listDecisions(work.id).filter((d) => d.actorType === 'human')).toHaveLength(0);
    // The evidence contract counts the policy decisions as the gate approvals.
    const shown = engine.contractShow(work.id).evaluated.obligations;
    expect(shown.find((o) => o.id === 'obl_requirements_approval')!.derivedStatus).toBe('satisfied');
    expect(shown.find((o) => o.id === 'obl_plan_approval')!.derivedStatus).toBe('satisfied');

    // Packet wording: "Passed by policy", never "approved".
    const today = new Date().toISOString().slice(0, 10);
    const spec = readFileSync(packetPaths(dir, work.id).spec, 'utf8');
    const decisionsSection = spec.slice(spec.indexOf('## Decisions'));
    expect(decisionsSection).toContain(`Passed by policy \`routine\` (approved by \`Ana\` on \`${today}\`)`);
    expect(decisionsSection).toContain('PASSED BY POLICY');
    expect(decisionsSection).not.toContain('**APPROVED**');
    engine.ctx.store.close();
  });

  it('acceptance needs FULL P0 traceability: PARTIAL goes to a human (FR-A7)', async () => {
    const { engine } = laneProject(dirs);
    const work = await toCodeReview(engine); // no test changed → no verified test link
    humanReviewAndRetry(engine, work.id);
    const partial = await engine.syncFromMarkdown(work.id); // verify → HUMAN_ACCEPTANCE
    expect(partial.work.currentState).toBe('HUMAN_ACCEPTANCE');
    expect(lastReasons(engine, work.id).join('\n')).toMatch(/FR-001 \(PARTIAL\)/);
    expect(policyDecisions(engine, work.id).some((d) => d.gate === 'sqa-acceptance')).toBe(false);
    engine.ctx.store.close();
  }, 60_000);

  it('acceptance passes by policy with FULL P0 traceability and every check passed at the current commit (FR-A7)', async () => {
    const { dir, engine } = laneProject(dirs);
    const work = await toCodeReview(engine, { 'README.md': '# fixture fixed\n', 'test/readme.test.mjs': "import test from 'node:test';\ntest('readme', () => {});\n" });
    expect(work.currentState).toBe('HUMAN_CODE_REVIEW');
    humanReviewAndRetry(engine, work.id);
    expect(engine.traceFor(work.id).find((r) => r.requirementId === 'FR-001')!.tests).toEqual(['test/readme.test.mjs']);
    const full = await engine.syncFromMarkdown(work.id); // verify → HUMAN_ACCEPTANCE → policy
    expect(full.action).toBe('lane.passed');
    expect(full.work.currentState).toBe('ACCEPTED');
    const sqa = policyDecisions(engine, work.id).find((d) => d.gate === 'sqa-acceptance')!;
    expect(sqa.commitSha).toBeTruthy();
    expect(engine.gateDecision(work.id).blocking).toEqual([]);
    // The human SQA evidence was not faked.
    expect(engine.ctx.store.listEvidence(work.id).some((e) => e.kind === 'manual-sqa')).toBe(false);
    const review = readFileSync(packetPaths(dir, work.id).review, 'utf8');
    expect(review).toContain('Passed by policy `routine`');
    engine.ctx.store.close();
  }, 60_000);

  it('acceptance by policy still needs the GitHub PR approval when humanGates.requirePrApproval is on', async () => {
    const { engine } = laneProject(dirs);
    engine.ctx.config.humanGates.requirePrApproval = true;
    let prApproved = true;
    engine.prApprovalChecker = () => ({ approved: prApproved, detail: prApproved ? 'approved' : 'no approving review at head' });
    const work = await toCodeReview(engine, { 'README.md': '# fixture fixed\n', 'test/readme.test.mjs': "import test from 'node:test';\ntest('readme', () => {});\n" });
    humanReviewAndRetry(engine, work.id);
    prApproved = false;
    const res = await engine.syncFromMarkdown(work.id);
    expect(res.work.currentState).toBe('HUMAN_ACCEPTANCE');
    expect(lastReasons(engine, work.id).join('\n')).toMatch(/GitHub PR approval required/);
    expect(policyDecisions(engine, work.id).some((d) => d.gate === 'sqa-acceptance')).toBe(false);
    engine.ctx.store.close();
  }, 60_000);
});

describe('code review policy opt-in', () => {
  it('codeReview stays human when the policy does not list the gate', async () => {
    const { dir, engine } = laneProject(dirs);
    const work = await toCodeReview(engine);
    expect(work.currentState).toBe('HUMAN_CODE_REVIEW');
    expect(engine.ctx.store.listDecisions(work.id).some((d) => d.gate === 'code-review')).toBe(false);
    expect(lastReasons(engine, work.id).join('\n')).toMatch(/does not list the codeReview gate/);
    const status = readFileSync(packetPaths(dir, work.id).status, 'utf8');
    expect(status).toContain('## Autonomous lane: a human decides');
    expect(status).toMatch(/does not list the codeReview gate/);
    expect(status).toContain(`turbine task lane ${work.id} --retry`);
    engine.ctx.store.close();
  }, 60_000);
});

describe('fallback (FR-A8)', () => {
  it('fallback is one-way until lane --retry', async () => {
    const { engine } = laneProject(dirs);
    const work = await toRequirementsGate(engine, { labels: [] }); // no label → not eligible
    await engine.syncFromMarkdown(work.id);
    expect(engine.laneState(work.id).inLane).toBe(false);
    const fallbacks = () => laneEvents(engine, work.id).filter((e) => e.type === 'lane.fallback').length;
    expect(fallbacks()).toBe(1);

    // More syncs neither re-enter the lane nor re-evaluate.
    const again = await engine.syncFromMarkdown(work.id);
    expect((again.detail as { lane: { status: string } }).lane.status).toBe('out-of-lane');
    expect(fallbacks()).toBe(1);

    // Only a human retry (with the fallback's code) puts it back; the next sync evaluates again.
    expect(() => engine.laneRetry(work.id, { actor: 'Rae', confirmToken: 'wrong', presence: 'test' })).toThrow(/does not match/);
    engine.laneRetry(work.id, { actor: 'Rae', confirmToken: engine.pendingLaneRetry(work.id).confirmToken, presence: 'test' });
    expect(engine.laneState(work.id).inLane).toBe(true);
    await engine.syncFromMarkdown(work.id);
    expect(fallbacks()).toBe(2);
    expect(() => engine.pendingLaneRetry(engine.ctx.store.getWork(work.id).id)).not.toThrow();
    engine.ctx.store.close();
  });
});

describe('each fallback reason is shown (FR-A5, AC5)', () => {
  it('risk raised above the policy maximum', async () => {
    const { engine } = laneProject(dirs, { policy: ROUTINE_POLICY.replace('maxRiskProfile: standard', 'maxRiskProfile: lightweight') });
    const work = await toRequirementsGate(engine);
    engine.raiseRisk(work.id, 'standard', 'touches a shared module');
    const res = await engine.syncFromMarkdown(work.id);
    expect(res.work.currentState).toBe('REQUIREMENTS_REVIEW');
    expect(lastReasons(engine, work.id).join('\n')).toMatch(/risk profile standard is above the policy maximum lightweight/);
    engine.ctx.store.close();
  });

  it('a source label the policy does not allow', async () => {
    const { engine } = laneProject(dirs);
    const work = await toRequirementsGate(engine, { labels: ['feature'] });
    await engine.syncFromMarkdown(work.id);
    expect(lastReasons(engine, work.id).join('\n')).toMatch(/source labels \(feature\) is allowed/);
    engine.ctx.store.close();
  });

  it('a second repository', async () => {
    const { engine } = laneProject(dirs);
    const work = await toRequirementsGate(engine);
    engine.addRepository(work.id, { path: makeRepo('turbine-lane-extra-', dirs), name: 'backend', checks: ['node lint.mjs'] });
    const res = await engine.syncFromMarkdown(work.id);
    expect(res.work.currentState).toBe('REQUIREMENTS_REVIEW');
    expect(lastReasons(engine, work.id).join('\n')).toMatch(/changes 2 repositories; the policy allows 1/);
    engine.ctx.store.close();
  });

  it('a new dependency in the diff', async () => {
    const { engine } = laneProject(dirs);
    const work = await toCodeReview(engine, { 'package.json': JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.3.0' } }, null, 2) });
    const reasons = lastReasons(engine, work.id).join('\n');
    expect(reasons).toMatch(/dependency changes are not allowed: .*left-pad/);
    expect(reasons).toMatch(/denied risk trigger\(s\) present: .*new-dependency/);
    engine.ctx.store.close();
  }, 60_000);

  it('a denied path', async () => {
    const { engine } = laneProject(dirs);
    const work = await toCodeReview(engine, { '.github/workflows/ci.yml': 'on: push\n' });
    expect(lastReasons(engine, work.id).join('\n')).toMatch(/denied path\(s\) changed: \.github\/workflows\/ci\.yml/);
    engine.ctx.store.close();
  }, 60_000);

  it('a diff over the limit', async () => {
    const { engine } = laneProject(dirs);
    const big = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const work = await toCodeReview(engine, { 'docs/big.md': big });
    expect(lastReasons(engine, work.id).join('\n')).toMatch(/diff has \d+ changed lines; the policy allows 40/);
    engine.ctx.store.close();
  }, 60_000);
});

describe('one commit per evaluation (FR-A5, AC6)', () => {
  it('head moved during evaluation', async () => {
    const { dir, engine } = laneProject(dirs);
    const work = await toRequirementsGate(engine);
    let moves = 0;
    engine.laneBeforeSave = () => {
      if (moves++ === 0) git(dir, 'commit', '-q', '--allow-empty', '-m', 'moved during evaluation');
    };
    const res = await engine.syncFromMarkdown(work.id);
    // The first evaluation was discarded; the retry at the new HEAD passed.
    const discarded = laneEvents(engine, work.id).filter((e) => e.type === 'lane.discarded');
    expect(discarded).toHaveLength(1);
    expect(String(discarded[0]!.payload.reason)).toMatch(/HEAD moved/);
    expect(res.work.currentState).toBe('REQUIREMENTS_APPROVED');
    expect(policyDecisions(engine, work.id)).toHaveLength(1);
    engine.ctx.store.close();
  });

  it('when HEAD keeps moving nothing is saved and the task stays in the lane for the next sync', async () => {
    const { dir, engine } = laneProject(dirs);
    const work = await toRequirementsGate(engine);
    engine.laneBeforeSave = () => git(dir, 'commit', '-q', '--allow-empty', '-m', 'moving');
    const res = await engine.syncFromMarkdown(work.id);
    expect(res.work.currentState).toBe('REQUIREMENTS_REVIEW');
    expect((res.detail as { lane: { status: string } }).lane.status).toBe('retry');
    expect(engine.ctx.store.listDecisions(work.id)).toHaveLength(0);
    expect(engine.laneState(work.id).inLane).toBe(true);
    engine.laneBeforeSave = undefined;
    const next = await engine.syncFromMarkdown(work.id);
    expect(next.work.currentState).toBe('REQUIREMENTS_APPROVED');
    engine.ctx.store.close();
  });

  it('discards the pass when risk rises after evaluation (revision may be unchanged)', async () => {
    const { engine } = laneProject(dirs, {
      policy: ROUTINE_POLICY.replace('maxRiskProfile: standard', 'maxRiskProfile: lightweight'),
    });
    const work = await toRequirementsGate(engine);
    expect(engine.ctx.store.getWork(work.id).risk.profile).toBe('lightweight');
    engine.laneBeforeSave = () => {
      engine.raiseRisk(work.id, 'standard', 'raised mid-evaluation');
    };
    const res = await engine.syncFromMarkdown(work.id);
    expect(res.work.currentState).toBe('REQUIREMENTS_REVIEW');
    expect(policyDecisions(engine, work.id)).toHaveLength(0);
    const discarded = laneEvents(engine, work.id).filter((e) => e.type === 'lane.discarded');
    expect(discarded.some((e) => String(e.payload.reason).includes('risk changed'))).toBe(true);
    expect(lastReasons(engine, work.id).join('\n')).toMatch(/risk profile standard is above the policy maximum lightweight/);
    engine.ctx.store.close();
  });

  it('does not save a policy pass after a concurrent lane.fallback', async () => {
    const { engine } = laneProject(dirs);
    const work = await toRequirementsGate(engine);
    engine.laneBeforeSave = () => {
      engine.ctx.store.appendEvent({
        workId: work.id,
        type: 'lane.fallback',
        payload: {
          gate: 'requirements',
          reasons: ['injected concurrent fallback'],
          evaluationHash: 'sha256:deadbeefdeadbeef',
        },
      });
    };
    const res = await engine.syncFromMarkdown(work.id);
    expect(policyDecisions(engine, work.id)).toHaveLength(0);
    expect(res.work.currentState).toBe('REQUIREMENTS_REVIEW');
    expect(engine.laneState(work.id).inLane).toBe(false);
    expect((res.detail as { lane: { status: string } }).lane.status).toBe('out-of-lane');
    engine.ctx.store.close();
  });

  it('discards the pass when risk.reasons gain a denied trigger without a profile change', async () => {
    const { engine } = laneProject(dirs);
    const work = await toRequirementsGate(engine);
    engine.laneBeforeSave = () => {
      const cur = engine.ctx.store.getWork(work.id);
      engine.ctx.store.saveWork({
        ...cur,
        risk: { ...cur.risk, reasons: [...cur.risk.reasons, 'new-dependency'] },
        updatedAt: new Date().toISOString(),
      });
    };
    const res = await engine.syncFromMarkdown(work.id);
    expect(policyDecisions(engine, work.id)).toHaveLength(0);
    expect(res.work.currentState).toBe('REQUIREMENTS_REVIEW');
    const discarded = laneEvents(engine, work.id).filter((e) => e.type === 'lane.discarded');
    expect(discarded.some((e) => String(e.payload.reason).includes('risk triggers changed'))).toBe(true);
    expect(lastReasons(engine, work.id).join('\n')).toMatch(/new-dependency/);
    engine.ctx.store.close();
  });
});
