import { contentHash, createId, err, type WorkPackage, type WorkState } from '@turbine-hall/turbine-contracts';
import type { Engine } from './engine.js';
import {
  acquireFleetLock,
  DEFAULT_FLEET_LEASE_MS,
  listFleetLockedWorkIds,
  readFleetLock,
  releaseFleetLock,
  type FleetLockBody,
} from './fleet-lock.js';
import { DEFAULT_USD_PER_MILLION_TOKENS, measureFleetSpend, type FleetSpend } from './fleet-spend.js';
import { policyStatuses } from './lane-policy.js';

const HUMAN_WAIT: ReadonlySet<WorkState> = new Set([
  'NEEDS_CLARIFICATION',
  'REQUIREMENTS_REVIEW',
  'PLAN_REVIEW',
  'HUMAN_CODE_REVIEW',
  'HUMAN_ACCEPTANCE',
]);

const TERMINAL: ReadonlySet<WorkState> = new Set(['ACCEPTED', 'CANCELLED']);

export type FleetRunOptions = {
  maxConcurrent: number;
  budgetUsd: number;
  policyName?: string;
  leaseMs?: number;
  usdPerMillionTokens?: number;
  /** Injectable clock for lease tests. */
  now?: () => Date;
  /** One advancement step (defaults to engine.syncFromMarkdown). */
  step?: (workId: string) => Promise<void>;
  /** Max scheduler loop iterations (default 10_000). */
  maxIterations?: number;
};

export type FleetTaskOutcome = {
  workId: string;
  kind: 'advanced' | 'waiting-on-human' | 'terminal' | 'error' | 'left-lane';
  state?: WorkState;
  detail?: string;
};

export type FleetRunReport = {
  runId: string;
  stoppedReason: 'idle' | 'budget' | 'policy-suspended' | 'max-iterations';
  spend: FleetSpend;
  outcomes: FleetTaskOutcome[];
  started: number;
  finished: number;
};

export type FleetStatusReport = {
  running: number;
  waitingOnHuman: number;
  failed: number;
  merged: number;
  runningWorkIds: string[];
  waitingOnHumanWorkIds: string[];
  failedWorkIds: string[];
  mergedWorkIds: string[];
};

function assertPositiveInt(name: string, n: number): void {
  if (!Number.isInteger(n) || n < 1) throw err('E_INVALID_CONFIG', `${name} must be an integer >= 1`);
}

function assertBudget(n: number): void {
  if (!(n >= 0) || !Number.isFinite(n)) throw err('E_INVALID_CONFIG', 'budget must be a finite number >= 0');
}

function policyIsSuspended(engine: Engine, policyName: string | undefined): boolean {
  if (!policyName) return false;
  const hit = policyStatuses(engine.ctx.store, engine.ctx.projectRoot).policies.find((p) => p.name === policyName);
  if (!hit) throw err('E_INVALID_CONFIG', `fleet --policy ${policyName}: policy not found`);
  return hit.state === 'suspended';
}

function leaveLaneForSuspend(engine: Engine, work: WorkPackage, reason: string): void {
  const reasons = [reason];
  const evaluationHash = contentHash({ reasons, at: 'fleet-suspend' });
  engine.ctx.store.appendEvent({
    workId: work.id,
    type: 'lane.fallback',
    payload: {
      gate: 'requirements',
      reasons,
      evaluationHash,
      at: new Date().toISOString(),
      source: 'fleet',
    },
  });
}

function logReclaim(engine: Engine, workId: string, runId: string): void {
  engine.ctx.store.appendEvent({
    workId,
    type: 'fleet.lock-reclaimed',
    payload: {
      runId,
      at: new Date().toISOString(),
    },
  });
}

/** Tasks the fleet may still advance (not terminal, not already waiting on a human). */
export function fleetCandidateWorks(engine: Engine): WorkPackage[] {
  return engine.ctx.store
    .listWork()
    .filter((w) => !TERMINAL.has(w.currentState) && !HUMAN_WAIT.has(w.currentState));
}

/**
 * Drive ready tasks under concurrency + budget locks.
 * Never invents human approvals — one `step` (default: sync) per claim, then release.
 */
export async function runFleet(engine: Engine, opts: FleetRunOptions): Promise<FleetRunReport> {
  assertPositiveInt('maxConcurrent', opts.maxConcurrent);
  assertBudget(opts.budgetUsd);
  const runId = createId('fleet');
  const leaseMs = opts.leaseMs ?? DEFAULT_FLEET_LEASE_MS;
  const usdPerMTok = opts.usdPerMillionTokens ?? DEFAULT_USD_PER_MILLION_TOKENS;
  const now = opts.now ?? (() => new Date());
  const step =
    opts.step ??
    (async (workId: string) => {
      await engine.syncFromMarkdown(workId);
    });
  const maxIterations = opts.maxIterations ?? 10_000;

  const outcomes: FleetTaskOutcome[] = [];
  let started = 0;
  let finished = 0;
  let stoppedReason: FleetRunReport['stoppedReason'] | undefined;
  const active = new Map<string, Promise<void>>();

  const allIds = () => engine.ctx.store.listWork().map((w) => w.id);
  const spendNow = () => measureFleetSpend(engine.ctx.store, allIds(), usdPerMTok);

  const launch = (work: WorkPackage, lock: FleetLockBody) => {
    started += 1;
    const workId = work.id;
    const promise = (async () => {
      try {
        await step(workId);
        const after = engine.ctx.store.getWork(workId);
        if (policyIsSuspended(engine, opts.policyName)) {
          leaveLaneForSuspend(engine, after, `policy ${opts.policyName} suspended during fleet run ${runId}`);
          outcomes.push({ workId, kind: 'left-lane', state: after.currentState, detail: 'policy suspended' });
        } else if (TERMINAL.has(after.currentState)) {
          outcomes.push({ workId, kind: 'terminal', state: after.currentState });
        } else if (HUMAN_WAIT.has(after.currentState)) {
          outcomes.push({ workId, kind: 'waiting-on-human', state: after.currentState });
        } else {
          outcomes.push({ workId, kind: 'advanced', state: after.currentState });
        }
      } catch (e) {
        outcomes.push({ workId, kind: 'error', detail: (e as Error).message.split('\n')[0] });
      } finally {
        releaseFleetLock({ projectRoot: engine.ctx.projectRoot, workId, owner: lock.owner });
        active.delete(workId);
        finished += 1;
      }
    })();
    active.set(workId, promise);
  };

  for (let iter = 0; iter < maxIterations; iter++) {
    if (policyIsSuspended(engine, opts.policyName) && active.size === 0) {
      stoppedReason = started > 0 ? 'policy-suspended' : 'idle';
      break;
    }

    let spend = spendNow();
    if (spend.knownUsd >= opts.budgetUsd && active.size === 0) {
      stoppedReason = 'budget';
      break;
    }

    while (active.size < opts.maxConcurrent) {
      spend = spendNow();
      if (spend.knownUsd >= opts.budgetUsd) {
        stoppedReason = 'budget';
        break;
      }
      if (policyIsSuspended(engine, opts.policyName)) {
        // Do not start more; let actives finish (FR-E4).
        stoppedReason = 'policy-suspended';
        break;
      }

      const candidates = fleetCandidateWorks(engine).filter((w) => !active.has(w.id));
      let claimed: { work: WorkPackage; lock: FleetLockBody } | undefined;
      for (const work of candidates) {
        const acq = acquireFleetLock({
          projectRoot: engine.ctx.projectRoot,
          workId: work.id,
          runId,
          leaseMs,
          now,
        });
        if (!acq.ok) continue;
        if (acq.reclaimed) logReclaim(engine, work.id, runId);
        claimed = { work, lock: acq.lock };
        break;
      }
      if (!claimed) break;
      launch(claimed.work, claimed.lock);
    }

    if (active.size > 0) {
      await Promise.race([...active.values()]);
      continue;
    }

    if (stoppedReason === 'budget' || stoppedReason === 'policy-suspended') break;

    // Idle: no ready candidates, or remaining candidates are held by other owners.
    stoppedReason = 'idle';
    break;
  }

  if (active.size > 0) {
    await Promise.allSettled([...active.values()]);
  }

  if (!stoppedReason) stoppedReason = 'max-iterations';

  return {
    runId,
    stoppedReason,
    spend: spendNow(),
    outcomes,
    started,
    finished,
  };
}

export function fleetStatus(engine: Engine, now: () => Date = () => new Date()): FleetStatusReport {
  const works = engine.ctx.store.listWork();
  const runningWorkIds: string[] = [];
  for (const id of listFleetLockedWorkIds(engine.ctx.projectRoot)) {
    try {
      const lock = readFleetLock(engine.ctx.projectRoot, id);
      if (!lock) continue;
      const exp = Date.parse(lock.expiresAt);
      if (Number.isFinite(exp) && now().getTime() < exp) runningWorkIds.push(id);
    } catch {
      // Corrupt lock fails closed on next acquire; omit from status running count.
    }
  }
  const waitingOnHumanWorkIds = works.filter((w) => HUMAN_WAIT.has(w.currentState)).map((w) => w.id);
  const failedWorkIds = works
    .filter((w) => w.currentState === 'CHANGES_REQUESTED' || w.currentState === 'CANCELLED')
    .map((w) => w.id);
  const mergedWorkIds = works.filter((w) => w.currentState === 'ACCEPTED').map((w) => w.id);
  return {
    running: runningWorkIds.length,
    waitingOnHuman: waitingOnHumanWorkIds.length,
    failed: failedWorkIds.length,
    merged: mergedWorkIds.length,
    runningWorkIds,
    waitingOnHumanWorkIds,
    failedWorkIds,
    mergedWorkIds,
  };
}
