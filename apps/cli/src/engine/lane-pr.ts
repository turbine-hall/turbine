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
  let record = store.getLanePrRecord(work.id);
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
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    record = store.transaction(() => {
      const saved = store.saveLanePrRecord(createdRecord);
      store.saveLaneMergeRecord({
        id: createId('merge'),
        workId: work.id,
        policyId: policy?.name ?? null,
        openedAt: timestamp,
        mergeState: 'open',
        reverted: 'unknown',
        recordedAt: timestamp,
      });
      return saved;
    });
  } else if (record.headSha !== headSha) {
    record = store.saveLanePrRecord({
      ...record,
      headSha,
      gateState: 'pending',
      queueState: 'not-enabled',
      queueReason: undefined,
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
    await invoke(target, 'pr.merge', work.id, { number: record.number, nodeId: record.nodeId, mode: 'auto-merge-only', admin: false });
    record = store.saveLanePrRecord({ ...record, queueState: 'queued', updatedAt: new Date().toISOString() });
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
  const result = await invoke<{
    state: 'open' | 'closed' | 'merged';
    headSha: string;
    mergeQueueState?: 'queued' | 'ejected';
    queueReason?: string;
    mergedAt?: string;
    mergeSha?: string;
  }>(input.target, 'pr.read', input.workId, { number: current.number });
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
      policyId: input.policy?.name ?? null,
      openedAt: opened?.openedAt ?? current.createdAt,
      mergeState: 'merged' as const,
      mergedAt: result.data.mergedAt,
      mergeSha: result.data.mergeSha,
      reverted: 'unknown' as const,
      fixRounds: input.store.listEvents(input.workId).filter((event) => event.type === 'lane.queue-ejected').length,
      recordedAt: at,
    };
    if (input.policy) recordPolicyMerge(input.store, merge);
    else input.store.saveLaneMergeRecord(merge);
    return { kind: 'merged', record };
  }
  if (result.data.mergeQueueState === 'ejected') {
    const reason = result.data.queueReason?.trim() || 'GitHub merge queue ejected the PR without a reason';
    const record = input.store.saveLanePrRecord({ ...current, queueState: 'ejected', queueReason: reason, updatedAt: at });
    return { kind: 'ejected', record, reason };
  }
  return { kind: 'open', record: current };
}
