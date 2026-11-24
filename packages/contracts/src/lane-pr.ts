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
    /** Policy terms in force when THIS landing attempt was authorized; Part G must sample with this snapshot, not the live policy. */
    authorizingPolicy: z
      .object({ name: z.string().min(1), samplingRate: z.number().min(0).max(1) })
      .strict()
      .optional(),
    /** The sqa-acceptance Decision that authorized this landing attempt. A new acceptance starts a new attempt. */
    authorizationId: z.string().min(1).optional(),
    /** Whether GitHub last reported the PR open or closed without merging (merged is `queueState`). */
    prState: z.enum(['open', 'closed']).optional(),
    /** The turbine/gate state last published successfully, and the SHA it was published on. */
    statusPublished: z
      .object({ sha: z.string().min(7), state: z.enum(['pending', 'success', 'failure']) })
      .strict()
      .optional(),
    /** The newest merge-queue removal GitHub already showed when this attempt began; it belongs to an earlier attempt. */
    queueBaselineRemovalId: z.string().min(1).optional(),
    /** A removal that already started a fix round; it never starts a second one. */
    handledQueueRemovalId: z.string().min(1).optional(),
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
