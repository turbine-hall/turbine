import type { RoleRun, TokenCount, UsageBucket, UsageRecord, UsageSummary } from '@turbine-hall/turbine-contracts';

function asCount(v: number | 'unknown' | undefined): TokenCount {
  if (v === undefined || v === null) return 'unknown';
  if (v === 'unknown') return 'unknown';
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  return 'unknown';
}

function addCounts(a: TokenCount, b: TokenCount): { value: TokenCount; unknown: boolean } {
  const aU = a === 'unknown';
  const bU = b === 'unknown';
  if (aU && bU) return { value: 'unknown', unknown: true };
  if (aU) return { value: b, unknown: true };
  if (bU) return { value: a, unknown: true };
  return { value: (a as number) + (b as number), unknown: false };
}

function totalOf(input: TokenCount, output: TokenCount): { value: TokenCount; unknown: boolean } {
  return addCounts(input, output);
}

function emptySide() {
  return { calls: 0, input: 0 as TokenCount, output: 0 as TokenCount, total: 0 as TokenCount, hasUnknown: false };
}

/**
 * Build a usage summary from Turbine role_runs + external usage_records.
 * Unknown token counts are never coerced to 0 in displayed totals (hasUnknown is set).
 */
export function summarizeUsage(input: {
  workId: string;
  roleRuns: RoleRun[];
  records: UsageRecord[];
}): UsageSummary {
  const turbine = emptySide();
  const agent = emptySide();
  const byModel = new Map<string, UsageBucket & { _unknown: boolean }>();

  const bump = (
    side: ReturnType<typeof emptySide>,
    tokens: { input: TokenCount; output: TokenCount },
    meta: { modelId?: string; modelProvider?: string; agentName?: string; source: 'turbine' | 'agent' },
  ) => {
    side.calls += 1;
    const inAdd = addCounts(side.input, tokens.input);
    const outAdd = addCounts(side.output, tokens.output);
    side.input = inAdd.value;
    side.output = outAdd.value;
    side.hasUnknown = side.hasUnknown || inAdd.unknown || outAdd.unknown;
    const tot = totalOf(side.input, side.output);
    side.total = tot.value;
    side.hasUnknown = side.hasUnknown || tot.unknown;

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
      _unknown: false,
    };
    prev.calls += 1;
    const pi = addCounts(prev.input, tokens.input);
    const po = addCounts(prev.output, tokens.output);
    prev.input = pi.value;
    prev.output = po.value;
    prev._unknown = prev._unknown || pi.unknown || po.unknown;
    const pt = totalOf(prev.input, prev.output);
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
      { source: 'turbine', modelId: run.modelId, modelProvider: run.modelProvider },
    );
  }

  for (const rec of input.records) {
    const side = rec.source === 'agent' ? agent : turbine;
    bump(side, rec.tokens, {
      source: rec.source,
      modelId: rec.modelId,
      modelProvider: rec.modelProvider,
      agentName: rec.agentName,
    });
  }

  const grandIn = addCounts(turbine.input, agent.input);
  const grandOut = addCounts(turbine.output, agent.output);
  const grandTot = totalOf(grandIn.value, grandOut.value);

  return {
    workId: input.workId,
    bySource: {
      turbine: {
        calls: turbine.calls,
        input: turbine.input,
        output: turbine.output,
        total: turbine.total,
        hasUnknown: turbine.hasUnknown,
      },
      agent: {
        calls: agent.calls,
        input: agent.input,
        output: agent.output,
        total: agent.total,
        hasUnknown: agent.hasUnknown,
      },
    },
    byModel: [...byModel.values()]
      .map(({ _unknown: _, ...rest }) => rest)
      .sort((a, b) => a.key.localeCompare(b.key)),
    grand: {
      calls: turbine.calls + agent.calls,
      input: grandIn.value,
      output: grandOut.value,
      total: grandTot.value,
      hasUnknown: grandIn.unknown || grandOut.unknown || grandTot.unknown || turbine.hasUnknown || agent.hasUnknown,
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
