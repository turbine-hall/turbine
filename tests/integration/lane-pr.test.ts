import { afterEach, describe, expect, it } from 'vitest';
import { confirmMergeQueueProtection, ensureAcceptedPr, refreshLanePr } from '../../apps/cli/src/engine/lane-pr.js';
import { cleanup, git } from './fixture.js';
import { laneProject, ROUTINE_POLICY } from './lane-fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

describe('Part C PR automation', () => {
  it('AC11 / FR-C1–C3: ACCEPTED creates and records a PR, publishes exact-SHA gate status, and queues auto-merge', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Automate PR', text: 'Create the accepted task PR.' });
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const policy = engine.ctx.store.getLanePolicy('routine')!;

    const record = await ensureAcceptedPr({
      store: engine.ctx.store,
      work,
      headSha,
      target: engine.lanePrTarget!,
      tools: engine.ctx.config.tools,
      policy,
      gatePassSha: headSha,
    });

    expect(engine.ctx.store.getLanePrRecord(work.id)).toMatchObject({
      number: 1,
      headSha,
      gateState: 'success',
      queueState: 'queued',
      headBranch: `turbine/${work.id}`,
    });
    expect(github.statuses?.[`fixture/project@${headSha}`]?.at(-1)).toMatchObject({
      context: 'turbine/gate',
      state: 'success',
    });
    expect(github.pullRequests?.['fixture/project']?.[0]).toMatchObject({
      number: record.number,
      mergeQueueState: 'queued',
      state: 'open',
    });
    engine.ctx.store.close();
  });

  it('AC11 / FR-C2: a new head resets turbine/gate instead of reusing an old PASS', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Reset status', text: 'Reset status after a push.' });
    const oldSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const policy = engine.ctx.store.getLanePolicy('routine')!;
    await ensureAcceptedPr({
      store: engine.ctx.store,
      work,
      headSha: oldSha,
      target: engine.lanePrTarget!,
      tools: engine.ctx.config.tools,
      policy,
      gatePassSha: oldSha,
    });
    const newSha = `${oldSha.startsWith('a') ? 'b' : 'a'}${oldSha.slice(1)}`;
    await ensureAcceptedPr({
      store: engine.ctx.store,
      work,
      headSha: newSha,
      target: engine.lanePrTarget!,
      tools: engine.ctx.config.tools,
      policy,
    });
    expect(engine.ctx.store.getLanePrRecord(work.id)).toMatchObject({ headSha: newSha, gateState: 'pending', queueState: 'not-enabled' });
    expect(github.statuses?.[`fixture/project@${newSha}`]?.at(-1)).toMatchObject({ context: 'turbine/gate', state: 'pending' });
    engine.ctx.store.close();
  });

  it('AC12 / FR-C4: missing or unreadable merge-queue protection is unknown', async () => {
    const { engine, github } = laneProject(dirs);
    github.protections!['fixture/project:main'] = { error: 'rulesets forbidden' };
    const result = await confirmMergeQueueProtection(engine.lanePrTarget!, 'work_fixture');
    expect(result).toMatchObject({ status: 'unknown', mergeQueueRequired: false, turbineGateRequired: false });
    expect(result.reason).toContain('rulesets forbidden');
    engine.ctx.store.close();
  });

  it('AC13 / FR-C5: project tools.allow alone cannot grant lane PR creation or merging', async () => {
    const policyWithoutTools = ROUTINE_POLICY.replace('tools: [pr.create, pr.merge]\n', '');
    const { dir, engine } = laneProject(dirs, { policy: policyWithoutTools });
    const work = engine.createTask({ title: 'No policy grant', text: 'Config alone is insufficient.' });
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    await expect(
      ensureAcceptedPr({
        store: engine.ctx.store,
        work,
        headSha,
        target: engine.lanePrTarget!,
        tools: engine.ctx.config.tools,
        policy: engine.ctx.store.getLanePolicy('routine')!,
        gatePassSha: headSha,
      }),
    ).rejects.toThrow(/does not grant pr.create/);
    expect(engine.ctx.store.getLanePrRecord(work.id)).toBeUndefined();
    engine.ctx.store.close();
  });

  it('FR-C6: merge-queue ejection moves ACCEPTED to CHANGES_REQUESTED and counts a fix round', async () => {
    const { engine, github } = laneProject(dirs);
    const created = engine.createTask({ title: 'Ejected PR', text: 'Handle queue ejection.' });
    const work = { ...created, currentState: 'ACCEPTED' as const };
    engine.ctx.store.saveWork(work);
    const timestamp = new Date().toISOString();
    engine.ctx.store.saveLanePrRecord({
      workId: work.id,
      owner: 'fixture',
      repo: 'project',
      number: 7,
      nodeId: 'PR_7',
      url: 'https://github.com/fixture/project/pull/7',
      baseBranch: 'main',
      headBranch: `turbine/${work.id}`,
      headSha: 'abcdef1234567890',
      gateState: 'success',
      queueState: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    github.pullRequests!['fixture/project'] = [{
      number: 7,
      nodeId: 'PR_7',
      url: 'https://github.com/fixture/project/pull/7',
      head: `turbine/${work.id}`,
      headSha: 'abcdef1234567890',
      base: 'main',
      state: 'open',
      mergeQueueState: 'ejected',
      queueReason: 'required check failed',
    }];
    const result = await engine.refreshLanePullRequest(work.id);
    expect(result.work.currentState).toBe('CHANGES_REQUESTED');
    expect(result.fixRound).toBe(1);
    expect(engine.ctx.store.listEvents(work.id).find((event) => event.type === 'lane.queue-ejected')?.payload).toMatchObject({
      reason: 'required check failed',
      fixRound: 1,
    });
    engine.ctx.store.close();
  });

  it('FR-C7: a merged PR writes its merge SHA and time to the Part G store', async () => {
    const { engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Merged PR', text: 'Record merge facts.' });
    const timestamp = new Date().toISOString();
    engine.ctx.store.saveLanePrRecord({
      workId: work.id,
      owner: 'fixture',
      repo: 'project',
      number: 8,
      nodeId: 'PR_8',
      url: 'https://github.com/fixture/project/pull/8',
      baseBranch: 'main',
      headBranch: `turbine/${work.id}`,
      headSha: 'abcdef1234567890',
      gateState: 'success',
      queueState: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    github.pullRequests!['fixture/project'] = [{
      number: 8,
      nodeId: 'PR_8',
      url: 'https://github.com/fixture/project/pull/8',
      head: `turbine/${work.id}`,
      headSha: 'abcdef1234567890',
      base: 'main',
      state: 'merged',
      mergedAt: timestamp,
      mergeSha: 'fedcba9876543210',
    }];
    const result = await refreshLanePr({
      store: engine.ctx.store,
      workId: work.id,
      target: engine.lanePrTarget!,
      policy: engine.ctx.store.getLanePolicy('routine')!,
    });
    expect(result.kind).toBe('merged');
    expect(engine.ctx.store.listLaneMergeRecords().at(-1)).toMatchObject({
      workId: work.id,
      mergeState: 'merged',
      mergedAt: timestamp,
      mergeSha: 'fedcba9876543210',
    });
    engine.ctx.store.close();
  });
});
