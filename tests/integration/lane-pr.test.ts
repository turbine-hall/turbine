import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitHubAdapter } from '../../packages/adapter-github/dist/index.js';
import { confirmMergeQueueProtection, ensureAcceptedPr, landingIncomplete, pendingMergeEvaluation, refreshLanePr } from '../../apps/cli/src/engine/lane-pr.js';
import { evaluateLaneEligibility, type LaneFacts } from '../../apps/cli/src/engine/lane-eligibility.js';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { suspendPolicy } from '../../apps/cli/src/engine/lane-policy.js';
import { cleanup, commitIn, git } from './fixture.js';
import { acceptByHuman, approve, laneProject, ROUTINE_POLICY, toCodeReview, writePolicy } from './lane-fixture.js';

const dirs: string[] = [];
const AUTH = 'dec_auth_1';
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup(dirs);
});

describe('Part C PR automation', () => {
  it('AC11 / FR-C1–C3: ACCEPTED creates and records a PR, publishes exact-SHA gate status, and queues auto-merge', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Automate PR', text: 'Create the accepted task PR.' });
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const policy = engine.ctx.store.getLanePolicy('routine')!;

    const record = await ensureAcceptedPr({ authorizationId: AUTH,
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
    await ensureAcceptedPr({ authorizationId: AUTH,
      store: engine.ctx.store,
      work,
      headSha: oldSha,
      target: engine.lanePrTarget!,
      tools: engine.ctx.config.tools,
      policy,
      gatePassSha: oldSha,
    });
    const newSha = `${oldSha.startsWith('a') ? 'b' : 'a'}${oldSha.slice(1)}`;
    // The remote branch has caught up with the new commit.
    github.pullRequests!['fixture/project']![0]!.headSha = newSha;
    await ensureAcceptedPr({ authorizationId: AUTH,
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
      ensureAcceptedPr({ authorizationId: AUTH,
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
      queueRemovalId: 'rm_1',
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

  const policyNow = (engine: ReturnType<typeof laneProject>['engine']) => engine.ctx.store.getLanePolicy('routine')!;
  const prRecord = (workId: string, number: number, extra: Record<string, unknown> = {}) => {
    const timestamp = new Date().toISOString();
    return {
      workId,
      owner: 'fixture',
      repo: 'project',
      number,
      nodeId: `PR_${number}`,
      url: `https://github.com/fixture/project/pull/${number}`,
      baseBranch: 'main',
      headBranch: `turbine/${workId}`,
      headSha: 'abcdef1234567890',
      gateState: 'success' as const,
      queueState: 'queued' as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...extra,
    };
  };
  const fixturePr = (workId: string, number: number, extra: Record<string, unknown> = {}) => ({
    number,
    nodeId: `PR_${number}`,
    url: `https://github.com/fixture/project/pull/${number}`,
    head: `turbine/${workId}`,
    headSha: 'abcdef1234567890',
    base: 'main',
    state: 'open' as const,
    ...extra,
  });

  it('FR-C1 queue: a second acceptance before the drain does not replace the first PR job', async () => {
    const { engine, github } = laneProject(dirs, { approved: false });
    const first = await acceptByHuman(engine, 'First accepted');
    const second = await acceptByHuman(engine, 'Second accepted');
    await engine.waitForLanePr();
    expect(engine.ctx.store.getLanePrRecord(first.work.id)).toMatchObject({ headSha: first.head });
    expect(engine.ctx.store.getLanePrRecord(second.work.id)).toMatchObject({ headSha: second.head });
    expect(github.pullRequests?.['fixture/project']).toHaveLength(2);
    engine.ctx.store.close();
  }, 120_000);

  it('FR-C2 reuse: a PR closed without merging is replaced, not reused', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Closed PR', text: 'Replace a closed PR.' });
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const input = { authorizationId: AUTH, store: engine.ctx.store, work, headSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy: policyNow(engine) };
    const first = await ensureAcceptedPr(input);
    github.pullRequests!['fixture/project']![0]!.state = 'closed';
    const replacement = await ensureAcceptedPr({ authorizationId: AUTH, ...input, gatePassSha: headSha });
    expect(replacement.number).not.toBe(first.number);
    expect(github.pullRequests!['fixture/project']!.find((pr) => pr.number === replacement.number)).toMatchObject({ state: 'open', mergeQueueState: 'queued' });
    expect(engine.ctx.store.listEvents(work.id).find((event) => event.type === 'lane.pr-replaced')?.payload).toMatchObject({ closedNumber: first.number, number: replacement.number });
    expect(engine.ctx.store.listLaneMergeRecords().filter((entry) => entry.workId === work.id)).toHaveLength(1);
    engine.ctx.store.close();
  });

  it('FR-C2 reuse: fixture PR reuse needs the same head AND base', async () => {
    const adapter = createGitHubAdapter({ fixtures: { pullRequests: {} } });
    const args = { owner: 'o', repo: 'r', head: 'turbine/w', headSha: 'abcdef1', title: 't' };
    const main = (await adapter.invoke({ capability: 'pr.create', workId: 'w', arguments: { ...args, base: 'main' }, correlationId: 'c' })) as { data: { number: number } };
    const release = (await adapter.invoke({ capability: 'pr.create', workId: 'w', arguments: { ...args, base: 'release' }, correlationId: 'c' })) as { data: { number: number } };
    expect(release.data.number).not.toBe(main.data.number);
  });

  it('FR-G sampling: merge sampling uses the terms snapshotted when landing was authorized, not the live policy', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Snapshot', text: 'Snapshot sampling terms.' });
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const policy = policyNow(engine);
    const record = await ensureAcceptedPr({ authorizationId: AUTH, store: engine.ctx.store, work, headSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy, gatePassSha: headSha });
    expect(record.authorizingPolicy).toEqual({ name: 'routine', samplingRate: policy.policy.sampling.rate });
    // The live policy says 0.1; the authorization snapshot says every merge is audited.
    engine.ctx.store.saveLanePrRecord({ ...record, authorizingPolicy: { name: 'routine', samplingRate: 1 } });
    const timestamp = new Date().toISOString();
    Object.assign(github.pullRequests!['fixture/project']![0]!, { state: 'merged', mergedAt: timestamp, mergeSha: 'fedcba9876543210' });
    await refreshLanePr({ store: engine.ctx.store, workId: work.id, target: engine.lanePrTarget! });
    expect(engine.ctx.store.listLaneMergeRecords().at(-1)).toMatchObject({ policyId: 'routine', sampling: { rate: 1, selected: true } });
    expect(engine.ctx.store.listLaneAudits()).toHaveLength(1);
    engine.ctx.store.close();
  });

  it('FR-C5 config: human acceptance without pr.create in tools.allow skips PR automation without throwing', async () => {
    const { engine, github } = laneProject(dirs, { approved: false });
    engine.ctx.config.tools.allow = engine.ctx.config.tools.allow.filter((capability) => capability !== 'pr.create');
    const { work } = await acceptByHuman(engine, 'Not opted in');
    await expect(engine.waitForLanePr()).resolves.toBeUndefined();
    expect(engine.ctx.store.getWork(work.id).currentState).toBe('ACCEPTED');
    expect(engine.ctx.store.getLanePrRecord(work.id)).toBeUndefined();
    expect(github.pullRequests?.['fixture/project'] ?? []).toHaveLength(0);
    expect(engine.ctx.store.listEvents(work.id).some((event) => event.type === 'lane.pr-automation-skipped')).toBe(true);
    engine.ctx.store.close();
  }, 60_000);

  it('FR-C5 config: an opted-in human acceptance still reports a failing PR automation', async () => {
    const { engine } = laneProject(dirs, { approved: false });
    const real = engine.lanePrTarget!.adapter;
    engine.lanePrTarget!.adapter = { ...real, invoke: async () => { throw new Error('github down'); } };
    const { work } = await acceptByHuman(engine, 'Opted in but failing');
    await expect(engine.waitForLanePr()).rejects.toThrow('github down');
    expect(engine.ctx.store.listEvents(work.id).some((event) => event.type === 'lane.pr-automation-failed')).toBe(true);
    engine.ctx.store.close();
  }, 60_000);

  it('FR-C3 resume: unfinished PR automation for an ACCEPTED task resumes on the next sync', async () => {
    const { engine, github } = laneProject(dirs, { approved: false });
    const real = engine.lanePrTarget!.adapter;
    let down = true;
    engine.lanePrTarget!.adapter = { ...real, invoke: async (request) => { if (down) throw new Error('github down'); return real.invoke(request); } };
    const { work } = await acceptByHuman(engine, 'Resume later');
    await expect(engine.waitForLanePr()).rejects.toThrow('github down');
    expect(engine.ctx.store.getLanePrRecord(work.id)).toBeUndefined();
    down = false;
    await engine.syncFromMarkdown(work.id);
    expect(engine.ctx.store.getLanePrRecord(work.id)).toMatchObject({ number: 1 });
    await engine.syncFromMarkdown(work.id);
    expect(github.pullRequests?.['fixture/project']).toHaveLength(1);
    engine.ctx.store.close();
  }, 60_000);

  it('FR-C1 multi-repo: a change-set hash is never used as a PR head SHA', async () => {
    const { engine, github } = laneProject(dirs, { approved: false });
    const { work } = await acceptByHuman(engine, 'Multi repo');
    await engine.waitForLanePr();
    const prs = github.pullRequests?.['fixture/project']?.length;
    const [only] = engine.repoStates(work.id);
    const multi = Object.assign(engine, { repoStates: () => [only!, { ...only!, name: 'other' }] });
    (multi as unknown as { queueAcceptedPr(work: unknown): void }).queueAcceptedPr(engine.ctx.store.getWork(work.id));
    await engine.waitForLanePr();
    expect(github.pullRequests?.['fixture/project']).toHaveLength(prs!);
    expect(engine.ctx.store.listEvents(work.id).find((event) => event.type === 'lane.pr-automation-skipped')?.payload.reason).toMatch(/one repo/);
    engine.ctx.store.close();
  }, 60_000);

  it('FR-C4 target: polling uses the stored repo; a switched origin cannot retarget the recorded PR', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Origin switch', text: 'Poll the stored repo.' });
    engine.ctx.store.saveLanePrRecord(prRecord(work.id, 8));
    github.pullRequests!['fixture/project'] = [fixturePr(work.id, 8, { state: 'merged', mergedAt: new Date().toISOString(), mergeSha: 'fedcba9876543210' })];
    const switched = { ...engine.lanePrTarget!, owner: 'other', repo: 'elsewhere' };
    expect((await refreshLanePr({ store: engine.ctx.store, workId: work.id, target: switched })).kind).toBe('merged');
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    await expect(
      ensureAcceptedPr({ authorizationId: AUTH, store: engine.ctx.store, work, headSha, target: switched, tools: engine.ctx.config.tools }),
    ).rejects.toThrow(/targets fixture\/project:main/);
    engine.ctx.store.close();
  });

  it('FR-C7 retarget: auto-merge is refused when the live PR base or head moved', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Retargeted', text: 'Refuse a retargeted PR.' });
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const input = { authorizationId: AUTH, store: engine.ctx.store, work, headSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy: policyNow(engine) };
    await ensureAcceptedPr(input); // gate pending: no merge yet
    const pr = github.pullRequests!['fixture/project']![0]!;
    pr.base = 'release';
    await expect(ensureAcceptedPr({ authorizationId: AUTH, ...input, gatePassSha: headSha })).rejects.toThrow(/base is release/);
    pr.base = 'main';
    // The head moved between the publish and the enqueue: GitHub is asked to enqueue nothing.
    const real = engine.lanePrTarget!.adapter;
    engine.lanePrTarget!.adapter = {
      ...real,
      invoke: async (request) => {
        const result = await real.invoke(request);
        if (request.capability === 'commit.status') pr.headSha = 'ffffffffffff';
        return result;
      },
    };
    await expect(ensureAcceptedPr({ authorizationId: AUTH, ...input, gatePassSha: headSha })).rejects.toThrow(/is not accepted head/);
    expect(pr.mergeQueueState).toBeUndefined();
    expect(engine.ctx.store.getLanePrRecord(work.id)?.queueState).toBe('not-enabled');
    engine.ctx.store.close();
  });

  it('FR-C6 ejection: an unexplained or unconfirmed ejection preserves the recorded state', async () => {
    const { engine, github } = laneProject(dirs);
    const work = { ...engine.createTask({ title: 'Unexplained', text: 'Do not eject without a reason.' }), currentState: 'ACCEPTED' as const };
    engine.ctx.store.saveWork(work);
    engine.ctx.store.saveLanePrRecord(prRecord(work.id, 7));
    github.pullRequests!['fixture/project'] = [fixturePr(work.id, 7, { mergeQueueState: 'ejected' })];
    const result = await engine.refreshLanePullRequest(work.id);
    expect(result.kind).toBe('open');
    expect(result.work.currentState).toBe('ACCEPTED');
    expect(engine.ctx.store.getLanePrRecord(work.id)?.queueState).toBe('queued');
    engine.ctx.store.close();
  });

  it('FR-C3 queued: auto-merge is recorded as queued only once GitHub confirms queue membership', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Unconfirmed queue', text: 'Do not claim queued early.' });
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const real = engine.lanePrTarget!.adapter;
    engine.lanePrTarget!.adapter = {
      ...real,
      invoke: async (request) => {
        const result = await real.invoke(request);
        if (request.capability === 'pr.merge') delete github.pullRequests!['fixture/project']![0]!.mergeQueueState;
        return result;
      },
    };
    const record = await ensureAcceptedPr({ authorizationId: AUTH, store: engine.ctx.store, work, headSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy: policyNow(engine), gatePassSha: headSha });
    expect(record.queueState).toBe('not-enabled');
    github.pullRequests!['fixture/project']![0]!.mergeQueueState = 'queued';
    expect((await refreshLanePr({ store: engine.ctx.store, workId: work.id, target: engine.lanePrTarget! })).record.queueState).toBe('queued');
    engine.ctx.store.close();
  });

  /** Policy-lane flow up to (but not including) the sync that accepts by policy. */
  const readyForPolicyAcceptance = async (engine: Engine) => {
    const work = await toCodeReview(engine, {
      'README.md': '# fixture fixed\n',
      'test/readme.test.mjs': "import test from 'node:test';\ntest('readme', () => {});\n",
    });
    const pending = engine.pendingApproval(work.id);
    engine.decide(work.id, { action: 'approve', reviewer: 'Rae', confirmToken: pending.confirmToken, presence: 'test' });
    engine.laneRetry(work.id, { actor: 'Rae', confirmToken: engine.pendingLaneRetry(work.id).confirmToken, presence: 'test' });
    return work.id;
  };
  /** GitHub is unreachable for PR work (rules reads still work so the policy can accept). */
  const flaky = (engine: Engine, failing: (capability: string) => boolean = (capability) => capability !== 'repo.rules.read') => {
    const real = engine.lanePrTarget!.adapter;
    const state = { down: true, requests: [] as Array<{ capability: string; arguments: Record<string, unknown> }> };
    engine.lanePrTarget!.adapter = {
      ...real,
      invoke: async (request) => {
        state.requests.push({ capability: request.capability, arguments: request.arguments });
        if (state.down && failing(request.capability)) throw new Error('github down');
        return real.invoke(request);
      },
    };
    return state;
  };
  const acceptedWork = (engine: Engine, title: string) => {
    const work = { ...engine.createTask({ title, text: `${title}.` }), currentState: 'ACCEPTED' as const };
    engine.ctx.store.saveWork(work);
    return work;
  };
  const events = (engine: Engine, workId: string, type: string) => engine.ctx.store.listEvents(workId).filter((event) => event.type === type);

  it('FR-C3 resume authority: a newer approval of the same policy name cannot authorize a retry, and is not human acceptance', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const net = flaky(engine);
    const id = await readyForPolicyAcceptance(engine);
    await expect(engine.syncFromMarkdown(id)).rejects.toThrow('github down');
    expect(engine.ctx.store.getWork(id).currentState).toBe('ACCEPTED');
    expect(engine.ctx.store.getLanePrRecord(id)).toBeUndefined();
    writePolicy(dir, 'routine', ROUTINE_POLICY.replace('maxChangedLines: 40', 'maxChangedLines: 41'));
    approve(engine, 'routine', 'Bo');
    net.down = false;
    await engine.syncFromMarkdown(id);
    expect(engine.ctx.store.getLanePrRecord(id)).toBeUndefined();
    expect(github.pullRequests?.['fixture/project'] ?? []).toHaveLength(0);
    expect(events(engine, id, 'lane.pr-automation-blocked').at(-1)?.payload.reason).toMatch(/re-approved/);
    expect(engine.ctx.store.listDecisions(id).filter((entry) => entry.gate === 'sqa-acceptance' && entry.actorType === 'human')).toHaveLength(0);
    engine.ctx.store.close();
  }, 120_000);

  it('FR-C3 resume authority: a suspended policy blocks the retry of its acceptance', async () => {
    const { engine, github } = laneProject(dirs);
    const net = flaky(engine);
    const id = await readyForPolicyAcceptance(engine);
    await expect(engine.syncFromMarkdown(id)).rejects.toThrow('github down');
    suspendPolicy(engine.ctx.store, 'routine', 'incident', 'agent');
    net.down = false;
    await engine.syncFromMarkdown(id);
    expect(engine.ctx.store.getLanePrRecord(id)).toBeUndefined();
    expect(github.pullRequests?.['fixture/project'] ?? []).toHaveLength(0);
    expect(events(engine, id, 'lane.pr-automation-blocked').at(-1)?.payload.reason).toMatch(/suspended/);
    engine.ctx.store.close();
  }, 120_000);

  it('FR-C4 target: a policy acceptance lands on the target its protection was evaluated against, not a re-resolved origin', async () => {
    const { engine, github } = laneProject(dirs);
    const net = flaky(engine);
    const id = await readyForPolicyAcceptance(engine);
    await expect(engine.syncFromMarkdown(id)).rejects.toThrow('github down');
    expect(events(engine, id, 'lane.acceptance-target-bound').at(-1)?.payload).toMatchObject({ owner: 'fixture', repo: 'project', baseBranch: 'main' });
    // Origin now resolves somewhere else; the resumed landing must not follow it.
    Object.assign(engine.lanePrTarget!, { owner: 'other', repo: 'elsewhere', baseBranch: 'release' });
    net.down = false;
    await engine.syncFromMarkdown(id);
    expect(engine.ctx.store.getLanePrRecord(id)).toMatchObject({ owner: 'fixture', repo: 'project', baseBranch: 'main', queueState: 'queued' });
    expect(github.pullRequests?.['fixture/project']).toHaveLength(1);
    expect(github.pullRequests?.['other/elsewhere']).toBeUndefined();
    engine.ctx.store.close();
  }, 120_000);

  it('FR-C3 head: auto-merge is requested for exactly the accepted head', async () => {
    const { dir, engine } = laneProject(dirs);
    const net = flaky(engine, () => false);
    net.down = false;
    const work = engine.createTask({ title: 'Head oid', text: 'Pin the head on auto-merge.' });
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    await ensureAcceptedPr({ authorizationId: AUTH, store: engine.ctx.store, work, headSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy: policyNow(engine), gatePassSha: headSha });
    expect(net.requests.find((request) => request.capability === 'pr.merge')?.arguments).toMatchObject({ expectedHeadOid: headSha });
    engine.ctx.store.close();
  });

  it('FR-C6 attempt: a removal GitHub already showed when the attempt began is not an ejection of the new acceptance', async () => {
    const { engine, github } = laneProject(dirs);
    const work = acceptedWork(engine, 'Old removal');
    engine.ctx.store.saveLanePrRecord(prRecord(work.id, 7, { queueBaselineRemovalId: 'rm_1' }));
    github.pullRequests!['fixture/project'] = [fixturePr(work.id, 7, { mergeQueueState: 'ejected', queueReason: 'required check failed', queueRemovalId: 'rm_1' })];
    const stale = await engine.refreshLanePullRequest(work.id);
    expect(stale.kind).toBe('open');
    expect(stale.work.currentState).toBe('ACCEPTED');
    expect(events(engine, work.id, 'lane.queue-ejected')).toHaveLength(0);
    github.pullRequests!['fixture/project']![0]!.queueRemovalId = 'rm_2';
    const fresh = await engine.refreshLanePullRequest(work.id);
    expect(fresh.kind).toBe('ejected');
    expect(fresh.work.currentState).toBe('CHANGES_REQUESTED');
    expect(fresh.fixRound).toBe(1);
    engine.ctx.store.close();
  });

  it('FR-C6 once: the same removal never starts a second fix round', async () => {
    const { engine, github } = laneProject(dirs);
    const work = acceptedWork(engine, 'One round');
    engine.ctx.store.saveLanePrRecord(prRecord(work.id, 7));
    github.pullRequests!['fixture/project'] = [fixturePr(work.id, 7, { mergeQueueState: 'ejected', queueReason: 'required check failed', queueRemovalId: 'rm_1' })];
    expect((await engine.refreshLanePullRequest(work.id)).fixRound).toBe(1);
    // The task is accepted again on the same PR while GitHub still shows that removal.
    const again = engine.ctx.store.getWork(work.id);
    engine.ctx.store.saveWork({ ...again, currentState: 'ACCEPTED' });
    const second = await engine.refreshLanePullRequest(work.id);
    expect(second.kind).toBe('open');
    expect(second.work.currentState).toBe('ACCEPTED');
    expect(events(engine, work.id, 'lane.queue-ejected')).toHaveLength(1);
    expect(engine.ctx.store.getLanePrRecord(work.id)?.handledQueueRemovalId).toBe('rm_1');
    engine.ctx.store.close();
  });

  it('FR-C6 attempt: a new head or acceptance on the same PR starts past the removal GitHub already showed', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Second attempt', text: 'Same PR, new acceptance.' });
    const oldSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const input = { authorizationId: AUTH, store: engine.ctx.store, work, headSha: oldSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy: policyNow(engine), gatePassSha: oldSha };
    await ensureAcceptedPr(input);
    Object.assign(github.pullRequests!['fixture/project']![0]!, { mergeQueueState: 'ejected', queueReason: 'conflict', queueRemovalId: 'rm_1' });
    expect((await refreshLanePr({ store: engine.ctx.store, workId: work.id, target: engine.lanePrTarget! })).kind).toBe('ejected');
    const newSha = `${oldSha.startsWith('a') ? 'b' : 'a'}${oldSha.slice(1)}`;
    github.pullRequests!['fixture/project']![0]!.headSha = newSha;
    const record = await ensureAcceptedPr({ ...input, authorizationId: 'dec_auth_2', headSha: newSha, gatePassSha: newSha });
    expect(record).toMatchObject({ headSha: newSha, queueBaselineRemovalId: 'rm_1', queueState: 'queued' });
    expect(record.handledQueueRemovalId).toBeUndefined();
    // GitHub still lists only the old removal: it is not an ejection of this attempt.
    github.pullRequests!['fixture/project']![0]!.mergeQueueState = 'ejected';
    const result = await refreshLanePr({ store: engine.ctx.store, workId: work.id, target: engine.lanePrTarget! });
    expect(result.kind).toBe('open');
    expect(engine.ctx.store.getLanePrRecord(work.id)?.queueState).toBe('queued');
    engine.ctx.store.close();
  });

  it('FR-G sampling: only a retry of the same authorization keeps the snapshot; a new acceptance or replacement PR re-snapshots', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Per attempt', text: 'Snapshot per landing attempt.' });
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const policy = policyNow(engine);
    const rated = (rate: number) => ({ ...policy, policy: { ...policy.policy, sampling: { ...policy.policy.sampling, rate } } });
    const input = { authorizationId: AUTH, store: engine.ctx.store, work, headSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy: rated(0.1), gatePassSha: headSha };
    const first = await ensureAcceptedPr(input);
    expect(first.authorizingPolicy).toEqual({ name: 'routine', samplingRate: 0.1 });
    // Same authorization retried: the snapshot taken then is kept even if the policy now says otherwise.
    const retried = await ensureAcceptedPr({ ...input, policy: rated(0.9) });
    expect(retried.authorizingPolicy?.samplingRate).toBe(0.1);
    // A new acceptance on the same PR snapshots its own policy...
    const second = await ensureAcceptedPr({ ...input, authorizationId: 'dec_auth_2', policy: rated(0.5) });
    expect(second.authorizingPolicy).toEqual({ name: 'routine', samplingRate: 0.5 });
    // ...and a human acceptance inherits no policy at all.
    const human = await ensureAcceptedPr({ ...input, authorizationId: 'dec_auth_3', policy: undefined });
    expect(human.authorizingPolicy).toBeUndefined();
    // A replacement PR takes a fresh snapshot rather than the closed PR's.
    engine.ctx.store.saveLanePrRecord({ ...human, authorizingPolicy: { name: 'routine', samplingRate: 1 } });
    github.pullRequests!['fixture/project']![0]!.state = 'closed';
    const replacement = await ensureAcceptedPr({ ...input, authorizationId: 'dec_auth_3', policy: rated(0.3) });
    expect(replacement.number).not.toBe(first.number);
    expect(replacement.authorizingPolicy).toEqual({ name: 'routine', samplingRate: 0.3 });
    engine.ctx.store.close();
  });

  it('FR-C2 resume: a gate status that never reached GitHub is retried although the head is unchanged', async () => {
    const { engine, github } = laneProject(dirs, { approved: false });
    const net = flaky(engine, (capability) => capability === 'commit.status');
    const { work, head } = await acceptByHuman(engine, 'Status pending');
    await expect(engine.waitForLanePr()).rejects.toThrow('github down');
    expect(engine.ctx.store.getLanePrRecord(work.id)).toMatchObject({ headSha: head, prState: 'open' });
    expect(engine.ctx.store.getLanePrRecord(work.id)?.statusPublished).toBeUndefined();
    net.down = false;
    await engine.syncFromMarkdown(work.id);
    expect(engine.ctx.store.getLanePrRecord(work.id)?.statusPublished).toMatchObject({ sha: head });
    expect(github.statuses?.[`fixture/project@${head}`]?.at(-1)).toMatchObject({ context: 'turbine/gate' });
    const published = github.statuses![`fixture/project@${head}`]!.length;
    await engine.syncFromMarkdown(work.id);
    expect(github.statuses![`fixture/project@${head}`]).toHaveLength(published);
    expect(github.pullRequests?.['fixture/project']).toHaveLength(1);
    engine.ctx.store.close();
  }, 120_000);

  it('FR-C2 resume: a human-lane PR closed without merging is replaced on the next sync although the head is unchanged', async () => {
    const { engine, github } = laneProject(dirs, { approved: false });
    const { work } = await acceptByHuman(engine, 'Closed later');
    await engine.waitForLanePr();
    github.pullRequests!['fixture/project']![0]!.state = 'closed';
    await engine.refreshLanePullRequest(work.id);
    expect(engine.ctx.store.getLanePrRecord(work.id)).toMatchObject({ prState: 'closed', queueReason: 'PR was closed without merging' });
    await engine.syncFromMarkdown(work.id);
    expect(github.pullRequests?.['fixture/project']).toHaveLength(2);
    expect(engine.ctx.store.getLanePrRecord(work.id)).toMatchObject({ number: 2, prState: 'open' });
    expect(events(engine, work.id, 'lane.pr-replaced')).toHaveLength(1);
    engine.ctx.store.close();
  }, 120_000);

  it('FR-C1 bound: a queued job is discarded when the accepted head or revision moved before it ran', async () => {
    const { engine, github } = laneProject(dirs, { approved: false });
    const moved = await acceptByHuman(engine, 'Head moves before drain');
    const bumped = await acceptByHuman(engine, 'Revision moves before drain');
    commitIn(engine.repoStates(moved.work.id)[0]!.worktreePath, 'late.txt');
    const current = engine.ctx.store.getWork(bumped.work.id);
    engine.ctx.store.saveWork({ ...current, currentRevision: current.currentRevision + 1 });
    await engine.waitForLanePr();
    expect(github.pullRequests?.['fixture/project'] ?? []).toHaveLength(0);
    expect(engine.ctx.store.getLanePrRecord(moved.work.id)).toBeUndefined();
    expect(events(engine, moved.work.id, 'lane.pr-automation-discarded').at(-1)?.payload.reason).toMatch(/head/);
    expect(events(engine, bumped.work.id, 'lane.pr-automation-discarded').at(-1)?.payload.reason).toMatch(/revision/);
    engine.ctx.store.close();
  }, 180_000);

  it('FR-C3 resume: a worktree that advanced past the accepted head is not landed; sync handles the new commit', async () => {
    const { engine, github } = laneProject(dirs, { approved: false });
    const net = flaky(engine, () => true);
    const { work } = await acceptByHuman(engine, 'Advanced head');
    await expect(engine.waitForLanePr()).rejects.toThrow('github down');
    commitIn(engine.repoStates(work.id)[0]!.worktreePath, 'late.txt');
    net.down = false;
    const result = await engine.syncFromMarkdown(work.id);
    expect(result.action).toBe('code.changed');
    expect(engine.ctx.store.getLanePrRecord(work.id)).toBeUndefined();
    expect(github.pullRequests?.['fixture/project'] ?? []).toHaveLength(0);
    engine.ctx.store.close();
  }, 120_000);

  it('FR-G atomic: a merged PR, its merge facts and its audit sample commit together', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Atomic merge', text: 'Commit merge facts together.' });
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const record = await ensureAcceptedPr({ authorizationId: AUTH, store: engine.ctx.store, work, headSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy: policyNow(engine), gatePassSha: headSha });
    engine.ctx.store.saveLanePrRecord({ ...record, authorizingPolicy: { name: 'routine', samplingRate: 1 } });
    Object.assign(github.pullRequests!['fixture/project']![0]!, { state: 'merged', mergedAt: new Date().toISOString(), mergeSha: 'fedcba9876543210' });
    const failing = vi.spyOn(engine.ctx.store, 'enqueueLaneAudit').mockImplementation(() => { throw new Error('queue write failed'); });
    await expect(refreshLanePr({ store: engine.ctx.store, workId: work.id, target: engine.lanePrTarget! })).rejects.toThrow('queue write failed');
    expect(engine.ctx.store.getLanePrRecord(work.id)?.queueState).toBe('queued');
    expect(engine.ctx.store.listLaneMergeRecords().filter((entry) => entry.mergeState === 'merged')).toHaveLength(0);
    failing.mockRestore();
    // A suspension check that fails after the commit cannot undo the committed facts.
    const unreadable = vi.spyOn(engine.ctx.store, 'getLanePolicy').mockImplementation(() => { throw new Error('policy store unreadable'); });
    await expect(refreshLanePr({ store: engine.ctx.store, workId: work.id, target: engine.lanePrTarget! })).rejects.toThrow('policy store unreadable');
    unreadable.mockRestore();
    expect(engine.ctx.store.getLanePrRecord(work.id)?.queueState).toBe('merged');
    expect(engine.ctx.store.listLaneMergeRecords().filter((entry) => entry.mergeState === 'merged')).toHaveLength(1);
    expect(engine.ctx.store.listLaneAudits()).toHaveLength(1);
    engine.ctx.store.close();
  });

  it('FR-C6 reachable: sync polls an ACCEPTED task\'s recorded PR, so a queue ejection returns it to CHANGES_REQUESTED', async () => {
    const { engine, github } = laneProject(dirs, { approved: false });
    const { work } = await acceptByHuman(engine, 'Ejected later');
    await engine.waitForLanePr();
    Object.assign(github.pullRequests!['fixture/project']![0]!, { mergeQueueState: 'ejected', queueReason: 'required check failed', queueRemovalId: 'rm_5' });
    await engine.syncFromMarkdown(work.id);
    expect(events(engine, work.id, 'lane.queue-ejected')[0]?.payload).toMatchObject({ reason: 'required check failed', fixRound: 1, removalId: 'rm_5' });
    expect(engine.ctx.store.getWork(work.id).currentState).not.toBe('ACCEPTED');
    engine.ctx.store.close();
  }, 120_000);

  /** An audit problem from an earlier merge: the policy suspends the next time its suspendWhen is evaluated. */
  const SUSPENDING_POLICY = ROUTINE_POLICY.replace(
    'gates: [requirements, plan, acceptance]',
    'suspendWhen:\n  auditProblems: { atLeast: 1, inLastAudits: 5 }\ngates: [requirements, plan, acceptance]',
  );
  const seedAuditProblem = (engine: Engine, workId: string) => {
    const store = engine.ctx.store;
    const at = new Date().toISOString();
    store.saveLaneMergeRecord({ id: 'merge-seed', workId, policyId: 'routine', openedAt: at, mergeState: 'merged', mergedAt: at, mergeSha: 'sha-seed', reverted: 'no', fixRounds: 0, recordedAt: at });
    const queued = store.enqueueLaneAudit({ id: 'audit-seed', mergeRecordId: 'merge-seed', workId, policyId: 'routine', seed: 'a'.repeat(64), draw: 0, rate: 1, queuedAt: at, outcome: 'queued' });
    store.recordLaneAudit({ ...queued, outcome: 'problem', note: 'seeded', recordedBy: 'Human Reviewer', recordedAt: at });
  };
  /** Ejection fields only — safe to Object.assign onto an existing fixture PR without clobbering headSha. */
  const ejectedPr = (removalId = 'rm_1') =>
    ({ mergeQueueState: 'ejected' as const, queueReason: 'required check failed', queueRemovalId: removalId });

  it('FR-C1 multi-repo acceptance: a policy that tolerates two repositories still hands ACCEPTANCE to a human, while review is unaffected', () => {
    const { engine } = laneProject(dirs, { policy: ROUTINE_POLICY.replace('maxRepos: 1', 'maxRepos: 2') });
    const work = engine.createTask({ title: 'Two repos', text: 'Landing carries one repository.' });
    const facts = (engine as unknown as { laneFacts(w: unknown, gate: string): LaneFacts }).laneFacts(work, 'acceptance');
    const protection = { status: 'confirmed' as const, mergeQueueRequired: true, turbineGateRequired: true };
    const lanePr = { configAllowsCreate: true, configAllowsMerge: true, protection };
    const policy = policyNow(engine);
    const single = evaluateLaneEligibility(policy, { ...facts, repoCount: 1, lanePr });
    expect(single.reasons.join('\n')).not.toMatch(/PR landing supports one repository/);
    const multi = evaluateLaneEligibility(policy, { ...facts, repoCount: 2, lanePr });
    expect(multi.status).not.toBe('eligible');
    expect(multi.reasons.join('\n')).toMatch(/PR landing supports one repository; the task changes 2/);
    const review = evaluateLaneEligibility(policy, { ...facts, gate: 'requirements', repoCount: 2 });
    expect(review.reasons.join('\n')).not.toMatch(/PR landing supports one repository/);
    engine.ctx.store.close();
  });

  it('FR-C6 stale: a worktree that advanced past the accepted head is never sent to CHANGES_REQUESTED by a queue ejection', async () => {
    const { engine, github } = laneProject(dirs, { approved: false });
    const { work } = await acceptByHuman(engine, 'Ejected after a push');
    await engine.waitForLanePr();
    Object.assign(github.pullRequests!['fixture/project']![0]!, ejectedPr('rm_7'));
    commitIn(engine.repoStates(work.id)[0]!.worktreePath, 'late.txt');
    const polled = await engine.refreshLanePullRequest(work.id);
    expect(polled.work.currentState).toBe('ACCEPTED');
    expect(events(engine, work.id, 'lane.queue-ejected')).toHaveLength(0);
    expect(events(engine, work.id, 'task.changes-requested')).toHaveLength(0);
    expect(engine.ctx.store.getLanePrRecord(work.id)?.handledQueueRemovalId).toBeUndefined();
    // Sync recaptures the head first; the stale ACCEPTED work is not polled, retried or ejected.
    const synced = await engine.syncFromMarkdown(work.id);
    expect(synced.action).toBe('code.changed');
    expect(events(engine, work.id, 'lane.queue-ejected')).toHaveLength(0);
    engine.ctx.store.close();
  }, 120_000);

  it('FR-C6 race: a poll result is not applied to a row that became another PR attempt while GitHub was read', async () => {
    const { engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Attempt moves', text: 'The row changes during the poll.' });
    const first = prRecord(work.id, 7, { authorizationId: AUTH, authorizingPolicy: { name: 'routine', samplingRate: 1 } });
    const second = { ...first, authorizationId: 'dec_auth_2', headSha: '1234567abcdef', queueState: 'not-enabled' as const };
    const real = engine.lanePrTarget!.adapter;
    engine.lanePrTarget!.adapter = {
      ...real,
      invoke: async (request) => {
        const result = await real.invoke(request);
        if (request.capability === 'pr.read') engine.ctx.store.saveLanePrRecord(second);
        return result;
      },
    };
    const scenarios: Array<Record<string, unknown>> = [
      { state: 'merged', mergedAt: new Date().toISOString(), mergeSha: 'fedcba9876543210' },
      { state: 'closed' },
      { mergeQueueState: 'ejected', queueReason: 'conflict', queueRemovalId: 'rm_3' },
      { mergeQueueState: 'queued' },
    ];
    for (const scenario of scenarios) {
      engine.ctx.store.saveLanePrRecord(first);
      github.pullRequests!['fixture/project'] = [fixturePr(work.id, 7, scenario)];
      const result = await refreshLanePr({ store: engine.ctx.store, workId: work.id, target: engine.lanePrTarget! });
      expect(result.kind).toBe('open');
      const stored = engine.ctx.store.getLanePrRecord(work.id)!;
      expect(stored).toMatchObject({ authorizationId: 'dec_auth_2', queueState: 'not-enabled' });
      expect(stored.prState).toBeUndefined();
      expect(stored.handledQueueRemovalId).toBeUndefined();
      expect(engine.ctx.store.listLaneMergeRecords().filter((entry) => entry.mergeState === 'merged')).toHaveLength(0);
    }
    engine.ctx.store.close();
  });

  it('FR-C3 order: an ejection GitHub already shows is reconciled before the enqueue is retried', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const net = flaky(engine, () => false);
    net.down = false;
    const work = engine.createTask({ title: 'Ejected before retry', text: 'Reconcile first.' });
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const input = { authorizationId: AUTH, store: engine.ctx.store, work, headSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy: policyNow(engine) };
    await ensureAcceptedPr(input); // gate pending: PR exists, nothing queued
    Object.assign(github.pullRequests!['fixture/project']![0]!, ejectedPr());
    const record = await ensureAcceptedPr({ ...input, gatePassSha: headSha });
    expect(net.requests.some((request) => request.capability === 'pr.merge')).toBe(false);
    expect(record).toMatchObject({ queueState: 'ejected', queueReason: 'required check failed' });
    expect(github.pullRequests!['fixture/project']![0]!.mergeQueueState).toBe('ejected');
    // The ejection is still unhandled, so the poll turns it into a fix round.
    expect(await refreshLanePr({ store: engine.ctx.store, workId: work.id, target: engine.lanePrTarget! })).toMatchObject({ kind: 'ejected', removalId: 'rm_1' });
    // A removal GitHub showed before this attempt is NOT an ejection: the enqueue is retried over it.
    const old = { ...record, queueState: 'not-enabled' as const, queueBaselineRemovalId: 'rm_1' };
    engine.ctx.store.saveLanePrRecord(old);
    expect((await ensureAcceptedPr({ ...input, gatePassSha: headSha })).queueState).toBe('queued');
    expect(net.requests.filter((request) => request.capability === 'pr.merge')).toHaveLength(1);
    engine.ctx.store.close();
  });

  it('FR-C3 order (sync): sync polls GitHub before resuming, so an ejected PR is not enqueued again', async () => {
    const { engine, github } = laneProject(dirs);
    const net = flaky(engine, (capability) => capability === 'pr.merge');
    const id = await readyForPolicyAcceptance(engine);
    await expect(engine.syncFromMarkdown(id)).rejects.toThrow('github down');
    expect(engine.ctx.store.getLanePrRecord(id)).toMatchObject({ queueState: 'not-enabled', statusPublished: { state: 'success' } });
    Object.assign(github.pullRequests!['fixture/project']![0]!, ejectedPr());
    net.down = false;
    const attempts = net.requests.filter((request) => request.capability === 'pr.merge').length;
    await engine.syncFromMarkdown(id);
    expect(events(engine, id, 'lane.queue-ejected')).toHaveLength(1);
    expect(engine.ctx.store.getWork(id).currentState).not.toBe('ACCEPTED');
    expect(net.requests.filter((request) => request.capability === 'pr.merge')).toHaveLength(attempts);
    engine.ctx.store.close();
  }, 180_000);

  it('FR-G retry: a post-merge suspension check that failed is retried on the next poll even though the merge SHA is stored, and runs once', async () => {
    const { dir, engine, github } = laneProject(dirs, { policy: SUSPENDING_POLICY });
    seedAuditProblem(engine, engine.createTask({ title: 'Earlier merge', text: 'Earlier merge.' }).id);
    const created = engine.createTask({ title: 'Merge then suspend', text: 'Suspension is retryable.' });
    const work = { ...created, currentState: 'ACCEPTED' as const };
    engine.ctx.store.saveWork(work);
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    await ensureAcceptedPr({ authorizationId: AUTH, store: engine.ctx.store, work, headSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy: policyNow(engine), gatePassSha: headSha });
    Object.assign(github.pullRequests!['fixture/project']![0]!, { state: 'merged', mergedAt: new Date().toISOString(), mergeSha: 'fedcba9876543210' });
    const unreadable = vi.spyOn(engine.ctx.store, 'getLanePolicy').mockImplementation(() => { throw new Error('policy store unreadable'); });
    await expect(refreshLanePr({ store: engine.ctx.store, workId: work.id, target: engine.lanePrTarget! })).rejects.toThrow('policy store unreadable');
    unreadable.mockRestore();
    expect(engine.ctx.store.getLanePolicy('routine')?.status).toBe('active');
    expect(pendingMergeEvaluation(engine.ctx.store, work.id)).toMatchObject({ mergeSha: 'fedcba9876543210', policyId: 'routine' });
    // The record is merged, yet sync's poll still runs because the check is owed.
    expect(engine.ctx.store.getLanePrRecord(work.id)?.queueState).toBe('merged');
    const poll = () => (engine as unknown as { pollAcceptedPr(w: unknown): Promise<void> }).pollAcceptedPr(engine.ctx.store.getWork(work.id));
    await poll();
    expect(engine.ctx.store.getLanePolicy('routine')).toMatchObject({ status: 'suspended' });
    expect(pendingMergeEvaluation(engine.ctx.store, work.id)).toBeUndefined();
    expect(engine.ctx.store.listLaneMergeRecords().filter((entry) => entry.workId === work.id && entry.mergeState === 'merged')).toHaveLength(1);
    expect(engine.ctx.store.listLaneAudits().filter((audit) => audit.workId === work.id).length).toBeLessThanOrEqual(1);
    // Done: a further poll neither reads GitHub nor re-evaluates.
    const net = flaky(engine, () => false);
    net.down = false;
    await poll();
    expect(net.requests).toHaveLength(0);
    engine.ctx.store.close();
  });

  it('FR-C3 resume authority: a pending edit of the policy file (not yet approved) blocks the resume of its acceptance', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const net = flaky(engine);
    const id = await readyForPolicyAcceptance(engine);
    await expect(engine.syncFromMarkdown(id)).rejects.toThrow('github down');
    // Edited on disk but NOT re-approved: the store still holds the accepted hash.
    writePolicy(dir, 'routine', ROUTINE_POLICY.replace('maxChangedLines: 40', 'maxChangedLines: 41'));
    net.down = false;
    await engine.syncFromMarkdown(id);
    expect(engine.ctx.store.getLanePrRecord(id)).toBeUndefined();
    expect(github.pullRequests?.['fixture/project'] ?? []).toHaveLength(0);
    expect(events(engine, id, 'lane.pr-automation-blocked').at(-1)?.payload.reason).toMatch(/pending edit/);
    engine.ctx.store.close();
  }, 120_000);

  it('FR-G attribution: a merge counts for the attempt that landed — a human merge never inherits a newer policy; only a record with no authorization falls back', async () => {
    const { engine, github } = laneProject(dirs);
    const at = new Date().toISOString();
    const land = async (title: string, number: number, extra: Record<string, unknown>, live: Record<string, unknown> = {}, policy?: ReturnType<typeof policyNow>) => {
      const work = engine.createTask({ title, text: title });
      engine.ctx.store.saveLanePrRecord(prRecord(work.id, number, extra));
      (github.pullRequests!['fixture/project'] ??= []).push(fixturePr(work.id, number, { state: 'merged', mergedAt: at, mergeSha: `sha_${number}`, ...live }));
      await refreshLanePr({ store: engine.ctx.store, workId: work.id, target: engine.lanePrTarget!, policy });
      return { work, merge: engine.ctx.store.listLaneMergeRecords().find((entry) => entry.workId === work.id && entry.mergeState === 'merged')! };
    };
    const policySnapshot = { name: 'routine', samplingRate: 1 };
    // The record's attempt was a human acceptance; a newer policy acceptance resolved `policy` for the caller.
    expect((await land('Human merge', 1, { authorizationId: 'dec_human' }, {}, policyNow(engine))).merge.policyId).toBeNull();
    expect((await land('Policy merge', 2, { authorizationId: 'dec_policy', authorizingPolicy: policySnapshot })).merge).toMatchObject({ policyId: 'routine', sampling: { rate: 1, selected: true } });
    // Legacy: no recorded authorization at all.
    expect((await land('Legacy merge', 3, {}, {}, policyNow(engine))).merge.policyId).toBe('routine');
    expect((await land('Legacy human', 4, {})).merge.policyId).toBeNull();
    // A merge of a head other than the attempt's accepted head is not that attempt's landing.
    const other = await land('Other head', 5, { authorizationId: 'dec_policy', authorizingPolicy: policySnapshot }, { headSha: 'ffffffffffffffff' });
    expect(other.merge.policyId).toBeNull();
    expect(events(engine, other.work.id, 'lane.merge-unattributed')).toHaveLength(1);
    expect(engine.ctx.store.listLaneAudits().map((audit) => audit.workId)).toEqual(expect.not.arrayContaining([other.work.id]));
    engine.ctx.store.close();
  });

  it('FR-C3 retry: a PR GitHub will not enqueue yet stays retryable, and only the queue-only request is ever made', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const net = flaky(engine, () => false);
    net.down = false;
    const work = engine.createTask({ title: 'Not ready', text: 'Queue refuses first.' });
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const input = { authorizationId: AUTH, store: engine.ctx.store, work, headSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy: policyNow(engine) };
    await ensureAcceptedPr(input);
    const pr = github.pullRequests!['fixture/project']![0]!;
    pr.queueRejection = 'merge queue is not ready';
    await expect(ensureAcceptedPr({ ...input, gatePassSha: headSha })).rejects.toThrow(/did not enqueue/);
    const stuck = engine.ctx.store.getLanePrRecord(work.id)!;
    expect(stuck).toMatchObject({ queueState: 'not-enabled', gateState: 'success' });
    expect(pr.mergeQueueState).toBeUndefined();
    // Owed work: the next sync resumes it.
    expect(landingIncomplete(stuck, { headSha, authorizationId: AUTH, gatePassSha: headSha, policy: true })).toBe(true);
    delete pr.queueRejection;
    expect((await ensureAcceptedPr({ ...input, gatePassSha: headSha })).queueState).toBe('queued');
    const merges = net.requests.filter((request) => request.capability === 'pr.merge');
    expect(merges).toHaveLength(2);
    for (const request of merges) expect(request.arguments).toMatchObject({ mode: 'queue-only', admin: false, expectedHeadOid: headSha });
    engine.ctx.store.close();
  });

  it('FR-C6 identity: an ejection is not applied when the acceptance moved while GitHub was polled, and a later poll applies it', async () => {
    const { engine, github } = laneProject(dirs);
    const work = acceptedWork(engine, 'Moves mid-poll');
    engine.ctx.store.saveLanePrRecord(prRecord(work.id, 7));
    github.pullRequests!['fixture/project'] = [fixturePr(work.id, 7, ejectedPr())];
    const real = engine.lanePrTarget!.adapter;
    engine.lanePrTarget!.adapter = {
      ...real,
      invoke: async (request) => {
        const result = await real.invoke(request);
        if (request.capability === 'pr.read') {
          const moved = engine.ctx.store.getWork(work.id);
          engine.ctx.store.saveWork({ ...moved, currentRevision: moved.currentRevision + 1 });
        }
        return result;
      },
    };
    const raced = await engine.refreshLanePullRequest(work.id);
    expect(raced.work.currentState).toBe('ACCEPTED');
    expect(events(engine, work.id, 'lane.queue-ejected')).toHaveLength(0);
    expect(events(engine, work.id, 'task.changes-requested')).toHaveLength(0);
    expect(engine.ctx.store.getLanePrRecord(work.id)?.handledQueueRemovalId).toBeUndefined();
    engine.lanePrTarget!.adapter = real;
    const later = await engine.refreshLanePullRequest(work.id);
    expect(later.fixRound).toBe(1);
    expect(later.work.currentState).toBe('CHANGES_REQUESTED');
    engine.ctx.store.close();
  });

  it('FR-C6 atomic: the state change, the fix-round event and the handled-removal mark commit together', async () => {
    const { engine, github } = laneProject(dirs);
    const work = acceptedWork(engine, 'Atomic ejection');
    engine.ctx.store.saveLanePrRecord(prRecord(work.id, 7));
    github.pullRequests!['fixture/project'] = [fixturePr(work.id, 7, ejectedPr())];
    const save = engine.ctx.store.saveLanePrRecord.bind(engine.ctx.store);
    const failing = vi.spyOn(engine.ctx.store, 'saveLanePrRecord').mockImplementation((record) => {
      if (record.handledQueueRemovalId) throw new Error('record write failed');
      return save(record);
    });
    await expect(engine.refreshLanePullRequest(work.id)).rejects.toThrow('record write failed');
    expect(engine.ctx.store.getWork(work.id).currentState).toBe('ACCEPTED');
    expect(events(engine, work.id, 'lane.queue-ejected')).toHaveLength(0);
    expect(events(engine, work.id, 'task.changes-requested')).toHaveLength(0);
    failing.mockRestore();
    const retried = await engine.refreshLanePullRequest(work.id);
    expect(retried.fixRound).toBe(1);
    expect(retried.work.currentState).toBe('CHANGES_REQUESTED');
    expect(engine.ctx.store.getLanePrRecord(work.id)).toMatchObject({ handledQueueRemovalId: 'rm_1' });
    expect(events(engine, work.id, 'lane.queue-ejected')).toHaveLength(1);
    expect(events(engine, work.id, 'task.changes-requested')).toHaveLength(1);
    engine.ctx.store.close();
  });

  it('FR-G suspend: a committed policy pass evaluates suspendWhen even when PR automation throws', async () => {
    const { engine } = laneProject(dirs, { policy: SUSPENDING_POLICY });
    const net = flaky(engine);
    const id = await readyForPolicyAcceptance(engine);
    seedAuditProblem(engine, engine.createTask({ title: 'Earlier merge', text: 'Earlier merge.' }).id);
    expect(engine.ctx.store.getLanePolicy('routine')?.status).toBe('active');
    await expect(engine.syncFromMarkdown(id)).rejects.toThrow('github down');
    expect(engine.ctx.store.getWork(id).currentState).toBe('ACCEPTED');
    expect(net.requests.some((request) => request.capability === 'pr.create')).toBe(true);
    expect(engine.ctx.store.getLanePolicy('routine')).toMatchObject({ status: 'suspended' });
    engine.ctx.store.close();
  }, 120_000);

  it('FR-C2 head: turbine/gate is not published for a PR whose head has not caught up, or whose base or branch moved', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Lagging remote', text: 'Do not publish on a stale head.' });
    const oldSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const input = { authorizationId: AUTH, store: engine.ctx.store, work, headSha: oldSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy: policyNow(engine), gatePassSha: oldSha };
    await ensureAcceptedPr(input);
    const pr = github.pullRequests!['fixture/project']![0]!;
    const newSha = `${oldSha.startsWith('a') ? 'b' : 'a'}${oldSha.slice(1)}`;
    const record = await ensureAcceptedPr({ ...input, headSha: newSha, gatePassSha: newSha });
    expect(record).toMatchObject({ headSha: newSha, gateState: 'pending', queueState: 'not-enabled' });
    expect(record.statusPublished).toBeUndefined();
    expect(github.statuses?.[`fixture/project@${newSha}`]).toBeUndefined();
    expect(landingIncomplete(record, { headSha: newSha, authorizationId: AUTH, gatePassSha: newSha, policy: true })).toBe(true);
    // Once the remote caught up, the owed publication and the queue request complete.
    pr.headSha = newSha;
    expect(await ensureAcceptedPr({ ...input, headSha: newSha, gatePassSha: newSha })).toMatchObject({ statusPublished: { sha: newSha, state: 'success' }, queueState: 'queued' });
    // A PR retargeted to another base or branch is refused before anything is published.
    const statuses = github.statuses![`fixture/project@${newSha}`]!.length;
    pr.base = 'release';
    await expect(ensureAcceptedPr({ ...input, headSha: newSha, gatePassSha: newSha })).rejects.toThrow(/base is release/);
    pr.base = 'main';
    pr.head = 'someone/else';
    await expect(ensureAcceptedPr({ ...input, headSha: newSha, gatePassSha: newSha })).rejects.toThrow(/head is someone\/else/);
    expect(github.statuses![`fixture/project@${newSha}`]).toHaveLength(statuses);
    engine.ctx.store.close();
  });

  it('FR-C6 adopt: an existing open PR is adopted past the removals GitHub already shows; unreadable history is not adopted', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Adopted PR', text: 'Adopt an open PR.' });
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const existing = fixturePr(work.id, 1, { headSha, mergeQueueState: 'ejected', queueReason: 'an earlier failure', queueRemovalId: 'rm_old' });
    github.pullRequests!['fixture/project'] = [existing];
    const input = { authorizationId: AUTH, store: engine.ctx.store, work, headSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools };
    // History that cannot be read proves nothing about earlier removals: nothing is recorded, a retry can adopt.
    existing.queueStateKnown = false;
    await expect(ensureAcceptedPr(input)).rejects.toThrow(/could not be read/);
    expect(engine.ctx.store.getLanePrRecord(work.id)).toBeUndefined();
    existing.queueStateKnown = true;
    const record = await ensureAcceptedPr(input);
    expect(record).toMatchObject({ number: 1, queueBaselineRemovalId: 'rm_old' });
    // The removal that predates the adoption is not an ejection of this attempt; a newer one is.
    expect((await refreshLanePr({ store: engine.ctx.store, workId: work.id, target: engine.lanePrTarget! })).kind).toBe('open');
    existing.queueRemovalId = 'rm_new';
    expect((await refreshLanePr({ store: engine.ctx.store, workId: work.id, target: engine.lanePrTarget! })).kind).toBe('ejected');
    // A same-PR new attempt also refuses to start from unreadable history.
    existing.queueStateKnown = false;
    await expect(ensureAcceptedPr({ ...input, authorizationId: 'dec_auth_2' })).rejects.toThrow(/could not be read/);
    expect(engine.ctx.store.getLanePrRecord(work.id)?.authorizationId).toBe(AUTH);
    engine.ctx.store.close();
  });

  it('FR-C1 bound: the evidence gate is read when the queued job runs, not when it was queued', async () => {
    const { engine, github } = laneProject(dirs, { approved: false });
    const { work, head } = await acceptByHuman(engine, 'Gate moves in the queue');
    // Human acceptance is often CONCERNS (acceptable) — not PASS. If the job reused a queue-time snapshot
    // it would publish pending; a job-time PASS must publish success instead.
    expect(engine.gateDecision(work.id).acceptable).toBe(true);
    expect(engine.gateDecision(work.id).decision).not.toBe('PASS');
    const gate = vi.spyOn(Engine.prototype, 'gateDecision').mockReturnValue({
      decision: 'PASS',
      acceptable: true,
      blocking: [],
      waived: [],
    } as ReturnType<Engine['gateDecision']>);
    try {
      await engine.waitForLanePr();
      expect(gate).toHaveBeenCalled();
      expect(github.statuses?.[`fixture/project@${head}`]?.at(-1)).toMatchObject({ context: 'turbine/gate', state: 'success' });
      expect(engine.ctx.store.getLanePrRecord(work.id)).toMatchObject({ gateState: 'success' });
    } finally {
      gate.mockRestore();
    }
    engine.ctx.store.close();
  }, 120_000);

  it('FR-C6 reachable: `turbine task pr-refresh` is an operator command', async () => {
    const { dir, engine } = laneProject(dirs);
    const work = acceptedWork(engine, 'CLI refresh');
    engine.ctx.store.close();
    const here = dirname(fileURLToPath(import.meta.url));
    const factory = resolve(here, '../..');
    const run = (args: string[]) =>
      spawnSync(join(factory, 'node_modules', '.bin', 'tsx'), [join(factory, 'apps', 'cli', 'src', 'index.ts'), ...args], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, INIT_CWD: dir, PWD: dir }, input: '',
      });
    const help = run(['task', 'pr-refresh', '--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Poll the recorded PR');
    const refused = run(['task', 'pr-refresh', work.id]);
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toMatch(/GitHub repository|No PR recorded/);
  }, 60_000);
});

type FetchRoute = (url: string) => unknown;
function stubGitHub(route: FetchRoute) {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const body = route(String(input));
    if (body instanceof Error) return new Response('{}', { status: 500, statusText: body.message });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}
const live = () => createGitHubAdapter({ token: 'test-token' });
const invokeLive = (capability: 'repo.rules.read' | 'pr.read', args: Record<string, unknown>) =>
  live().invoke({ capability, workId: 'w', arguments: { owner: 'o', repo: 'r', ...args }, correlationId: 'c' }) as Promise<{ data: Record<string, unknown> }>;

describe('Part C GitHub adapter live rules and queue state', () => {
  const queueRule = { type: 'merge_queue', parameters: {} };
  const gateRule = { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'turbine/gate' }] } };
  const seen: string[] = [];
  const rulesFor = (rules: unknown) => (url: string) => {
    seen.push(url);
    return rules;
  };

  it('FR-C4: the exact branch is evaluated by GitHub ("Get rules for a branch"), never by local pattern matching', async () => {
    seen.length = 0;
    stubGitHub(rulesFor([queueRule, gateRule]));
    expect((await invokeLive('repo.rules.read', { branch: 'release/1.0' })).data).toMatchObject({ status: 'confirmed', mergeQueueRequired: true, turbineGateRequired: true });
    expect(seen[0]).toContain('/repos/o/r/rules/branches/release%2F1.0?');
    expect(seen.some((url) => url.includes('/rulesets'))).toBe(false);
    stubGitHub(rulesFor([gateRule]));
    expect((await invokeLive('repo.rules.read', { branch: 'main' })).data).toMatchObject({ status: 'confirmed', mergeQueueRequired: false, turbineGateRequired: true });
    stubGitHub(rulesFor([]));
    expect((await invokeLive('repo.rules.read', { branch: 'main' })).data).toMatchObject({ status: 'confirmed', mergeQueueRequired: false, turbineGateRequired: false });
  });

  it('FR-C4: an unreadable, malformed or oversized rules answer is unknown, not a guess', async () => {
    stubGitHub(rulesFor(new Error('forbidden')));
    expect((await invokeLive('repo.rules.read', { branch: 'main' })).data).toMatchObject({ status: 'unknown' });
    stubGitHub(rulesFor({ message: 'not a list' }));
    expect((await invokeLive('repo.rules.read', { branch: 'main' })).data).toMatchObject({ status: 'unknown' });
    stubGitHub(rulesFor([queueRule, 'garbage']));
    expect((await invokeLive('repo.rules.read', { branch: 'main' })).data).toMatchObject({ status: 'unknown' });
    stubGitHub(rulesFor([{ type: 'required_status_checks', parameters: {} }]));
    expect((await invokeLive('repo.rules.read', { branch: 'main' })).data).toMatchObject({ status: 'unknown' });
    // A full page every time never ends: the page budget stops the walk and reports unknown.
    const full = Array.from({ length: 100 }, () => ({ type: 'deletion' }));
    stubGitHub(rulesFor(full));
    expect((await invokeLive('repo.rules.read', { branch: 'main' })).data).toMatchObject({ status: 'unknown' });
  });

  it('FR-C4: rules on a later page still count', async () => {
    const full = Array.from({ length: 100 }, () => ({ type: 'deletion' }));
    stubGitHub((url) => (new URL(url).searchParams.get('page') === '1' ? full : [queueRule, gateRule]));
    expect((await invokeLive('repo.rules.read', { branch: 'main' })).data).toMatchObject({ status: 'confirmed', mergeQueueRequired: true, turbineGateRequired: true });
  });

  const enqueueArgs = { owner: 'o', repo: 'r', number: 3, nodeId: 'PR_3', mode: 'queue-only', expectedHeadOid: 'abc1234' };
  const mergeLive = (args: Record<string, unknown>) =>
    live().invoke({ capability: 'pr.merge', workId: 'w', arguments: args, correlationId: 'c' });
  const captureGraphql = (response: unknown) => {
    const bodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(response), { status: 200 });
    });
    return bodies;
  };

  it('FR-C3: a PR is enqueued for exactly the accepted head (expectedHeadOid) with the queue-only mutation', async () => {
    const bodies = captureGraphql({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'mqe_1' } } } });
    await mergeLive(enqueueArgs);
    expect(bodies[0]!.query).toContain('enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$oid})');
    expect(bodies[0]!.query).toContain('mergeQueueEntry{id}');
    expect(bodies[0]!.variables).toMatchObject({ id: 'PR_3', oid: 'abc1234' });
    await expect(mergeLive({ ...enqueueArgs, expectedHeadOid: undefined })).rejects.toThrow(/expectedHeadOid is required/);
    expect(bodies).toHaveLength(1);
  });

  it('FR-C3 queue-only: ordinary auto-merge is never used, and anything but a queue entry fails closed (retryable)', async () => {
    const bodies = captureGraphql({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'mqe_1' } } } });
    await mergeLive(enqueueArgs);
    expect(bodies.map((body) => body.query).join('\n')).not.toContain('enablePullRequestAutoMerge');
    // Only the queue-only mode exists: no direct merge, no admin bypass, no auto-merge fallback.
    await expect(mergeLive({ ...enqueueArgs, mode: 'auto-merge-only' })).rejects.toThrow(/only supports mode "queue-only"/);
    await expect(mergeLive({ ...enqueueArgs, mode: undefined })).rejects.toThrow(/only supports mode "queue-only"/);
    expect(bodies).toHaveLength(1);
    // The PR is not ready / the repository has no queue: GitHub answers with an error or with no entry.
    captureGraphql({ errors: [{ message: 'Pull request is not ready to be enqueued' }] });
    await expect(mergeLive(enqueueArgs)).rejects.toThrow(/not ready to be enqueued/);
    captureGraphql({ data: { enqueuePullRequest: { mergeQueueEntry: null } } });
    await expect(mergeLive(enqueueArgs)).rejects.toThrow(/did not return a merge-queue entry/);
    captureGraphql({ data: { enqueuePullRequest: null } });
    await expect(mergeLive(enqueueArgs)).rejects.toThrow(/did not return a merge-queue entry/);
  });

  it('FR-C3: the fixture adapter also refuses to enqueue when the head is not the expected one', async () => {
    const github = { pullRequests: { 'o/r': [{ number: 3, nodeId: 'PR_3', url: 'https://github.com/o/r/pull/3', head: 'h', headSha: 'aaaaaaa', base: 'main', state: 'open' as const }] } };
    const adapter = createGitHubAdapter({ fixtures: github });
    await expect(
      adapter.invoke({ capability: 'pr.merge', workId: 'w', arguments: { owner: 'o', repo: 'r', number: 3, mode: 'queue-only', expectedHeadOid: 'bbbbbbb' }, correlationId: 'c' }),
    ).rejects.toThrow(/not the expected head/);
    expect((github.pullRequests['o/r'][0] as { mergeQueueState?: string }).mergeQueueState).toBeUndefined();
  });

  const prJson = { number: 3, node_id: 'PR_3', html_url: 'https://github.com/o/r/pull/3', state: 'open', merged: false, head: { sha: 'abc1234', ref: 'turbine/w' }, base: { ref: 'main' } };
  const prRoutes = (graphql: unknown) => (url: string) => (url.endsWith('/graphql') ? graphql : prJson);

  it('FR-C6: pr.read reports ejection only with a GitHub removal reason, else nothing', async () => {
    const removed = (reason: string | null) => ({ data: { node: { mergeQueueEntry: null, timelineItems: { nodes: [{ __typename: 'RemovedFromMergeQueueEvent', id: 'rm_9', reason }] } } } });
    stubGitHub(prRoutes(removed('required check failed')));
    expect((await invokeLive('pr.read', { number: 3 })).data).toMatchObject({ mergeQueueState: 'ejected', queueReason: 'required check failed', queueRemovalId: 'rm_9' });
    stubGitHub(prRoutes(removed(null)));
    expect((await invokeLive('pr.read', { number: 3 })).data.mergeQueueState).toBeUndefined();
    stubGitHub(prRoutes({ data: { node: { mergeQueueEntry: null, timelineItems: { nodes: [{ __typename: 'AddedToMergeQueueEvent' }] } } } }));
    expect((await invokeLive('pr.read', { number: 3 })).data.mergeQueueState).toBeUndefined();
    stubGitHub(prRoutes({ errors: [{ message: 'forbidden' }] }));
    expect((await invokeLive('pr.read', { number: 3 })).data.mergeQueueState).toBeUndefined();
    stubGitHub(prRoutes({ data: { node: { mergeQueueEntry: { id: 'e' }, timelineItems: { nodes: [] } } } }));
    expect((await invokeLive('pr.read', { number: 3 })).data.mergeQueueState).toBe('queued');
  });

  it('FR-C6: pr.read says whether the merge-queue history was readable, so "no removal" is never guessed', async () => {
    stubGitHub(prRoutes({ data: { node: { mergeQueueEntry: null, timelineItems: { nodes: [] } } } }));
    expect((await invokeLive('pr.read', { number: 3 })).data).toMatchObject({ queueStateKnown: true });
    expect((await invokeLive('pr.read', { number: 3 })).data.queueRemovalId).toBeUndefined();
    stubGitHub(prRoutes({ errors: [{ message: 'forbidden' }] }));
    expect((await invokeLive('pr.read', { number: 3 })).data).toMatchObject({ queueStateKnown: false });
    stubGitHub(prRoutes({ data: { node: null } }));
    expect((await invokeLive('pr.read', { number: 3 })).data).toMatchObject({ queueStateKnown: false });
  });

  it('FR-C6: pr.read names the newest removal even while re-queued, so an old removal can be told from a new one', async () => {
    stubGitHub(prRoutes({ data: { node: { mergeQueueEntry: { id: 'e' }, timelineItems: { nodes: [{ __typename: 'RemovedFromMergeQueueEvent', id: 'rm_1', reason: 'conflict' }, { __typename: 'AddedToMergeQueueEvent' }] } } } }));
    expect((await invokeLive('pr.read', { number: 3 })).data).toMatchObject({ mergeQueueState: 'queued', queueRemovalId: 'rm_1' });
    // A removal without an event id cannot be told apart from an old one: nothing is reported.
    stubGitHub(prRoutes({ data: { node: { mergeQueueEntry: null, timelineItems: { nodes: [{ __typename: 'RemovedFromMergeQueueEvent', reason: 'conflict' }] } } } }));
    expect((await invokeLive('pr.read', { number: 3 })).data.mergeQueueState).toBeUndefined();
  });
});
