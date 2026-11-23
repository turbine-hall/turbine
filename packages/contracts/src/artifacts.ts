import { z } from 'zod';

export const ArtifactTypeSchema = z.enum([
  'source',
  'assessment',
  'specification',
  'plan',
  'test-plan',
  'architecture',
  'change-report',
  'diff',
  'review',
  'test-report',
  'release-readiness',
  'execution-brief',
  /** Repository context layer 3: the files relevant to one task, bound to a Layer 1 snapshot. */
  'repo-context',
  'other',
]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactSchema = z.object({
  id: z.string(),
  workId: z.string(),
  type: ArtifactTypeSchema,
  revision: z.number().int().positive(),
  contentHash: z.string(),
  contentType: z.string(),
  location: z.string(),
  createdBy: z.object({
    kind: z.enum(['human', 'agent', 'tool']),
    identifier: z.string(),
  }),
  createdAt: z.string(),
  parentArtifactIds: z.array(z.string()),
  relatedCommit: z.string().optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const DecisionSchema = z.object({
  id: z.string(),
  workId: z.string(),
  gate: z.enum(['requirements', 'plan', 'code-review', 'sqa-acceptance', 'exception']),
  action: z.enum(['approve', 'reject', 'request-changes']),
  artifactIds: z.array(z.string()),
  artifactHashes: z.array(z.string()),
  workRevision: z.number().int(),
  commitSha: z.string().optional(),
  actorId: z.string(),
  actorType: z.literal('human'),
  identityAssurance: z.enum(['local-attestation', 'authenticated']),
  rationale: z.string().optional(),
  decidedAt: z.string(),
  invalidatedAt: z.string().optional(),
  invalidationReason: z.string().optional(),
  /** Waivers only (gate=exception): which obligations this waiver covers. */
  obligationIds: z.array(z.string()).optional(),
  /** Waivers only: ISO timestamp after which the waiver no longer applies. */
  expiresAt: z.string().optional(),
  /** How the human was confirmed present (e.g. tty-hash-confirmation, github-pr-review). */
  presence: z.string().optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const RoleRunSchema = z.object({
  id: z.string(),
  workId: z.string(),
  roleId: z.string(),
  roleVersion: z.string(),
  skillIds: z.array(z.string()),
  toolCapabilityGrants: z.array(z.string()),
  modelProvider: z.string().optional(),
  modelId: z.string().optional(),
  promptArtifactHash: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled']),
  inputArtifactIds: z.array(z.string()),
  outputArtifactIds: z.array(z.string()),
  attempts: z.number().int(),
  tokens: z
    .object({
      /** Measured count, or the literal `unknown` when the adapter omitted usage (never silent 0). */
      input: z.union([z.number().nonnegative(), z.literal('unknown')]).optional(),
      output: z.union([z.number().nonnegative(), z.literal('unknown')]).optional(),
    })
    .optional(),
  cost: z
    .object({
      actual: z.number().optional(),
      estimated: z.number().optional(),
      currency: z.string(),
      basis: z.string().optional(),
    })
    .optional(),
  errorCode: z.string().optional(),
});
export type RoleRun = z.infer<typeof RoleRunSchema>;

export const EvidenceSchema = z.object({
  id: z.string(),
  workId: z.string(),
  kind: z.enum([
    'unit',
    'lint',
    'typecheck',
    'build',
    'api',
    'e2e',
    'security',
    'manual-sqa',
    'review',
    'other',
  ]),
  producedByRunId: z.string().optional(),
  reviewerId: z.string().optional(),
  commandOrCheck: z.string().optional(),
  exitCode: z.number().optional(),
  result: z.enum(['passed', 'failed', 'blocked', 'not-run']),
  commitSha: z.string().optional(),
  environment: z.string().optional(),
  observedAt: z.string(),
  logArtifactId: z.string().optional(),
  limitations: z.array(z.string()),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
