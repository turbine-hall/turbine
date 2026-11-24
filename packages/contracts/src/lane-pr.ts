import { z } from 'zod';

export const LanePrRecordSchema = z
  .object({
    workId: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    number: z.number().int().positive(),
    nodeId: z.string().min(1).optional(),
    url: z.string().url(),
    baseBranch: z.string().min(1),
    headBranch: z.string().min(1),
    headSha: z.string().min(7),
    gateState: z.enum(['pending', 'success', 'failure']),
    queueState: z.enum(['not-enabled', 'queued', 'ejected', 'merged']),
    queueReason: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type LanePrRecord = z.infer<typeof LanePrRecordSchema>;

export type MergeQueueProtection = {
  status: 'confirmed' | 'unknown';
  mergeQueueRequired: boolean;
  turbineGateRequired: boolean;
  reason?: string;
};
