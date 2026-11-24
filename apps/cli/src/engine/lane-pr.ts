import {
  createId,
  err,
  type ApprovedLanePolicy,
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

/** Refuse auto-merge unless the live PR is still the recorded, open, exact-head PR. */
function assertLivePrMatches(live: LivePr, record: LanePrRecord, target: LanePrTarget, headSha: string): void {
  assertRecordedTarget(record, target);
  if (live.state !== 'open') throw err('E_STALE_REVISION', `PR #${record.number} is ${live.state}, not open`);
  if (live.base !== record.baseBranch) throw err('E_STALE_REVISION', `PR #${record.number} base is ${live.base ?? 'unknown'}, expected ${record.baseBranch}`);
  if (live.head !== record.headBranch) throw err('E_STALE_REVISION', `PR #${record.number} head is ${live.head ?? 'unknown'}, expected ${record.headBranch}`);
  if (live.headSha !== headSha) throw err('E_STALE_REVISION', `PR #${record.number} head ${live.headSha} is not accepted head ${headSha}`);
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
  if (record.queueState === 'merged') return false;
  if (record.headSha !== input.headSha || record.authorizationId !== input.authorizationId) return true;
  if (record.prState === 'closed') return true;
  const gate = desiredGateState(input.headSha, input.gatePassSha);
  if (record.statusPublished?.sha !== input.headSha || record.statusPublished.state !== gate) return true;
  return input.policy && gate === 'success' && record.queueState === 'not-enabled';
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
}): Promise<LanePrRecord> {
  const { store, work, headSha, authorizationId, target, tools, policy } = input;
  if (!configAllows(tools, 'pr.create')) throw err('E_MISSING_CAPABILITY', 'pr.create is not allowed by project config');
  if (policy && !policy.policy.tools.includes('pr.create')) {
    throw err('E_MISSING_CAPABILITY', `Lane policy ${policy.name} does not grant pr.create`);
  }
  const timestamp = new Date().toISOString();
  const previous = store.getLanePrRecord(work.id);
  let record = previous;
  let live: LivePr | undefined;
  if (record) {
    assertRecordedTarget(record, target);
    live = (await readPr(target, work.id, record.number)).data;
    if (live.state === 'merged') return record;
    // A PR closed without merging cannot land; find or create an open replacement.
    if (live.state === 'closed') record = undefined;
  }
  // The authorizing policy terms belong to ONE landing attempt. Only a retry of the same authorization on the
  // same PR keeps its snapshot; a new acceptance or a replacement PR snapshots the policy it was authorized by.
  const snapshot = policy ? { name: policy.name, samplingRate: policy.policy.sampling.rate } : undefined;
  const authorizingPolicy =
    record && record.authorizationId === authorizationId && record.authorizingPolicy ? record.authorizingPolicy : snapshot;
  if (!record) {
    const created = await invoke<{
      number: number;
      nodeId?: string;
      url: string;
      head: string;
      headSha: string;
      base: string;
    }>(target, 'pr.create', work.id, {
      head: `turbine/${work.id}`,
      headSha,
      base: target.baseBranch,
      title: work.title,
      body: `Turbine task ${work.id}`,
    });
    if (created.data.headSha !== headSha) throw err('E_STALE_REVISION', `Created PR head ${created.data.headSha} is not accepted head ${headSha}`);
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
    record = store.saveLanePrRecord({
      ...record,
      headSha,
      gateState: 'pending',
      queueState: 'not-enabled',
      queueReason: undefined,
      statusPublished: undefined,
      handledQueueRemovalId: undefined,
      queueBaselineRemovalId: live?.queueRemovalId,
      prState: 'open',
      authorizationId,
      authorizingPolicy,
      updatedAt: timestamp,
    });
  }

  const gateState = desiredGateState(headSha, input.gatePassSha);
  await invoke(target, 'commit.status', work.id, {
    sha: headSha,
    context: 'turbine/gate',
    state: gateState,
    description: gateState === 'success' ? 'Turbine gate passed at this commit' : 'Turbine gate is not passed at this commit',
  });
  // Recorded only after GitHub accepted it, so a failed publication stays visible as incomplete work.
  record = store.saveLanePrRecord({
    ...record,
    gateState,
    statusPublished: { sha: headSha, state: gateState },
    prState: 'open',
    updatedAt: new Date().toISOString(),
  });

  if (policy) {
    if (!configAllows(tools, 'pr.merge')) throw err('E_MISSING_CAPABILITY', 'pr.merge is not allowed by project config');
    if (!policy.policy.tools.includes('pr.merge')) throw err('E_MISSING_CAPABILITY', `Lane policy ${policy.name} does not grant pr.merge`);
    if (gateState !== 'success') return record;
    assertLivePrMatches((await readPr(target, work.id, record.number)).data, record, target, headSha);
    await invoke(target, 'pr.merge', work.id, {
      number: record.number,
      nodeId: record.nodeId,
      mode: 'auto-merge-only',
      admin: false,
      expectedHeadOid: headSha,
    });
    // Enabling auto-merge is a request; only GitHub reporting queue membership makes the task "queued".
    const confirmed = (await readPr(target, work.id, record.number)).data.mergeQueueState === 'queued';
    record = store.saveLanePrRecord({
      ...record,
      queueState: confirmed ? 'queued' : 'not-enabled',
      queueReason: confirmed ? undefined : 'auto-merge requested; GitHub has not confirmed merge-queue membership',
      updatedAt: new Date().toISOString(),
    });
  }
  return record;
}

export async function refreshLanePr(input: {
  store: WorkStore;
  workId: string;
  target: LanePrTarget;
  policy?: ApprovedLanePolicy;
}): Promise<{ kind: 'open' | 'ejected' | 'merged'; record: LanePrRecord; reason?: string; removalId?: string }> {
  const { store } = input;
  const current = store.getLanePrRecord(input.workId);
  if (!current) throw err('E_NOT_FOUND', `No PR recorded for ${input.workId}`);
  // Poll the repo the PR was created in, even if origin has since changed.
  const result = await readPr({ ...input.target, owner: current.owner, repo: current.repo }, input.workId, current.number);
  const at = new Date().toISOString();
  if (result.data.state === 'merged' && result.data.mergedAt && result.data.mergeSha) {
    const { mergedAt, mergeSha } = result.data;
    // The merged PR record, the Part G merge facts and the audit sample commit together or not at all.
    const outcome = store.transaction(() => {
      const record = store.saveLanePrRecord({ ...current, queueState: 'merged', updatedAt: at });
      const priorRecords = store.listLaneMergeRecords().filter((entry) => entry.workId === input.workId);
      if (priorRecords.some((entry) => entry.mergeState === 'merged' && entry.mergeSha === mergeSha)) {
        return { record, policyId: null as string | null };
      }
      const opened = priorRecords.find((entry) => entry.mergeState === 'open');
      const merge = {
        id: opened?.id ?? createId('merge'),
        workId: input.workId,
        policyId: current.authorizingPolicy?.name ?? input.policy?.name ?? null,
        openedAt: opened?.openedAt ?? current.createdAt,
        mergeState: 'merged' as const,
        mergedAt,
        mergeSha,
        reverted: 'unknown' as const,
        fixRounds: store.listEvents(input.workId).filter((event) => event.type === 'lane.queue-ejected').length,
        recordedAt: at,
      };
      if (merge.policyId) savePolicyMergeFacts(store, merge, { rate: current.authorizingPolicy?.samplingRate });
      else store.saveLaneMergeRecord(merge);
      return { record, policyId: merge.policyId };
    });
    // Suspension is a consequence of committed facts; it must never roll them back.
    if (outcome.policyId) evaluateSuspendWhen(store, outcome.policyId);
    return { kind: 'merged', record: outcome.record };
  }
  if (result.data.state === 'closed') {
    const record = store.saveLanePrRecord({
      ...current,
      queueState: 'not-enabled',
      queueReason: 'PR was closed without merging',
      prState: 'closed',
      updatedAt: at,
    });
    return { kind: 'open', record };
  }
  // Ejection needs GitHub's own removal reason AND a removal that belongs to this attempt: one GitHub already
  // showed when the attempt began, or one that already started a fix round, is not a new ejection.
  const reason = result.data.queueReason?.trim();
  const removalId = result.data.queueRemovalId;
  if (
    result.data.mergeQueueState === 'ejected' &&
    reason &&
    removalId &&
    removalId !== current.queueBaselineRemovalId &&
    removalId !== current.handledQueueRemovalId
  ) {
    const record = store.saveLanePrRecord({ ...current, queueState: 'ejected', queueReason: reason, updatedAt: at });
    return { kind: 'ejected', record, reason, removalId };
  }
  if (result.data.mergeQueueState === 'queued' && current.queueState !== 'queued') {
    return { kind: 'open', record: store.saveLanePrRecord({ ...current, queueState: 'queued', queueReason: undefined, updatedAt: at }) };
  }
  return { kind: 'open', record: current };
}
