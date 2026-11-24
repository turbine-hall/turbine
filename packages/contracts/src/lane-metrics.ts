import { z } from 'zod';

/** Part C writes these facts when it ships; until then tests and adapters may inject them explicitly. */
export const LaneMergeRecordSchema = z
  .object({
    id: z.string().min(1),
    workId: z.string().min(1),
    /** Null is the human lane. */
    policyId: z.string().min(1).nullable(),
    openedAt: z.string().datetime(),
    mergeState: z.enum(['open', 'merged', 'unknown']),
    mergedAt: z.string().datetime().optional(),
    mergeSha: z.string().min(1).optional(),
    /** A missing revert fact is unknown, not false. */
    reverted: z.enum(['yes', 'no', 'unknown']).default('unknown'),
    revertedAt: z.string().datetime().optional(),
    fixRounds: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    sampling: z
      .object({
        seed: z.string().regex(/^[a-f0-9]{64}$/),
        draw: z.number().min(0).lt(1),
        rate: z.number().min(0).max(1),
        selected: z.boolean(),
      })
      .strict()
      .optional(),
    recordedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.mergeState === 'merged' && !record.mergedAt) {
      ctx.addIssue({ code: 'custom', path: ['mergedAt'], message: 'mergedAt is required for a merged record' });
    }
    if (record.reverted === 'yes' && !record.revertedAt) {
      ctx.addIssue({ code: 'custom', path: ['revertedAt'], message: 'revertedAt is required when reverted=yes' });
    }
  });
export type LaneMergeRecord = z.infer<typeof LaneMergeRecordSchema>;

export const LaneAuditRecordSchema = z
  .object({
    id: z.string().min(1),
    mergeRecordId: z.string().min(1),
    workId: z.string().min(1),
    policyId: z.string().min(1),
    seed: z.string().regex(/^[a-f0-9]{64}$/),
    draw: z.number().min(0).lt(1),
    rate: z.number().min(0).max(1),
    queuedAt: z.string().datetime(),
    outcome: z.enum(['queued', 'ok', 'problem']),
    note: z.string().max(10_000).optional(),
    recordedBy: z.string().min(1).optional(),
    recordedAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.outcome === 'problem' && !record.note?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'a problem audit requires a note' });
    }
    if (record.outcome !== 'queued' && (!record.recordedBy || !record.recordedAt)) {
      ctx.addIssue({ code: 'custom', message: 'a completed audit requires recordedBy and recordedAt' });
    }
  });
export type LaneAuditRecord = z.infer<typeof LaneAuditRecordSchema>;
