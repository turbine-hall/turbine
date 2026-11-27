import { err, type LaneMergeRecord } from '@turbine-hall/turbine-contracts';
import type { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import { suspendPolicy } from './lane-policy.js';

export type MetricPeriod = { since: string; until: string };
export type LaneMetric = {
  value: number | 'unknown';
  numerator: number | 'unknown';
  denominator: number;
  unknown: number;
  period: MetricPeriod;
};
export type LaneMetricsRow = {
  lane: 'policy' | 'human';
  policy: string | null;
  tasks: number;
  mergedPrsPerWeek: LaneMetric;
  mergeRate: LaneMetric;
  revertRate: LaneMetric;
  fixRoundsPerMergedPr: LaneMetric;
  costPerMergedPrUsd: LaneMetric;
  reviewerDisagreementRate: LaneMetric;
  fallbackShare: LaneMetric & { reasons: Record<string, number> };
};
export type PredictionMissMetric = {
  /** Tasks that recorded at least one fleet.prediction-miss in the period. */
  tasksWithMisses: number;
  missEvents: number;
  /** Predicted paths that did not appear in the change-report (sum of miss array lengths). */
  missedPaths: number;
  period: MetricPeriod;
};

export type LaneMetricsReport = {
  generatedAt: string;
  period: MetricPeriod;
  rows: LaneMetricsRow[];
  /** Part F: prediction vs actual misses (never blocks acceptance). */
  predictionMisses: PredictionMissMetric;
};

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

function metric(numerator: number, denominator: number, unknown: number, period: MetricPeriod): LaneMetric {
  return {
    value: denominator > 0 && unknown === 0 ? round(numerator / denominator) : 'unknown',
    numerator,
    denominator,
    unknown,
    period,
  };
}

function parseSince(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const millis = Date.parse(raw);
  if (!Number.isFinite(millis)) throw err('E_INVALID_CONFIG', `Invalid --since date: ${raw}`);
  return new Date(millis).toISOString();
}

function policyForWork(store: WorkStore, workId: string): string | null {
  const decisions = store
    .listDecisions(workId)
    .filter((decision) => decision.actorType === 'policy' && decision.action === 'approve' && !decision.invalidatedAt)
    .sort((a, b) => a.decidedAt.localeCompare(b.decidedAt) || a.id.localeCompare(b.id));
  return decisions.at(-1)?.policyId ?? null;
}

function attributedAgreements(store: WorkStore, workId: string, changeSetId?: string) {
  return store.listReviewerAgreements(workId, changeSetId).filter((agreement) => {
    if (agreement.policyId && agreement.policyHash) return true;
    const alreadyRecorded = store
      .listEvents(workId)
      .some(
        (event) =>
          event.type === 'review.agreement-skipped' &&
          event.payload.agreementId === agreement.id,
      );
    if (!alreadyRecorded) {
      store.appendEvent({
        workId,
        type: 'review.agreement-skipped',
        payload: {
          agreementId: agreement.id,
          changeSetId: agreement.changeSetId,
          lens: agreement.lens,
          reason: 'legacy reviewer agreement lacks evaluated policy identity',
        },
      });
    }
    return false;
  }) as Array<ReturnType<WorkStore['listReviewerAgreements']>[number] & { policyId: string; policyHash: string }>;
}

function agreementsForPolicy(store: WorkStore, policyId: string) {
  return store
    .listWork()
    .flatMap((work) => attributedAgreements(store, work.id))
    .filter((agreement) => agreement.policyId === policyId);
}

export function policyForReviewPair(store: WorkStore, workId: string, changeSetId: string): string | null {
  const agreements = attributedAgreements(store, workId, changeSetId);
  const policyIds = new Set(agreements.map((agreement) => agreement.policyId));
  if (policyIds.size > 1) {
    throw err('E_INVALID_CONFIG', `Reviewer agreements for ${workId} at ${changeSetId} name conflicting policies`);
  }
  return policyIds.values().next().value ?? null;
}

function recordsForLane(records: LaneMergeRecord[], policy: string | null): LaneMergeRecord[] {
  return records.filter((record) => record.policyId === policy);
}

/**
 * Computes one explicit-denominator report. A task with no Part C record contributes an unknown
 * merge state; optional cost/revert/fix facts likewise remain visible as unknown.
 */
export function computeLaneMetrics(
  store: WorkStore,
  input: { policy?: string; since?: string; now?: string } = {},
): LaneMetricsReport {
  const generatedAt = input.now ?? new Date().toISOString();
  const allWork = store.listWork();
  const fallbackStart = allWork.map((work) => work.createdAt).sort()[0] ?? generatedAt;
  const since = parseSince(input.since, fallbackStart);
  if (Date.parse(since) > Date.parse(generatedAt)) throw err('E_INVALID_CONFIG', '--since cannot be after the report time');
  const period = { since, until: generatedAt };
  const weeks = Math.max((Date.parse(generatedAt) - Date.parse(since)) / (7 * 24 * 60 * 60 * 1000), 1 / 7);
  const work = allWork.filter((item) => item.createdAt >= since && item.createdAt <= generatedAt);
  const records = store
    .listLaneMergeRecords()
    .filter((record) => record.openedAt >= since && record.openedAt <= generatedAt);
  const storedPolicies = store.listLanePolicies();
  const unreadable = storedPolicies.find((row) => row.error);
  if (unreadable) throw err('E_INVALID_CONFIG', `Stored lane policy ${unreadable.name} is unreadable: ${unreadable.error}`);
  const names = storedPolicies.map((row) => row.name);
  const lanes: Array<string | null> = input.policy
    ? [input.policy === 'human' ? null : input.policy]
    : [...names, null];
  if (input.policy && input.policy !== 'human' && !names.includes(input.policy)) {
    throw err('E_NOT_FOUND', `No approved policy named ${input.policy}`);
  }

  const rows = lanes.map((policy): LaneMetricsRow => {
    const laneWork = work.filter((item) => policyForWork(store, item.id) === policy);
    const laneRecords = recordsForLane(records, policy);
    const agreements = policy === null
      ? []
      : agreementsForPolicy(store, policy).filter((agreement) => agreement.recordedAt >= since && agreement.recordedAt <= generatedAt);
    const taskIds = new Set([
      ...laneWork.map((item) => item.id),
      ...laneRecords.map((record) => record.workId),
      ...agreements.map((agreement) => agreement.workId),
    ]);
    const latestByTask = new Map<string, LaneMergeRecord>();
    for (const record of laneRecords) latestByTask.set(record.workId, record);
    const merged = [...latestByTask.values()].filter((record) => record.mergeState === 'merged');
    const knownReverts = merged.filter((record) => record.reverted !== 'unknown');
    const revertUnknown = merged.length - knownReverts.length;
    const reverted = knownReverts.filter((record) => record.reverted === 'yes').length;
    const knownFixRounds = merged.filter((record) => record.fixRounds !== undefined);
    const knownCosts = merged.filter((record) => record.costUsd !== undefined);

    const disagreements = agreements.filter((agreement) => !agreement.agreed).length;
    const fallbackEvents = work.flatMap((item) =>
      store
        .listEvents(item.id)
        .filter((event) => event.type === 'lane.fallback')
        .filter((event) => {
          if (policy === null) return true;
          const evaluations = Array.isArray(event.payload.evaluations) ? event.payload.evaluations : [];
          return evaluations.some((entry) => entry && typeof entry === 'object' && (entry as { policy?: unknown }).policy === policy);
        }),
    );
    const fallbackWorkIds = new Set(fallbackEvents.map((event) => event.workId).filter((id): id is string => !!id));
    for (const id of fallbackWorkIds) taskIds.add(id);
    const mergeUnknown = [...taskIds].filter((id) => !latestByTask.has(id) || latestByTask.get(id)!.mergeState === 'unknown').length;
    const reasons: Record<string, number> = {};
    for (const event of fallbackEvents) {
      const eventReasons = Array.isArray(event.payload.reasons) ? event.payload.reasons.map(String) : ['(reason unavailable)'];
      for (const reason of eventReasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    const mergedPerWeek = metric(merged.length, round(weeks), mergeUnknown, period);
    if (mergedPerWeek.value !== 'unknown') mergedPerWeek.value = round(merged.length / weeks);
    return {
      lane: policy === null ? 'human' : 'policy',
      policy,
      tasks: taskIds.size,
      mergedPrsPerWeek: mergedPerWeek,
      mergeRate: metric(merged.length, taskIds.size, mergeUnknown, period),
      revertRate: metric(reverted, merged.length, revertUnknown, period),
      fixRoundsPerMergedPr: metric(
        knownFixRounds.reduce((sum, record) => sum + record.fixRounds!, 0),
        merged.length,
        merged.length - knownFixRounds.length,
        period,
      ),
      costPerMergedPrUsd: metric(
        knownCosts.reduce((sum, record) => sum + record.costUsd!, 0),
        merged.length,
        merged.length - knownCosts.length,
        period,
      ),
      reviewerDisagreementRate: metric(disagreements, agreements.length, 0, period),
      fallbackShare: { ...metric(fallbackWorkIds.size, taskIds.size, 0, period), reasons },
    };
  });

  // Use allWork so misses on older tasks still count when their event time is in-period.
  const missEvents = allWork.flatMap((item) =>
    store
      .listEvents(item.id)
      .filter((event) => event.type === 'fleet.prediction-miss')
      .filter((event) => event.createdAt >= since && event.createdAt <= generatedAt),
  );
  const tasksWithMisses = new Set(missEvents.map((event) => event.workId).filter((id): id is string => !!id));
  let missedPaths = 0;
  for (const event of missEvents) {
    const misses = Array.isArray(event.payload.misses) ? event.payload.misses : [];
    missedPaths += misses.length;
  }

  return {
    generatedAt,
    period,
    rows,
    predictionMisses: {
      tasksWithMisses: tasksWithMisses.size,
      missEvents: missEvents.length,
      missedPaths,
      period,
    },
  };
}

const DEFAULT_SUSPEND = {
  revertRate: { above: 0.02, overLastMerges: 50 },
  auditProblems: { atLeast: 2, inLastAudits: 20 },
  reviewerDisagreement: { above: 0.3 },
};

/** Evaluate known evidence only. An incomplete revert window cannot trigger a suspension. */
export function evaluateSuspendWhen(store: WorkStore, policyId: string): { suspended: boolean; reasons: string[] } {
  const approved = store.getLanePolicy(policyId);
  if (!approved || approved.status !== 'active') return { suspended: false, reasons: [] };
  const configured = approved.policy.suspendWhen;
  const thresholds = {
    revertRate: configured.revertRate ?? DEFAULT_SUSPEND.revertRate,
    auditProblems: configured.auditProblems ?? DEFAULT_SUSPEND.auditProblems,
    reviewerDisagreement: configured.reviewerDisagreement ?? DEFAULT_SUSPEND.reviewerDisagreement,
  };
  const reasons: string[] = [];

  const merges = store
    .listLaneMergeRecords()
    .filter((record) => record.policyId === policyId && record.mergeState === 'merged')
    .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))
    .slice(0, thresholds.revertRate.overLastMerges);
  if (merges.length && merges.every((record) => record.reverted !== 'unknown')) {
    const reverted = merges.filter((record) => record.reverted === 'yes').length;
    const rate = reverted / merges.length;
    if (rate > thresholds.revertRate.above) {
      reasons.push(`revert rate ${round(rate)} exceeded ${thresholds.revertRate.above} over last ${merges.length} known merges`);
    }
  }

  const audits = store
    .listLaneAudits(policyId)
    .filter((audit) => audit.outcome !== 'queued')
    .sort((a, b) => a.recordedAt!.localeCompare(b.recordedAt!) || a.id.localeCompare(b.id))
    .slice(-thresholds.auditProblems.inLastAudits);
  const problems = audits.filter((audit) => audit.outcome === 'problem').length;
  if (problems >= thresholds.auditProblems.atLeast) {
    reasons.push(`${problems} audit problems reached ${thresholds.auditProblems.atLeast} in last ${audits.length} audits`);
  }

  const agreements = agreementsForPolicy(store, policyId);
  if (agreements.length) {
    const disagreement = agreements.filter((agreement) => !agreement.agreed).length / agreements.length;
    if (disagreement > thresholds.reviewerDisagreement.above) {
      reasons.push(`reviewer disagreement ${round(disagreement)} exceeded ${thresholds.reviewerDisagreement.above}`);
    }
  }
  if (!reasons.length) return { suspended: false, reasons };
  suspendPolicy(store, policyId, `Auto-suspended: ${reasons.join('; ')}`, 'engine:auto-suspend');
  return { suspended: true, reasons };
}
