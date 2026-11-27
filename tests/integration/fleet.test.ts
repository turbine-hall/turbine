import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentHash, createId } from '../../packages/contracts/dist/index.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { openContext } from '../../apps/cli/src/engine/project.js';
import * as fleetLock from '../../apps/cli/src/engine/fleet-lock.js';
import {
  acquireFleetLock,
  fleetLockPath,
  pidAlive,
  readFleetLock,
  releaseFleetLock,
  renewFleetLock,
  takeoverDeadHolder,
  tryAcquireFence,
  tryAcquireRecoverGuard,
} from '../../apps/cli/src/engine/fleet-lock.js';
import { measureFleetSpend } from '../../apps/cli/src/engine/fleet-spend.js';
import { fleetStatus, runFleet } from '../../apps/cli/src/engine/fleet.js';
import {
  actualPathsFromChangeReport,
  blocksAdmit,
  comparePredictionToActual,
  parseFilePrediction,
  type FilePrediction,
} from '../../apps/cli/src/engine/file-prediction.js';
import { computeLaneMetrics } from '../../apps/cli/src/engine/lane-metrics.js';
import { suspendPolicy } from '../../apps/cli/src/engine/lane-policy.js';
import { cleanup, tempProject } from './fixture.js';
import { laneProject, writePolicy } from './lane-fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function makeReadyTask(dir: string, title: string) {
  const request = join(dir, `${title.replace(/\s+/g, '-').toLowerCase()}.md`);
  writeFileSync(request, `# ${title}\n\nA small docs chore for the fleet.\n`);
  const engine = new Engine(openContext(dir));
  const work = engine.createTask({ title, file: request, type: 'maintenance' });
  return { engine, work };
}

function plantPrediction(engine: Engine, workId: string, prediction: FilePrediction) {
  const body = `${JSON.stringify(prediction, null, 2)}\n`;
  engine.ctx.store.saveArtifact(
    {
      id: createId('art'),
      workId,
      type: 'file-prediction',
      revision: 1,
      contentHash: contentHash(prediction),
      contentType: 'application/json',
      location: join(engine.ctx.projectRoot, `.turbine/artifacts/${workId}-pred.json`),
      createdBy: { kind: 'tool', identifier: 'test' },
      createdAt: new Date().toISOString(),
      parentArtifactIds: [],
    },
    body,
  );
  writeFileSync(join(engine.ctx.projectRoot, `.turbine/artifacts/${workId}-pred.json`), body);
}

describe('fleet scheduler (Part E / #43)', () => {
  it('FR-002: unlock only after re-read; stale reclaim only after lease + logged event', async () => {
    const dir = tempProject('fleet-lock-', dirs);
    const workId = 'work_fleet_lock_1';
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const now = () => new Date(nowMs);

    const first = acquireFleetLock({ projectRoot: dir, workId, runId: 'fleet_run_a', leaseMs: 1_000, now });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(existsSync(fleetLockPath(dir, workId))).toBe(true);

    const held = acquireFleetLock({ projectRoot: dir, workId, runId: 'fleet_run_b', leaseMs: 1_000, now });
    expect(held.ok).toBe(false);

    const wrongRelease = releaseFleetLock({ projectRoot: dir, workId, owner: 'fleet:other:x' });
    expect(wrongRelease.released).toBe(false);
    expect(readFleetLock(dir, workId)?.owner).toBe(first.lock.owner);

    nowMs += 2_000;
    // Expired lease while holder pid is still alive must not reclaim.
    const aliveHold = acquireFleetLock({ projectRoot: dir, workId, runId: 'fleet_run_b', leaseMs: 1_000, now });
    expect(aliveHold.ok).toBe(false);
    expect(aliveHold.ok === false && /still alive/.test(aliveHold.reason)).toBe(true);

    // Simulate a crashed holder: same claim metadata, dead pid.
    const crashed = readFleetLock(dir, workId);
    expect(crashed).toBeTruthy();
    if (!crashed) return;
    writeFileSync(
      fleetLockPath(dir, workId),
      `${JSON.stringify({ ...crashed, pid: 2 ** 22 }, null, 2)}\n`,
    );
    const reclaim = acquireFleetLock({ projectRoot: dir, workId, runId: 'fleet_run_b', leaseMs: 1_000, now });
    expect(reclaim.ok).toBe(true);
    if (!reclaim.ok) return;
    expect(reclaim.reclaimed).toBe(true);
    expect(reclaim.lock.owner).toContain('fleet_run_b');

    const okRelease = releaseFleetLock({ projectRoot: dir, workId, owner: reclaim.lock.owner });
    expect(okRelease.released).toBe(true);
    expect(existsSync(fleetLockPath(dir, workId))).toBe(false);

    // Fleet runner logs reclaim when it takes over an expired lock.
    const { engine, work } = makeReadyTask(dir, 'Reclaim log');
    writeFileSync(
      fleetLockPath(dir, work.id),
      `${JSON.stringify({
        owner: 'fleet:stale:owner',
        workId: work.id,
        runId: 'stale',
        pid: 2 ** 22,
        claimedAt: new Date(nowMs - 10_000).toISOString(),
        expiresAt: new Date(nowMs - 1_000).toISOString(),
        leaseMs: 1_000,
      })}\n`,
    );
    const report = await runFleet(engine, {
      maxConcurrent: 1,
      budgetUsd: 100,
      leaseMs: 5_000,
      now: () => new Date(nowMs),
      step: async () => {},
      maxIterations: 5,
    });
    expect(report.started).toBeGreaterThanOrEqual(1);
    const reclaimEvents = engine.ctx.store.listEvents(work.id).filter((e) => e.type === 'fleet.lock-reclaimed');
    expect(reclaimEvents.length).toBeGreaterThanOrEqual(1);
    engine.ctx.store.close();
  });

  it('FR-006: corrupt lock fails closed (throws with path)', () => {
    const dir = tempProject('fleet-corrupt-', dirs);
    const workId = 'work_corrupt_lock';
    mkdirSync(join(dir, '.turbine', 'fleet', 'locks'), { recursive: true });
    const path = fleetLockPath(dir, workId);
    writeFileSync(path, '{not-json');
    expect(() => readFleetLock(dir, workId)).toThrow(/corrupt|unreadable/i);
    expect(() =>
      acquireFleetLock({ projectRoot: dir, workId, runId: 'fleet_x', leaseMs: 1_000 }),
    ).toThrow(/corrupt|unreadable/i);
    writeFileSync(path, '   \n');
    expect(() => readFleetLock(dir, workId)).toThrow(/empty/i);
  });

  it('budget boundary: exact token×rate USD stops admission', () => {
    const dir = tempProject('fleet-budget-boundary-', dirs);
    const engine = new Engine(openContext(dir));
    const request = join(dir, 'boundary.md');
    writeFileSync(request, '# Boundary\n');
    const work = engine.createTask({ title: 'Boundary', file: request, type: 'maintenance' });
    // 46_000 × $5 / 1e6 = exactly $0.23
    engine.addUsage({
      idOrAlias: work.id,
      source: 'agent',
      agentName: 'cursor',
      modelId: 'gpt-test',
      inputTokens: 46_000,
      outputTokens: 0,
      method: 'reported',
      recordedBy: 'tester',
      enteredBy: 'human',
    });
    const spend = measureFleetSpend(engine.ctx.store, [work.id], 5);
    expect(spend.knownUsd).toBe(0.23);
    expect(spend.knownUsd >= 0.23).toBe(true);
    // Just below budget still admits.
    const below = measureFleetSpend(engine.ctx.store, [work.id], 5);
    expect(below.knownUsd < 0.2300001).toBe(true);
    engine.ctx.store.close();
  });

  it('invalid fence pid is inconclusive; shared recover guard serializes two recoverers', () => {
    expect(pidAlive(0)).toBe(true);
    expect(pidAlive(-1)).toBe(true);
    const dir = tempProject('fleet-recover-guard-', dirs);
    const workId = 'work_recover_shared';
    mkdirSync(join(dir, '.turbine', 'fleet', 'locks'), { recursive: true });
    // Plant a fence owned by a definitely-dead pid.
    writeFileSync(
      `${fleetLockPath(dir, workId)}.fence`,
      `${JSON.stringify({ owner: 'fleet:dead:x', pid: 2 ** 22, at: new Date(0).toISOString() })}\n`,
    );
    expect(pidAlive(2 ** 22)).toBe(false);
    const a = tryAcquireRecoverGuard(dir, workId, 'fleet:a:x');
    const b = tryAcquireRecoverGuard(dir, workId, 'fleet:b:x');
    expect(a).toBe(true);
    expect(b).toBe(false);
    unlinkSync(`${fleetLockPath(dir, workId)}.fence.recover`);
    // With the shared recover free, fence takeover serializes on that same guard.
    expect(tryAcquireFence(dir, workId, 'fleet:a:x')).toBe(true);
    expect(tryAcquireFence(dir, workId, 'fleet:b:x')).toBe(false);
  });

  it('dead-holder takeover restores path when renamed content mismatches stale expected', () => {
    const dir = tempProject('fleet-tomb-restore-', dirs);
    const workId = 'work_tomb_restore';
    mkdirSync(join(dir, '.turbine', 'fleet', 'locks'), { recursive: true });
    const recover = `${fleetLockPath(dir, workId)}.fence.recover`;
    const dead = { owner: 'fleet:dead:x', pid: 2 ** 22, at: new Date(0).toISOString() };
    const live = { owner: 'fleet:live:x', pid: process.pid, at: new Date().toISOString() };
    const attacker = { owner: 'fleet:attacker:x', pid: process.pid, at: new Date().toISOString() };
    // Disk holds a live successor; stale expected still names the dead holder.
    writeFileSync(recover, `${JSON.stringify(live)}\n`);
    expect(takeoverDeadHolder(recover, dead, attacker)).toBe(false);
    const restored = JSON.parse(readFileSync(recover, 'utf8')) as { owner: string; pid: number };
    expect(restored.owner).toBe('fleet:live:x');
    expect(restored.pid).toBe(process.pid);
    expect(existsSync(recover)).toBe(true);
  });

  it('FR-003: budget stops starting; running finish; unknown spend separate', async () => {
    const dir = tempProject('fleet-budget-', dirs);
    const engine = new Engine(openContext(dir));
    const works = ['Budget A', 'Budget B', 'Budget C'].map((title) => {
      const request = join(dir, `${title.replace(/\s+/g, '-').toLowerCase()}.md`);
      writeFileSync(request, `# ${title}\n\nFleet budget fixture.\n`);
      return engine.createTask({ title, file: request, type: 'maintenance' });
    });

    // 200_000 tokens @ $5/MTok = $1.00 known spend.
    engine.addUsage({
      idOrAlias: works[0]!.id,
      source: 'agent',
      agentName: 'cursor',
      modelId: 'gpt-test',
      inputTokens: 100_000,
      outputTokens: 100_000,
      method: 'reported',
      recordedBy: 'tester',
      enteredBy: 'human',
    });
    engine.addUsage({
      idOrAlias: works[1]!.id,
      source: 'agent',
      agentName: 'cursor',
      modelId: 'gpt-test',
      inputTokens: 'unknown',
      outputTokens: 0,
      method: 'estimated',
      recordedBy: 'tester',
      enteredBy: 'human',
    });

    const spend = measureFleetSpend(
      engine.ctx.store,
      works.map((w) => w.id),
      5,
    );
    expect(spend.knownTokens).toBe(200_000);
    expect(spend.knownUsd).toBeCloseTo(1, 5);
    expect(spend.hasUnknown).toBe(true);

    const atBudget = await runFleet(engine, {
      maxConcurrent: 2,
      budgetUsd: 1,
      usdPerMillionTokens: 5,
      step: async () => {
        throw new Error('must not start when already at budget');
      },
      maxIterations: 10,
    });
    expect(atBudget.stoppedReason).toBe('budget');
    expect(atBudget.started).toBe(0);
    expect(atBudget.spend.hasUnknown).toBe(true);
    expect(atBudget.spend.knownUsd).toBeGreaterThanOrEqual(1);
    engine.ctx.store.close();

    // Mid-run: finish the in-flight task, do not start another once spend crosses budget.
    const dir2 = tempProject('fleet-budget2-', dirs);
    const engine2 = new Engine(openContext(dir2));
    for (const title of ['Run1', 'Run2', 'Run3']) {
      const request = join(dir2, `${title.toLowerCase()}.md`);
      writeFileSync(request, `# ${title}\n\nBudget mid-run.\n`);
      engine2.createTask({ title, file: request, type: 'maintenance' });
    }

    let stepCount = 0;
    const mid = await runFleet(engine2, {
      maxConcurrent: 1,
      budgetUsd: 0.5,
      usdPerMillionTokens: 5,
      step: async (id) => {
        stepCount += 1;
        if (stepCount === 1) {
          engine2.addUsage({
            idOrAlias: id,
            source: 'agent',
            agentName: 'cursor',
            modelId: 'gpt-test',
            inputTokens: 200_000,
            outputTokens: 0,
            method: 'reported',
            recordedBy: 'tester',
            enteredBy: 'human',
          });
        }
      },
      maxIterations: 20,
    });
    expect(mid.stoppedReason).toBe('budget');
    expect(mid.started).toBe(1);
    expect(mid.finished).toBe(1);
    expect(mid.spend.knownUsd).toBeGreaterThanOrEqual(0.5);
    engine2.ctx.store.close();
  });

  it('FR-004: mid-run policy suspend finishes current step then leaves lane', async () => {
    const { engine } = laneProject(dirs);
    const request = join(engine.ctx.projectRoot, 'suspend-fleet.md');
    writeFileSync(request, '# Suspend fleet\n\nSmall chore.\n');
    const work = engine.createTask({
      title: 'Suspend fleet',
      file: request,
      type: 'maintenance',
      labels: ['bug'],
    });

    let suspendFired = false;
    const report = await runFleet(engine, {
      maxConcurrent: 1,
      budgetUsd: 100,
      policyName: 'routine',
      step: async () => {
        if (!suspendFired) {
          suspendPolicy(engine.ctx.store, 'routine', 'fleet test suspend', 'agent');
          suspendFired = true;
        }
      },
      maxIterations: 10,
    });

    expect(suspendFired).toBe(true);
    expect(report.stoppedReason).toBe('policy-suspended');
    const left = report.outcomes.find((o) => o.workId === work.id);
    expect(left?.kind).toBe('left-lane');
    const fallbacks = engine.ctx.store.listEvents(work.id).filter((e) => e.type === 'lane.fallback');
    expect(fallbacks.length).toBeGreaterThanOrEqual(1);
    engine.ctx.store.close();
  });

  it('FR-004: suspend during ownership confirm leaves lane without calling step', async () => {
    const { engine } = laneProject(dirs);
    const request = join(engine.ctx.projectRoot, 'suspend-before-step.md');
    writeFileSync(request, '# Suspend before step\n\nSmall chore.\n');
    const work = engine.createTask({
      title: 'Suspend before step',
      file: request,
      type: 'maintenance',
      labels: ['bug'],
    });

    const originalRenew = fleetLock.renewFleetLock;
    let renewCount = 0;
    const spy = vi.spyOn(fleetLock, 'renewFleetLock').mockImplementation((input) => {
      renewCount += 1;
      if (renewCount === 1) {
        suspendPolicy(engine.ctx.store, 'routine', 'suspend during ownership confirm', 'agent');
      }
      return originalRenew(input);
    });

    let stepCalls = 0;
    try {
      const report = await runFleet(engine, {
        maxConcurrent: 1,
        budgetUsd: 100,
        policyName: 'routine',
        step: async () => {
          stepCalls += 1;
          throw new Error('must not step after suspend during ownership confirm');
        },
        maxIterations: 5,
      });

      expect(stepCalls).toBe(0);
      expect(report.stoppedReason).toBe('policy-suspended');
      const left = report.outcomes.find((o) => o.workId === work.id);
      expect(left?.kind).toBe('left-lane');
      expect(left?.detail).toBe('policy suspended');
    } finally {
      spy.mockRestore();
      engine.ctx.store.close();
    }
  });

  it('FR-001/FR-007: fleet run drives a ready fixture through one sync step without inventing approvals', async () => {
    const dir = tempProject('fleet-drive-', dirs);
    const { engine, work } = makeReadyTask(dir, 'Drive sync');
    const decisionsBefore = engine.ctx.store.listDecisions(work.id).length;
    const beforeState = work.currentState;
    const report = await runFleet(engine, {
      maxConcurrent: 1,
      budgetUsd: 100,
      maxIterations: 20,
    });
    expect(report.started).toBeGreaterThanOrEqual(1);
    const outcome = report.outcomes.find((o) => o.workId === work.id);
    expect(outcome).toBeTruthy();
    expect(outcome?.kind).not.toBe('error');
    const after = engine.ctx.store.getWork(work.id);
    expect(after.currentState).not.toBe(beforeState);
    const humanApprovals = engine.ctx.store
      .listDecisions(work.id)
      .slice(decisionsBefore)
      .filter((d) => d.actorType === 'human');
    expect(humanApprovals).toHaveLength(0);
    engine.ctx.store.close();
  });

  it('FR-005: fleet status counts running, waiting-on-human, failed, merged', () => {
    const dir = tempProject('fleet-status-', dirs);
    const engine = new Engine(openContext(dir));
    const mk = (title: string) => {
      const request = join(dir, `${title.toLowerCase()}.md`);
      writeFileSync(request, `# ${title}\n\nStatus fixture.\n`);
      return engine.createTask({ title, file: request, type: 'maintenance' });
    };
    const a = mk('Status A');
    const b = mk('Status B');
    const c = mk('Status C');
    const d = mk('Status D');
    const e = mk('Status E');

    engine.ctx.store.saveWork({ ...engine.ctx.store.getWork(a.id), currentState: 'REQUIREMENTS_REVIEW' });
    engine.ctx.store.saveWork({ ...engine.ctx.store.getWork(b.id), currentState: 'CHANGES_REQUESTED' });
    engine.ctx.store.saveWork({ ...engine.ctx.store.getWork(c.id), currentState: 'ACCEPTED' });
    engine.ctx.store.saveWork({ ...engine.ctx.store.getWork(d.id), currentState: 'FAILED' });
    engine.ctx.store.saveWork({ ...engine.ctx.store.getWork(e.id), currentState: 'ACCEPTED' });
    const now = new Date().toISOString();
    engine.ctx.store.saveLaneMergeRecord({
      id: createId('merge'),
      workId: c.id,
      policyId: null,
      openedAt: now,
      mergeState: 'merged',
      mergedAt: now,
      mergeSha: 'deadbeef',
      reverted: 'no',
      recordedAt: now,
    });

    const lock = acquireFleetLock({
      projectRoot: dir,
      workId: a.id,
      runId: 'status_run',
      leaseMs: 60_000,
    });
    expect(lock.ok).toBe(true);

    const status = fleetStatus(engine);
    expect(status.running).toBeGreaterThanOrEqual(1);
    expect(status.waitingOnHuman).toBeGreaterThanOrEqual(1);
    expect(status.failed).toBeGreaterThanOrEqual(2);
    expect(status.merged).toBe(1);
    expect(status.runningWorkIds).toContain(a.id);
    expect(status.waitingOnHumanWorkIds).toContain(a.id);
    expect(status.failedWorkIds).toContain(b.id);
    expect(status.failedWorkIds).toContain(d.id);
    expect(status.mergedWorkIds).toEqual([c.id]);
    // ACCEPTED without a merge fact (e) is not counted as merged.

    if (lock.ok) releaseFleetLock({ projectRoot: dir, workId: a.id, owner: lock.lock.owner });
    engine.ctx.store.close();
  });

  it('FR-008: docs mention fleet scheduler as shipped subset', () => {
    const status = readFileSync(join(repoRoot, 'docs/IMPLEMENTATION_STATUS.md'), 'utf8');
    const driver = readFileSync(join(repoRoot, 'docs/AGENT_DRIVER.md'), 'utf8');
    const guide = readFileSync(join(repoRoot, 'docs/autonomous-lane-and-sandbox.md'), 'utf8');
    expect(status).toMatch(/Autonomous lane — part E: fleet scheduler/i);
    expect(status).not.toMatch(/fleet scheduler remain unimplemented/i);
    expect(driver).toMatch(/turbine fleet run/i);
    expect(guide).toMatch(/fleet run/i);
  });

  it('continues an admitted task past budget and does not admit another', async () => {
    const dir = tempProject('fleet-continue-budget-', dirs);
    const engine = new Engine(openContext(dir));
    const mk = (title: string) => {
      const request = join(dir, `${title.toLowerCase()}.md`);
      writeFileSync(request, `# ${title}\n`);
      return engine.createTask({ title, file: request, type: 'maintenance' });
    };
    const a = mk('Continue A');
    const b = mk('Continue B');
    const [first, second] = [a, b].sort((x, y) => x.id.localeCompare(y.id));
    let stepsOnFirst = 0;
    const report = await runFleet(engine, {
      maxConcurrent: 1,
      budgetUsd: 0.5,
      usdPerMillionTokens: 5,
      step: async (id) => {
        if (id !== first.id) throw new Error('second task must not be admitted after budget');
        stepsOnFirst += 1;
        if (stepsOnFirst === 1) {
          engine.addUsage({
            idOrAlias: id,
            source: 'agent',
            agentName: 'cursor',
            modelId: 'gpt-test',
            inputTokens: 200_000,
            outputTokens: 0,
            method: 'reported',
            recordedBy: 'tester',
            enteredBy: 'human',
          });
          engine.ctx.store.saveWork({
            ...engine.ctx.store.getWork(id),
            currentState: 'PLANNING',
          });
        } else {
          engine.ctx.store.saveWork({
            ...engine.ctx.store.getWork(id),
            currentState: 'PLAN_REVIEW',
          });
        }
      },
      maxIterations: 20,
    });
    expect(stepsOnFirst).toBe(2);
    expect(report.started).toBe(1);
    expect(report.stoppedReason).toBe('budget');
    expect(report.outcomes.find((o) => o.workId === first.id)?.kind).toBe('waiting-on-human');
    expect(report.outcomes.some((o) => o.workId === second.id)).toBe(false);
    engine.ctx.store.close();
  });

  it('defers no-progress tasks so another ready task can run', async () => {
    const dir = tempProject('fleet-defer-', dirs);
    const engine = new Engine(openContext(dir));
    const stuck = engine.createTask({
      title: 'Stuck',
      file: (() => {
        const p = join(dir, 'stuck.md');
        writeFileSync(p, '# Stuck\n');
        return p;
      })(),
      type: 'maintenance',
    });
    const ready = engine.createTask({
      title: 'Ready',
      file: (() => {
        const p = join(dir, 'ready.md');
        writeFileSync(p, '# Ready\n');
        return p;
      })(),
      type: 'maintenance',
    });
    const seen: string[] = [];
    const report = await runFleet(engine, {
      maxConcurrent: 1,
      budgetUsd: 100,
      step: async (id) => {
        seen.push(id);
        // Leave state unchanged → deferred for the rest of the run.
      },
      maxIterations: 20,
    });
    expect(report.outcomes.some((o) => o.workId === stuck.id && o.kind === 'deferred')).toBe(true);
    expect(seen).toContain(ready.id);
    expect(seen.filter((id) => id === stuck.id).length).toBe(1);
    engine.ctx.store.close();
  });

  it('renew keeps ownership past the original lease while a step runs', async () => {
    const dir = tempProject('fleet-renew-', dirs);
    const { engine } = makeReadyTask(dir, 'Renew lease');
    let nowMs = Date.parse('2026-06-01T00:00:00.000Z');
    const now = () => new Date(nowMs);
    const otherAttempts: boolean[] = [];
    const report = await runFleet(engine, {
      maxConcurrent: 1,
      budgetUsd: 100,
      leaseMs: 900,
      now,
      step: async (id) => {
        // Advance past the original lease several times; renewals should keep us exclusive.
        for (let i = 0; i < 4; i++) {
          nowMs += 500;
          await new Promise((r) => setTimeout(r, 300));
          const rival = acquireFleetLock({
            projectRoot: dir,
            workId: id,
            runId: 'rival_run',
            leaseMs: 900,
            now,
          });
          otherAttempts.push(rival.ok);
        }
      },
      maxIterations: 5,
    });
    expect(report.started).toBe(1);
    expect(report.outcomes.some((o) => o.kind === 'error')).toBe(false);
    expect(otherAttempts).toEqual([false, false, false, false]);
    engine.ctx.store.close();
  });

  it('release after reclaim by another owner does not delete the replacement lock', () => {
    const dir = tempProject('fleet-release-race-', dirs);
    const workId = 'work_release_race';
    let nowMs = Date.parse('2026-07-01T00:00:00.000Z');
    const now = () => new Date(nowMs);
    const first = acquireFleetLock({ projectRoot: dir, workId, runId: 'run_a', leaseMs: 800, now });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    nowMs += 1_000;
    const crashed = readFleetLock(dir, workId);
    expect(crashed).toBeTruthy();
    if (!crashed) return;
    writeFileSync(
      fleetLockPath(dir, workId),
      `${JSON.stringify({ ...crashed, pid: 2 ** 22 }, null, 2)}\n`,
    );
    const second = acquireFleetLock({ projectRoot: dir, workId, runId: 'run_b', leaseMs: 5_000, now });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.reclaimed).toBe(true);
    const staleRelease = releaseFleetLock({ projectRoot: dir, workId, owner: first.lock.owner });
    expect(staleRelease.released).toBe(false);
    expect(readFleetLock(dir, workId)?.owner).toBe(second.lock.owner);
    expect(releaseFleetLock({ projectRoot: dir, workId, owner: second.lock.owner }).released).toBe(true);
  });

  it('renewFleetLock fails closed when ownership was lost', () => {
    const dir = tempProject('fleet-renew-lost-', dirs);
    const workId = 'work_renew_lost';
    const first = acquireFleetLock({ projectRoot: dir, workId, runId: 'run_a', leaseMs: 60_000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(
      renewFleetLock({
        projectRoot: dir,
        workId,
        owner: 'fleet:other:x',
        leaseMs: 60_000,
      }).ok,
    ).toBe(false);
    expect(
      renewFleetLock({
        projectRoot: dir,
        workId,
        owner: first.lock.owner,
        leaseMs: 60_000,
      }).ok,
    ).toBe(true);
    releaseFleetLock({ projectRoot: dir, workId, owner: first.lock.owner });
  });

  it('pending policy file still honors approved suspension for fleet', async () => {
    const { dir, engine } = laneProject(dirs);
    suspendPolicy(engine.ctx.store, 'routine', 'suspend before edit', 'agent');
    // Edit YAML so status becomes pending while approved snapshot stays suspended.
    writePolicy(dir, 'routine', `${readFileSync(join(dir, '.turbine', 'policies', 'routine.yaml'), 'utf8')}\n# edit\n`);
    const request = join(dir, 'pending-suspend.md');
    writeFileSync(request, '# Pending suspend\n');
    engine.createTask({ title: 'Pending suspend', file: request, type: 'maintenance', labels: ['bug'] });
    const report = await runFleet(engine, {
      maxConcurrent: 1,
      budgetUsd: 100,
      policyName: 'routine',
      step: async () => {
        throw new Error('must not start when approved snapshot is suspended');
      },
      maxIterations: 5,
    });
    expect(report.started).toBe(0);
    expect(report.stoppedReason).toBe('idle');
    engine.ctx.store.close();
  });

  it('FR-F3: overlapping or unknown predictions are not admitted concurrently', async () => {
    const dir = tempProject('fleet-overlap-', dirs);
    const engine = new Engine(openContext(dir));
    mkdirSync(join(dir, '.turbine', 'artifacts'), { recursive: true });
    const mk = (title: string) => {
      const p = join(dir, `${title.toLowerCase()}.md`);
      writeFileSync(p, `# ${title}\n`);
      return engine.createTask({ title, file: p, type: 'maintenance' });
    };
    const a = mk('Overlap A');
    const b = mk('Overlap B');
    const c = mk('Overlap C');
    plantPrediction(engine, a.id, {
      kind: 'selection',
      paths: ['apps/cli/src/engine/fleet.ts'],
      sources: { context: true, plan: false },
      labelled: 'selection',
      at: new Date().toISOString(),
    });
    plantPrediction(engine, b.id, {
      kind: 'selection',
      paths: ['apps/cli/src/engine/fleet.ts', 'README.md'],
      sources: { context: true, plan: true },
      labelled: 'selection',
      at: new Date().toISOString(),
    });
    plantPrediction(engine, c.id, {
      kind: 'selection',
      paths: ['docs/AGENT_DRIVER.md'],
      sources: { context: true, plan: false },
      labelled: 'selection',
      at: new Date().toISOString(),
    });

    const started: string[] = [];
    const report = await runFleet(engine, {
      maxConcurrent: 2,
      budgetUsd: 100,
      step: async (id) => {
        started.push(id);
        await new Promise((r) => setTimeout(r, 80));
      },
      maxIterations: 20,
    });
    expect(report.started).toBeGreaterThanOrEqual(2);
    // A and B share a path — they must never both be active; C can pair with either.
    const blocked = engine.ctx.store
      .listWork()
      .flatMap((w) => engine.ctx.store.listEvents(w.id))
      .filter((e) => e.type === 'fleet.prediction-blocked');
    expect(blocked.length).toBeGreaterThanOrEqual(1);

    // Unknown never pairs with an active task.
    const dir2 = tempProject('fleet-unknown-pred-', dirs);
    const engine2 = new Engine(openContext(dir2));
    mkdirSync(join(dir2, '.turbine', 'artifacts'), { recursive: true });
    const u1 = engine2.createTask({
      title: 'Unknown 1',
      file: (() => {
        const p = join(dir2, 'u1.md');
        writeFileSync(p, '# u1\n');
        return p;
      })(),
      type: 'maintenance',
    });
    engine2.createTask({
      title: 'Unknown 2',
      file: (() => {
        const p = join(dir2, 'u2.md');
        writeFileSync(p, '# u2\n');
        return p;
      })(),
      type: 'maintenance',
    });
    plantPrediction(engine2, u1.id, {
      kind: 'selection',
      paths: ['a.ts'],
      sources: { context: true, plan: false },
      labelled: 'selection',
      at: new Date().toISOString(),
    });
    // u2 left without prediction → unknown
    let concurrent = 0;
    let maxSeen = 0;
    await runFleet(engine2, {
      maxConcurrent: 2,
      budgetUsd: 100,
      step: async () => {
        concurrent += 1;
        maxSeen = Math.max(maxSeen, concurrent);
        await new Promise((r) => setTimeout(r, 50));
        concurrent -= 1;
      },
      maxIterations: 15,
    });
    expect(maxSeen).toBe(1);
    engine.ctx.store.close();
    engine2.ctx.store.close();
  });

  it('FR-F2/F4: prediction is labelled selection; misses feed metrics without blocking', () => {
    const selection = parseFilePrediction({
      kind: 'selection',
      paths: ['a.ts', 'b.ts', 'src/../shared.ts'],
      sources: { context: true, plan: true },
      labelled: 'selection',
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(selection.kind).toBe('selection');
    if (selection.kind === 'selection') {
      expect(selection.labelled).toBe('selection');
      expect(selection.paths).toContain('shared.ts');
      expect(selection.paths).not.toContain('src/../shared.ts');
    }
    expect(blocksAdmit(selection, [])).toBe(false);
    expect(
      blocksAdmit(
        { kind: 'selection', paths: ['shared.ts'], sources: { context: true, plan: false }, labelled: 'selection', at: 't' },
        [selection],
      ),
    ).toBe(true);

    const miss = comparePredictionToActual(['a.ts', 'b.ts'], ['a.ts', 'c.ts']);
    expect(miss.misses).toEqual(['b.ts']);
    expect(miss.extras).toEqual(['c.ts']);
    expect(actualPathsFromChangeReport({ filesTouched: ['repo:a.ts', 'c.ts'] })).toEqual(['a.ts', 'c.ts']);

    const dir = tempProject('fleet-miss-metrics-', dirs);
    const engine = new Engine(openContext(dir));
    const work = engine.createTask({
      title: 'Miss metrics',
      file: (() => {
        const p = join(dir, 'miss.md');
        writeFileSync(p, '# miss\n');
        return p;
      })(),
      type: 'maintenance',
    });
    engine.ctx.store.appendEvent({
      workId: work.id,
      type: 'fleet.prediction-miss',
      payload: {
        predicted: ['a.ts', 'b.ts'],
        actual: ['a.ts'],
        misses: ['b.ts'],
        extras: [],
        at: new Date().toISOString(),
        predictionKind: 'selection',
      },
    });
    const report = computeLaneMetrics(engine.ctx.store);
    expect(report.predictionMisses.missEvents).toBe(1);
    expect(report.predictionMisses.missedPaths).toBe(1);
    expect(report.predictionMisses.tasksWithMisses).toBe(1);
    engine.ctx.store.close();
  });

  it('drains an in-flight step when the scheduler throws on a later claim', async () => {
    const dir = tempProject('fleet-drain-', dirs);
    const engine = new Engine(openContext(dir));
    mkdirSync(join(dir, '.turbine', 'artifacts'), { recursive: true });
    const a = engine.createTask({
      title: 'Drain A',
      file: (() => {
        const p = join(dir, 'drain-a.md');
        writeFileSync(p, '# A\n');
        return p;
      })(),
      type: 'maintenance',
    });
    const b = engine.createTask({
      title: 'Drain B',
      file: (() => {
        const p = join(dir, 'drain-b.md');
        writeFileSync(p, '# B\n');
        return p;
      })(),
      type: 'maintenance',
    });
    const [first, second] = [a, b].sort((x, y) => x.id.localeCompare(y.id));
    // Disjoint selections so Part F admit does not block before the corrupt-lock throw.
    plantPrediction(engine, first.id, {
      kind: 'selection',
      paths: ['drain-a.ts'],
      sources: { context: true, plan: false },
      labelled: 'selection',
      at: new Date().toISOString(),
    });
    plantPrediction(engine, second.id, {
      kind: 'selection',
      paths: ['drain-b.ts'],
      sources: { context: true, plan: false },
      labelled: 'selection',
      at: new Date().toISOString(),
    });
    mkdirSync(join(dir, '.turbine', 'fleet', 'locks'), { recursive: true });
    writeFileSync(fleetLockPath(dir, second.id), '{not-json');
    let firstFinished = false;
    await expect(
      runFleet(engine, {
        maxConcurrent: 2,
        budgetUsd: 100,
        step: async (id) => {
          if (id !== first.id) return;
          await new Promise((r) => setTimeout(r, 250));
          firstFinished = true;
        },
        maxIterations: 10,
      }),
    ).rejects.toThrow(/corrupt|unreadable/i);
    expect(firstFinished).toBe(true);
    expect(existsSync(fleetLockPath(dir, first.id))).toBe(false);
    engine.ctx.store.close();
  });
});
