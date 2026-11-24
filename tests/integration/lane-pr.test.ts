import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitHubAdapter } from '../../packages/adapter-github/dist/index.js';
import { confirmMergeQueueProtection, ensureAcceptedPr, refreshLanePr } from '../../apps/cli/src/engine/lane-pr.js';
import { cleanup, git } from './fixture.js';
import { acceptByHuman, laneProject, ROUTINE_POLICY } from './lane-fixture.js';

const dirs: string[] = [];
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
    const input = { store: engine.ctx.store, work, headSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy: policyNow(engine) };
    const first = await ensureAcceptedPr(input);
    github.pullRequests!['fixture/project']![0]!.state = 'closed';
    const replacement = await ensureAcceptedPr({ ...input, gatePassSha: headSha });
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
    const record = await ensureAcceptedPr({ store: engine.ctx.store, work, headSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy, gatePassSha: headSha });
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
      ensureAcceptedPr({ store: engine.ctx.store, work, headSha, target: switched, tools: engine.ctx.config.tools }),
    ).rejects.toThrow(/targets fixture\/project:main/);
    engine.ctx.store.close();
  });

  it('FR-C7 retarget: auto-merge is refused when the live PR base or head moved', async () => {
    const { dir, engine, github } = laneProject(dirs);
    const work = engine.createTask({ title: 'Retargeted', text: 'Refuse a retargeted PR.' });
    const headSha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    const input = { store: engine.ctx.store, work, headSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy: policyNow(engine) };
    await ensureAcceptedPr(input); // gate pending: no merge yet
    const pr = github.pullRequests!['fixture/project']![0]!;
    pr.base = 'release';
    await expect(ensureAcceptedPr({ ...input, gatePassSha: headSha })).rejects.toThrow(/base is release/);
    pr.base = 'main';
    pr.headSha = 'ffffffffffff';
    await expect(ensureAcceptedPr({ ...input, gatePassSha: headSha })).rejects.toThrow(/is not accepted head/);
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
    const record = await ensureAcceptedPr({ store: engine.ctx.store, work, headSha, target: engine.lanePrTarget!, tools: engine.ctx.config.tools, policy: policyNow(engine), gatePassSha: headSha });
    expect(record.queueState).toBe('not-enabled');
    github.pullRequests!['fixture/project']![0]!.mergeQueueState = 'queued';
    expect((await refreshLanePr({ store: engine.ctx.store, workId: work.id, target: engine.lanePrTarget! })).record.queueState).toBe('queued');
    engine.ctx.store.close();
  });
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
  const rulesetRoutes = (include: string[], defaultBranch: string | Error, exclude: string[] = []) => (url: string) => {
    if (url.includes('/rulesets?')) return [{ id: 1, enforcement: 'active' }];
    if (url.includes('/rulesets/1')) {
      return {
        target: 'branch',
        conditions: { ref_name: { include, exclude } },
        rules: [{ type: 'merge_queue' }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'turbine/gate' }] } }],
      };
    }
    return defaultBranch instanceof Error ? defaultBranch : { default_branch: defaultBranch };
  };

  it('FR-C4: ~DEFAULT_BRANCH only counts for the repo default branch', async () => {
    stubGitHub(rulesetRoutes(['~DEFAULT_BRANCH'], 'develop'));
    expect((await invokeLive('repo.rules.read', { branch: 'main' })).data).toMatchObject({ status: 'confirmed', mergeQueueRequired: false, turbineGateRequired: false });
    expect((await invokeLive('repo.rules.read', { branch: 'develop' })).data).toMatchObject({ mergeQueueRequired: true, turbineGateRequired: true });
  });

  it('FR-C4: an unreadable default branch or an unevaluable pattern is unknown, not a match', async () => {
    stubGitHub(rulesetRoutes(['~DEFAULT_BRANCH'], new Error('forbidden')));
    expect((await invokeLive('repo.rules.read', { branch: 'main' })).data).toMatchObject({ status: 'unknown' });
    stubGitHub(rulesetRoutes(['refs/heads/[mn]ain'], 'main'));
    expect((await invokeLive('repo.rules.read', { branch: 'main' })).data).toMatchObject({ status: 'unknown' });
  });

  it('FR-C4: globs and excludes apply to the exact base branch', async () => {
    stubGitHub(rulesetRoutes(['refs/heads/release/*'], 'main'));
    expect((await invokeLive('repo.rules.read', { branch: 'main' })).data).toMatchObject({ status: 'confirmed', mergeQueueRequired: false });
    stubGitHub(rulesetRoutes(['refs/heads/ma*'], 'main'));
    expect((await invokeLive('repo.rules.read', { branch: 'main' })).data).toMatchObject({ mergeQueueRequired: true });
    stubGitHub(rulesetRoutes(['~ALL'], 'main', ['refs/heads/main']));
    expect((await invokeLive('repo.rules.read', { branch: 'main' })).data).toMatchObject({ mergeQueueRequired: false });
  });

  const prJson = { number: 3, node_id: 'PR_3', html_url: 'https://github.com/o/r/pull/3', state: 'open', merged: false, head: { sha: 'abc1234', ref: 'turbine/w' }, base: { ref: 'main' } };
  const prRoutes = (graphql: unknown) => (url: string) => (url.endsWith('/graphql') ? graphql : prJson);

  it('FR-C6: pr.read reports ejection only with a GitHub removal reason, else nothing', async () => {
    const removed = (reason: string | null) => ({ data: { node: { mergeQueueEntry: null, timelineItems: { nodes: [{ __typename: 'RemovedFromMergeQueueEvent', reason }] } } } });
    stubGitHub(prRoutes(removed('required check failed')));
    expect((await invokeLive('pr.read', { number: 3 })).data).toMatchObject({ mergeQueueState: 'ejected', queueReason: 'required check failed' });
    stubGitHub(prRoutes(removed(null)));
    expect((await invokeLive('pr.read', { number: 3 })).data.mergeQueueState).toBeUndefined();
    stubGitHub(prRoutes({ data: { node: { mergeQueueEntry: null, timelineItems: { nodes: [{ __typename: 'AddedToMergeQueueEvent' }] } } } }));
    expect((await invokeLive('pr.read', { number: 3 })).data.mergeQueueState).toBeUndefined();
    stubGitHub(prRoutes({ errors: [{ message: 'forbidden' }] }));
    expect((await invokeLive('pr.read', { number: 3 })).data.mergeQueueState).toBeUndefined();
    stubGitHub(prRoutes({ data: { node: { mergeQueueEntry: { id: 'e' }, timelineItems: { nodes: [] } } } }));
    expect((await invokeLive('pr.read', { number: 3 })).data.mergeQueueState).toBe('queued');
  });
});
