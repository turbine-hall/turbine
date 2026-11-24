import { z } from 'zod';

export const WorkTypeSchema = z.enum([
  'bug',
  'feature',
  'refactor',
  'migration',
  'maintenance',
  'investigation',
]);
export type WorkType = z.infer<typeof WorkTypeSchema>;

export const WorkStateSchema = z.enum([
  'IMPORTED',
  'ASSESSING',
  'REQUIREMENTS_REVIEW',
  'REQUIREMENTS_APPROVED',
  'PLANNING',
  'PLAN_REVIEW',
  'PLAN_APPROVED',
  'IMPLEMENTING',
  'AI_REVIEW',
  'HUMAN_CODE_REVIEW',
  'VERIFYING',
  'HUMAN_ACCEPTANCE',
  'ACCEPTED',
  'NEEDS_CLARIFICATION',
  'BLOCKED',
  'CHANGES_REQUESTED',
  'PAUSED_BUDGET',
  'PAUSED_POLICY',
  'CANCELLED',
  'FAILED',
]);
export type WorkState = z.infer<typeof WorkStateSchema>;

export const RiskProfileSchema = z.enum(['lightweight', 'standard', 'comprehensive']);
export type RiskProfile = z.infer<typeof RiskProfileSchema>;

export const SourceRefSchema = z.object({
  provider: z.string(),
  externalId: z.string().optional(),
  url: z.string().optional(),
  sourceUpdatedAt: z.string().optional(),
  sourceVersion: z.string().optional(),
  snapshotHash: z.string(),
  /** Labels read from the source issue at intake (lane policy eligibility). Never edited afterwards. */
  labels: z.array(z.string()).optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const RequirementPrioritySchema = z.enum(['P0', 'P1', 'P2']);
export type RequirementPriority = z.infer<typeof RequirementPrioritySchema>;

/**
 * A requirement / acceptance criterion. IDs follow FR-001 style for new work.
 * Priority: P0 = must work for acceptance, P1 = should, P2 = nice to have.
 */
export const AcceptanceCriterionSchema = z.object({
  id: z.string(),
  statement: z.string(),
  kind: z.enum(['behavioral', 'technical', 'nonfunctional']),
  status: z.enum(['confirmed', 'proposed']),
  priority: RequirementPrioritySchema.optional(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const SelectedRoleSchema = z.object({
  id: z.string(),
  version: z.string(),
  why: z.string(),
  mode: z.enum(['ai', 'human', 'tool']),
});
export type SelectedRole = z.infer<typeof SelectedRoleSchema>;

/** An additional git repository this task changes (the project repo is always included). */
export const RepoRefSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/i, 'repo name: letters, digits, dashes'),
  /** Absolute path of the repository's main checkout. */
  path: z.string(),
  /** Quality checks to run in this repo's worktree (the project repo uses quality.checks). */
  checks: z.array(z.string()).default([]),
  /** Setup commands run in the worktree before checks (e.g. npm ci). */
  setup: z.array(z.string()).default([]),
});
export type RepoRef = z.infer<typeof RepoRefSchema>;

export const WorkPackageSchema = z.object({
  id: z.string(),
  frameworkId: z.string(),
  frameworkVersion: z.string(),
  type: WorkTypeSchema,
  title: z.string(),
  objective: z.string(),
  why: z.string().optional(),
  sourceRefs: z.array(SourceRefSchema),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema),
  constraints: z.array(z.string()),
  nonGoals: z.array(z.string()),
  unknowns: z.array(z.string()),
  assumptions: z.array(z.string()),
  accountableHuman: z.string().optional(),
  risk: z.object({
    profile: RiskProfileSchema,
    reasons: z.array(z.string()),
    /** Human-raised minimum. Selection may go higher, never lower. */
    minimum: RiskProfileSchema.optional(),
  }),
  selectedRoles: z.array(SelectedRoleSchema),
  currentState: WorkStateSchema,
  currentRevision: z.number().int().nonnegative(),
  aliases: z.array(z.string()).default([]),
  repositories: z.array(RepoRefSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkPackage = z.infer<typeof WorkPackageSchema>;
