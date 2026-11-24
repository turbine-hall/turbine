import { z } from 'zod';

/**
 * Trigger names a policy may deny. They mirror the keys of HARD_TRIGGERS and SOFT_TRIGGERS in
 * `packages/core/src/arsp.ts` (contracts cannot import core); a core test keeps the two lists equal.
 */
export const LANE_HARD_TRIGGER_NAMES = ['auth-permissions', 'data-migration', 'payments', 'sensitive-data', 'file-upload'] as const;
export const LANE_SOFT_TRIGGER_NAMES = ['untrusted-input', 'data-deletion', 'new-dependency'] as const;
export const LANE_TRIGGER_NAMES: readonly string[] = [...LANE_HARD_TRIGGER_NAMES, ...LANE_SOFT_TRIGGER_NAMES];

/** Gates a lane policy may name. `codeReview` is accepted by the schema but not passed by policy until part B. */
export const LaneGateSchema = z.enum(['requirements', 'plan', 'codeReview', 'acceptance']);
export type LaneGate = z.infer<typeof LaneGateSchema>;

/** Lowercase letters, digits and dashes; also the file name (`<name>.yaml`). */
export const LanePolicyNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'policy name: lowercase letters, digits, dashes (max 64)');

/** A repository-relative glob. Absolute paths, `..` segments, backslashes and NUL are refused (rule 1). */
export const LanePathPatternSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((p) => !p.includes('\0') && !p.includes('\\'), 'path pattern must not contain NUL or backslashes')
  .refine((p) => !p.startsWith('/') && !/^[a-zA-Z]:/.test(p) && !p.startsWith('~'), 'path pattern must be relative to the repository')
  .refine((p) => !p.split('/').some((s) => s === '..'), 'path pattern must not contain ".."');

const thresholdAbove = z.object({ above: z.number().min(0).max(1) }).strict();

export const LanePolicySchema = z
  .object({
    name: LanePolicyNameSchema,
    /** `comprehensive` is never allowed: hard-trigger work always goes to humans. */
    maxRiskProfile: z.enum(['lightweight', 'standard']),
    /** Source-issue labels; a task with none of them is not eligible. */
    labels: z.array(z.string().min(1).max(100)).max(100).default([]),
    deniedTriggers: z
      .array(z.string())
      .max(64)
      .default([])
      .superRefine((names, ctx) => {
        for (const n of names) {
          if (!LANE_TRIGGER_NAMES.includes(n)) {
            ctx.addIssue({ code: 'custom', message: `unknown trigger "${n}" (known: ${LANE_TRIGGER_NAMES.join(', ')})` });
          }
        }
      }),
    maxChangedLines: z.number().int().nonnegative(),
    maxChangedFiles: z.number().int().nonnegative(),
    allowDependencyChanges: z.boolean().default(false),
    deniedPaths: z.array(LanePathPatternSchema).max(200).default([]),
    maxRepos: z.number().int().min(1).default(1),
    gates: z.array(LaneGateSchema).min(1),
    /** Two model profile names (used by part B). */
    reviewers: z.array(z.string().min(1)).length(2).optional(),
    /** Tool capabilities the lane may use (used by part C). */
    tools: z.array(z.string().min(1)).max(32).default([]),
    sampling: z.object({ rate: z.number().min(0).max(1).default(0.1) }).strict().default({ rate: 0.1 }),
    revertWindowDays: z.number().int().min(0).max(365).optional(),
    suspendWhen: z
      .object({
        revertRate: z.object({ above: z.number().min(0).max(1), overLastMerges: z.number().int().positive() }).strict().optional(),
        auditProblems: z.object({ atLeast: z.number().int().positive(), inLastAudits: z.number().int().positive() }).strict().optional(),
        reviewerDisagreement: thresholdAbove.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type LanePolicy = z.infer<typeof LanePolicySchema>;

export const LanePolicyStatusSchema = z.enum(['active', 'suspended']);
export type LanePolicyStatus = z.infer<typeof LanePolicyStatusSchema>;

/** The approved snapshot of a policy held in the store. File edits never change it. */
export const ApprovedLanePolicySchema = z.object({
  name: LanePolicyNameSchema,
  contentHash: z.string(),
  /** The approved YAML text, so `policy show` can diff it against the file. */
  yaml: z.string(),
  policy: LanePolicySchema,
  approvedDecisionId: z.string(),
  approvedBy: z.string(),
  approvedAt: z.string(),
  status: LanePolicyStatusSchema,
  suspendedReason: z.string().optional(),
  updatedAt: z.string(),
});
export type ApprovedLanePolicy = z.infer<typeof ApprovedLanePolicySchema>;

/** Decision.workId used for policy approvals (they belong to a policy, not a task). */
export const policyDecisionSubject = (name: string) => `policy:${name}`;
