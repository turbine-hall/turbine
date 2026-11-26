import { contentHash, type ApprovedLanePolicy, type LaneGate, type RiskProfile, type WorkState } from '@turbine-hall/turbine-contracts';
import { compileGlob } from './context/snapshot.js';
import { deniedBy, resolvePolicyReviewers, type ModelProfiles } from './lane-policy.js';

/** Work states where a gate waits for a human, and the lane gate each one is. */
export const LANE_GATE_FOR_STATE: Partial<Record<WorkState, LaneGate>> = {
  REQUIREMENTS_REVIEW: 'requirements',
  PLAN_REVIEW: 'plan',
  AI_REVIEW: 'codeReview',
  HUMAN_CODE_REVIEW: 'codeReview',
  HUMAN_ACCEPTANCE: 'acceptance',
};

const RISK_RANK: Record<RiskProfile, number> = { lightweight: 0, standard: 1, comprehensive: 2 };

/**
 * Everything the evaluation reads, gathered by the engine from one commit. A fact the engine could not
 * read is listed in `readErrors`, which makes the result `unknown` (never eligible).
 */
export type LaneFacts = {
  gate: LaneGate;
  workId: string;
  workRevision: number;
  state: WorkState;
  /** The commit every fact was read at: project HEAD before code exists, the change set id after. */
  commit: string;
  /** Hash of the artifact under decision (spec / plan) or the change set id. */
  subject: string;
  riskProfile: RiskProfile;
  /** Trigger names present on the task (risk reasons + detection + observed dependency changes). */
  triggers: string[];
  /** Source-issue labels recorded at intake. */
  labels: string[];
  /** The project repository plus every extra repository. */
  repoCount: number;
  unknowns: string[];
  criteriaCount: number;
  lintErrors: string[];
  criticalFindings: string[];
  /** Absent before code exists (requirements / plan gates). */
  change?: { files: string[]; changedLines: number; dependencyChanges: string[] };
  /** Acceptance gate only. */
  acceptance?: {
    p0: Array<{ id: string; status: 'FULL' | 'PARTIAL' | 'NONE' | 'unknown' }>;
    /** Configured quality checks with their latest result at `commit`. */
    checks: Array<{ command: string; result: string }>;
    /** Required obligations still unmet (excluding the acceptance decision being made). */
    gateBlocking: string[];
  };
  readErrors: string[];
  reviewerProfiles: ModelProfiles;
  dualReview?: {
    changeSetId: string;
    complete: boolean;
    clean: boolean;
    disagreement: boolean;
    artifacts?: Array<{ id: string; contentHash: string }>;
    reason?: string;
  };
  /** Part C acceptance preconditions. Missing/unconfirmed values fail closed to unknown. */
  lanePr?: {
    configAllowsCreate: boolean;
    configAllowsMerge: boolean;
    protection: {
      status: 'confirmed' | 'unknown';
      mergeQueueRequired: boolean;
      turbineGateRequired: boolean;
      reason?: string;
    };
  };
};

export type LaneEvaluation = {
  policy: string;
  policyHash: string;
  gate: LaneGate;
  status: 'eligible' | 'not-eligible' | 'unknown';
  reasons: string[];
  evaluationHash: string;
};

/**
 * Deterministic: the same policy snapshot and facts always give the same result and hash. Every check runs
 * (reasons are complete), and any read error makes the result `unknown`.
 */
export function evaluateLaneEligibility(
  policy: ApprovedLanePolicy,
  facts: LaneFacts,
  options: { requireDualReview?: boolean } = {},
): LaneEvaluation {
  const p = policy.policy;
  const reasons: string[] = [];
  if (facts.gate === 'codeReview') {
    try {
      resolvePolicyReviewers(p, facts.reviewerProfiles);
    } catch (e) {
      reasons.push((e as Error).message);
    }
    if (options.requireDualReview) {
      const review = facts.dualReview;
      if (!review || review.changeSetId !== facts.commit) reasons.push('dual review is missing or stale for the current change set');
      else if (!review.complete) reasons.push(review.reason ?? 'both reviewers did not complete with parseable output');
      else if (review.disagreement) reasons.push('the two reviewers disagree about blocking findings');
      else if (!review.clean) reasons.push('dual review has kept blocking findings');
    }
  }
  if (!p.gates.includes(facts.gate)) reasons.push(`policy ${policy.name} does not list the ${facts.gate} gate`);
  if (RISK_RANK[facts.riskProfile] > RISK_RANK[p.maxRiskProfile]) {
    reasons.push(`risk profile ${facts.riskProfile} is above the policy maximum ${p.maxRiskProfile}`);
  }
  const denied = facts.triggers.filter((t) => p.deniedTriggers.includes(t));
  if (denied.length) reasons.push(`denied risk trigger(s) present: ${[...new Set(denied)].sort().join(', ')}`);
  if (p.labels.length && !facts.labels.some((l) => p.labels.includes(l))) {
    reasons.push(
      facts.labels.length
        ? `none of the task's source labels (${facts.labels.join(', ')}) is allowed (${p.labels.join(', ')})`
        : `the task has no source-issue label; the policy requires one of: ${p.labels.join(', ')}`,
    );
  }
  if (facts.repoCount > p.maxRepos) reasons.push(`the task changes ${facts.repoCount} repositories; the policy allows ${p.maxRepos}`);
  if (facts.unknowns.length) reasons.push(`open questions remain: ${facts.unknowns.length}`);
  if (facts.criteriaCount === 0) reasons.push('no acceptance criteria');
  if (facts.lintErrors.length) reasons.push(`task documents have lint errors: ${facts.lintErrors.slice(0, 3).join('; ')}`);
  if (facts.criticalFindings.length) reasons.push(`CRITICAL analysis findings: ${facts.criticalFindings.slice(0, 3).join('; ')}`);

  if (facts.change) {
    const c = facts.change;
    if (c.changedLines > p.maxChangedLines) reasons.push(`diff has ${c.changedLines} changed lines; the policy allows ${p.maxChangedLines}`);
    if (c.files.length > p.maxChangedFiles) reasons.push(`diff touches ${c.files.length} files; the policy allows ${p.maxChangedFiles}`);
    if (!p.allowDependencyChanges && c.dependencyChanges.length) {
      reasons.push(`dependency changes are not allowed: ${c.dependencyChanges.slice(0, 5).join(', ')}`);
    }
    const matchers = p.deniedPaths.map((g) => ({ g, m: compileGlob(g, { dot: true }) }));
    const unusable = matchers.filter((x) => !x.m).map((x) => x.g);
    if (unusable.length) reasons.push(`deniedPaths pattern(s) cannot be matched: ${unusable.join(', ')}`);
    const hits = c.files.filter((f) => matchers.some((x) => x.m && deniedBy(x.m, f)));
    if (hits.length) reasons.push(`denied path(s) changed: ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', …' : ''}`);
  } else if (facts.gate === 'codeReview' || facts.gate === 'acceptance') {
    reasons.push('change facts for the commit under review are missing');
  }

  if (facts.gate === 'acceptance') {
    // One PR cannot carry a multi-repo change set, so landing would be skipped after the policy already
    // accepted. Route it to a human now (multi-repo review under `maxRepos` is unaffected).
    if (facts.repoCount > 1) reasons.push(`PR landing supports one repository; the task changes ${facts.repoCount}`);
    if (!facts.lanePr || facts.lanePr.protection.status !== 'confirmed') {
      reasons.push(`merge-queue protection is unknown${facts.lanePr?.protection.reason ? `: ${facts.lanePr.protection.reason}` : ''}`);
    } else {
      if (!facts.lanePr.protection.mergeQueueRequired) reasons.push('base branch does not require the merge queue');
      if (!facts.lanePr.protection.turbineGateRequired) reasons.push('base branch does not require turbine/gate');
    }
    if (!facts.lanePr?.configAllowsCreate) reasons.push('project config does not allow pr.create');
    if (!facts.lanePr?.configAllowsMerge) reasons.push('project config does not allow pr.merge');
    if (!p.tools.includes('pr.create')) reasons.push(`policy ${policy.name} does not grant pr.create`);
    if (!p.tools.includes('pr.merge')) reasons.push(`policy ${policy.name} does not grant pr.merge`);
    const a = facts.acceptance;
    if (!a) reasons.push('acceptance facts are missing');
    else {
      if (!a.p0.length) reasons.push('no P0 requirement to trace');
      const gaps = a.p0.filter((r) => r.status !== 'FULL');
      if (gaps.length) reasons.push(`P0 requirement(s) without FULL traceability: ${gaps.map((g) => `${g.id} (${g.status})`).join(', ')}`);
      if (!a.checks.length) reasons.push('no quality check ran at the commit under review');
      const bad = a.checks.filter((c) => c.result !== 'passed');
      if (bad.length) reasons.push(`quality check(s) not passed at this commit: ${bad.map((c) => `${c.command}=${c.result}`).join(', ')}`);
      if (a.gateBlocking.length) reasons.push(`evidence gate is not satisfied: ${a.gateBlocking.join('; ')}`);
    }
  }

  const protectionUnknown = facts.gate === 'acceptance' && facts.lanePr?.protection.status !== 'confirmed';
  const status: LaneEvaluation['status'] = facts.readErrors.length || protectionUnknown ? 'unknown' : reasons.length ? 'not-eligible' : 'eligible';
  const allReasons = facts.readErrors.length ? [...facts.readErrors.map((e) => `could not read: ${e}`), ...reasons] : reasons;
  return {
    policy: policy.name,
    policyHash: policy.contentHash,
    gate: facts.gate,
    status,
    reasons: allReasons,
    evaluationHash: contentHash({ policy: policy.name, policyHash: policy.contentHash, facts, status, reasons: allReasons }),
  };
}
