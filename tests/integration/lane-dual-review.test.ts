import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { contentHash, createId } from '../../packages/contracts/dist/index.js';
import type { ModelAdapter } from '../../packages/models/dist/index.js';
import { createMockModelAdapter, registerModel } from '../../packages/models/dist/index.js';
import { packetPaths } from '../../apps/cli/src/engine/packet.js';
import type { Engine } from '../../apps/cli/src/engine/engine.js';
import { changeSetId, collectDiffs, observe } from '../../apps/cli/src/engine/changeset.js';
import { cleanup, commitIn } from './fixture.js';
import {
  DUAL_ROUTINE_POLICY,
  approve,
  laneEvents,
  laneProject,
  toRequirementsGate,
  toCodeReview,
} from './lane-fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

function reviewer(id: string, output: 'clean' | 'blocking' | 'malformed' | 'malformed-finding'): ModelAdapter {
  return {
    id,
    provider: 'mock',
    capabilities: { text: true, structuredOutput: true, toolCalling: false },
    async run(request) {
      if (request.schemaId !== 'review') throw new Error(`unexpected schema ${request.schemaId}`);
      if (output === 'malformed') return { content: { summary: 'missing required fields' } };
      const file =
        request.prompt.match(/CHANGED FILES:\n((?: {2}\S+ .+\n?)+)/)?.[1]?.split('\n')[0]?.trim().split(/\s+/).slice(1).join(' ') ??
        'README.md';
      return {
        content: {
          findings:
            output === 'blocking'
              ? [{ severity: 'high', claim: `${id} found a blocking defect`, file }]
              : output === 'malformed-finding'
                ? [{}]
              : [],
          claims: { dependenciesAdded: [], testFilesChanged: [] },
          coverage: [],
          summary: `${id} review`,
        },
      };
    },
  };
}

function useReviewers(
  primary: 'clean' | 'blocking' | 'malformed' | 'malformed-finding',
  secondary: 'clean' | 'blocking' | 'malformed' | 'malformed-finding',
) {
  registerModel(reviewer('mock-review-primary', primary));
  registerModel(reviewer('mock-review-secondary', secondary));
}

async function reachAiReview(engine: Engine) {
  const initial = await toRequirementsGate(engine);
  for (let i = 0; i < 8; i++) {
    const work = engine.ctx.store.getWork(initial.id);
    if (work.currentState === 'AI_REVIEW') return work;
    if (work.currentState === 'IMPLEMENTING') {
      commitIn(engine.repoStates(work.id)[0]!.worktreePath, 'README.md', '# fixture fixed\n');
      const captured = engine.captureImplementation(work.id);
      if (captured.work.currentState === 'AI_REVIEW') return captured.work;
    }
    await engine.syncFromMarkdown(work.id);
  }
  throw new Error('task did not reach AI_REVIEW');
}

describe('autonomous dual review', () => {
  it('FR-B1: approval and evaluation reject missing or identical resolved reviewer models', async () => {
    const missing = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY, approved: false });
    delete missing.engine.ctx.config.models.profiles['review-secondary'];
    expect(() => approve(missing.engine, 'routine')).toThrow(/review-secondary.*not configured/);
    missing.engine.ctx.store.close();

    const identical = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY, approved: false });
    identical.engine.ctx.config.models.profiles['review-secondary'] = {
      provider: 'mock',
      model: 'mock-review-primary',
      maxOutputTokens: 3000,
    };
    expect(() => approve(identical.engine, 'routine')).toThrow(/same model/);
    identical.engine.ctx.store.close();

    const changed = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    changed.engine.ctx.config.models.profiles['review-secondary'] = {
      provider: 'mock',
      model: 'mock-review-primary',
      maxOutputTokens: 3000,
    };
    const work = await toCodeReview(changed.engine);
    expect(work.currentState).toBe('HUMAN_CODE_REVIEW');
    const reasons = laneEvents(changed.engine, work.id).at(-1)!.payload.reasons as string[];
    expect(reasons.join('\n')).toMatch(/same model/);
    changed.engine.ctx.store.close();
  }, 60_000);

  it('FR-B2/FR-B3/FR-B7: two clean reviewers run every lens on one change set and pass by policy', async () => {
    const { engine } = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    useReviewers('clean', 'clean');
    const work = await toCodeReview(engine);
    expect(work.currentState).toBe('VERIFYING');
    const decision = engine.ctx.store.listDecisions(work.id).find((entry) => entry.gate === 'code-review')!;
    expect(decision).toMatchObject({ actorType: 'policy', actorId: 'policy:routine' });
    expect(decision.rationale).toMatch(/^Passed by policy routine/);
    const reviews = engine.ctx.store
      .listArtifacts(work.id, 'review')
      .map((artifact) => JSON.parse(engine.ctx.store.getArtifactContent(artifact.id)))
      .filter((review) => review.reviewer);
    expect(reviews).toHaveLength(2);
    expect(new Set(reviews.map((review) => review.changeSetId))).toEqual(new Set([decision.commitSha]));
    expect(reviews.map((review) => review.lenses)).toEqual([
      ['spec-compliance', 'tests'],
      ['spec-compliance', 'tests'],
    ]);
    engine.ctx.store.close();
  }, 60_000);

  it('FR-B3: incomplete output fails closed to a human and never policy-passes', async () => {
    const { engine } = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    useReviewers('malformed', 'clean');
    const work = await toCodeReview(engine);
    expect(work.currentState).toBe('HUMAN_CODE_REVIEW');
    expect(engine.ctx.store.listDecisions(work.id).some((entry) => entry.gate === 'code-review')).toBe(false);
    const reasons = laneEvents(engine, work.id).at(-1)!.payload.reasons as string[];
    expect(reasons.join('\n')).toMatch(/incomplete or unparseable/);
    engine.ctx.store.close();
  }, 60_000);

  it('rejects malformed finding entries before counting a reviewer lens complete', async () => {
    const { engine } = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    useReviewers('malformed-finding', 'clean');
    const work = await toCodeReview(engine);
    expect(work.currentState).toBe('HUMAN_CODE_REVIEW');
    expect(engine.ctx.store.listDecisions(work.id).some((entry) => entry.gate === 'code-review')).toBe(false);
    const reasons = laneEvents(engine, work.id).at(-1)!.payload.reasons as string[];
    expect(reasons.join('\n')).toMatch(/incomplete or unparseable/);
    engine.ctx.store.close();
  }, 60_000);

  it('runs eligible dual review before the advisory analysis model', async () => {
    const { engine } = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    useReviewers('clean', 'clean');
    const pending = await reachAiReview(engine);
    engine.ctx.config.models.profiles.analysis = { provider: 'mock', model: 'failing-analysis' };
    const fallback = createMockModelAdapter('failing-analysis');
    registerModel({
      ...reviewer('failing-analysis', 'clean'),
      async run(request) {
        if (request.schemaId === 'review') throw new Error('advisory analysis must not run');
        return fallback.run(request);
      },
    });
    const work = (await engine.syncFromMarkdown(pending.id)).work;
    expect(work.currentState).toBe('VERIFYING');
    expect(engine.ctx.store.listDecisions(work.id).some((entry) => entry.gate === 'code-review')).toBe(true);
    engine.ctx.store.close();
  }, 60_000);

  it('hands budget-exhausted dual review to a human without another model call', async () => {
    const { engine } = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    useReviewers('clean', 'clean');
    const pending = await reachAiReview(engine);
    const before = engine.ctx.store.getBudget(pending.id).modelCalls;
    engine.ctx.config.budgets.perTask.maxModelCalls = before + 1;
    const result = await engine.syncFromMarkdown(pending.id);
    expect(result.action).toBe('review.human');
    expect(result.work.currentState).toBe('HUMAN_CODE_REVIEW');
    expect(engine.ctx.store.getBudget(pending.id).modelCalls).toBe(before + 1);
    expect(engine.ctx.store.listDecisions(pending.id).some((entry) => entry.gate === 'code-review')).toBe(false);
    expect(
      engine.ctx.store.listEvents(pending.id).some((entry) => entry.type === 'review.handed-off'),
    ).toBe(true);
    engine.ctx.store.close();
  }, 60_000);

  it('routes truncated dual-review diffs to a human without a policy pass', async () => {
    const roomyPolicy = DUAL_ROUTINE_POLICY.replace('maxChangedLines: 40', 'maxChangedLines: 100000');
    const { engine } = laneProject(dirs, { policy: roomyPolicy });
    useReviewers('clean', 'clean');
    const work = await toCodeReview(engine, { 'LARGE.txt': `marker\n${'x'.repeat(70_000)}\n` });
    expect(work.currentState).toBe('HUMAN_CODE_REVIEW');
    expect(engine.ctx.store.listDecisions(work.id).some((entry) => entry.gate === 'code-review')).toBe(false);
    const reasons = laneEvents(engine, work.id).at(-1)!.payload.reasons as string[];
    expect(reasons.join('\n')).toMatch(/truncated diff content/);
    engine.ctx.store.close();
  }, 60_000);

  it('pins collected review diffs to the recorded head instead of live HEAD', async () => {
    const { engine } = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    const pending = await reachAiReview(engine);
    const recorded = engine.repoStates(pending.id);
    commitIn(recorded[0]!.worktreePath, 'AFTER.md', 'must not enter recorded diff\n');
    const diff = collectDiffs(recorded);
    expect(diff.text).not.toContain('must not enter recorded diff');
    expect(diff.text).toContain('fixture fixed');
    engine.ctx.store.close();
  }, 60_000);

  it('does not publish dual results after the task revision changes during model calls', async () => {
    const { engine } = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    useReviewers('clean', 'clean');
    const pending = await reachAiReview(engine);
    engine.dualReviewBeforePublish = () => {
      const work = engine.ctx.store.getWork(pending.id);
      engine.ctx.store.saveWork({ ...work, currentRevision: work.currentRevision + 1 });
      engine.dualReviewBeforePublish = undefined;
    };
    const outcome = await engine.tryLanePass(pending.id);
    const autonomous = engine.ctx.store
      .listArtifacts(pending.id, 'review')
      .map((artifact) => JSON.parse(engine.ctx.store.getArtifactContent(artifact.id)))
      .filter((review) => review.reviewer);
    expect(autonomous).toHaveLength(0);
    expect(outcome?.status).toBe('retry');
    expect(engine.ctx.store.listDecisions(pending.id).some((entry) => entry.gate === 'code-review')).toBe(false);
    engine.ctx.store.close();
  }, 60_000);

  it('requires PR approval and rechecks reviewed heads before saving a code-review decision', async () => {
    const { engine } = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    useReviewers('clean', 'clean');
    engine.ctx.config.humanGates.requirePrApproval = true;
    engine.prApprovalChecker = () => ({ approved: false, detail: 'review still pending' });
    const work = await toCodeReview(engine);
    expect(work.currentState).toBe('HUMAN_CODE_REVIEW');
    expect(engine.ctx.store.listDecisions(work.id).some((entry) => entry.gate === 'code-review')).toBe(false);
    const reasons = laneEvents(engine, work.id).at(-1)!.payload.reasons as string[];
    expect(reasons.join('\n')).toContain('GitHub PR approval required');
    engine.ctx.store.close();

    const advancing = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    useReviewers('clean', 'clean');
    advancing.engine.ctx.config.humanGates.requirePrApproval = true;
    const pending = await reachAiReview(advancing.engine);
    const reviewedHead = advancing.engine.currentCommit(pending.id);
    let checks = 0;
    advancing.engine.prApprovalChecker = () => {
      checks++;
      if (checks === 1) {
        commitIn(advancing.engine.repoStates(pending.id)[0]!.worktreePath, 'PR-MOVED.md', 'advanced during PR lookup\n');
      }
      return { approved: true, detail: 'approved' };
    };
    const outcome = await advancing.engine.tryLanePass(pending.id);
    const decisions = advancing.engine.ctx.store.listDecisions(pending.id).filter((entry) => entry.gate === 'code-review');
    expect(outcome?.status).toBe('passed');
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(changeSetId(observe(advancing.engine.repoStates(pending.id)).repos)).not.toBe(reviewedHead);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.commitSha).toBe(changeSetId(observe(advancing.engine.repoStates(pending.id)).repos));
    advancing.engine.ctx.store.close();

    const dirty = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    useReviewers('clean', 'clean');
    dirty.engine.ctx.config.humanGates.requirePrApproval = true;
    const dirtyPending = await reachAiReview(dirty.engine);
    dirty.engine.prApprovalChecker = () => {
      writeFileSync(
        `${dirty.engine.repoStates(dirtyPending.id)[0]!.worktreePath}/DIRTY.md`,
        'uncommitted during PR lookup\n',
      );
      return { approved: true, detail: 'approved' };
    };
    const dirtyOutcome = await dirty.engine.tryLanePass(dirtyPending.id);
    expect(dirtyOutcome?.status).not.toBe('passed');
    expect(dirty.engine.uncommitted(dirtyPending.id)).not.toHaveLength(0);
    expect(
      dirty.engine.ctx.store.listDecisions(dirtyPending.id).filter((entry) => entry.gate === 'code-review'),
    ).toHaveLength(0);
    dirty.engine.ctx.store.close();
  }, 60_000);

  it('refreshes recorded heads before the early AI_REVIEW lane pass', async () => {
    const { engine } = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    useReviewers('clean', 'clean');
    const pending = await reachAiReview(engine);
    commitIn(engine.repoStates(pending.id)[0]!.worktreePath, 'LATE.md', 'captured before early lane review\n');
    const result = await engine.syncFromMarkdown(pending.id);
    const decision = engine.ctx.store.listDecisions(pending.id).find((entry) => entry.gate === 'code-review')!;
    expect(result.work.currentState).toBe('VERIFYING');
    expect(decision.commitSha).toBe(engine.currentCommit(pending.id));
    engine.ctx.store.close();
  }, 60_000);

  it('binds the policy decision to the exact evaluated review pair', async () => {
    const { engine } = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    useReviewers('clean', 'clean');
    const pending = await reachAiReview(engine);
    engine.laneBeforeSave = () => {
      const event = engine.ctx.store.listEvents(pending.id).find((entry) => entry.type === 'review.dual-completed')!;
      for (const originalId of event.payload.artifacts as string[]) {
        const original = engine.ctx.store.listArtifacts(pending.id, 'review').find((entry) => entry.id === originalId)!;
        const body = engine.ctx.store.getArtifactContent(original.id);
        engine.ctx.store.saveArtifact(
          {
            ...original,
            id: createId('art'),
            revision: original.revision + 1,
            contentHash: contentHash(body),
            createdAt: new Date(Date.now() + 1_000).toISOString(),
          },
          body,
        );
      }
      engine.laneBeforeSave = undefined;
    };
    const work = (await engine.syncFromMarkdown(pending.id)).work;
    const event = engine.ctx.store.listEvents(work.id).find((entry) => entry.type === 'review.dual-completed')!;
    const decision = engine.ctx.store.listDecisions(work.id).find((entry) => entry.gate === 'code-review')!;
    expect(decision.artifactIds).toEqual(event.payload.artifacts);
    engine.ctx.store.close();
  }, 60_000);

  it('rejects inherited reviewer profile names and provider/model registry collisions', async () => {
    const inherited = laneProject(dirs, {
      policy: DUAL_ROUTINE_POLICY.replace('review-secondary]', 'constructor]'),
      approved: false,
    });
    expect(() => approve(inherited.engine, 'routine')).toThrow(/constructor.*not configured/);
    inherited.engine.ctx.store.close();

    const collision = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    collision.engine.ctx.config.models.profiles['review-secondary'] = {
      provider: 'openai',
      model: 'mock-review-primary',
      maxOutputTokens: 3000,
    };
    useReviewers('clean', 'clean');
    const work = await toCodeReview(collision.engine);
    expect(work.currentState).toBe('HUMAN_CODE_REVIEW');
    const reasons = laneEvents(collision.engine, work.id).at(-1)!.payload.reasons as string[];
    expect(reasons.join('\n')).toMatch(/requires provider openai.*resolved to mock/);
    collision.engine.ctx.store.close();
  }, 60_000);

  it('FR-B4: disagreement stays human and renders both reviewers side by side', async () => {
    const { dir, engine } = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    useReviewers('clean', 'blocking');
    const work = await toCodeReview(engine);
    expect(work.currentState).toBe('HUMAN_CODE_REVIEW');
    const packet = readFileSync(packetPaths(dir, work.id).review, 'utf8');
    expect(packet).toContain('| Reviewer 1 | Reviewer 2 |');
    expect(packet).toContain('review-primary');
    expect(packet).toContain('review-secondary');
    expect(packet).toContain('Needs attention');
    engine.ctx.store.close();
  }, 60_000);

  it('FR-B5: a new commit stales both reviews and requires both again', async () => {
    const { engine } = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    useReviewers('clean', 'clean');
    let work = await toCodeReview(engine);
    const firstCommit = engine.currentCommit(work.id)!;
    const worktree = engine.repoStates(work.id)[0]!.worktreePath;
    commitIn(worktree, 'SECOND.md', 'second commit\n');
    const changed = await engine.syncFromMarkdown(work.id);
    work = changed.work;
    expect(work.currentState).toBe('VERIFYING');
    const decisions = engine.ctx.store.listDecisions(work.id).filter((entry) => entry.gate === 'code-review' && !entry.invalidatedAt);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.commitSha).not.toBe(firstCommit);
    const evidence = engine.ctx.store.listEvidence(work.id).filter((entry) => entry.kind === 'review' && entry.reviewerId);
    expect(new Set(evidence.map((entry) => entry.commitSha)).size).toBe(2);
    engine.ctx.store.close();
  }, 60_000);

  it('FR-B6: completed dual review records reviewer agreement per lens', async () => {
    const { engine } = laneProject(dirs, { policy: DUAL_ROUTINE_POLICY });
    useReviewers('clean', 'clean');
    const work = await toCodeReview(engine);
    const agreements = engine.ctx.store.listReviewerAgreements(work.id, engine.currentCommit(work.id)!);
    expect(agreements.map((entry) => entry.lens)).toEqual(['spec-compliance', 'tests']);
    expect(agreements.every((entry) => entry.agreed && entry.blocking.every((value) => value === false))).toBe(true);
    engine.ctx.store.close();
  }, 60_000);
});
