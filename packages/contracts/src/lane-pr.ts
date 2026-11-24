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
    /** Policy terms in force when landing was authorized; Part G must sample with this snapshot, not the live policy. */
    authorizingPolicy: z
      .object({ name: z.string().min(1), samplingRate: z.number().min(0).max(1) })
      .strict()
      .optional(),
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
