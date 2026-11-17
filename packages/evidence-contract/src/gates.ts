import type {
  Decision,
  Evidence,
  EvidenceObligation,
  ObligationStatus,
  WorkPackage,
} from '@turbine-hall/turbine-contracts';

/**
 * Gate evaluation is FAIL-CLOSED: missing data (no approved hash, no commit binding,
 * no evidence) never counts as satisfied. Every rule returns a status plus a reason a
 * human can read.
 */
export type GateContext = {
  work: WorkPackage;
  obligations: EvidenceObligation[];
  decisions: Decision[];
  evidence: Evidence[];
  approvedSpecHash?: string;
  approvedPlanHash?: string;
  /** Hash of the latest specification artifact (what a human would approve today). */
  currentSpecHash?: string;
  /** Hash of the latest plan artifact. */
  currentPlanHash?: string;
  /** Commit currently under review (worktree HEAD recorded by the engine). */
  currentCommit?: string;
  /** Commit the worktree was branched from. */
  baseCommit?: string;
  /** Dependencies added or changed by the change set (from git), per repo. */
  dependencyChanges?: Array<{ repo: string; names: string[] }>;
  /** Requirement coverage from traceability (FULL = linked test + passing checks). */
  coverage?: Array<{ requirementId: string; priority: string; status: 'FULL' | 'PARTIAL' | 'NONE' }>;
};

export type RuleResult = { status: ObligationStatus; reason: string };

/** Latest decision of any action for a gate (a later rejection supersedes an earlier approval). */
function latestDecision(ctx: GateContext, gate: Decision['gate']): Decision | undefined {
  return ctx.decisions
    .filter((d) => d.gate === gate && !d.invalidatedAt)
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
}

function hashBoundApproval(
  ctx: GateContext,
  gate: 'requirements' | 'plan',
  boundHash: string | undefined,
  currentHash: string | undefined,
): RuleResult {
  if (!boundHash) {
    return { status: 'unsatisfied', reason: `No approved ${gate} hash recorded on the contract` };
  }
  if (!currentHash) {
    return { status: 'blocked', reason: `No current ${gate} artifact to compare against` };
  }
  if (currentHash !== boundHash) {
    return {
      status: 'stale',
      reason: `${gate} changed since approval (approved ${boundHash.slice(7, 15)}, current ${currentHash.slice(7, 15)})`,
    };
  }
  const latest = latestDecision(ctx, gate);
  if (!latest || latest.action !== 'approve') {
    return { status: 'unsatisfied', reason: `No current human approval for ${gate}` };
  }
  if (!latest.artifactHashes.includes(boundHash)) {
    return {
      status: 'stale',
      reason: `Latest ${gate} approval is for a different revision than ${boundHash}`,
    };
  }
  return { status: 'satisfied', reason: `Approved by ${latest.actorId} at ${boundHash}` };
}

function commitBoundApproval(ctx: GateContext, gate: 'code-review' | 'sqa-acceptance'): RuleResult {
  if (!ctx.currentCommit) {
    return { status: 'blocked', reason: 'No implementation commit recorded' };
  }
  const latest = latestDecision(ctx, gate);
  if (!latest || latest.action !== 'approve') {
    return { status: 'unsatisfied', reason: `No current human ${gate} approval` };
  }
  if (!latest.commitSha) {
    return { status: 'blocked', reason: `${gate} approval is not bound to a commit` };
  }
  if (latest.commitSha !== ctx.currentCommit) {
    return {
      status: 'stale',
      reason: `${gate} approved ${latest.commitSha.slice(0, 8)} but current commit is ${ctx.currentCommit.slice(0, 8)}`,
    };
  }
  return { status: 'satisfied', reason: `Approved by ${latest.actorId} at ${latest.commitSha.slice(0, 8)}` };
}

const PASS_RULES: Record<string, (ctx: GateContext, obl: EvidenceObligation) => RuleResult> = {
  'has-source-snapshot': (ctx) =>
    ctx.work.sourceRefs.length > 0 && ctx.work.sourceRefs.every((s) => !!s.snapshotHash)
      ? { status: 'satisfied', reason: 'Source snapshot recorded' }
      : { status: 'unsatisfied', reason: 'Source snapshot missing' },

  'requirements-approved': (ctx) => hashBoundApproval(ctx, 'requirements', ctx.approvedSpecHash, ctx.currentSpecHash),

  'plan-approved': (ctx) => hashBoundApproval(ctx, 'plan', ctx.approvedPlanHash, ctx.currentPlanHash),

  'acceptance-criteria-present': (ctx) =>
    ctx.work.acceptanceCriteria.some((c) => c.status === 'confirmed')
      ? { status: 'satisfied', reason: 'Confirmed acceptance criteria present' }
      : { status: 'unsatisfied', reason: 'No confirmed acceptance criteria' },

  'implementation-present': (ctx) => {
    if (!ctx.currentCommit) {
      return { status: 'unsatisfied', reason: 'No implementation commit recorded' };
    }
    if (!ctx.baseCommit) {
      return { status: 'blocked', reason: 'Base commit unknown; cannot prove code changed' };
    }
    if (ctx.currentCommit === ctx.baseCommit) {
      return { status: 'unsatisfied', reason: 'Head commit equals base commit — no code changed' };
    }
    return {
      status: 'satisfied',
      reason: `Commit ${ctx.currentCommit.slice(0, 8)} is past base ${ctx.baseCommit.slice(0, 8)}`,
    };
  },

  'code-review-current': (ctx) => commitBoundApproval(ctx, 'code-review'),

  'tests-current': (ctx, obl) => {
    if (!ctx.currentCommit) {
      return { status: 'blocked', reason: 'No implementation commit to test' };
    }
    const kinds = obl.requiredEvidenceKinds.length
      ? obl.requiredEvidenceKinds
      : ['unit', 'lint', 'typecheck'];
    // Only evidence produced for the current commit counts; never evidence without a commit.
    const current = ctx.evidence.filter(
      (e) => kinds.includes(e.kind) && !!e.commitSha && e.commitSha === ctx.currentCommit,
    );
    // Each distinct check (same command) is judged by its latest run.
    const latestByCheck = new Map<string, Evidence>();
    for (const e of [...current].sort((a, b) => a.observedAt.localeCompare(b.observedAt))) {
      latestByCheck.set(`${e.kind}|${e.commandOrCheck ?? ''}`, e);
    }
    const problems: string[] = [];
    for (const e of latestByCheck.values()) {
      if (e.result !== 'passed') problems.push(`${e.commandOrCheck ?? e.kind}: ${e.result}`);
    }
    for (const kind of kinds) {
      if (![...latestByCheck.values()].some((e) => e.kind === kind)) {
        problems.push(`${kind}: no evidence for current commit`);
      }
    }
    if (problems.length === 0) {
      return { status: 'satisfied', reason: `${latestByCheck.size} check(s) passed at current commit` };
    }
    const anyStale =
      current.length === 0 &&
      ctx.evidence.some((e) => kinds.includes(e.kind) && e.commitSha && e.result === 'passed');
    return { status: anyStale ? 'stale' : 'unsatisfied', reason: problems.join('; ') };
  },

  'manual-sqa-accepted': (ctx) => commitBoundApproval(ctx, 'sqa-acceptance'),

  'dependency-audit': (ctx) => {
    const changed = (ctx.dependencyChanges ?? []).filter((d) => d.names.length);
    if (!changed.length) return { status: 'satisfied', reason: 'No dependencies added or changed' };
    if (!ctx.currentCommit) return { status: 'blocked', reason: 'No implementation commit' };
    const missing: string[] = [];
    for (const d of changed) {
      const runs = ctx.evidence
        .filter((e) => e.kind === 'security' && e.commitSha === ctx.currentCommit && (e.commandOrCheck ?? '').startsWith(`${d.repo}: `))
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
      const latest = runs[0];
      if (!latest) missing.push(`${d.repo}: no audit for ${d.names.join(', ')}`);
      else if (latest.result !== 'passed') missing.push(`${d.repo}: audit ${latest.result}${latest.limitations[0] ? ` (${latest.limitations[0]})` : ''}`);
    }
    return missing.length
      ? { status: 'unsatisfied', reason: missing.join('; ') }
      : { status: 'satisfied', reason: `Dependency audit passed for ${changed.map((d) => d.repo).join(', ')}` };
  },

  'requirements-covered': (ctx) => {
    if (!ctx.coverage?.length) return { status: 'unsatisfied', reason: 'No traceability data yet' };
    const gaps = ctx.coverage.filter((c) => c.priority === 'P0' && c.status !== 'FULL');
    return gaps.length
      ? { status: 'unsatisfied', reason: `P0 requirements without full test coverage: ${gaps.map((g) => `${g.requirementId} (${g.status})`).join(', ')}` }
      : { status: 'satisfied', reason: 'Every P0 requirement has a linked test and passing checks' };
  },

  'human-acceptance': (ctx) =>
    ctx.work.currentState === 'ACCEPTED'
      ? { status: 'satisfied', reason: 'Work accepted' }
      : { status: 'unsatisfied', reason: 'Final acceptance not yet recorded' },
};

/**
 * Status is always DERIVED from decisions and evidence. A stored obligation status is
 * only a hint: a "stale" marker explains why a rule is unsatisfied, but can never make
 * an obligation pass, and a stored "waived" status is ignored (waivers are separate
 * decisions — see computeGateDecision).
 */
export function evaluateObligationDetailed(obl: EvidenceObligation, ctx: GateContext): RuleResult {
  const rule = PASS_RULES[obl.passRule];
  if (!rule) return { status: 'blocked', reason: `Unknown pass rule ${obl.passRule}` };
  const result = rule(ctx, obl);
  if (result.status === 'unsatisfied' && obl.status === 'stale') {
    return { status: 'stale', reason: `${result.reason} (invalidated by an upstream change)` };
  }
  return result;
}

export function evaluateObligation(obl: EvidenceObligation, ctx: GateContext): ObligationStatus {
  return evaluateObligationDetailed(obl, ctx).status;
}

export type EvaluatedObligation = EvidenceObligation & {
  derivedStatus: ObligationStatus;
  reason: string;
};

export function evaluateEec(ctx: GateContext): {
  obligations: EvaluatedObligation[];
  ok: boolean;
  blockers: string[];
} {
  const obligations = ctx.obligations.map((o) => {
    const r = evaluateObligationDetailed(o, ctx);
    return { ...o, derivedStatus: r.status, reason: r.reason };
  });
  const blockers = obligations
    .filter((o) => o.required && o.derivedStatus !== 'satisfied')
    .map((o) => `${o.id}: ${o.derivedStatus} — ${o.reason}`);
  return { obligations, ok: blockers.length === 0, blockers };
}

/**
 * A waiver is a human decision (gate=exception) naming obligations, a reason and an expiry.
 * A waiver granted for one commit does not carry over to a different commit.
 */
export function activeWaivers(
  decisions: Decision[],
  now: Date = new Date(),
  currentCommit?: string,
): Decision[] {
  return decisions.filter(
    (d) =>
      d.gate === 'exception' &&
      d.action === 'approve' &&
      !d.invalidatedAt &&
      (d.obligationIds?.length ?? 0) > 0 &&
      !!d.rationale &&
      !!d.expiresAt &&
      new Date(d.expiresAt).getTime() > now.getTime() &&
      (!d.commitSha || !currentCommit || d.commitSha === currentCommit),
  );
}

export type GateDecisionValue = 'PASS' | 'CONCERNS' | 'FAIL';

export type GateDecision = {
  /** Derived from evidence only. Waivers never change this value. */
  decision: GateDecisionValue;
  blocking: Array<{ id: string; status: ObligationStatus; reason: string }>;
  concerns: Array<{ id: string; status: ObligationStatus; reason: string }>;
  /** Blocking obligations covered by an active human waiver. */
  waived: Array<{ id: string; waiverId: string; actorId: string; expiresAt: string }>;
  /** True when the work may be accepted: PASS/CONCERNS, or every blocker is waived. */
  acceptable: boolean;
};

/**
 * Deterministic gate decision (modelled on BMad's PASS / CONCERNS / FAIL):
 * - FAIL: any required obligation is not satisfied
 * - CONCERNS: all required satisfied, some optional obligations are not
 * - PASS: everything satisfied
 * Waivers are recorded alongside and can make a FAIL acceptable, but never turn it into PASS.
 */
export function computeGateDecision(
  obligations: EvaluatedObligation[],
  decisions: Decision[],
  options: { exclude?: string[]; now?: Date; currentCommit?: string } = {},
): GateDecision {
  const exclude = new Set(options.exclude ?? []);
  const considered = obligations.filter((o) => !exclude.has(o.id));
  const toItem = (o: EvaluatedObligation) => ({ id: o.id, status: o.derivedStatus, reason: o.reason });
  const blocking = considered.filter((o) => o.required && o.derivedStatus !== 'satisfied').map(toItem);
  const concerns = considered.filter((o) => !o.required && o.derivedStatus !== 'satisfied').map(toItem);
  const waivers = activeWaivers(decisions, options.now, options.currentCommit);
  const waived = blocking.flatMap((b) => {
    const w = waivers.find((x) => x.obligationIds!.includes(b.id));
    return w ? [{ id: b.id, waiverId: w.id, actorId: w.actorId, expiresAt: w.expiresAt! }] : [];
  });
  const decision: GateDecisionValue = blocking.length ? 'FAIL' : concerns.length ? 'CONCERNS' : 'PASS';
  return {
    decision,
    blocking,
    concerns,
    waived,
    acceptable: blocking.length === waived.length,
  };
}
