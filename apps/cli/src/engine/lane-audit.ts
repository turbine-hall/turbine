import { createHash } from 'node:crypto';
import { createId, err, type LaneAuditRecord, type LaneMergeRecord } from '@turbine-hall/turbine-contracts';
import type { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import { evaluateSuspendWhen } from './lane-metrics.js';

export function samplingDraw(record: Pick<LaneMergeRecord, 'id' | 'workId' | 'policyId' | 'mergedAt' | 'mergeSha'>): {
  seed: string;
  draw: number;
} {
  const identity = [record.id, record.workId, record.policyId ?? 'human', record.mergedAt ?? '', record.mergeSha ?? ''].join('\0');
  const seed = createHash('sha256').update(identity).digest('hex');
  // Thirteen hex digits fit exactly within JavaScript's safe integer range.
  const draw = Number.parseInt(seed.slice(0, 13), 16) / 16 ** 13;
  return { seed, draw };
}

/**
 * Part C's future merge hook calls this entry point. It saves the merge fact and selected audit
 * atomically; a failed queue write cannot leave an un-sampled policy merge behind.
 */
export function recordPolicyMerge(
  store: WorkStore,
  input: Omit<LaneMergeRecord, 'sampling'>,
  /** Sampling rate snapshotted when landing was authorized; omitted falls back to the live policy. */
  opts: { rate?: number } = {},
): { merge: LaneMergeRecord; audit: LaneAuditRecord | null } {
  if (input.mergeState !== 'merged' || !input.policyId) {
    throw err('E_INVALID_CONFIG', 'Audit sampling requires a merged policy record');
  }
  let rate = opts.rate;
  if (rate === undefined) {
    const approved = store.getLanePolicy(input.policyId);
    if (!approved) throw err('E_NOT_FOUND', `No approved policy named ${input.policyId}`);
    rate = approved.policy.sampling.rate;
  }
  const { seed, draw } = samplingDraw(input);
  const selected = draw < rate;
  const result = store.transaction(() => {
    const merge = store.saveLaneMergeRecord({ ...input, sampling: { seed, draw, rate, selected } });
    if (!selected) return { merge, audit: null };
    const audit = store.enqueueLaneAudit({
      id: createId('audit'),
      mergeRecordId: merge.id,
      workId: merge.workId,
      policyId: input.policyId!,
      seed,
      draw,
      rate,
      queuedAt: input.recordedAt,
      outcome: 'queued',
    });
    return { merge, audit };
  });
  evaluateSuspendWhen(store, input.policyId);
  return result;
}

export function nextLaneAudit(store: WorkStore): LaneAuditRecord | null {
  return store.listLaneAudits().find((audit) => audit.outcome === 'queued') ?? null;
}

/** Caller must establish TTY/no-agent presence before invoking this human attestation. */
export function recordLaneAuditOutcome(
  store: WorkStore,
  input: { id: string; outcome: 'ok' | 'problem'; note?: string; reviewer: string },
): { audit: LaneAuditRecord; suspended: boolean; reasons: string[] } {
  const reviewer = input.reviewer.trim();
  if (!reviewer) throw err('E_UNTRUSTED_IDENTITY', 'Reviewer name is required');
  const audit = store.transaction(() => {
    const queued = store.getLaneAudit(input.id);
    if (!queued) throw err('E_NOT_FOUND', `Audit not found: ${input.id}`);
    if (queued.outcome !== 'queued') throw err('E_INVALID_TRANSITION', `Audit ${input.id} has already been recorded`);
    return store.recordLaneAudit({
      ...queued,
      outcome: input.outcome,
      note: input.note?.trim() || undefined,
      recordedBy: reviewer,
      recordedAt: new Date().toISOString(),
    });
  });
  const evaluated = evaluateSuspendWhen(store, audit.policyId);
  return { audit, ...evaluated };
}
