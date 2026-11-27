import {
  createId,
  err,
  type ApprovedLanePolicy,
  type LaneMergeRecord,
  type LanePrRecord,
  type MergeQueueProtection,
  type WorkPackage,
} from '@turbine-hall/turbine-contracts';
import type { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import type { Capability, ToolAdapter } from '@turbine-hall/turbine-tools';
import { savePolicyMergeFacts } from './lane-audit.js';
import { evaluateSuspendWhen } from './lane-metrics.js';

export type LanePrTarget = {
  adapter: ToolAdapter;
  owner: string;
  repo: string;
  baseBranch: string;
};

type InvokeResult<T> = { data: T; externalOperationId?: string };

async function invoke<T>(
  target: LanePrTarget,
  capability: Capability,
  workId: string,
  args: Record<string, unknown>,
): Promise<InvokeResult<T>> {
  if (!target.adapter.capabilities.includes(capability)) {
    throw err('E_MISSING_CAPABILITY', `GitHub adapter does not support ${capability}`);
  }
  return target.adapter.invoke({
    capability,
    workId,
    arguments: { owner: target.owner, repo: target.repo, ...args },
    correlationId: createId('corr'),
  }) as Promise<InvokeResult<T>>;
}

export function configAllows(tools: { allow: string[]; denied: string[] }, capability: 'pr.create' | 'pr.merge'): boolean {
  return tools.allow.includes(capability) && !tools.denied.includes(capability);
}

export async function confirmMergeQueueProtection(target: LanePrTarget, workId: string): Promise<MergeQueueProtection> {
  try {
    const result = await invoke<MergeQueueProtection>(target, 'repo.rules.read', workId, { branch: target.baseBranch });
    const value = result.data;
    if (value.status !== 'confirmed') return { status: 'unknown', mergeQueueRequired: false, turbineGateRequired: false, reason: value.reason ?? 'protection could not be confirmed' };
    if (!value.mergeQueueRequired || !value.turbineGateRequired) {
      return {
        status: 'unknown',
        mergeQueueRequired: value.mergeQueueRequired,
        turbineGateRequired: value.turbineGateRequired,
        reason: [
          !value.mergeQueueRequired ? 'base branch does not require the merge queue' : '',
          !value.turbineGateRequired ? 'base branch does not require turbine/gate' : '',
        ].filter(Boolean).join('; '),
      };
    }
    return value;
  } catch (e) {
    return { status: 'unknown', mergeQueueRequired: false, turbineGateRequired: false, reason: (e as Error).message };
  }
}

type LivePr = {
  state: 'open' | 'closed' | 'merged';
  head?: string;
  headSha: string;
  base?: string;
  mergeQueueState?: 'queued' | 'ejected';
  queueReason?: string;
  queueRemovalId?: string;
  /** False when the merge-queue history was unreadable: no removal id then proves nothing. */
  queueStateKnown?: boolean;
  mergedAt?: string;
  mergeSha?: string;
};

function readPr(target: LanePrTarget, workId: string, number: number): Promise<InvokeResult<LivePr>> {
  return invoke<LivePr>(target, 'pr.read', workId, { number });
}

/** The recorded PR belongs to one repo and base; an origin or base switch must not silently retarget it. */
function assertRecordedTarget(record: LanePrRecord, target: LanePrTarget): void {
  if (record.owner !== target.owner || record.repo !== target.repo || record.baseBranch !== target.baseBranch) {
    throw err(
      'E_INVALID_CONFIG',
      `Recorded PR #${record.number} targets ${record.owner}/${record.repo}:${record.baseBranch}, but the configured target is ${target.owner}/${target.repo}:${target.baseBranch}`,
    );
  }
}

/** The recorded, open PR on the recorded base and head branch. The head COMMIT is checked separately. */
function assertLivePrIdentity(live: LivePr, record: LanePrRecord, target: LanePrTarget): void {
  assertRecordedTarget(record, target);
  if (live.state !== 'open') throw err('E_STALE_REVISION', `PR #${record.number} is ${live.state}, not open`);
  if (live.base !== record.baseBranch) throw err('E_STALE_REVISION', `PR #${record.number} base is ${live.base ?? 'unknown'}, expected ${record.baseBranch}`);
  if (live.head !== record.headBranch) throw err('E_STALE_REVISION', `PR #${record.number} head is ${live.head ?? 'unknown'}, expected ${record.headBranch}`);
}

/** Refuse to enqueue unless the live PR is still the recorded, open, exact-head PR. */
function assertLivePrMatches(live: LivePr, record: LanePrRecord, target: LanePrTarget, headSha: string): void {
  assertLivePrIdentity(live, record, target);
  if (live.headSha !== headSha) throw err('E_STALE_REVISION', `PR #${record.number} head ${live.headSha} is not accepted head ${headSha}`);
}

/**
 * The newest removal GitHub already shows belongs to an earlier attempt. Unreadable merge-queue history cannot
 * prove "no removal yet", so it fails closed instead of recording an empty baseline.
 */
function removalBaseline(live: LivePr, number: number): string | undefined {
  if (live.queueStateKnown !== true) {
    throw err('E_ADAPTER', `Merge-queue history of PR #${number} could not be read, so the removals GitHub already showed are unknown; retry later`);
  }
  return live.queueRemovalId;
}

/** A removal that is new for this attempt: explained by GitHub, not shown at attempt start, not already handled. */
function newEjection(live: LivePr, record: LanePrRecord): { reason: string; removalId: string } | undefined {
  const reason = live.queueReason?.trim();
  const removalId = live.queueRemovalId;
  // A removal reported after the remote head moved past this attempt belongs to that newer head, not to us.
  if (live.headSha && live.headSha !== record.headSha) return undefined;
  if (
    live.mergeQueueState === 'ejected' &&
    reason &&
    removalId &&
    removalId !== record.queueBaselineRemovalId &&
    removalId !== record.handledQueueRemovalId
  ) {
    return { reason, removalId };
  }
  return undefined;
}

export type GateState = 'pending' | 'success' | 'failure';

/** The turbine/gate state that belongs on `headSha`: success only for a PASS bound to that exact commit. */
export function desiredGateState(headSha: string, gatePassSha?: string): GateState {
  return gatePassSha === headSha ? 'success' : gatePassSha ? 'failure' : 'pending';
}

/**
 * Whether landing work for the accepted `headSha` is still owed, independent of the head changing: the
 * record is missing, belongs to another head or authorization, its gate status never reached GitHub (or
 * differs from what should be there), the PR was closed unmerged, or auto-merge was requested but unconfirmed.
 */
export function landingIncomplete(
  record: LanePrRecord | undefined,
  input: { headSha: string; authorizationId: string; gatePassSha?: string; policy: boolean },
): boolean {
  if (!record) return true;
  // An earlier merge of a different head does not complete a later acceptance: that head needs its own PR.
  if (record.queueState === 'merged') return record.headSha !== input.headSha;
  if (record.headSha !== input.headSha || record.authorizationId !== input.authorizationId) return true;
  if (record.prState === 'closed') return true;
  const gate = desiredGateState(input.headSha, input.gatePassSha);
  if (record.statusPublished?.sha !== input.headSha || record.statusPublished.state !== gate) return true;
  return input.policy && gate === 'success' && record.queueState === 'not-enabled';
}

/** The row is still the same PR and the same landing attempt as the one a result was computed for. */
function sameAttempt(fresh: LanePrRecord, basis: LanePrRecord): boolean {
  return (
    fresh.owner === basis.owner &&
    fresh.repo === basis.repo &&
    fresh.number === basis.number &&
    fresh.authorizationId === basis.authorizationId &&
    fresh.headSha === basis.headSha
  );
}

/**
 * Save a result of a network call only if, under the write lock, the stored row is still the PR and landing
 * attempt it was computed for and has not already merged. Otherwise the row is returned unchanged and the next
 * poll recomputes it.
 */
function saveIfCurrent(
  store: WorkStore,
  basis: LanePrRecord,
  patch: Partial<LanePrRecord>,
): { record: LanePrRecord; applied: boolean } {
  return store.transaction(() => {
    const fresh = store.getLanePrRecord(basis.workId);
    if (!fresh || !sameAttempt(fresh, basis) || fresh.queueState === 'merged') return { record: fresh ?? basis, applied: false };
    return { record: store.saveLanePrRecord({ ...fresh, ...patch }), applied: true };
  });
}

export async function ensureAcceptedPr(input: {
  store: WorkStore;
  work: WorkPackage;
  headSha: string;
  /** The sqa-acceptance Decision authorizing this landing attempt. */
  authorizationId: string;
  target: LanePrTarget;
  tools: { allow: string[]; denied: string[] };
  policy?: ApprovedLanePolicy;
  gatePassSha?: string;
  /** Re-check that the acceptance still authorizes landing (e.g. policy not suspended) before each remote write. */
  assertStillAuthorized?: () => void;
}): Promise<LanePrRecord> {
  const { store, work, headSha, authorizationId, target, tools, policy } = input;
  const assertAuth = () => input.assertStillAuthorized?.();
  if (!configAllows(tools, 'pr.create')) throw err('E_MISSING_CAPABILITY', 'pr.create is not allowed by project config');
  if (policy && !policy.policy.tools.includes('pr.create')) {
    throw err('E_MISSING_CAPABILITY', `Lane policy ${policy.name} does not grant pr.create`);
  }
  const timestamp = new Date().toISOString();
  let previous = store.getLanePrRecord(work.id);
  let record = previous;
  let live: LivePr | undefined;
  if (record) {
    assertRecordedTarget(record, target);
    live = (await readPr(target, work.id, record.number)).data;
    if (live.state === 'merged') {
      // Same head already merged: done. A later acceptance of a different head needs a new PR; keep A's facts.
      if (record.headSha === headSha) return record;
      previous = undefined;
      record = undefined;
    } else if (live.state === 'closed') {
      // A PR closed without merging cannot land; find or create an open replacement.
      record = undefined;
    }
  }
  // The authorizing policy terms belong to ONE landing attempt. Only a retry of the same authorization on the
  // same PR keeps its snapshot; a new acceptance or a replacement PR snapshots the policy it was authorized by.
  const snapshot = policy ? { name: policy.name, samplingRate: policy.policy.sampling.rate } : undefined;
  const authorizingPolicy =
    record && record.authorizationId === authorizationId && record.authorizingPolicy ? record.authorizingPolicy : snapshot;
  if (!record) {
    assertAuth();
    const head = `turbine/${work.id}`;
    let created: InvokeResult<{
      number: number;
      nodeId?: string;
      url: string;
      head: string;
      headSha: string;
      base: string;
    }>;
    try {
      // Ensure the landing head exists remotely (or in fixtures) before pr.create.
      if (target.adapter.capabilities.includes('git.branch.create')) {
        await invoke(target, 'git.branch.create', work.id, { branch: head, sha: headSha });
      }
      created = await invoke(target, 'pr.create', work.id, {
        head,
        headSha,
        base: target.baseBranch,
        title: work.title,
        body: `Turbine task ${work.id}`,
      });
    } catch (e) {
      // Create fails closed when the accepted branch cannot be published / opened remotely.
      throw err(
        'E_ADAPTER',
        `${(e as Error).message}. Push branch turbine/${work.id} with the accepted commit to the remote, then sync again`,
      );
    }
    if (created.data.headSha !== headSha) throw err('E_STALE_REVISION', `Created PR head ${created.data.headSha} is not accepted head ${headSha}`);
    // The PR may be an existing open one that was adopted rather than created: whatever removals GitHub already
    // shows belong to earlier history. Read them BEFORE recording, so an unreadable history records nothing.
    live = (await readPr(target, work.id, created.data.number)).data;
    const queueBaselineRemovalId = removalBaseline(live, created.data.number);
    const createdRecord: LanePrRecord = {
      workId: work.id,
      owner: target.owner,
      repo: target.repo,
      number: created.data.number,
      nodeId: created.data.nodeId,
      url: created.data.url,
      baseBranch: target.baseBranch,
      headBranch: created.data.head,
      headSha,
      gateState: 'pending',
      queueState: 'not-enabled',
      prState: 'open',
      authorizationId,
      authorizingPolicy,
      queueBaselineRemovalId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    record = store.transaction(() => {
      const saved = store.saveLanePrRecord(createdRecord);
      if (previous) {
        store.appendEvent({
          workId: work.id,
          type: 'lane.pr-replaced',
          payload: { closedNumber: previous.number, number: saved.number },
        });
      }
      // One merge record per task; the open one is reused, never duplicated, when the PR is replaced.
      if (!store.listLaneMergeRecords().some((entry) => entry.workId === work.id && entry.mergeState === 'open')) {
        store.saveLaneMergeRecord({
          id: createId('merge'),
          workId: work.id,
          policyId: policy?.name ?? null,
          openedAt: timestamp,
          mergeState: 'open',
          reverted: 'unknown',
          recordedAt: timestamp,
        });
      }
      return saved;
    });
  } else if (record.headSha !== headSha || record.authorizationId !== authorizationId) {
    // A new head or a new acceptance is a new attempt: nothing from the previous attempt (gate state, queue
    // state, a removal GitHub already showed) may carry over.
    const queueBaselineRemovalId = removalBaseline(live!, record.number);
    record = store.saveLanePrRecord({
      ...record,
      headSha,
      gateState: 'pending',
      queueState: 'not-enabled',
      queueReason: undefined,
      statusPublished: undefined,
      handledQueueRemovalId: undefined,
      queueBaselineRemovalId,
      prState: 'open',
      authorizationId,
      authorizingPolicy,
      updatedAt: timestamp,
    });
  }

  // Publish turbine/gate only on the PR GitHub actually shows: same repo/base/branch, and a head that has caught
  // up with the accepted commit. A lagging remote leaves publication incomplete; the next sync retries it.
  const shown = live!;
  assertLivePrIdentity(shown, record, target);
  if (shown.headSha !== headSha) return record;

  const gateState = desiredGateState(headSha, input.gatePassSha);
  assertAuth();
  await invoke(target, 'commit.status', work.id, {
    sha: headSha,
    context: 'turbine/gate',
    state: gateState,
    description: gateState === 'success' ? 'Turbine gate passed at this commit' : 'Turbine gate is not passed at this commit',
  });
  // Recorded only after GitHub accepted it, so a failed publication stays visible as incomplete work.
  const published = saveIfCurrent(store, record, {
    gateState,
    statusPublished: { sha: headSha, state: gateState },
    prState: 'open',
    updatedAt: new Date().toISOString(),
  });
  record = published.record;
  // A newer attempt replaced the row (or it already merged) while status was publishing: do not enqueue that PR.
  if (!published.applied) return record;

  if (policy) {
    if (!configAllows(tools, 'pr.merge')) throw err('E_MISSING_CAPABILITY', 'pr.merge is not allowed by project config');
    if (!policy.policy.tools.includes('pr.merge')) throw err('E_MISSING_CAPABILITY', `Lane policy ${policy.name} does not grant pr.merge`);
    if (gateState !== 'success') return record;
    const beforeQueue = (await readPr(target, work.id, record.number)).data;
    assertLivePrMatches(beforeQueue, record, target, headSha);
    if (beforeQueue.queueStateKnown !== true) {
      throw err('E_ADAPTER', `Merge-queue history of PR #${record.number} could not be read; retry later`);
    }
    // GitHub may already have removed this PR from the queue. Reconcile that first: re-enqueueing over an
    // unhandled ejection would hide it from the fix-round path.
    const ejection = newEjection(beforeQueue, record);
    if (ejection) {
      return saveIfCurrent(store, record, {
        queueState: 'ejected',
        queueReason: ejection.reason,
        updatedAt: new Date().toISOString(),
      }).record;
    }
    if (beforeQueue.mergeQueueState !== 'queued') {
      assertAuth();
      // Queue-only: if GitHub cannot enqueue (no merge queue, PR not ready) this throws and stays retryable.
      await invoke(target, 'pr.merge', work.id, {
        number: record.number,
        nodeId: record.nodeId,
        mode: 'queue-only',
        admin: false,
        expectedHeadOid: headSha,
      });
    }
    // Enqueueing is a request; only GitHub reporting queue membership makes the task "queued".
    const confirmed = (await readPr(target, work.id, record.number)).data.mergeQueueState === 'queued';
    record = saveIfCurrent(store, record, {
      queueState: confirmed ? 'queued' : 'not-enabled',
      queueReason: confirmed ? undefined : 'enqueue requested; GitHub has not confirmed merge-queue membership',
      updatedAt: new Date().toISOString(),
    }).record;
  }
  return record;
}

const SUSPENSION_EVALUATED = 'lane.merge-suspension-evaluated';

/** The merge fact recorded for this PR's merge SHA, if any. */
function mergedFactFor(store: WorkStore, workId: string, mergeSha?: string) {
  return store
    .listLaneMergeRecords()
    .filter((entry) => entry.workId === workId && entry.mergeState === 'merged' && (!mergeSha || entry.mergeSha === mergeSha))
    .at(-1);
}

/** A committed policy merge whose post-merge suspension check has not completed yet (it must be retried). */
export function pendingMergeEvaluation(store: WorkStore, workId: string): LaneMergeRecord | undefined {
  const merge = mergedFactFor(store, workId);
  if (!merge?.policyId) return undefined;
  const done = store.listEvents(workId).some((event) => event.type === SUSPENSION_EVALUATED && event.payload.mergeRecordId === merge.id);
  return done ? undefined : merge;
}

/**
 * Suspension is a consequence of committed facts; it never rolls them back, and it is retried until it has
 * run once for the merge fact (the marker is written only after the check succeeded).
 */
function evaluateMergeSuspension(store: WorkStore, merge: LaneMergeRecord | undefined): void {
  if (!merge?.policyId) return;
  if (store.listEvents(merge.workId).some((event) => event.type === SUSPENSION_EVALUATED && event.payload.mergeRecordId === merge.id)) return;
  evaluateSuspendWhen(store, merge.policyId);
  store.appendEvent({ workId: merge.workId, type: SUSPENSION_EVALUATED, payload: { mergeRecordId: merge.id, policyId: merge.policyId } });
}

/**
 * The policy a merge counts for: only the policy that authorized the attempt that landed. A recorded
 * authorization without a policy snapshot is a human acceptance: it never inherits whatever policy is current.
 * Only a legacy record with no recorded authorization may fall back to the policy the caller resolved.
 */
function landedPolicyName(record: LanePrRecord, legacyPolicy?: ApprovedLanePolicy): string | null {
  if (record.authorizationId) return record.authorizingPolicy?.name ?? null;
  return record.authorizingPolicy?.name ?? legacyPolicy?.name ?? null;
}

export async function refreshLanePr(input: {
  store: WorkStore;
  workId: string;
  target: LanePrTarget;
  /** Legacy fallback only: used when the PR record carries no authorization. */
  policy?: ApprovedLanePolicy;
}): Promise<{ kind: 'open' | 'ejected' | 'merged'; record: LanePrRecord; reason?: string; removalId?: string }> {
  const { store } = input;
  const stored = store.getLanePrRecord(input.workId);
  if (!stored) throw err('E_NOT_FOUND', `No PR recorded for ${input.workId}`);
  const current: LanePrRecord = stored;
  // Poll the repo the PR was created in, even if origin has since changed.
  const result = await readPr({ ...input.target, owner: current.owner, repo: current.repo }, input.workId, current.number);
  const at = new Date().toISOString();
  if (result.data.state === 'merged' && result.data.mergedAt && result.data.mergeSha) {
    const { mergedAt, mergeSha } = result.data;
    // A merge of a head other than the one this attempt accepted is not this attempt's landing: it counts as an
    // unattributed (human-lane) merge rather than being credited to the attempt's policy.
    const landedHead = result.data.headSha;
    const attributable = !landedHead || landedHead === current.headSha;
    // The merged PR record, the Part G merge facts and the audit sample commit together or not at all, and
    // only if the row is still the PR and attempt this result was read for.
    type MergeOutcome = { stale: LanePrRecord } | { stale?: undefined; record: LanePrRecord; merge: LaneMergeRecord };
    const outcome = store.transaction((): MergeOutcome => {
      const fresh = store.getLanePrRecord(input.workId);
      if (!fresh || !sameAttempt(fresh, current)) return { stale: fresh ?? current };
      const record = fresh.queueState === 'merged' ? fresh : store.saveLanePrRecord({ ...fresh, queueState: 'merged', updatedAt: at });
      const priorRecords = store.listLaneMergeRecords().filter((entry) => entry.workId === input.workId);
      // Idempotent: this merge SHA is already recorded; its (possibly unfinished) suspension check is retried.
      const recorded = priorRecords.find((entry) => entry.mergeState === 'merged' && entry.mergeSha === mergeSha);
      if (recorded) return { record, merge: recorded };
      const opened = priorRecords.find((entry) => entry.mergeState === 'open');
      const policyId = attributable ? landedPolicyName(fresh, input.policy) : null;
      const merge = {
        id: opened?.id ?? createId('merge'),
        workId: input.workId,
        policyId,
        openedAt: opened?.openedAt ?? fresh.createdAt,
        mergeState: 'merged' as const,
        mergedAt,
        mergeSha,
        reverted: 'unknown' as const,
        fixRounds: store.listEvents(input.workId).filter((event) => event.type === 'lane.queue-ejected').length,
        recordedAt: at,
      };
      if (!attributable) {
        store.appendEvent({
          workId: input.workId,
          type: 'lane.merge-unattributed',
          payload: { reason: `merged head ${landedHead} is not the accepted head ${fresh.headSha}`, mergeSha },
        });
      }
      if (merge.policyId) return { record, merge: savePolicyMergeFacts(store, merge, { rate: fresh.authorizingPolicy?.samplingRate }).merge };
      return { record, merge: store.saveLaneMergeRecord(merge) };
    });
    if (outcome.stale) return { kind: 'open', record: outcome.stale };
    evaluateMergeSuspension(store, outcome.merge);
    return { kind: 'merged', record: outcome.record };
  }
  if (result.data.state === 'closed') {
    const saved = saveIfCurrent(store, current, {
      queueState: 'not-enabled',
      queueReason: 'PR was closed without merging',
      prState: 'closed',
      updatedAt: at,
    });
    return { kind: 'open', record: saved.record };
  }
  // Ejection needs GitHub's own removal reason AND a removal that belongs to this attempt: one GitHub already
  // showed when the attempt began, or one that already started a fix round, is not a new ejection.
  const ejection = newEjection(result.data, current);
  if (ejection) {
    const saved = store.transaction(() => {
      const fresh = store.getLanePrRecord(input.workId);
      // Judge "new" against the stored row now, not the one read before the network call.
      if (!fresh || !sameAttempt(fresh, current) || fresh.queueState === 'merged' || !newEjection(result.data, fresh)) {
        return { record: fresh ?? current, applied: false };
      }
      return { record: store.saveLanePrRecord({ ...fresh, queueState: 'ejected', queueReason: ejection.reason, updatedAt: at }), applied: true };
    });
    if (saved.applied) return { kind: 'ejected', record: saved.record, reason: ejection.reason, removalId: ejection.removalId };
    return { kind: 'open', record: saved.record };
  }
  if (result.data.mergeQueueState === 'queued' && current.queueState !== 'queued') {
    return { kind: 'open', record: saveIfCurrent(store, current, { queueState: 'queued', queueReason: undefined, updatedAt: at }).record };
  }
  return { kind: 'open', record: store.getLanePrRecord(input.workId) ?? current };
}
