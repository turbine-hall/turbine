import type {
  EngineeringEvidenceContract,
  EvidenceObligation,
  RiskProfile,
  WorkPackage,
} from '@turbine-hall/turbine-contracts';
import { createId } from '@turbine-hall/turbine-contracts';

function nextRevisionId(): string {
  return createId('eecrev');
}


export function createDraftEec(input: {
  work: WorkPackage;
  creationEventId: string;
  riskProfile?: RiskProfile;
}): EngineeringEvidenceContract {
  const obligations: EvidenceObligation[] = [
    {
      id: 'obl_source',
      kind: 'requirement',
      acceptanceCriterionIds: [],
      requiredEvidenceKinds: ['other'],
      policyRuleIds: ['source-provenance'],
      required: true,
      passRule: 'has-source-snapshot',
      dependsOnArtifactIds: [],
      status: 'unsatisfied',
    },
    {
      id: 'obl_requirements_approval',
      kind: 'requirement',
      acceptanceCriterionIds: [],
      requiredEvidenceKinds: [],
      policyRuleIds: ['human-requirements-gate'],
      required: true,
      passRule: 'requirements-approved',
      dependsOnArtifactIds: [],
      status: 'unsatisfied',
    },
    {
      id: 'obl_acceptance_criteria',
      kind: 'requirement',
      acceptanceCriterionIds: [],
      requiredEvidenceKinds: [],
      policyRuleIds: ['acceptance-criteria'],
      required: true,
      passRule: 'acceptance-criteria-present',
      dependsOnArtifactIds: [],
      status: 'unsatisfied',
    },
    {
      id: 'obl_plan_approval',
      kind: 'planning',
      acceptanceCriterionIds: [],
      requiredEvidenceKinds: [],
      policyRuleIds: ['human-plan-gate'],
      required: true,
      passRule: 'plan-approved',
      dependsOnArtifactIds: [],
      status: 'unsatisfied',
    },
  ];

  return {
    id: createId('eec'),
    workId: input.work.id,
    revision: 1,
    frameworkId: input.work.frameworkId,
    frameworkVersion: input.work.frameworkVersion,
    sourceSnapshotHashes: input.work.sourceRefs.map((s) => s.snapshotHash),
    accountableHumanId: input.work.accountableHuman,
    riskProfile: input.riskProfile ?? input.work.risk.profile,
    obligations,
    artifactRevisionIds: [],
    approvalDecisionIds: [],
    evidenceIds: [],
    roleSelectionDecisionIds: [],
    dependencyEdgeIds: [],
    createdAt: new Date().toISOString(),
    creationEventId: input.creationEventId,
  };
}

export function extendEecForImplementation(
  eec: EngineeringEvidenceContract,
): EngineeringEvidenceContract {
  const extras: EvidenceObligation[] = [
    {
      id: 'obl_implementation',
      kind: 'implementation',
      acceptanceCriterionIds: [],
      requiredEvidenceKinds: ['unit'],
      policyRuleIds: ['implementation'],
      required: true,
      passRule: 'implementation-present',
      dependsOnArtifactIds: [],
      status: 'unsatisfied',
    },
    {
      id: 'obl_code_review',
      kind: 'review',
      acceptanceCriterionIds: [],
      requiredEvidenceKinds: ['review'],
      policyRuleIds: ['human-code-review'],
      required: true,
      passRule: 'code-review-current',
      dependsOnArtifactIds: [],
      status: 'unsatisfied',
    },
    {
      id: 'obl_automated_checks',
      kind: 'automated-check',
      acceptanceCriterionIds: [],
      requiredEvidenceKinds: ['unit', 'lint', 'typecheck'],
      policyRuleIds: ['deterministic-checks'],
      required: true,
      passRule: 'tests-current',
      dependsOnArtifactIds: [],
      status: 'unsatisfied',
    },
    {
      id: 'obl_manual_sqa',
      kind: 'manual-sqa',
      acceptanceCriterionIds: [],
      requiredEvidenceKinds: ['manual-sqa'],
      policyRuleIds: ['sqa-acceptance'],
      required: true,
      passRule: 'manual-sqa-accepted',
      dependsOnArtifactIds: [],
      status: 'unsatisfied',
    },
    {
      // Required only in effect when the change adds/changes dependencies (rule is satisfied otherwise).
      id: 'obl_dependency_audit',
      kind: 'security',
      acceptanceCriterionIds: [],
      requiredEvidenceKinds: ['security'],
      policyRuleIds: ['new-dependency-audit'],
      required: true,
      passRule: 'dependency-audit',
      dependsOnArtifactIds: [],
      status: 'unsatisfied',
    },
    {
      // Not required: an unmet coverage obligation makes the gate CONCERNS, not FAIL.
      id: 'obl_requirement_coverage',
      kind: 'automated-check',
      acceptanceCriterionIds: [],
      requiredEvidenceKinds: [],
      policyRuleIds: ['traceability'],
      required: false,
      passRule: 'requirements-covered',
      dependsOnArtifactIds: [],
      status: 'unsatisfied',
    },
    {
      id: 'obl_final_acceptance',
      kind: 'acceptance',
      acceptanceCriterionIds: [],
      requiredEvidenceKinds: [],
      policyRuleIds: ['human-acceptance'],
      required: true,
      passRule: 'human-acceptance',
      dependsOnArtifactIds: [],
      status: 'unsatisfied',
    },
  ];
  const existing = new Set(eec.obligations.map((o) => o.id));
  return {
    ...eec,
    id: nextRevisionId(),
    revision: eec.revision + 1,
    obligations: [
      ...eec.obligations,
      ...extras.filter((o) => !existing.has(o.id)),
    ],
    createdAt: new Date().toISOString(),
  };
}

export function bumpEecRevision(
  eec: EngineeringEvidenceContract,
  patch: Partial<EngineeringEvidenceContract>,
): EngineeringEvidenceContract {
  return {
    ...eec,
    ...patch,
    id: nextRevisionId(),
    workId: eec.workId,
    revision: eec.revision + 1,
    createdAt: new Date().toISOString(),
  };
}
