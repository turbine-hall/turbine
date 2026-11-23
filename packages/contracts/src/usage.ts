import { z } from 'zod';

/** Token count that is either a measured number or explicitly unknown (never silent 0). */
export const TokenCountSchema = z.union([z.number().nonnegative(), z.literal('unknown')]);
export type TokenCount = z.infer<typeof TokenCountSchema>;

export const UsageMethodSchema = z.enum(['measured', 'reported', 'estimated']);
export type UsageMethod = z.infer<typeof UsageMethodSchema>;

export const UsageSourceKindSchema = z.enum(['turbine', 'agent']);
export type UsageSourceKind = z.infer<typeof UsageSourceKindSchema>;

/**
 * Distinct usage record (agent-reported or imported). Turbine role_runs remain the source for
 * automatic Turbine model calls; this table holds coding-agent and other external reports.
 */
export const UsageRecordSchema = z.object({
  id: z.string(),
  workId: z.string(),
  source: UsageSourceKindSchema,
  /** e.g. cursor, claude-code, codex — required when source is agent */
  agentName: z.string().optional(),
  modelProvider: z.string().optional(),
  modelId: z.string().optional(),
  tokens: z.object({
    input: TokenCountSchema,
    output: TokenCountSchema,
  }),
  method: UsageMethodSchema,
  note: z.string().optional(),
  recordedAt: z.string(),
  recordedBy: z.string(),
  /** Who entered the record — agents must not edit/delete human-entered rows. */
  enteredBy: z.enum(['human', 'agent']),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export const UsageBucketSchema = z.object({
  key: z.string(),
  source: UsageSourceKindSchema,
  modelId: z.string().optional(),
  modelProvider: z.string().optional(),
  agentName: z.string().optional(),
  calls: z.number().int().nonnegative(),
  input: TokenCountSchema,
  output: TokenCountSchema,
  total: TokenCountSchema,
  hasUnknown: z.boolean(),
});
export type UsageBucket = z.infer<typeof UsageBucketSchema>;

export const UsageSummarySchema = z.object({
  workId: z.string(),
  bySource: z.object({
    turbine: z.object({
      calls: z.number().int(),
      input: TokenCountSchema,
      output: TokenCountSchema,
      total: TokenCountSchema,
      hasUnknown: z.boolean(),
    }),
    agent: z.object({
      calls: z.number().int(),
      input: TokenCountSchema,
      output: TokenCountSchema,
      total: TokenCountSchema,
      hasUnknown: z.boolean(),
    }),
  }),
  byModel: z.array(UsageBucketSchema),
  grand: z.object({
    calls: z.number().int(),
    input: TokenCountSchema,
    output: TokenCountSchema,
    total: TokenCountSchema,
    hasUnknown: z.boolean(),
  }),
  records: z.array(UsageRecordSchema),
  roleRunCount: z.number().int(),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
