import { z } from 'zod';
import { RiskProfileSchema } from './work.js';

export const ObligationStatusSchema = z.enum([
  'unsatisfied',
  'satisfied',
  'stale',
  'blocked',
  'waived-with-authority',
]);
export type ObligationStatus = z.infer<typeof ObligationStatusSchema>;

export const ObligationKindSchema = z.enum([
  'requirement',
  'planning',
  'implementation',
  'review',
  'automated-check',
  'manual-sqa',
  'security',
  'acceptance',
]);
export type ObligationKind = z.infer<typeof ObligationKindSchema>;

export const EvidenceObligationSchema = z.object({
  id: z.string(),
  kind: ObligationKindSchema,
  acceptanceCriterionIds: z.array(z.string()),
  requiredEvidenceKinds: z.array(z.string()),
  policyRuleIds: z.array(z.string()),
  required: z.boolean(),
  passRule: z.string(),
  dependsOnArtifactIds: z.array(z.string()),
  status: ObligationStatusSchema.default('unsatisfied'),
});
export type EvidenceObligation = z.infer<typeof EvidenceObligationSchema>;

export const EngineeringEvidenceContractSchema = z.object({
  id: z.string(),
  workId: z.string(),
  revision: z.number().int().positive(),
  frameworkId: z.string(),
  frameworkVersion: z.string(),
  sourceSnapshotHashes: z.array(z.string()),
  approvedSpecHash: z.string().optional(),
  approvedPlanHash: z.string().optional(),
  accountableHumanId: z.string().optional(),
  riskProfile: RiskProfileSchema,
  obligations: z.array(EvidenceObligationSchema),
  artifactRevisionIds: z.array(z.string()),
  approvalDecisionIds: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  roleSelectionDecisionIds: z.array(z.string()),
  dependencyEdgeIds: z.array(z.string()),
  createdAt: z.string(),
  creationEventId: z.string(),
});
export type EngineeringEvidenceContract = z.infer<typeof EngineeringEvidenceContractSchema>;

export const ArtifactDependencyEdgeSchema = z.object({
  id: z.string(),
  workId: z.string(),
  upstreamArtifactId: z.string(),
  upstreamRevisionHash: z.string(),
  downstreamArtifactId: z.string(),
  downstreamRevisionHash: z.string(),
  reason: z.string(),
  affectedObligationIds: z.array(z.string()),
});
export type ArtifactDependencyEdge = z.infer<typeof ArtifactDependencyEdgeSchema>;

export const EecInvalidationEventSchema = z.object({
  id: z.string(),
  workId: z.string(),
  triggerEventId: z.string(),
  changedArtifactId: z.string(),
  oldRevisionHash: z.string(),
  newRevisionHash: z.string(),
  affectedArtifactIds: z.array(z.string()),
  affectedDecisionIds: z.array(z.string()),
  affectedEvidenceIds: z.array(z.string()),
  affectedObligationIds: z.array(z.string()),
  rationale: z.string(),
  createdAt: z.string(),
  idempotencyKey: z.string(),
});
export type EecInvalidationEvent = z.infer<typeof EecInvalidationEventSchema>;

export const RecoveryPlanSchema = z.object({
  id: z.string(),
  workId: z.string(),
  eecRevision: z.number().int(),
  triggerInvalidationIds: z.array(z.string()),
  requiredStageIds: z.array(z.string()),
  retainedArtifactRevisionIds: z.array(z.string()),
  staleArtifactRevisionIds: z.array(z.string()),
  unknownImpactIds: z.array(z.string()),
  requiredApprovalGates: z.array(z.string()),
  proposedRoleIds: z.array(z.string()),
  estimatedCost: z
    .object({
      amount: z.number(),
      currency: z.string(),
      basis: z.string(),
    })
    .optional(),
  status: z.enum(['proposed', 'authorized', 'in-progress', 'completed', 'blocked']),
  createdAt: z.string(),
});
export type RecoveryPlan = z.infer<typeof RecoveryPlanSchema>;

export const EngineEventSchema = z.object({
  id: z.string(),
  workId: z.string().optional(),
  type: z.string(),
  sequence: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  correlationId: z.string().optional(),
});
export type EngineEvent = z.infer<typeof EngineEventSchema>;
