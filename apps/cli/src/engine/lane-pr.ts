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
import { recordPolicyMerge } from './lane-audit.js';

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

export async function ensureAcceptedPr(input: {
  store: WorkStore;
  work: WorkPackage;
  headSha: string;
  target: LanePrTarget;
  tools: { allow: string[]; denied: string[] };
  policy?: ApprovedLanePolicy;
  gatePassSha?: string;
}): Promise<LanePrRecord> {
  const { store, work, headSha, target, tools, policy } = input;
  if (!configAllows(tools, 'pr.create')) throw err('E_MISSING_CAPABILITY', 'pr.create is not allowed by project config');
  if (policy && !policy.policy.tools.includes('pr.create')) {
    throw err('E_MISSING_CAPABILITY', `Lane policy ${policy.name} does not grant pr.create`);
  }
  const timestamp = new Date().toISOString();
  const previous = store.getLanePrRecord(work.id);
  let record = previous;
  if (record) {
    assertRecordedTarget(record, target);
    const live = (await readPr(target, work.id, record.number)).data;
    if (live.state === 'merged') return record;
    // A PR closed without merging cannot land; find or create an open replacement.
    if (live.state === 'closed') record = undefined;
  }
  // Snapshot the terms that authorized landing; later policy edits must not change how the merge is sampled.
  const authorizingPolicy =
    previous?.authorizingPolicy ?? (policy ? { name: policy.name, samplingRate: policy.policy.sampling.rate } : undefined);
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
      } else {
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
  } else if (record.headSha !== headSha || (policy && !record.authorizingPolicy)) {
    record = store.saveLanePrRecord({
      ...record,
      ...(record.headSha !== headSha
        ? { headSha, gateState: 'pending' as const, queueState: 'not-enabled' as const, queueReason: undefined }
        : {}),
      authorizingPolicy,
      updatedAt: timestamp,
    });
  }

  const gateState = input.gatePassSha === headSha ? 'success' : input.gatePassSha ? 'failure' : 'pending';
  await invoke(target, 'commit.status', work.id, {
    sha: headSha,
    context: 'turbine/gate',
    state: gateState,
    description: gateState === 'success' ? 'Turbine gate passed at this commit' : 'Turbine gate is not passed at this commit',
  });
  record = store.saveLanePrRecord({ ...record, gateState, updatedAt: new Date().toISOString() });

  if (policy) {
    if (!configAllows(tools, 'pr.merge')) throw err('E_MISSING_CAPABILITY', 'pr.merge is not allowed by project config');
    if (!policy.policy.tools.includes('pr.merge')) throw err('E_MISSING_CAPABILITY', `Lane policy ${policy.name} does not grant pr.merge`);
    if (gateState !== 'success') return record;
    assertLivePrMatches((await readPr(target, work.id, record.number)).data, record, target, headSha);
    await invoke(target, 'pr.merge', work.id, { number: record.number, nodeId: record.nodeId, mode: 'auto-merge-only', admin: false });
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
}): Promise<{ kind: 'open' | 'ejected' | 'merged'; record: LanePrRecord; reason?: string }> {
  const current = input.store.getLanePrRecord(input.workId);
  if (!current) throw err('E_NOT_FOUND', `No PR recorded for ${input.workId}`);
  // Poll the repo the PR was created in, even if origin has since changed.
  const result = await readPr({ ...input.target, owner: current.owner, repo: current.repo }, input.workId, current.number);
  const at = new Date().toISOString();
  if (result.data.state === 'merged' && result.data.mergedAt && result.data.mergeSha) {
    const record = input.store.saveLanePrRecord({ ...current, queueState: 'merged', updatedAt: at });
    const priorRecords = input.store.listLaneMergeRecords().filter((entry) => entry.workId === input.workId);
    const alreadyRecorded = priorRecords.find(
      (entry) => entry.mergeState === 'merged' && entry.mergeSha === result.data.mergeSha,
    );
    if (alreadyRecorded) return { kind: 'merged', record };
    const opened = priorRecords.find((entry) => entry.mergeState === 'open');
    const merge = {
      id: opened?.id ?? createId('merge'),
      workId: input.workId,
      policyId: current.authorizingPolicy?.name ?? input.policy?.name ?? null,
      openedAt: opened?.openedAt ?? current.createdAt,
      mergeState: 'merged' as const,
      mergedAt: result.data.mergedAt,
      mergeSha: result.data.mergeSha,
      reverted: 'unknown' as const,
      fixRounds: input.store.listEvents(input.workId).filter((event) => event.type === 'lane.queue-ejected').length,
      recordedAt: at,
    };
    if (merge.policyId) recordPolicyMerge(input.store, merge, { rate: current.authorizingPolicy?.samplingRate });
    else input.store.saveLaneMergeRecord(merge);
    return { kind: 'merged', record };
  }
  if (result.data.state === 'closed') {
    const record = input.store.saveLanePrRecord({
      ...current,
      queueState: 'not-enabled',
      queueReason: 'PR was closed without merging',
      updatedAt: at,
    });
    return { kind: 'open', record };
  }
  // Ejection needs GitHub's own removal reason; an unexplained signal preserves the recorded state.
  const reason = result.data.queueReason?.trim();
  if (result.data.mergeQueueState === 'ejected' && reason) {
    const record = input.store.saveLanePrRecord({ ...current, queueState: 'ejected', queueReason: reason, updatedAt: at });
    return { kind: 'ejected', record, reason };
  }
  if (result.data.mergeQueueState === 'queued' && current.queueState !== 'queued') {
    return { kind: 'open', record: input.store.saveLanePrRecord({ ...current, queueState: 'queued', queueReason: undefined, updatedAt: at }) };
  }
  return { kind: 'open', record: current };
}
