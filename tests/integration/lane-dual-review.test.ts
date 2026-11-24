import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelAdapter } from '../../packages/models/dist/index.js';
import { registerModel } from '../../packages/models/dist/index.js';
import { packetPaths } from '../../apps/cli/src/engine/packet.js';
import { cleanup, commitIn } from './fixture.js';
import {
  DUAL_ROUTINE_POLICY,
  approve,
  laneEvents,
  laneProject,
  toCodeReview,
} from './lane-fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

function reviewer(id: string, output: 'clean' | 'blocking' | 'malformed'): ModelAdapter {
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
              : [],
          claims: { dependenciesAdded: [], testFilesChanged: [] },
          coverage: [],
          summary: `${id} review`,
        },
      };
    },
  };
}

function useReviewers(primary: 'clean' | 'blocking' | 'malformed', secondary: 'clean' | 'blocking' | 'malformed') {
  registerModel(reviewer('mock-review-primary', primary));
  registerModel(reviewer('mock-review-secondary', secondary));
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
    expect(changed.work.currentState).toBe('AI_REVIEW');
    work = (await engine.syncFromMarkdown(work.id)).work;
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
