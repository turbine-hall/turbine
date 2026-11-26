import type { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import { err, type TokenCount } from '@turbine-hall/turbine-contracts';
import { summarizeUsage } from './usage.js';

/**
 * Accounting rate for converting measured tokens → USD for `--budget`.
 * Not a billing quote — a fleet stop-starting threshold. Override with `--usd-per-mtok`.
 */
export const DEFAULT_USD_PER_MILLION_TOKENS = 5;

export type FleetSpend = {
  knownUsd: number;
  knownTokens: number;
  hasUnknown: boolean;
  usdPerMillionTokens: number;
  byWork: Array<{ workId: string; knownTokens: number; knownUsd: number; hasUnknown: boolean }>;
};

function tokensOf(v: TokenCount): { n: number; unknown: boolean } {
  if (v === 'unknown') return { n: 0, unknown: true };
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return { n: v, unknown: false };
  return { n: 0, unknown: true };
}

/**
 * Measured fleet spend from usage_records + role_runs.
 * Unknown token observations are never summed as 0 into knownUsd; they set hasUnknown.
 */
export function measureFleetSpend(
  store: WorkStore,
  workIds: string[],
  usdPerMillionTokens: number = DEFAULT_USD_PER_MILLION_TOKENS,
): FleetSpend {
  if (!(usdPerMillionTokens > 0) || !Number.isFinite(usdPerMillionTokens)) {
    throw err('E_INVALID_CONFIG', 'usdPerMillionTokens must be a positive finite number');
  }
  const byWork: FleetSpend['byWork'] = [];
  let knownTokens = 0;
  let hasUnknown = false;
  for (const workId of workIds) {
    let summary;
    try {
      summary = summarizeUsage({
        workId,
        roleRuns: store.listRoleRuns(workId),
        records: store.listUsageRecords(workId),
      });
    } catch (e) {
      throw err(
        'E_UNSAFE_EXECUTION',
        `fleet spend unreadable for ${workId}: ${(e as Error).message.split('\n')[0]}`,
      );
    }
    const tot = tokensOf(summary.grand.total);
    const workUnknown = tot.unknown || summary.grand.hasUnknown;
    hasUnknown = hasUnknown || workUnknown;
    knownTokens += tot.n;
    const knownUsd = (tot.n / 1_000_000) * usdPerMillionTokens;
    byWork.push({ workId, knownTokens: tot.n, knownUsd, hasUnknown: workUnknown });
  }
  return {
    knownUsd: (knownTokens / 1_000_000) * usdPerMillionTokens,
    knownTokens,
    hasUnknown,
    usdPerMillionTokens,
    byWork,
  };
}
