import type {
  Artifact,
  Decision,
  EecInvalidationEvent,
  Evidence,
  RecoveryPlan,
} from '@turbine-hall/turbine-contracts';
import { createId } from '@turbine-hall/turbine-contracts';

export type ImpactInput = {
  workId: string;
  eecRevision: number;
  changeKind: 'source' | 'requirements' | 'plan' | 'code' | 'tests';
  changedArtifactId: string;
  oldRevisionHash: string;
  newRevisionHash: string;
  affectedArtifactIds: string[];
  affectedDecisionIds: string[];
  affectedEvidenceIds: string[];
  affectedObligationIds: string[];
  unknown: boolean;
  artifacts: Artifact[];
  decisions: Decision[];
  evidence: Evidence[];
  triggerEventId: string;
};

export function buildInvalidation(input: ImpactInput): EecInvalidationEvent {
  return {
    id: createId('inv'),
    workId: input.workId,
    triggerEventId: input.triggerEventId,
    changedArtifactId: input.changedArtifactId,
    oldRevisionHash: input.oldRevisionHash,
    newRevisionHash: input.newRevisionHash,
    affectedArtifactIds: input.affectedArtifactIds,
    affectedDecisionIds: input.affectedDecisionIds,
    affectedEvidenceIds: input.affectedEvidenceIds,
    affectedObligationIds: input.affectedObligationIds,
    rationale: `Change kind=${input.changeKind}; conservative impact applied`,
    createdAt: new Date().toISOString(),
    idempotencyKey: `${input.workId}:${input.changeKind}:${input.oldRevisionHash}:${input.newRevisionHash}`,
  };
}

export function buildRecoveryPlan(input: ImpactInput & { invalidationId: string }): RecoveryPlan {
  const requiredStageIds: string[] = [];
  const requiredApprovalGates: string[] = [];

  switch (input.changeKind) {
    case 'source':
      requiredStageIds.push('ASSESSING', 'REQUIREMENTS_REVIEW', 'PLANNING', 'PLAN_REVIEW');
      requiredApprovalGates.push('requirements', 'plan');
      break;
    case 'requirements':
      requiredStageIds.push('PLANNING', 'PLAN_REVIEW');
      requiredApprovalGates.push('plan');
      break;
    case 'plan':
      requiredStageIds.push('IMPLEMENTING', 'AI_REVIEW', 'HUMAN_CODE_REVIEW', 'VERIFYING');
      requiredApprovalGates.push('code-review', 'sqa-acceptance');
      break;
    case 'code':
      requiredStageIds.push('AI_REVIEW', 'HUMAN_CODE_REVIEW', 'VERIFYING', 'HUMAN_ACCEPTANCE');
      requiredApprovalGates.push('code-review', 'sqa-acceptance');
      break;
    case 'tests':
      requiredStageIds.push('VERIFYING', 'HUMAN_ACCEPTANCE');
      requiredApprovalGates.push('sqa-acceptance');
      break;
  }

  const staleArtifactRevisionIds = input.affectedArtifactIds;
  const retained = input.artifacts
    .filter((a) => !staleArtifactRevisionIds.includes(a.id))
    .map((a) => a.id);

  return {
    id: createId('rcv'),
    workId: input.workId,
    eecRevision: input.eecRevision,
    triggerInvalidationIds: [input.invalidationId],
    requiredStageIds,
    retainedArtifactRevisionIds: retained,
    staleArtifactRevisionIds,
    unknownImpactIds: input.unknown ? [input.changedArtifactId] : [],
    requiredApprovalGates,
    proposedRoleIds: [],
    status: input.unknown ? 'blocked' : 'proposed',
    createdAt: new Date().toISOString(),
  };
}

export function decisionsToInvalidate(
  decisions: Decision[],
  changeKind: ImpactInput['changeKind'],
): Decision[] {
  return decisions.filter((d) => {
    if (d.invalidatedAt) return false;
    if (changeKind === 'requirements') return d.gate === 'plan' || d.gate === 'code-review' || d.gate === 'sqa-acceptance';
    if (changeKind === 'plan') return d.gate === 'code-review' || d.gate === 'sqa-acceptance';
    if (changeKind === 'code' || changeKind === 'tests') {
      return d.gate === 'code-review' || d.gate === 'sqa-acceptance';
    }
    if (changeKind === 'source') {
      return ['requirements', 'plan', 'code-review', 'sqa-acceptance'].includes(d.gate);
    }
    return false;
  });
}
