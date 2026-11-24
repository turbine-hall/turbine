import type { RoleRun, TokenCount, UsageBucket, UsageRecord, UsageSummary } from '@turbine-hall/turbine-contracts';

function asCount(v: number | 'unknown' | undefined): TokenCount {
  if (v === undefined || v === null) return 'unknown';
  if (v === 'unknown') return 'unknown';
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  return 'unknown';
}

/**
 * Aggregate token fields. Empty accumulators start with no known observation (`null`);
 * unknown-only fields stay `'unknown'` (never invented 0). Measured zeros are preserved.
 */
function addField(
  prev: TokenCount | null,
  next: TokenCount,
): { value: TokenCount; unknown: boolean } {
  const nextU = next === 'unknown';
  if (prev === null) {
    return { value: next, unknown: nextU };
  }
  const prevU = prev === 'unknown';
  if (prevU && nextU) return { value: 'unknown', unknown: true };
  if (prevU) return { value: next, unknown: true };
  if (nextU) return { value: prev, unknown: true };
  return { value: (prev as number) + (next as number), unknown: false };
}

function totalOf(input: TokenCount, output: TokenCount): { value: TokenCount; unknown: boolean } {
  const inU = input === 'unknown';
  const outU = output === 'unknown';
  if (inU && outU) return { value: 'unknown', unknown: true };
  if (inU) return { value: output, unknown: true };
  if (outU) return { value: input, unknown: true };
  return { value: (input as number) + (output as number), unknown: false };
}

type SideAcc = {
  calls: number;
  input: TokenCount | null;
  output: TokenCount | null;
  hasUnknown: boolean;
  hasEstimated: boolean;
};

function emptySide(): SideAcc {
  return { calls: 0, input: null, output: null, hasUnknown: false, hasEstimated: false };
}

function finalizeSide(side: SideAcc) {
  // No calls → numeric zeros. Calls with only unknown observations → 'unknown'.
  const displayIn: TokenCount = side.calls === 0 ? 0 : side.input === null ? 'unknown' : side.input;
  const displayOut: TokenCount = side.calls === 0 ? 0 : side.output === null ? 'unknown' : side.output;
  const tot = totalOf(displayIn, displayOut);
  return {
    calls: side.calls,
    input: displayIn,
    output: displayOut,
    total: tot.value,
    hasUnknown: side.hasUnknown || tot.unknown || displayIn === 'unknown' || displayOut === 'unknown',
    hasEstimated: side.hasEstimated,
  };
}

/**
 * Build a usage summary from Turbine role_runs + external usage_records.
 * Unknown token counts are never coerced to 0 in displayed totals (hasUnknown is set;
 * unknown-only fields remain `'unknown'`). Estimated contributions set hasEstimated.
 */
export function summarizeUsage(input: {
  workId: string;
  roleRuns: RoleRun[];
  records: UsageRecord[];
}): UsageSummary {
  const turbine = emptySide();
  const agent = emptySide();
  const byModel = new Map<
    string,
    UsageBucket & { _in: TokenCount | null; _out: TokenCount | null; _unknown: boolean }
  >();

  const bump = (
    side: SideAcc,
    tokens: { input: TokenCount; output: TokenCount },
    meta: {
      modelId?: string;
      modelProvider?: string;
      agentName?: string;
      source: 'turbine' | 'agent';
      estimated: boolean;
    },
  ) => {
    side.calls += 1;
    const inAdd = addField(side.input, tokens.input);
    const outAdd = addField(side.output, tokens.output);
    side.input = inAdd.value;
    side.output = outAdd.value;
    side.hasUnknown = side.hasUnknown || inAdd.unknown || outAdd.unknown;
    side.hasEstimated = side.hasEstimated || meta.estimated;

    const modelKey = meta.modelId ?? meta.agentName ?? '(unknown-model)';
    const key = `${meta.source}:${meta.modelProvider ?? ''}:${modelKey}`;
    const prev = byModel.get(key) ?? {
      key,
      source: meta.source,
      modelId: meta.modelId,
      modelProvider: meta.modelProvider,
      agentName: meta.agentName,
      calls: 0,
      input: 0 as TokenCount,
      output: 0 as TokenCount,
      total: 0 as TokenCount,
      hasUnknown: false,
      hasEstimated: false,
      _in: null as TokenCount | null,
      _out: null as TokenCount | null,
      _unknown: false,
    };
    prev.calls += 1;
    const pi = addField(prev._in, tokens.input);
    const po = addField(prev._out, tokens.output);
    prev._in = pi.value;
    prev._out = po.value;
    prev._unknown = prev._unknown || pi.unknown || po.unknown;
    prev.hasEstimated = prev.hasEstimated || meta.estimated;
    const displayIn = prev._in ?? 'unknown';
    const displayOut = prev._out ?? 'unknown';
    const pt = totalOf(displayIn, displayOut);
    prev.input = displayIn;
    prev.output = displayOut;
    prev.total = pt.value;
    prev.hasUnknown = prev._unknown || pt.unknown;
    byModel.set(key, prev);
  };

  for (const run of input.roleRuns) {
    // Count finished Turbine model attempts (succeeded or failed) that had a model attached.
    if (run.status !== 'succeeded' && run.status !== 'failed') continue;
    if (!run.modelProvider && !run.modelId) continue;
    bump(
      turbine,
      {
        input: asCount(run.tokens?.input),
        output: asCount(run.tokens?.output),
      },
      {
        source: 'turbine',
        modelId: run.modelId,
        modelProvider: run.modelProvider,
        estimated: false, // adapter-reported / measured role_run tokens
      },
    );
  }

  for (const rec of input.records) {
    const side = rec.source === 'agent' ? agent : turbine;
    bump(side, rec.tokens, {
      source: rec.source,
      modelId: rec.modelId,
      modelProvider: rec.modelProvider,
      agentName: rec.agentName,
      estimated: rec.method === 'estimated',
    });
  }

  const t = finalizeSide(turbine);
  const a = finalizeSide(agent);
  // Grand: combine finalized sides. Empty side contributes nothing, not invented 0.
  const gIn =
    t.calls === 0 && a.calls === 0
      ? ({ value: 0 as TokenCount, unknown: false } as const)
      : t.calls === 0
        ? { value: a.input, unknown: a.hasUnknown }
        : a.calls === 0
          ? { value: t.input, unknown: t.hasUnknown }
          : addField(t.input, a.input);
  const gOut =
    t.calls === 0 && a.calls === 0
      ? ({ value: 0 as TokenCount, unknown: false } as const)
      : t.calls === 0
        ? { value: a.output, unknown: a.hasUnknown }
        : a.calls === 0
          ? { value: t.output, unknown: t.hasUnknown }
          : addField(t.output, a.output);
  const grandTot = totalOf(gIn.value, gOut.value);

  return {
    workId: input.workId,
    bySource: {
      turbine: t,
      agent: a,
    },
    byModel: [...byModel.values()]
      .map(({ _unknown: _, _in: _i, _out: _o, ...rest }) => rest)
      .sort((x, y) => x.key.localeCompare(y.key)),
    grand: {
      calls: turbine.calls + agent.calls,
      input: gIn.value,
      output: gOut.value,
      total: grandTot.value,
      hasUnknown: gIn.unknown || gOut.unknown || grandTot.unknown || t.hasUnknown || a.hasUnknown,
      hasEstimated: t.hasEstimated || a.hasEstimated,
    },
    records: input.records,
    roleRunCount: input.roleRuns.filter((r) => r.status === 'succeeded' || r.status === 'failed').length,
  };
}

/** Sum of measured Turbine role_run tokens only (unknown ignored) — for maxTokens budget. */
export function measuredTurbineTokens(roleRuns: RoleRun[]): number {
  let n = 0;
  for (const run of roleRuns) {
    if (run.status !== 'succeeded' && run.status !== 'failed') continue;
    const i = run.tokens?.input;
    const o = run.tokens?.output;
    if (typeof i === 'number') n += i;
    if (typeof o === 'number') n += o;
  }
  return n;
}

export function formatTokenCount(v: TokenCount): string {
  return v === 'unknown' ? 'unknown' : String(v);
}

/** Parenthetical qualifiers for CLI / docs (`+unknown`, `+estimated`). */
export function formatUsageQualifiers(flags: { hasUnknown?: boolean; hasEstimated?: boolean }): string {
  const parts: string[] = [];
  if (flags.hasUnknown) parts.push('+unknown');
  if (flags.hasEstimated) parts.push('+estimated');
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** Markdown italic qualifiers for packet Usage tables. */
export function formatUsageQualifiersMd(flags: { hasUnknown?: boolean; hasEstimated?: boolean }): string {
  const parts: string[] = [];
  if (flags.hasUnknown) parts.push('+unknown');
  if (flags.hasEstimated) parts.push('+estimated');
  return parts.length ? ` _(${parts.join(', ')})_` : '';
}
