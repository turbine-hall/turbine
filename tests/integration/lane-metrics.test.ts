import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createId, type LaneMergeRecord } from '../../packages/contracts/dist/index.js';
import { computeLaneMetrics, evaluateSuspendWhen } from '../../apps/cli/src/engine/lane-metrics.js';
import {
  nextLaneAudit,
  recordLaneAuditOutcome,
  recordPolicyMerge,
  samplingDraw,
} from '../../apps/cli/src/engine/lane-audit.js';
import { isHumanOnlyCommand } from '../../apps/cli/src/engine/agent-guard.js';
import { cleanup } from './fixture.js';
import { ROUTINE_POLICY, laneEvents, laneProject, toRequirementsGate } from './lane-fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

const here = dirname(fileURLToPath(import.meta.url));
const factory = resolve(here, '../..');
const tsx = join(factory, 'node_modules', '.bin', 'tsx');
const cli = join(factory, 'apps', 'cli', 'src', 'index.ts');

function run(dir: string, args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, INIT_CWD: dir, PWD: dir };
  delete env.TURBINE_AGENT;
  delete env.CLAUDECODE;
  delete env.CURSOR_AGENT;
  return spawnSync(tsx, [cli, ...args], { cwd: dir, encoding: 'utf8', env, input: '' });
}

function markPolicyWork(engine: ReturnType<typeof laneProject>['engine'], workId: string) {
  const policy = engine.ctx.store.getLanePolicy('routine')!;
  engine.ctx.store.saveDecision({
    id: createId('dec'),
    workId,
    gate: 'requirements',
    action: 'approve',
    artifactIds: [],
    artifactHashes: [],
    workRevision: 0,
    actorId: 'policy:routine',
    actorType: 'policy',
    identityAssurance: 'local-attestation',
    policyId: 'routine',
    policyHash: policy.contentHash,
    policyApprovalDecisionId: policy.approvedDecisionId,
    evaluationHash: 'sha256:test',
    decidedAt: new Date().toISOString(),
  });
}

function merge(
  workId: string,
  overrides: Partial<LaneMergeRecord> = {},
) {
  const now = new Date().toISOString();
  return {
    id: createId('merge'),
    workId,
    policyId: 'routine',
    openedAt: now,
    mergeState: 'merged' as const,
    mergedAt: now,
    mergeSha: 'abc123',
    reverted: 'no' as const,
    fixRounds: 1,
    recordedAt: now,
    ...overrides,
  };
}

describe('autonomous lane metrics and audits (Part G)', () => {
  it('AC19 / FR-G1, FR-G2, FR-G6: reports all series and preserves unknown denominators', () => {
    const { engine } = laneProject(dirs);
    const known = engine.createTask({ title: 'Known merge', text: 'known', type: 'bug', labels: ['bug'] });
    const unknown = engine.createTask({ title: 'Unknown merge', text: 'unknown', type: 'bug', labels: ['bug'] });
    markPolicyWork(engine, known.id);
    markPolicyWork(engine, unknown.id);
    engine.ctx.store.saveLaneMergeRecord(merge(known.id, { costUsd: undefined }));
    engine.ctx.store.saveReviewerAgreement({
      workId: known.id,
      changeSetId: 'abc123',
      policyId: 'routine',
      policyHash: engine.ctx.store.getLanePolicy('routine')!.contentHash,
      lens: 'tests',
      reviewerProfiles: ['a', 'b'],
      blocking: [true, false],
      agreed: false,
    });
    engine.ctx.store.appendEvent({
      workId: unknown.id,
      type: 'lane.fallback',
      payload: { reasons: ['unknown merge evidence'], evaluations: [{ policy: 'routine' }] },
    });

    const report = computeLaneMetrics(engine.ctx.store, { policy: 'routine' });
    const row = report.rows[0]!;
    expect(row.tasks).toBe(2);
    expect(row.mergeRate).toMatchObject({ value: 'unknown', numerator: 1, denominator: 2, unknown: 1 });
    expect(row.revertRate).toMatchObject({ value: 0, denominator: 1, unknown: 0 });
    expect(row.costPerMergedPrUsd).toMatchObject({ value: 'unknown', denominator: 1, unknown: 1 });
    expect(row.reviewerDisagreementRate).toMatchObject({ value: 1, numerator: 1, denominator: 1 });
    expect(row.fallbackShare.reasons).toEqual({ 'unknown merge evidence': 1 });
    for (const value of [
      row.mergedPrsPerWeek,
      row.mergeRate,
      row.revertRate,
      row.fixRoundsPerMergedPr,
      row.costPerMergedPrUsd,
      row.reviewerDisagreementRate,
      row.fallbackShare,
    ]) {
      expect(value.period).toEqual(report.period);
      expect(typeof value.denominator).toBe('number');
    }
  });

  it('AC20 / FR-G3: sampling is reproducible, queued, and audit record is human-only', () => {
    const policy = ROUTINE_POLICY.replace(
      'gates: [requirements, plan, acceptance]',
      'sampling: { rate: 1 }\ngates: [requirements, plan, acceptance]',
    );
    const { dir, engine } = laneProject(dirs, { policy });
    const work = engine.createTask({ title: 'Sample me', text: 'sample', type: 'bug', labels: ['bug'] });
    const input = merge(work.id);
    const expected = samplingDraw(input);
    const recorded = recordPolicyMerge(engine.ctx.store, input);
    expect(recorded.merge.sampling).toEqual({ ...expected, rate: 1, selected: true });
    expect(recorded.audit).toMatchObject({ seed: expected.seed, draw: expected.draw, outcome: 'queued' });
    expect(nextLaneAudit(engine.ctx.store)?.id).toBe(recorded.audit?.id);
    expect(isHumanOnlyCommand(`pnpm turbine audit record ${recorded.audit!.id} --ok`)).toBe(true);

    engine.ctx.store.close();
    const denied = run(dir, ['audit', 'record', recorded.audit!.id, '--ok']);
    expect(denied.status).not.toBe(0);
    expect(`${denied.stdout}${denied.stderr}`).toMatch(/human decision|interactive terminal/i);
  });

  it('AC18 / FR-G4: audit threshold auto-suspends and the next eligible task falls back to humans', async () => {
    const policy = ROUTINE_POLICY.replace(
      'gates: [requirements, plan, acceptance]',
      [
        'sampling: { rate: 1 }',
        'suspendWhen:',
        '  auditProblems: { atLeast: 2, inLastAudits: 20 }',
        'gates: [requirements, plan, acceptance]',
      ].join('\n'),
    );
    const { engine } = laneProject(dirs, { policy });
    for (let i = 0; i < 2; i++) {
      const work = engine.createTask({ title: `Merged ${i}`, text: 'merge', type: 'bug', labels: ['bug'] });
      const sampled = recordPolicyMerge(engine.ctx.store, merge(work.id, { id: `merge-${i}`, mergeSha: `sha-${i}` }));
      recordLaneAuditOutcome(engine.ctx.store, {
        id: sampled.audit!.id,
        outcome: 'problem',
        note: `problem ${i}`,
        reviewer: 'Human Reviewer',
      });
    }
    expect(engine.ctx.store.getLanePolicy('routine')).toMatchObject({
      status: 'suspended',
      suspendedReason: expect.stringMatching(/Auto-suspended.*audit problems/i),
    });
    const next = await toRequirementsGate(engine, { title: 'Must go human' });
    await engine.syncFromMarkdown(next.id);
    expect(laneEvents(engine, next.id).at(-1)).toMatchObject({
      type: 'lane.fallback',
      payload: { reasons: expect.arrayContaining([expect.stringMatching(/policy routine is suspended/i)]) },
    });
  });

  it('FR-G4: known revert and disagreement thresholds use explicit evidence only', () => {
    const { engine } = laneProject(dirs);
    const work = engine.createTask({ title: 'Signals', text: 'signals', type: 'bug', labels: ['bug'] });
    markPolicyWork(engine, work.id);
    engine.ctx.store.saveLaneMergeRecord(merge(work.id, { reverted: 'yes', revertedAt: new Date().toISOString() }));
    expect(evaluateSuspendWhen(engine.ctx.store, 'routine')).toMatchObject({ suspended: true });
  });

  it('FR-G4: attributes failed review agreements without a policy approval decision', () => {
    const policy = ROUTINE_POLICY.replace(
      'gates: [requirements, plan, acceptance]',
      'suspendWhen:\n  reviewerDisagreement: { above: 0 }\ngates: [requirements, plan, acceptance]',
    );
    const { engine } = laneProject(dirs, { policy });
    const work = engine.createTask({ title: 'Review fallback', text: 'signals', type: 'bug', labels: ['bug'] });
    const approved = engine.ctx.store.getLanePolicy('routine')!;
    engine.ctx.store.saveReviewerAgreement({
      workId: work.id,
      changeSetId: 'failed-review',
      policyId: approved.name,
      policyHash: approved.contentHash,
      lens: 'tests',
      reviewerProfiles: ['review-primary', 'review-secondary'],
      blocking: [true, false],
      agreed: false,
    });

    expect(engine.ctx.store.listDecisions(work.id).filter((decision) => decision.actorType === 'policy')).toEqual([]);
    expect(computeLaneMetrics(engine.ctx.store, { policy: 'routine' }).rows[0]).toMatchObject({
      tasks: 1,
      reviewerDisagreementRate: { value: 1, numerator: 1, denominator: 1 },
    });
    expect(evaluateSuspendWhen(engine.ctx.store, 'routine')).toMatchObject({ suspended: true });
  });

  it('FR-G5: metrics --json emits the same machine-readable report including the human lane', () => {
    const { dir, engine } = laneProject(dirs);
    const work = engine.createTask({ title: 'Human task', text: 'human', type: 'bug', labels: [] });
    engine.ctx.store.saveLaneMergeRecord(merge(work.id, { policyId: null, costUsd: 3 }));
    engine.ctx.store.close();
    const result = run(dir, ['metrics', '--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as ReturnType<typeof computeLaneMetrics>;
    expect(json.rows.some((row) => row.lane === 'human' && row.mergeRate.denominator === 1)).toBe(true);
    expect(json.rows.every((row) => row.mergeRate.period.since === json.period.since)).toBe(true);
  });
});
