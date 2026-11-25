/**
 * Autonomous lane Part D — sandboxed-unattended executor (AC14–AC15, FR-D1–D6).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createFixtureImplementer,
  forbiddenMountPaths,
  planSandboxMounts,
  preflightSandbox,
  runSandboxedStateMachine,
  type SandboxHooks,
  type SandboxPhase,
} from '../../packages/executor/dist/index.js';
import { cleanup } from './fixture.js';
import { laneProject, toRequirementsGate } from './lane-fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

async function toPlanApproved(engine: ReturnType<typeof laneProject>['engine']) {
  const work = await toRequirementsGate(engine);
  await engine.syncFromMarkdown(work.id); // requirements → REQUIREMENTS_APPROVED (policy)
  await engine.syncFromMarkdown(work.id); // plan → PLAN_APPROVED (policy)
  return engine.ctx.store.getWork(work.id);
}

function fixtureHooks(opts: {
  runtime?: 'docker' | 'podman' | undefined;
  egressSucceeds?: boolean;
  checksOk?: boolean | ((attempt: number) => boolean);
  commitOk?: boolean;
}): SandboxHooks {
  let checkAttempt = 0;
  return {
    detectRuntime: () => opts.runtime,
    egressProbeSucceeds: () => opts.egressSucceeds ?? false,
    runPhase: async (phase: SandboxPhase, ctx) => {
      if (phase === 'checks') {
        checkAttempt += 1;
        const ok =
          typeof opts.checksOk === 'function' ? opts.checksOk(ctx.attempt || checkAttempt) : (opts.checksOk ?? true);
        return { ok, report: ok ? 'checks passed' : `checks failed attempt ${checkAttempt}`, outputBytes: 20 };
      }
      if (phase === 'commit') {
        return { ok: opts.commitOk ?? true, report: 'commit', outputBytes: 8 };
      }
      return { ok: true, report: `${phase} ok`, outputBytes: 8 };
    },
  };
}

describe('Part D sandboxed-unattended executor', () => {
  it('AC14 / FR-D1: mount plan forbids home/SSH/credentials/state (planning boundary)', async () => {
    const { dir, engine } = laneProject(dirs);
    engine.ctx.config.execution.mode = 'sandboxed-unattended';
    engine.sandboxHooks = fixtureHooks({ runtime: 'docker' });
    engine.sandboxImplementer = createFixtureImplementer({
      commits: ['abc123'],
      usage: { inputTokens: 1, outputTokens: 2, modelId: 'fixture', provider: 'fixture' },
    });

    const work = await toPlanApproved(engine);
    await engine.execute(work.id);

    const prepared = engine.ctx.store.listEvents(work.id).find((e) => e.type === 'execution.prepared')!;
    const payload = prepared.payload as {
      mode: string;
      runtime: string;
      worktreePath: string;
      forbiddenMounts: string[];
    };
    expect(payload.mode).toBe('sandboxed-unattended');
    expect(payload.runtime).toBe('docker');
    expect(payload.worktreePath).toContain(work.id);
    expect(payload.worktreePath).not.toContain(`${resolve(dir, '.turbine', 'state')}`);

    const forbidden = forbiddenMountPaths(dir, '/tmp/fake-home');
    expect(forbidden).toEqual(
      expect.arrayContaining([
        resolve(dir, '.turbine', 'state'),
        resolve('/tmp/fake-home'),
        resolve('/tmp/fake-home', '.ssh'),
        resolve('/tmp/fake-home', '.git-credentials'),
        resolve('/tmp/fake-home', '.netrc'),
      ]),
    );
    for (const f of payload.forbiddenMounts) {
      if (f === resolve('/tmp/fake-home')) continue; // listed as forbidden mount, not as worktree parent ban
      expect(f === payload.worktreePath || payload.worktreePath.startsWith(`${f}/`)).toBe(false);
    }
    const plan = planSandboxMounts({
      worktreePath: payload.worktreePath,
      projectRoot: dir,
      runtime: 'docker',
      home: '/tmp/fake-home',
    });
    expect(plan.worktreePath).toBe(realpathSync(payload.worktreePath));
    expect(plan.forbiddenMounts).toEqual(
      expect.arrayContaining([
        realpathSync(resolve(dir, '.turbine', 'state')),
        resolve('/tmp/fake-home'),
        resolve('/tmp/fake-home', '.ssh'),
      ]),
    );
    void forbidden;
    engine.ctx.store.close();
  });

  it('FR-D1: isolated worktree under $HOME is allowed; home itself and .turbine/state overlap are refused', () => {
    const home = mkdtempSync(join(tmpdir(), 'turbine-home-'));
    dirs.push(home);
    const project = join(home, 'project');
    const wt = join(project, 'worktrees', 'task-1');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'README'), 'ok');
    mkdirSync(join(project, '.turbine', 'state'), { recursive: true });

    const plan = planSandboxMounts({
      worktreePath: wt,
      projectRoot: project,
      runtime: 'docker',
      home,
    });
    expect(plan.worktreePath).toBe(realpathSync(wt));

    expect(() =>
      planSandboxMounts({ worktreePath: home, projectRoot: project, runtime: 'docker', home }),
    ).toThrow(/home directory/i);

    expect(() =>
      planSandboxMounts({ worktreePath: project, projectRoot: project, runtime: 'docker', home }),
    ).toThrow(/overlaps forbidden path/);
  });

  it('AC14 / FR-D3: missing runtime refuses start and never falls back to unsandboxed', async () => {
    const { engine } = laneProject(dirs);
    engine.ctx.config.execution.mode = 'sandboxed-unattended';
    engine.sandboxHooks = fixtureHooks({ runtime: undefined });
    engine.sandboxImplementer = createFixtureImplementer({ commits: ['should-not-run'] });

    const work = await toPlanApproved(engine);
    await expect(engine.execute(work.id)).rejects.toThrow(/E_UNSAFE_EXECUTION|requires Docker or Podman/);
    expect(engine.ctx.store.getWork(work.id).currentState).toBe('PLAN_APPROVED');
    expect(engine.ctx.store.listEvents(work.id).some((e) => e.type === 'execution.sandboxed')).toBe(false);
    expect(engine.ctx.store.listUsageRecords(work.id)).toHaveLength(0);
    engine.ctx.store.close();
  });

  it('AC14 / FR-D3: successful egress probe refuses start (no unsandboxed fallback)', async () => {
    const { engine } = laneProject(dirs);
    engine.ctx.config.execution.mode = 'sandboxed-unattended';
    engine.sandboxHooks = fixtureHooks({ runtime: 'podman', egressSucceeds: true });
    engine.sandboxImplementer = createFixtureImplementer({ ok: true });
    const work = await toPlanApproved(engine);
    await expect(engine.execute(work.id)).rejects.toThrow(/egress probe succeeded|E_UNSAFE_EXECUTION|inconclusive/);
    expect(engine.ctx.store.listEvents(work.id).some((e) => e.type === 'execution.sandboxed')).toBe(false);
    engine.ctx.store.close();
  });

  it('FR-D3: allowNetwork outside sandboxed-unattended still raises E_UNSAFE_EXECUTION', async () => {
    const { engine } = laneProject(dirs);
    engine.ctx.config.execution.mode = 'manual-supervised';
    engine.ctx.config.execution.allowNetwork = true;
    const work = await toPlanApproved(engine);
    await expect(engine.execute(work.id)).rejects.toThrow(/E_UNSAFE_EXECUTION|sandboxed-unattended/);
    engine.ctx.store.close();
  });

  it('FR-D1: host check execution is refused until a container phase runner is bound', async () => {
    const { engine } = laneProject(dirs);
    engine.ctx.config.execution.mode = 'sandboxed-unattended';
    engine.ctx.config.quality.checks = ['node lint.mjs'];
    engine.ctx.config.budgets.perTask.maxExecutionAttempts = 1;
    // Preflight-only: no sandboxHooks phase runner — Engine refuseHostPhase must fire.
    engine.sandboxPreflightHooks = {
      detectRuntime: () => 'docker',
      egressProbeSucceeds: () => false,
    };
    engine.sandboxImplementer = createFixtureImplementer({ ok: true, commits: ['c'] });
    const work = await toPlanApproved(engine);
    const result = await engine.execute(work.id);
    expect(result.work.currentState).toBe('CHANGES_REQUESTED');
    const refused = engine.ctx.store.listEvents(work.id).some((e) => {
      const p = e.payload as { reason?: string; reportsUnverified?: string[] };
      return (
        (typeof p.reason === 'string' && /host execution refused/i.test(p.reason)) ||
        p.reportsUnverified?.some((r) => /host execution refused/i.test(r)) === true
      );
    });
    expect(refused).toBe(true);
    engine.ctx.store.close();
  });

  it('FR-D3: sandbox checks respect tools.denied tests.run (same as verify)', async () => {
    const { engine } = laneProject(dirs);
    engine.ctx.config.execution.mode = 'sandboxed-unattended';
    engine.ctx.config.budgets.perTask.maxExecutionAttempts = 1;
    engine.ctx.config.tools.denied.push('tests.run');
    engine.sandboxHooks = fixtureHooks({ runtime: 'docker', checksOk: true });
    engine.sandboxImplementer = createFixtureImplementer({ ok: true, commits: ['x'] });
    const work = await toPlanApproved(engine);
    const result = await engine.execute(work.id);
    expect(result.work.currentState).toBe('CHANGES_REQUESTED');
    expect(
      engine.ctx.store.listEvents(work.id).some((e) => {
        const p = e.payload as { reason?: string; reportsUnverified?: string[] };
        return (
          (typeof p.reason === 'string' && /tests\.run/.test(p.reason)) ||
          p.reportsUnverified?.some((r) => /tests\.run/.test(r))
        );
      }),
    ).toBe(true);
    engine.ctx.store.close();
  });

  it('FR-D3: sandboxed-unattended without a bound implementer refuses before IMPLEMENTING', async () => {
    const { engine } = laneProject(dirs);
    engine.ctx.config.execution.mode = 'sandboxed-unattended';
    engine.sandboxHooks = fixtureHooks({ runtime: 'docker' });
    // no sandboxImplementer
    const work = await toPlanApproved(engine);
    await expect(engine.execute(work.id)).rejects.toThrow(/bound agent implementer|E_UNSAFE_EXECUTION/);
    expect(engine.ctx.store.getWork(work.id).currentState).toBe('PLAN_APPROVED');
    engine.ctx.store.close();
  });

  it('AC15 / FR-D2: fix cap leaves lane — after maxExecutionAttempts failed checks → CHANGES_REQUESTED + out of lane', async () => {
    const { engine } = laneProject(dirs);
    engine.ctx.config.execution.mode = 'sandboxed-unattended';
    engine.ctx.config.budgets.perTask.maxExecutionAttempts = 2;
    engine.sandboxHooks = fixtureHooks({ runtime: 'docker', checksOk: false });
    engine.sandboxImplementer = createFixtureImplementer({
      commits: ['deadbeef'],
      report: 'I fixed everything (unverified)',
      usage: { inputTokens: 3, outputTokens: 4, modelId: 'fixture', provider: 'fixture' },
    });

    const work = await toPlanApproved(engine);
    const result = await engine.execute(work.id);
    expect(result.work.currentState).toBe('CHANGES_REQUESTED');
    expect(engine.laneState(work.id).inLane).toBe(false);
    expect(engine.laneState(work.id).fallback?.reasons.join(' ')).toMatch(/max 2|execution attempts/i);

    const cap = engine.ctx.store.listEvents(work.id).find((e) => e.type === 'execution.fix-cap');
    expect(cap).toBeTruthy();
    expect((cap!.payload as { attempts: number }).attempts).toBe(2);
    engine.ctx.store.close();
  });

  it('FR-D2: after leave-lane, sync/execute does not restart sandboxed run without lane.retry', async () => {
    const { engine } = laneProject(dirs);
    engine.ctx.config.execution.mode = 'sandboxed-unattended';
    engine.ctx.config.budgets.perTask.maxExecutionAttempts = 1;
    engine.sandboxHooks = fixtureHooks({ runtime: 'docker', checksOk: false });
    engine.sandboxImplementer = createFixtureImplementer({ commits: ['c1'], ok: true });

    const work = await toPlanApproved(engine);
    await engine.execute(work.id);
    expect(engine.laneState(work.id).inLane).toBe(false);
    const sandboxedBefore = engine.ctx.store.listEvents(work.id).filter((e) => e.type === 'execution.sandboxed' || e.type === 'execution.fix-cap').length;

    // Sync from CHANGES_REQUESTED would call execute; without lane membership it must use supervised recovery.
    const again = await engine.execute(work.id);
    expect(again.work.currentState).toBe('IMPLEMENTING');
    expect(engine.laneState(work.id).inLane).toBe(false);
    const sandboxedAfter = engine.ctx.store.listEvents(work.id).filter((e) => e.type === 'execution.sandboxed' || e.type === 'execution.fix-cap').length;
    expect(sandboxedAfter).toBe(sandboxedBefore);
    engine.ctx.store.close();
  });

  it('FR-D4: agent adapter receives SPEC+PLAN+CONTEXT+knowledge and records usage with commits', async () => {
    const { engine } = laneProject(dirs);
    engine.ctx.config.execution.mode = 'sandboxed-unattended';
    let seen: { spec: string; plan: string; context: string; knowledge: string } | undefined;
    engine.sandboxHooks = fixtureHooks({ runtime: 'docker', checksOk: true });
    engine.sandboxImplementer = createFixtureImplementer({
      commits: ['cafebabe'],
      onRun: (input) => {
        seen = input;
      },
      usage: { inputTokens: 11, outputTokens: 7, modelId: 'fixture-model', provider: 'fixture' },
    });

    const work = await toPlanApproved(engine);
    await engine.execute(work.id);

    expect(seen).toBeTruthy();
    expect(seen!.spec.length).toBeGreaterThan(10);
    expect(seen!.plan.length).toBeGreaterThan(10);
    expect(seen!.context.length).toBeGreaterThan(0);
    expect(seen!.knowledge.length).toBeGreaterThan(0);

    const usage = engine.ctx.store.listUsageRecords(work.id);
    expect(usage.some((u) => u.source === 'agent' && u.agentName === 'fixture')).toBe(true);

    const done = engine.ctx.store.listEvents(work.id).find((e) => e.type === 'execution.sandboxed');
    expect((done!.payload as { commits: string[] }).commits).toContain('cafebabe');
    engine.ctx.store.close();
  });

  it('FR-D5: agent-reported summary alone is not evidence — only commits + checks count', async () => {
    const { engine } = laneProject(dirs);
    engine.ctx.config.execution.mode = 'sandboxed-unattended';
    engine.sandboxHooks = fixtureHooks({ runtime: 'docker', checksOk: true });
    engine.sandboxImplementer = createFixtureImplementer({
      commits: [],
      report: 'All acceptance criteria are fully satisfied without any commits.',
      ok: true,
    });

    const work = await toPlanApproved(engine);
    await engine.execute(work.id);

    const change = engine.ctx.store.getLatestArtifact(work.id, 'change-report');
    const body = JSON.parse(engine.ctx.store.getArtifactContent(change!.id)) as {
      status: string;
      summary: string;
      modelNotes?: { unverifiedReports?: string[]; commits?: string[] };
    };
    expect(body.status).toBe('sandboxed-incomplete');
    expect(body.summary).toMatch(/unverified|without an observed commit/i);
    expect(body.modelNotes?.unverifiedReports?.some((r) => /fully satisfied/i.test(r))).toBe(true);
    expect(engine.ctx.store.listEvidence(work.id).filter((e) => /agent|implementer/i.test(e.kind))).toHaveLength(0);
    engine.ctx.store.close();
  });

  it('FR-D2/D5: implement ok:false ends as phase-failed, not completed', async () => {
    const { engine } = laneProject(dirs);
    engine.ctx.config.execution.mode = 'sandboxed-unattended';
    engine.sandboxHooks = fixtureHooks({ runtime: 'docker', checksOk: true });
    engine.sandboxImplementer = createFixtureImplementer({
      ok: false,
      report: 'implementer failed',
      commits: [],
    });

    const work = await toPlanApproved(engine);
    const result = await engine.execute(work.id);
    expect(result.work.currentState).toBe('CHANGES_REQUESTED');
    expect(engine.ctx.store.listEvents(work.id).some((e) => e.type === 'execution.phase-failed')).toBe(true);
    expect(engine.ctx.store.listEvents(work.id).some((e) => e.type === 'execution.sandboxed')).toBe(false);
    engine.ctx.store.close();
  });

  it('FR-D6: wall-clock limit kills the run and records limit-exceeded with the limit name', async () => {
    const hooks: SandboxHooks = {
      detectRuntime: () => 'docker',
      egressProbeSucceeds: () => false,
      nowMs: (() => {
        let t = 0;
        return () => {
          t += 100;
          return t;
        };
      })(),
      runPhase: async () => ({ ok: true, report: 'slow', outputBytes: 4 }),
    };
    preflightSandbox(hooks);
    const result = await runSandboxedStateMachine({
      hooks,
      limits: { wallClockMs: 50, maxOutputBytes: 1_000_000, maxExecutionAttempts: 2 },
      mount: {
        worktreePath: '/tmp',
        forbiddenMounts: [],
        runtime: 'docker',
      },
    });
    expect(result.status).toBe('limit-exceeded');
    if (result.status === 'limit-exceeded') {
      expect(result.limitName).toBe('wall-clock');
      expect(result.reason).toMatch(/wall-clock/);
    }
  });

  it('FR-D6: output-size limit records limit-exceeded naming output-size', async () => {
    const hooks: SandboxHooks = {
      detectRuntime: () => 'docker',
      egressProbeSucceeds: () => false,
      runPhase: async () => ({ ok: true, report: 'x'.repeat(200), outputBytes: 200 }),
    };
    const result = await runSandboxedStateMachine({
      hooks,
      limits: { wallClockMs: 60_000, maxOutputBytes: 100, maxExecutionAttempts: 2 },
      mount: { worktreePath: '/tmp', forbiddenMounts: [], runtime: 'docker' },
    });
    expect(result.status).toBe('limit-exceeded');
    if (result.status === 'limit-exceeded') {
      expect(result.limitName).toBe('output-size');
    }
  });

  it('FR-D6: outputOverflow at exact remaining budget is still limit-exceeded', async () => {
    const hooks: SandboxHooks = {
      detectRuntime: () => 'docker',
      egressProbeSucceeds: () => false,
      runPhase: async (_phase, ctx) => ({
        ok: false,
        report: 'truncated',
        outputBytes: ctx.remainingOutputBytes,
        outputOverflow: true,
      }),
    };
    const result = await runSandboxedStateMachine({
      hooks,
      limits: { wallClockMs: 60_000, maxOutputBytes: 100, maxExecutionAttempts: 2 },
      mount: { worktreePath: '/tmp', forbiddenMounts: [], runtime: 'docker' },
    });
    expect(result.status).toBe('limit-exceeded');
    if (result.status === 'limit-exceeded') expect(result.limitName).toBe('output-size');
  });

  it('FR-D6: hung phase after abort records termination-not-confirmed', async () => {
    const hooks: SandboxHooks = {
      detectRuntime: () => 'docker',
      egressProbeSucceeds: () => false,
      runPhase: async (_phase, ctx) => {
        await new Promise<never>(() => {
          // Acknowledge abort but never settle — forces the grace-period path.
          ctx.signal.addEventListener('abort', () => {
            /* intentionally do not resolve */
          });
        });
        return { ok: false, report: 'unreachable', outputBytes: 0 };
      },
    };
    const result = await runSandboxedStateMachine({
      hooks,
      limits: { wallClockMs: 30, maxOutputBytes: 1_000_000, maxExecutionAttempts: 2 },
      mount: { worktreePath: '/tmp', forbiddenMounts: [], runtime: 'docker' },
    });
    expect(result.status).toBe('limit-exceeded');
    if (result.status === 'limit-exceeded') {
      expect(result.limitName).toBe('wall-clock');
      expect(result.workloadStopped).toBe(false);
      expect(result.reason).toMatch(/termination not confirmed/i);
    }
  }, 20_000);

  it('post-commit dirty evidence refuses completion', async () => {
    const hooks: SandboxHooks = {
      ...fixtureHooks({ runtime: 'docker', checksOk: true, commitOk: true }),
      readEvidence: () => ({ heads: { primary: 'abc' }, dirty: true }),
    };
    const result = await runSandboxedStateMachine({
      hooks,
      limits: { wallClockMs: 60_000, maxOutputBytes: 1_000_000, maxExecutionAttempts: 2 },
      mount: { worktreePath: '/tmp', forbiddenMounts: [], runtime: 'docker' },
    });
    expect(result.status).toBe('phase-failed');
    if (result.status === 'phase-failed') expect(result.reason).toMatch(/dirty/i);
  });

  it('FR-D6: AbortSignal is aborted when wall-clock expires during a hanging phase', async () => {
    let sawAbort = false;
    const hooks: SandboxHooks = {
      detectRuntime: () => 'docker',
      egressProbeSucceeds: () => false,
      runPhase: async (_phase, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve({ ok: false, report: 'aborted', outputBytes: 0 });
          });
        }),
    };
    const result = await runSandboxedStateMachine({
      hooks,
      limits: { wallClockMs: 30, maxOutputBytes: 1_000_000, maxExecutionAttempts: 2 },
      mount: { worktreePath: '/tmp', forbiddenMounts: [], runtime: 'docker' },
    });
    expect(result.status).toBe('limit-exceeded');
    expect(sawAbort).toBe(true);
  });

  it('commit phase ok:false does not complete', async () => {
    const hooks = fixtureHooks({ runtime: 'docker', checksOk: true, commitOk: false });
    const result = await runSandboxedStateMachine({
      hooks,
      limits: { wallClockMs: 60_000, maxOutputBytes: 1_000_000, maxExecutionAttempts: 2 },
      mount: { worktreePath: '/tmp', forbiddenMounts: [], runtime: 'docker' },
    });
    expect(result.status).toBe('phase-failed');
    if (result.status === 'phase-failed') expect(result.reason).toMatch(/commit failed/);
  });

  it('FR-D6 via engine: limit-exceeded moves to CHANGES_REQUESTED and leaves the lane', async () => {
    const { engine } = laneProject(dirs);
    engine.ctx.config.execution.mode = 'sandboxed-unattended';
    engine.ctx.config.execution.sandboxMaxOutputBytes = 40;
    engine.sandboxHooks = {
      detectRuntime: () => 'docker',
      egressProbeSucceeds: () => false,
      runPhase: async (phase) => {
        if (phase === 'checks') return { ok: true, report: 'ok', outputBytes: 8 };
        if (phase === 'commit') return { ok: true, report: 'ok', outputBytes: 8 };
        return { ok: true, report: 'y'.repeat(80), outputBytes: 80 };
      },
    };
    engine.sandboxImplementer = createFixtureImplementer({
      report: 'z'.repeat(80),
      commits: ['lim1'],
    });

    const work = await toPlanApproved(engine);
    const result = await engine.execute(work.id);
    expect(result.work.currentState).toBe('CHANGES_REQUESTED');
    expect(engine.laneState(work.id).inLane).toBe(false);
    const ev = engine.ctx.store.listEvents(work.id).find((e) => e.type === 'execution.limit-exceeded');
    expect(ev).toBeTruthy();
    expect((ev!.payload as { limitName?: string }).limitName).toBe('output-size');
    // Worktrees remain recoverable via change-report.
    expect(engine.repoStates(work.id).length).toBeGreaterThan(0);
    engine.ctx.store.close();
  });
});
