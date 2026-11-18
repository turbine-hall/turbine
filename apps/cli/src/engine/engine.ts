import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  contentHash,
  contentHashText,
  createId,
  err,
  RepoRefSchema,
  type AcceptanceCriterion,
  type Artifact,
  type Decision,
  type Evidence,
  type RiskProfile,
  type RoleRun,
  type WorkPackage,
  type WorkState,
  type WorkType,
} from '@turbine-hall/turbine-contracts';
import { assertTransition, getRole, listFrameworks, loadFramework, loadRoles, maxProfile, selectRoles } from '@turbine-hall/turbine-core';
import {
  bumpEecRevision,
  createDraftEec,
  evaluateEec,
  computeGateDecision,
  extendEecForImplementation,
} from '@turbine-hall/turbine-evidence-contract';
import {
  buildInvalidation,
  buildRecoveryPlan,
  createEdge,
  decisionsToInvalidate,
  graphImpact,
} from '@turbine-hall/turbine-lineage-impact';
import {
  configureModelsFromProfiles,
  createMockModelAdapter,
  createOpenAICompatibleAdapter,
  ensureDefaultMock,
  getModel,
  listModels,
  registerModel,
  testModel,
} from '@turbine-hall/turbine-models';
import { getSkill, loadSkills, runSkill, type SkillManifest } from '@turbine-hall/turbine-skills';
import type { ModelAdapter } from '@turbine-hall/turbine-models';
import { ToolBroker } from '@turbine-hall/turbine-tools';
import { createJiraAdapter, issueToMarkdown, type JiraIssue } from '@turbine-hall/turbine-adapter-jira';
import { inspectRepo } from '@turbine-hall/turbine-adapter-git';
import { analyze, type AnalysisFinding } from './docs/analyze.js';
import { lintPacket, type LintIssue } from './docs/lint.js';
import {
  extractRequestItems,
  normalizeAssessment,
  normalizePlan,
  normalizeRequirements,
  normalizeSpec,
} from './docs/normalize.js';
import { renderPacket, trackFor, type PacketData } from './docs/render.js';
import { GLOSSARY } from './docs/glossary.js';
import { computeTrace, type TraceRow } from './docs/trace.js';
import { checkLabel, inferCheckKind, runCommand, type CheckRun } from './checks.js';
import {
  LENS_INSTRUCTIONS,
  REVIEW_OUTPUT_CONTRACT,
  crossCheckClaims,
  disposition,
  factsBlock,
  selectLenses,
  triage,
  validateCoverage,
  type ClaimMismatch,
  type CoverageLink,
  type DiscardedFinding,
  type Finding,
  type Lens,
  type ReviewResult,
} from './review.js';
import {
  baseSetId,
  changeSetId,
  collectDiffs,
  computeFacts,
  observe,
  prepareWorktrees,
  primaryName,
  type RepoFacts,
  type RepoState,
} from './changeset.js';
import type { EngineContext } from './project.js';
import { saveConfig } from './project.js';
import {
  collectProjectEvidence,
  isDeferredEngineeringUnknown,
  projectEvidenceFacts,
} from './project-context.js';
import { computeNextStep, type NextStep } from './next-step.js';
import {
  packetPaths,
  parseAcceptanceChecklist,
  parseSpecMarkdown,
  readPacketFile,
  writeFile,
} from './packet.js';

function now(): string {
  return new Date().toISOString();
}

function transition(work: WorkPackage, to: WorkState): WorkPackage {
  assertTransition(work.currentState, to);
  return { ...work, currentState: to, updatedAt: now(), currentRevision: work.currentRevision + 1 };
}

function normalizeAcceptanceCriteria(raw: unknown): AcceptanceCriterion[] {
  return normalizeRequirements(raw);
}

export type PrApprovalResult = { approved: boolean; detail: string; url?: string };
export type PrApprovalChecker = (input: {
  projectRoot: string;
  branch: string;
  headCommit: string;
}) => PrApprovalResult;

/** Checks the open PR for `branch` has an APPROVED review decision at exactly `headCommit`. */
export const githubPrApprovalChecker: PrApprovalChecker = ({ projectRoot, branch, headCommit }) => {
  const r = spawnSync(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url,reviewDecision,headRefOid'],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  if (r.status !== 0) {
    return { approved: false, detail: `gh failed: ${(r.stderr || r.error?.message || '').trim()}` };
  }
  let prs: Array<{ number: number; url: string; reviewDecision: string; headRefOid: string }> = [];
  try {
    prs = JSON.parse(r.stdout || '[]');
  } catch {
    return { approved: false, detail: 'Could not parse gh output' };
  }
  const pr = prs[0];
  if (!pr) return { approved: false, detail: `No open PR for branch ${branch}` };
  if (pr.headRefOid !== headCommit) {
    return {
      approved: false,
      url: pr.url,
      detail: `PR head ${pr.headRefOid.slice(0, 8)} is not the commit under review ${headCommit.slice(0, 8)} — push it first`,
    };
  }
  if (pr.reviewDecision !== 'APPROVED') {
    return { approved: false, url: pr.url, detail: `PR review decision is ${pr.reviewDecision || 'none'}` };
  }
  return { approved: true, url: pr.url, detail: `PR #${pr.number} approved at ${headCommit.slice(0, 8)}` };
};

export class Engine {
  /** Replaceable for tests; used when humanGates.requirePrApproval is on. */
  prApprovalChecker: PrApprovalChecker = githubPrApprovalChecker;

  constructor(readonly ctx: EngineContext) {
    ensureDefaultMock();
    configureModelsFromProfiles(this.ctx.config.models.profiles);
  }

  private artifactLocation(workId: string, type: string, revision: number): string {
    const dir = join(this.ctx.paths.artifactsDir, workId);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${type}-r${revision}.json`);
  }

  private saveArtifact(input: {
    workId: string;
    type: Artifact['type'];
    content: unknown;
    createdBy: Artifact['createdBy'];
    parentArtifactIds?: string[];
    relatedCommit?: string;
  }): Artifact {
    const latest = this.ctx.store.getLatestArtifact(input.workId, input.type);
    const revision = (latest?.revision ?? 0) + 1;
    const body = typeof input.content === 'string' ? input.content : JSON.stringify(input.content, null, 2);
    const hash = typeof input.content === 'string' ? contentHashText(body) : contentHash(input.content);
    const location = this.artifactLocation(input.workId, input.type, revision);
    writeFileSync(location, body, 'utf8');
    const artifact: Artifact = {
      id: createId('art'),
      workId: input.workId,
      type: input.type,
      revision,
      contentHash: hash,
      contentType: 'application/json',
      location,
      createdBy: input.createdBy,
      createdAt: now(),
      parentArtifactIds: input.parentArtifactIds ?? [],
      relatedCommit: input.relatedCommit,
    };
    this.ctx.store.saveArtifact(artifact, body);
    return artifact;
  }

  createTask(input: {
    title: string;
    type?: WorkType;
    file?: string;
    text?: string;
    accountableHuman?: string;
  }): WorkPackage {
    const sourceText =
      input.text ??
      (input.file ? readFileSync(input.file, 'utf8') : `# ${input.title}\n\n(No body provided)`);
    const snapshotHash = contentHashText(sourceText);
    const workId = createId('work');
    const createdAt = now();

    const work: WorkPackage = {
      id: workId,
      frameworkId: this.ctx.config.framework.id,
      frameworkVersion: this.ctx.config.framework.version,
      type: input.type ?? 'feature',
      title: input.title,
      objective: sourceText.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() || input.title,
      sourceRefs: [
        {
          provider: input.file ? 'file' : 'text',
          externalId: input.file,
          snapshotHash,
        },
      ],
      acceptanceCriteria: [],
      constraints: [],
      nonGoals: [],
      unknowns: [],
      assumptions: [],
      accountableHuman: input.accountableHuman,
      risk: { profile: this.ctx.config.framework.policyProfile, reasons: [] },
      selectedRoles: [],
      currentState: 'IMPORTED',
      currentRevision: 1,
      aliases: [],
      createdAt,
      updatedAt: createdAt,
    };

    const created = this.ctx.store.transaction(() => {
      this.ctx.store.saveWork(work);
      this.ctx.store.saveSourceSnapshot({
        hash: snapshotHash,
        workId,
        provider: work.sourceRefs[0]!.provider,
        content: sourceText,
      });
      const evt = this.ctx.store.appendEvent({
        workId,
        type: 'work.created',
        payload: { title: work.title, snapshotHash },
      });
      this.ctx.store.appendEvent({
        workId,
        type: 'source.imported',
        payload: { snapshotHash, provider: work.sourceRefs[0]!.provider },
      });
      const sourceArt = this.saveArtifact({
        workId,
        type: 'source',
        content: { text: sourceText, snapshotHash },
        createdBy: { kind: 'tool', identifier: 'intake' },
      });
      const eec = createDraftEec({ work, creationEventId: evt.id });
      eec.artifactRevisionIds = [sourceArt.id];
      this.ctx.store.saveEec(eec);
      return work;
    });
    this.render(created.id, ['Request received. Next: sync to assess it.']);
    return Object.assign(created, { packetDir: packetPaths(this.ctx.projectRoot, created.id).dir }) as WorkPackage & { packetDir: string };
  }

  takeoverJira(key: string, fixtures?: Record<string, JiraIssue>): WorkPackage {
    const jiraCfg = this.ctx.config.inputs.adapters.jira;
    const adapter = createJiraAdapter({
      siteUrl: jiraCfg.siteUrl ?? '',
      email: process.env.JIRA_EMAIL,
      apiToken: process.env.JIRA_API_TOKEN,
      fixtures,
    });
    const broker = new ToolBroker({
      allow: this.ctx.config.tools.allow,
      deny: this.ctx.config.tools.denied,
    });
    broker.register(adapter);

    // invoke synchronously via deasync-less pattern: we use async in command layer
    throw err('E_ADAPTER', 'Use takeoverJiraAsync');
  }

  async takeoverJiraAsync(key: string, fixtures?: Record<string, JiraIssue>): Promise<WorkPackage> {
    const jiraCfg = this.ctx.config.inputs.adapters.jira;
    const adapter = createJiraAdapter({
      siteUrl: jiraCfg.siteUrl ?? '',
      email: process.env.JIRA_EMAIL,
      apiToken: process.env.JIRA_API_TOKEN,
      fixtures,
    });
    const broker = new ToolBroker({
      allow: this.ctx.config.tools.allow,
      deny: this.ctx.config.tools.denied,
    });
    broker.register(adapter);
    const result = await broker.invoke({
      capability: 'issue.read',
      workId: 'intake',
      arguments: { key },
      grants: ['issue.read'],
    });
    const issue = result.data as JiraIssue;
    const md = issueToMarkdown(issue);
    const work = this.createTask({
      title: `${issue.key}: ${issue.summary}`,
      type: 'feature',
      text: md,
    });
    const withAlias: WorkPackage = {
      ...work,
      aliases: [issue.key, `jira:${issue.key}`],
      sourceRefs: [
        {
          provider: 'jira',
          externalId: issue.key,
          url: issue.url,
          sourceUpdatedAt: issue.updatedAt,
          sourceVersion: issue.id,
          snapshotHash: work.sourceRefs[0]!.snapshotHash,
        },
      ],
      acceptanceCriteria: (issue.acceptanceCriteria ?? []).map((statement, i) => ({
        id: `ac_jira_${i + 1}`,
        statement,
        kind: 'behavioral' as const,
        status: 'proposed' as const,
      })),
      updatedAt: now(),
    };
    this.ctx.store.saveWork(withAlias);
    this.ctx.store.appendEvent({
      workId: work.id,
      type: 'source.imported',
      payload: { provider: 'jira', key: issue.key },
    });
    return withAlias;
  }

  /**
   * Run a skill AS a role (framework §5): the role manifest must list the skill, tool grants
   * come from the role's required capabilities minus its prohibited ones and the project's
   * tools policy, and every run is recorded. Roles other than intake roles must have been
   * selected by ARSP for this task.
   */
  private async runAsRole(input: {
    skill: SkillManifest;
    model: ModelAdapter;
    workId: string;
    roleId: string;
    context: string;
    schemaId: string;
    maxOutputTokens: number;
  }): Promise<{ content: unknown; usage?: { inputTokens?: number; outputTokens?: number } }> {
    const work = this.ctx.store.getWork(input.workId);
    const { grants } = this.roleGrants(work, input.roleId, input.skill.id);
    const run: RoleRun = {
      id: createId('run'),
      workId: work.id,
      roleId: input.roleId,
      roleVersion: getRole(this.ctx.factoryRoot, input.roleId).version,
      skillIds: [input.skill.id],
      toolCapabilityGrants: grants,
      modelProvider: input.model.provider,
      modelId: input.model.id,
      promptArtifactHash: input.skill.contentHash,
      startedAt: now(),
      status: 'running',
      inputArtifactIds: [],
      outputArtifactIds: [],
      attempts: 1,
    };
    this.ctx.store.saveRoleRun(run);
    try {
      const result = await runSkill({ ...input, grantedCapabilities: grants });
      this.ctx.store.saveRoleRun({
        ...run,
        status: 'succeeded',
        endedAt: now(),
        tokens: { input: result.usage?.inputTokens, output: result.usage?.outputTokens },
      });
      return result;
    } catch (e) {
      this.ctx.store.saveRoleRun({ ...run, status: 'failed', endedAt: now(), errorCode: (e as { code?: string }).code ?? 'E_RUN_FAILURE' });
      throw e;
    }
  }

  /** Capabilities a role may use for a skill under the project's policy (fails closed). */
  roleGrants(work: WorkPackage, roleId: string, skillId: string): { grants: string[] } {
    const role = getRole(this.ctx.factoryRoot, roleId);
    if (![...role.skills.required, ...role.skills.optional].includes(skillId)) {
      throw err('E_MISSING_CAPABILITY', `Role ${roleId} is not allowed to run skill ${skillId}`);
    }
    const intake = ['requirements-analyst', 'spec-writer', 'project-manager'];
    if (!intake.includes(roleId) && !work.selectedRoles.some((r) => r.id === roleId)) {
      throw err('E_MISSING_CAPABILITY', `Role ${roleId} was not selected for this task (see turbine task roles)`);
    }
    const { allow, denied } = this.ctx.config.tools;
    const grants = role.capabilities.required.filter(
      (c) => !role.capabilities.prohibited.includes(c) && !denied.includes(c) && (allow.length === 0 || allow.includes(c)),
    );
    return { grants: [...grants, 'none'] };
  }

  private checkBudget(workId: string): void {
    const budget = this.ctx.store.getBudget(workId);
    const max = this.ctx.config.budgets.perTask.maxModelCalls;
    if (budget.modelCalls >= max) {
      throw err('E_BUDGET_EXCEEDED', `Model call budget exceeded (${budget.modelCalls}/${max})`);
    }
  }

  async assess(idOrAlias: string): Promise<{
    work: WorkPackage;
    assessment: unknown;
    roles: ReturnType<typeof selectRoles>;
    packetDir: string;
  }> {
    let work = this.ctx.store.getWork(idOrAlias);
    // Resume safely if a previous assess crashed mid-run.
    if (work.currentState === 'IMPORTED' || work.currentState === 'NEEDS_CLARIFICATION') {
      work = transition(work, 'ASSESSING');
      this.ctx.store.saveWork(work);
    } else if (work.currentState !== 'ASSESSING') {
      throw err(
        'E_INVALID_TRANSITION',
        `Cannot assess from ${work.currentState}`,
      );
    }

    this.checkBudget(work.id);
    const source = this.ctx.store.getLatestArtifact(work.id, 'source');
    // The source artifact is stored as JSON {text, snapshotHash}; the model needs the text itself.
    const sourceText = (() => {
      if (!source) return work.objective;
      const raw = this.ctx.store.getArtifactContent(source.id);
      try {
        const parsed = JSON.parse(raw) as { text?: unknown };
        return typeof parsed.text === 'string' ? parsed.text : raw;
      } catch {
        return raw;
      }
    })();
    const projectEvidence = collectProjectEvidence(this.ctx.projectRoot, `${work.title}\n${sourceText}`, { store: this.ctx.store });
    const groundedFacts = projectEvidenceFacts(projectEvidence);
    const model = getModel(this.ctx.config.models.profiles.analysis?.model ?? 'mock-default');
    const skill = getSkill(this.ctx.factoryRoot, 'core/assess-requirements');
    const assessContext = [
      '## REQUEST',
      sourceText,
      '',
      '## PROJECT_EVIDENCE (deterministic — treat as confirmed facts, do not re-assume)',
      JSON.stringify(projectEvidence, null, 2),
      '',
      '## GROUNDED_FACTS',
      ...groundedFacts.map((f) => `- ${f}`),
      '',
      '## RULES',
      '- Put PROJECT_EVIDENCE items in facts, never in assumptions.',
      '- assumptions: only gaps not in REQUEST and not observable in PROJECT_EVIDENCE.',
      '- unknowns: ONLY human product/policy decisions that block writing requirements.',
      '- Do NOT list engineering discovery as unknowns (current versions, npm latest lookup, whether typecheck will pass, whether @types need bumps, whether code must change) — those belong in plan/execute.',
    ].join('\n');
    const result = await this.runAsRole({
      skill,
      model,
      workId: work.id,
      roleId: 'requirements-analyst',
      context: assessContext,
      schemaId: 'assessment',
      maxOutputTokens: this.ctx.config.models.profiles.analysis?.maxOutputTokens ?? 4000,
    });
    this.ctx.store.incrementBudget(work.id, 1);

    const assessment = result.content as any;
    // Deterministic project facts first (with sources); model facts must name a source too.
    const normalized = normalizeAssessment(assessment);
    const modelFacts = normalized.facts.filter(
      (f) => !projectEvidence.facts.some((g) => g.text.toLowerCase() === f.text.toLowerCase()),
    );
    assessment.facts = [...projectEvidence.facts, ...modelFacts];
    assessment.assumptions = normalized.assumptions;
    const rawUnknowns = normalized.questions.map((q) => q.text);
    const deferredUnknowns = rawUnknowns.filter((u: string) => isDeferredEngineeringUnknown(u));
    const blockingUnknowns = rawUnknowns.filter((u: string) => !isDeferredEngineeringUnknown(u));
    assessment.unknowns = blockingUnknowns;
    if (deferredUnknowns.length) {
      assessment.assumptions = [
        ...(Array.isArray(assessment.assumptions) ? assessment.assumptions.map(String) : []),
        ...deferredUnknowns.map((u: string) => `Deferred to plan/execute (not a human blocker): ${u}`),
      ];
    }
    assessment.projectEvidence = projectEvidence;

    const modelProfile = ['lightweight', 'standard', 'comprehensive'].includes(String(assessment.recommendedProfile))
      ? (assessment.recommendedProfile as RiskProfile)
      : undefined;
    const roles = selectRoles({
      work,
      // Only the request: engine-generated project facts must not trip risk triggers.
      extraContext: sourceText,
      // Floor: a human minimum, and on re-assessment the previous profile (downgrades are disabled).
      forceProfile:
        work.risk.minimum || work.selectedRoles.length
          ? maxProfile(work.risk.minimum, work.selectedRoles.length ? work.risk.profile : undefined)
          : undefined,
      modelProfile,
      modelHints: Array.isArray(assessment.riskHints) ? assessment.riskHints.map(String) : [],
    });
    const criteria = normalizeAcceptanceCriteria(
      assessment.proposedAcceptanceCriteria ?? assessment.acceptanceCriteria,
    ).map((c) => ({ ...c, status: 'proposed' as const }));

    // Spec skill
    const requestItems = extractRequestItems(sourceText);
    this.checkBudget(work.id);
    const specSkill = getSkill(this.ctx.factoryRoot, 'core/write-specification');
    const specResult = await this.runAsRole({
      skill: specSkill,
      model,
      workId: work.id,
      roleId: 'spec-writer',
      context: [
        'REQUEST ITEMS (map every one in requestCoverage):',
        ...requestItems.map((r) => `- ${r.id}: ${r.text}`),
        '',
        JSON.stringify({ assessment, sourceText, projectEvidence: projectEvidence.facts }, null, 2),
      ].join('\n'),
      schemaId: 'specification',
      maxOutputTokens: 4000,
    });
    this.ctx.store.incrementBudget(work.id, 1);

    const hasCriticalUnknowns = blockingUnknowns.length > 0;

    const assessmentArt = this.saveArtifact({
      workId: work.id,
      type: 'assessment',
      content: assessment,
      createdBy: { kind: 'agent', identifier: 'requirements-analyst' },
    });
    const rawSpec = (specResult.content ?? {}) as Record<string, unknown>;
    const normalizedSpec = {
      ...rawSpec,
      requestItems,
      acceptanceCriteria: normalizeAcceptanceCriteria(
        rawSpec.requirements ?? rawSpec.acceptanceCriteria ?? criteria,
      ),
    };
    const specArt = this.saveArtifact({
      workId: work.id,
      type: 'specification',
      content: normalizedSpec,
      createdBy: { kind: 'agent', identifier: 'spec-writer' },
      parentArtifactIds: [assessmentArt.id],
    });

    const specCriteria = normalizeAcceptanceCriteria(normalizedSpec.acceptanceCriteria);
    // Select roles with the drafted requirements too (they often name the risky part,
    // e.g. "uploads a document"), not only the raw request.
    const finalRoles = selectRoles({
      work: { ...work, acceptanceCriteria: specCriteria.length ? specCriteria : criteria },
      extraContext: sourceText,
      forceProfile:
        work.risk.minimum || work.selectedRoles.length
          ? maxProfile(work.risk.minimum, work.selectedRoles.length ? work.risk.profile : undefined)
          : undefined,
      modelProfile,
      modelHints: Array.isArray(assessment.riskHints) ? assessment.riskHints.map(String) : [],
    });
    roles.profile = finalRoles.profile;
    roles.roles = finalRoles.roles;
    roles.omitted = finalRoles.omitted;
    roles.hardTriggers = finalRoles.hardTriggers;
    roles.softTriggers = finalRoles.softTriggers;
    roles.explanation = finalRoles.explanation;
    roles.profileSource = finalRoles.profileSource;
    work = {
      ...work,
      acceptanceCriteria: (specCriteria.length ? specCriteria : criteria).map((c) => ({
        ...c,
        status: 'proposed' as const,
      })),
      unknowns: Array.isArray(assessment.unknowns)
        ? assessment.unknowns.map(String)
        : [],
      assumptions: Array.isArray(assessment.assumptions)
        ? assessment.assumptions.map(String)
        : [],
      nonGoals: Array.isArray(assessment.nonGoals)
        ? assessment.nonGoals.map(String)
        : work.nonGoals,
      selectedRoles: roles.roles,
      risk: { profile: roles.profile, reasons: [...roles.hardTriggers, ...roles.softTriggers], minimum: work.risk.minimum },
      updatedAt: now(),
    };

    work = transition(work, hasCriticalUnknowns ? 'NEEDS_CLARIFICATION' : 'REQUIREMENTS_REVIEW');

    this.ctx.store.transaction(() => {
      this.ctx.store.saveWork(work);
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'requirements.assessed',
        payload: { assessmentArtifactId: assessmentArt.id, specArtifactId: specArt.id, roles },
      });
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'role.selected',
        payload: roles,
      });
      const eec = this.ctx.store.getLatestEec(work.id)!;
      const updated = bumpEecRevision(eec, {
        riskProfile: roles.profile,
        artifactRevisionIds: [...eec.artifactRevisionIds, assessmentArt.id, specArt.id],
        obligations: eec.obligations.map((o) =>
          o.id === 'obl_acceptance_criteria'
            ? { ...o, acceptanceCriterionIds: criteria.map((c) => c.id) }
            : o,
        ),
      });
      // link edge source -> spec
      const sourceArt = this.ctx.store.getLatestArtifact(work.id, 'source');
      if (sourceArt) {
        const edge = createEdge({
          workId: work.id,
          upstreamArtifactId: sourceArt.id,
          upstreamRevisionHash: sourceArt.contentHash,
          downstreamArtifactId: specArt.id,
          downstreamRevisionHash: specArt.contentHash,
          reason: 'source-to-specification',
          affectedObligationIds: ['obl_requirements_approval', 'obl_plan_approval'],
        });
        this.ctx.store.saveEdge(edge);
        updated.dependencyEdgeIds = [...updated.dependencyEdgeIds, edge.id];
      }
      this.ctx.store.saveEec(updated);
    });

    this.render(work.id, [
        ...work.unknowns.map((u) => `Open question (blocks approval): ${u}`),
        ...deferredUnknowns.map((u: string) => `Deferred (plan/execute): ${u}`),
        `Assessed: ${work.acceptanceCriteria.length} requirement(s), ${work.unknowns.length} open question(s).`,
      ]);

    return { work, assessment, roles, packetDir: packetPaths(this.ctx.projectRoot, work.id).dir };
  }

  editRequirements(idOrAlias: string, patch: {
    acceptanceCriteria?: AcceptanceCriterion[];
    unknowns?: string[];
    assumptions?: string[];
    nonGoals?: string[];
    objective?: string;
  }): WorkPackage {
    let work = this.ctx.store.getWork(idOrAlias);
    const prevSpec = this.ctx.store.getLatestArtifact(work.id, 'specification');
    const nextContent = {
      ...(prevSpec ? JSON.parse(this.ctx.store.getArtifactContent(prevSpec.id)) : {}),
      ...patch,
      acceptanceCriteria: patch.acceptanceCriteria ?? work.acceptanceCriteria,
      // Keep the model's original draft from lingering under a second key with stale IDs.
      requirements: patch.acceptanceCriteria ?? work.acceptanceCriteria,
      editedAt: now(),
    };
    const specArt = this.saveArtifact({
      workId: work.id,
      type: 'specification',
      content: nextContent,
      createdBy: { kind: 'human', identifier: work.accountableHuman ?? 'local-user' },
      parentArtifactIds: prevSpec ? [prevSpec.id] : [],
    });

    // If previously approved, invalidate
    if (['REQUIREMENTS_APPROVED', 'PLANNING', 'PLAN_REVIEW', 'PLAN_APPROVED', 'IMPLEMENTING', 'AI_REVIEW', 'HUMAN_CODE_REVIEW', 'VERIFYING', 'HUMAN_ACCEPTANCE'].includes(work.currentState)) {
      this.applyChangeImpact(work.id, 'requirements', prevSpec?.id ?? specArt.id, prevSpec?.contentHash ?? 'none', specArt.contentHash);
      work = this.ctx.store.getWork(work.id);
      if (work.currentState !== 'REQUIREMENTS_REVIEW' && work.currentState !== 'ASSESSING') {
        // move back for reapproval
        work = { ...work, currentState: 'REQUIREMENTS_REVIEW', updatedAt: now(), currentRevision: work.currentRevision + 1 };
      }
    } else if (work.currentState === 'NEEDS_CLARIFICATION') {
      work = transition(work, 'ASSESSING');
      work = transition(work, 'REQUIREMENTS_REVIEW');
    } else if (work.currentState === 'IMPORTED') {
      work = transition(work, 'ASSESSING');
      work = transition(work, 'REQUIREMENTS_REVIEW');
    }

    work = {
      ...work,
      acceptanceCriteria: normalizeAcceptanceCriteria(
        patch.acceptanceCriteria ?? work.acceptanceCriteria,
      ).map((c) => ({
        ...c,
        status: 'confirmed' as const,
      })),
      unknowns: patch.unknowns ?? [],
      assumptions: patch.assumptions ?? work.assumptions,
      nonGoals: patch.nonGoals ?? work.nonGoals,
      objective: patch.objective ?? work.objective,
      updatedAt: now(),
    };
    // Open questions block approval, so the task waits on clarification until they are answered.
    if (work.unknowns.length && work.currentState === 'REQUIREMENTS_REVIEW') {
      work = transition(work, 'NEEDS_CLARIFICATION');
    }
    this.ctx.store.saveWork(work);
    this.render(work.id);
    return work;
  }

  approveRequirements(
    idOrAlias: string,
    revisionHash: string,
    actorId: string,
    presence = 'engine-api',
  ): { work: WorkPackage; decision: Decision } {
    let work = this.ctx.store.getWork(idOrAlias);
    if (work.currentState !== 'REQUIREMENTS_REVIEW' && work.currentState !== 'CHANGES_REQUESTED') {
      // allow from NEEDS_CLARIFICATION only after edit moved it
      throw err('E_INVALID_TRANSITION', `Cannot approve requirements from ${work.currentState}`);
    }
    const confirmed = work.acceptanceCriteria.filter((c) => c.status === 'confirmed');
    if (confirmed.length === 0) {
      // auto-confirm proposed if human is approving exact revision with criteria present
      if (work.acceptanceCriteria.length === 0) {
        throw err('E_REQUIREMENTS_INCOMPLETE', 'No acceptance criteria present');
      }
      work = {
        ...work,
        acceptanceCriteria: work.acceptanceCriteria.map((c) => ({ ...c, status: 'confirmed' })),
        unknowns: [],
        updatedAt: now(),
      };
    }
    if (work.unknowns.length > 0) {
      throw err('E_REQUIREMENTS_INCOMPLETE', `Unresolved unknowns block approval: ${work.unknowns.join('; ')}`);
    }

    const spec = this.ctx.store.getLatestArtifact(work.id, 'specification');
    if (!spec) throw err('E_NOT_FOUND', 'No specification artifact');
    if (spec.contentHash !== revisionHash) {
      throw err('E_STALE_REVISION', `Expected ${spec.contentHash}, got ${revisionHash}`);
    }

    const decision: Decision = {
      id: createId('dec'),
      workId: work.id,
      gate: 'requirements',
      action: 'approve',
      artifactIds: [spec.id],
      artifactHashes: [spec.contentHash],
      workRevision: work.currentRevision,
      actorId,
      actorType: 'human',
      identityAssurance: 'local-attestation',
      rationale: 'Local attestation — identity not independently verified',
      decidedAt: now(),
      presence,
    };

    work = transition(work, 'REQUIREMENTS_APPROVED');
    this.ctx.store.transaction(() => {
      this.ctx.store.saveDecision(decision);
      this.ctx.store.saveWork(work);
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'requirements.approved',
        payload: { decisionId: decision.id, hash: revisionHash, identityAssurance: 'local-attestation' },
      });
      const eec = this.ctx.store.getLatestEec(work.id)!;
      this.ctx.store.saveEec(
        bumpEecRevision(eec, {
          approvedSpecHash: spec.contentHash,
          approvalDecisionIds: [...eec.approvalDecisionIds, decision.id],
        }),
      );
    });
    this.render(work.id, ['Requirements approved (local attestation)']);
    return { work, decision };
  }

  rejectRequirements(idOrAlias: string, reason: string, actorId: string): WorkPackage {
    let work = this.ctx.store.getWork(idOrAlias);
    const spec = this.ctx.store.getLatestArtifact(work.id, 'specification');
    const decision: Decision = {
      id: createId('dec'),
      workId: work.id,
      gate: 'requirements',
      action: 'reject',
      artifactIds: spec ? [spec.id] : [],
      artifactHashes: spec ? [spec.contentHash] : [],
      workRevision: work.currentRevision,
      actorId,
      actorType: 'human',
      identityAssurance: 'local-attestation',
      rationale: reason,
      decidedAt: now(),
    };
    this.ctx.store.saveDecision(decision);
    work = transition(work, 'ASSESSING');
    this.ctx.store.saveWork(work);
    this.render(work.id, [`Requirements rejected by ${actorId}: ${reason}`]);
    return work;
  }

  async plan(idOrAlias: string): Promise<{
    work: WorkPackage;
    plan: unknown;
    planHash: string;
    packetDir: string;
  }> {
    let work = this.ctx.store.getWork(idOrAlias);
    if (work.currentState === 'PLAN_REVIEW' || work.currentState === 'CHANGES_REQUESTED') {
      work = { ...work, currentState: 'PLANNING', updatedAt: now() };
      this.ctx.store.saveWork(work);
    } else if (work.currentState === 'REQUIREMENTS_APPROVED') {
      work = transition(work, 'PLANNING');
      this.ctx.store.saveWork(work);
    } else if (work.currentState !== 'PLANNING') {
      throw err(
        'E_INVALID_TRANSITION',
        `Cannot plan from ${work.currentState}; requirements must be approved`,
      );
    }

    const specForEvidence = this.ctx.store.getLatestArtifact(work.id, 'specification');
    const projectEvidence = collectProjectEvidence(
      this.ctx.projectRoot,
      `${work.title}\n${specForEvidence ? this.ctx.store.getArtifactContent(specForEvidence.id) : ''}`,
      { store: this.ctx.store },
    );
    let repoContext = JSON.stringify(projectEvidence, null, 2);
    try {
      const info = inspectRepo(this.ctx.projectRoot);
      repoContext = JSON.stringify({ git: info, projectEvidence }, null, 2);
    } catch {
      // projectEvidence alone is enough
    }

    this.checkBudget(work.id);
    const model = getModel(this.ctx.config.models.profiles.analysis?.model ?? 'mock-default');
    const skill = getSkill(this.ctx.factoryRoot, 'core/plan-change');
    const spec = this.ctx.store.getLatestArtifact(work.id, 'specification');
    const specJson = (() => {
      try {
        return spec ? (JSON.parse(this.ctx.store.getArtifactContent(spec.id)) as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    })();
    // Only the approved, human-edited content — not raw model drafts with stale requirement IDs.
    const specText = JSON.stringify(
      { summary: specJson.summary, nonGoals: work.nonGoals, decisionsAndAssumptions: work.assumptions },
      null,
      2,
    );
    const validIds = work.acceptanceCriteria.map((c) => c.id);
    // Evidence for every repository in scope, not just the project repo.
    const extraRepoEvidence = (work.repositories ?? [])
      .map((r) => {
        const ev = collectProjectEvidence(r.path, `${work.title}\n${work.acceptanceCriteria.map((c) => c.statement).join('\n')}`);
        return `REPO ${r.name} (${r.path}):\n${ev.facts.map((f) => `- ${f.text}`).join('\n')}`;
      })
      .join('\n\n');
    // Re-plan: feed back what deterministic analysis found wrong with the previous plan.
    const previousPlan = this.ctx.store.getLatestArtifact(work.id, 'plan');
    const previousProblems = previousPlan
      ? this.analyzeWork(work.id).filter((a) => a.gate === 'plan' && a.severity !== 'LOW')
      : [];
    const feedback = previousProblems.length
      ? `\n\nTHE PREVIOUS PLAN WAS REJECTED BY AUTOMATED ANALYSIS. Fix every one of these:\n${previousProblems.map((p) => `- ${p.severity}: ${p.message}`).join('\n')}`
      : '';
    const result = await this.runAsRole({
      skill,
      model,
      workId: work.id,
      roleId: work.selectedRoles.some((r) => r.id === 'project-manager') || !work.selectedRoles.some((r) => r.id === 'architect')
        ? 'project-manager'
        : 'architect',
      context: `REQUIREMENTS (link every step and test to these IDs):\n${work.acceptanceCriteria.map((c) => `- ${c.id} (${c.priority ?? 'P1'}): ${c.statement}`).join('\n')}\n\nVALID REQUIREMENT IDS: ${validIds.join(', ')}. Use only these; every one needs at least one step, and every P0 at least one test.${feedback}\n\nAPPROVED SPEC CONTEXT:\n${specText}\n\nPROJECT_EVIDENCE:\n${repoContext}${extraRepoEvidence ? `\n\n${extraRepoEvidence}` : ''}\n\nREPOSITORIES IN SCOPE:\n- project (this repo)\n${(work.repositories ?? []).map((r) => `- ${r.name}: ${r.path}`).join('\n')}\nOnly plan changes in these repositories; if another repo is needed, say so under risks.`,
      schemaId: 'plan',
      maxOutputTokens: 4000,
    });
    this.ctx.store.incrementBudget(work.id, 1);

    const planArt = this.saveArtifact({
      workId: work.id,
      type: 'plan',
      content: result.content,
      createdBy: { kind: 'agent', identifier: 'project-manager' },
      parentArtifactIds: spec ? [spec.id] : [],
    });

    if (spec) {
      const edge = createEdge({
        workId: work.id,
        upstreamArtifactId: spec.id,
        upstreamRevisionHash: spec.contentHash,
        downstreamArtifactId: planArt.id,
        downstreamRevisionHash: planArt.contentHash,
        reason: 'specification-to-plan',
        affectedObligationIds: ['obl_plan_approval'],
      });
      this.ctx.store.saveEdge(edge);
    }

    work = transition(work, 'PLAN_REVIEW');
    this.ctx.store.transaction(() => {
      this.ctx.store.saveWork(work);
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'plan.created',
        payload: { planArtifactId: planArt.id, hash: planArt.contentHash },
      });
      const eec = this.ctx.store.getLatestEec(work.id)!;
      this.ctx.store.saveEec(
        bumpEecRevision(eec, {
          artifactRevisionIds: [...eec.artifactRevisionIds, planArt.id],
        }),
      );
    });

    this.render(work.id);

    return { work, plan: result.content, planHash: planArt.contentHash, packetDir: packetPaths(this.ctx.projectRoot, work.id).dir };
  }

  approvePlan(
    idOrAlias: string,
    revisionHash: string,
    actorId: string,
    presence = 'engine-api',
  ): { work: WorkPackage; decision: Decision } {
    let work = this.ctx.store.getWork(idOrAlias);
    if (work.currentState !== 'PLAN_REVIEW') {
      throw err('E_INVALID_TRANSITION', `Cannot approve plan from ${work.currentState}`);
    }
    const plan = this.ctx.store.getLatestArtifact(work.id, 'plan');
    if (!plan) throw err('E_NOT_FOUND', 'No plan artifact');
    if (plan.contentHash !== revisionHash) {
      throw err('E_STALE_REVISION', `Expected ${plan.contentHash}, got ${revisionHash}`);
    }
    const currentSpec = this.ctx.store.getLatestArtifact(work.id, 'specification');
    const reqDecision = this.ctx.store
      .listDecisions(work.id)
      .find(
        (d) =>
          d.gate === 'requirements' &&
          d.action === 'approve' &&
          !d.invalidatedAt &&
          !!currentSpec &&
          d.artifactHashes.includes(currentSpec.contentHash),
      );
    if (!reqDecision) {
      throw err('E_EEC_UNSATISFIED', 'Requirements approval missing or not bound to the current specification');
    }

    const decision: Decision = {
      id: createId('dec'),
      workId: work.id,
      gate: 'plan',
      action: 'approve',
      artifactIds: [plan.id],
      artifactHashes: [plan.contentHash],
      workRevision: work.currentRevision,
      actorId,
      actorType: 'human',
      identityAssurance: 'local-attestation',
      rationale: 'Local attestation — identity not independently verified',
      decidedAt: now(),
      presence,
    };
    work = transition(work, 'PLAN_APPROVED');
    this.ctx.store.transaction(() => {
      this.ctx.store.saveDecision(decision);
      this.ctx.store.saveWork(work);
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'plan.approved',
        payload: { decisionId: decision.id, hash: revisionHash },
      });
      const eec = this.ctx.store.getLatestEec(work.id)!;
      this.ctx.store.saveEec(
        bumpEecRevision(eec, {
          approvedPlanHash: plan.contentHash,
          approvalDecisionIds: [...eec.approvalDecisionIds, decision.id],
        }),
      );
    });
    this.render(work.id, ['Plan approved. Next: open STATUS.md and run execute, then work in the worktree.']);
    return { work, decision };
  }

  rejectPlan(idOrAlias: string, reason: string, actorId: string): WorkPackage {
    let work = this.ctx.store.getWork(idOrAlias);
    const plan = this.ctx.store.getLatestArtifact(work.id, 'plan');
    const decision: Decision = {
      id: createId('dec'),
      workId: work.id,
      gate: 'plan',
      action: 'reject',
      artifactIds: plan ? [plan.id] : [],
      artifactHashes: plan ? [plan.contentHash] : [],
      workRevision: work.currentRevision,
      actorId,
      actorType: 'human',
      identityAssurance: 'local-attestation',
      rationale: reason,
      decidedAt: now(),
    };
    this.ctx.store.saveDecision(decision);
    work = transition(work, 'PLANNING');
    this.ctx.store.saveWork(work);
    this.render(work.id, [`Plan rejected by ${actorId}: ${reason}`]);
    return work;
  }

  applyChangeImpact(
    workId: string,
    changeKind: 'source' | 'requirements' | 'plan' | 'code' | 'tests',
    changedArtifactId: string,
    oldHash: string,
    newHash: string,
  ) {
    const edges = this.ctx.store.listEdges(workId);
    const decisions = this.ctx.store.listDecisions(workId);
    const evidence = this.ctx.store.listEvidence(workId);
    const artifacts = this.ctx.store.listArtifacts(workId);
    // Walk the explicit dependency graph. If a link is missing, impact is unknown: fall back to
    // the conservative per-stage table so nothing downstream can keep a stale approval.
    const impact = graphImpact({ edges, artifacts, decisions, changedArtifactId });
    const conservative = decisionsToInvalidate(decisions, changeKind).map((d) => d.id);
    const decisionIds = new Set(impact.unknown ? [...impact.decisionIds, ...conservative] : impact.decisionIds);
    const toInvalidate = decisions.filter((d) => decisionIds.has(d.id));
    const fallbackObligations =
      changeKind === 'requirements' || changeKind === 'source'
        ? ['obl_requirements_approval', 'obl_plan_approval', 'obl_code_review', 'obl_automated_checks', 'obl_manual_sqa']
        : changeKind === 'plan'
          ? ['obl_plan_approval', 'obl_code_review', 'obl_automated_checks', 'obl_manual_sqa']
          : ['obl_code_review', 'obl_automated_checks', 'obl_dependency_audit', 'obl_manual_sqa', 'obl_final_acceptance'];
    const eec = this.ctx.store.getLatestEec(workId)!;

    const evt = this.ctx.store.appendEvent({
      workId,
      type: 'impact.computed',
      payload: { changeKind, oldHash, newHash, impact, conservativeFallback: impact.unknown },
    });

    const invalidation = buildInvalidation({
      workId,
      eecRevision: eec.revision,
      changeKind,
      changedArtifactId,
      oldRevisionHash: oldHash,
      newRevisionHash: newHash,
      affectedArtifactIds: impact.artifactIds,
      affectedDecisionIds: toInvalidate.map((d) => d.id),
      affectedEvidenceIds:
        changeKind === 'code' || changeKind === 'tests' ? evidence.map((ev) => ev.id) : [],
      affectedObligationIds:
        impact.unknown || impact.obligationIds.length === 0
          ? [...new Set([...impact.obligationIds, ...fallbackObligations])]
          : impact.obligationIds,
      unknown: impact.unknown,
      artifacts,
      decisions,
      evidence,
      triggerEventId: evt.id,
    });

    const saved = this.ctx.store.saveInvalidation(invalidation);
    if (!saved) return { invalidation: null, recovery: null };

    for (const d of toInvalidate) {
      this.ctx.store.saveDecision({
        ...d,
        invalidatedAt: now(),
        invalidationReason: invalidation.rationale,
      });
    }

    // Mark obligations stale on new EEC revision
    const staleIds = new Set(invalidation.affectedObligationIds);
    const nextEec = bumpEecRevision(eec, {
      obligations: eec.obligations.map((o) =>
        staleIds.has(o.id) ? { ...o, status: 'stale' as const } : o,
      ),
      approvedPlanHash:
        changeKind === 'requirements' || changeKind === 'source' ? undefined : eec.approvedPlanHash,
      approvedSpecHash: changeKind === 'source' ? undefined : eec.approvedSpecHash,
    });
    this.ctx.store.saveEec(nextEec);

    const recovery = buildRecoveryPlan({
      workId,
      eecRevision: nextEec.revision,
      changeKind,
      changedArtifactId,
      oldRevisionHash: oldHash,
      newRevisionHash: newHash,
      affectedArtifactIds: invalidation.affectedArtifactIds,
      affectedDecisionIds: invalidation.affectedDecisionIds,
      affectedEvidenceIds: invalidation.affectedEvidenceIds,
      affectedObligationIds: invalidation.affectedObligationIds,
      unknown: impact.unknown,
      artifacts,
      decisions,
      evidence,
      triggerEventId: evt.id,
      invalidationId: invalidation.id,
    });
    this.ctx.store.saveRecoveryPlan(recovery);
    return { invalidation, recovery };
  }

  contractShow(idOrAlias: string) {
    const work = this.ctx.store.getWork(idOrAlias);
    const eec = this.ctx.store.getLatestEec(work.id);
    if (!eec) throw err('E_NOT_FOUND', 'No EEC for work item');
    const decisions = this.ctx.store.listDecisions(work.id);
    const evidence = this.ctx.store.listEvidence(work.id);
    const evaluated = evaluateEec({
      work,
      obligations: eec.obligations,
      decisions,
      evidence,
      approvedSpecHash: eec.approvedSpecHash,
      approvedPlanHash: eec.approvedPlanHash,
      currentSpecHash: this.ctx.store.getLatestArtifact(work.id, 'specification')?.contentHash,
      currentPlanHash: this.ctx.store.getLatestArtifact(work.id, 'plan')?.contentHash,
      currentCommit: this.currentCommit(work.id),
      baseCommit: this.changeCommits(work.id).base,
      dependencyChanges: (() => {
        const repos = this.repoStates(work.id);
        if (!repos.length || changeSetId(repos) === baseSetId(repos)) return [];
        return this.factsFor(work.id, repos).map((f) => ({
          repo: f.repo,
          names: [...f.dependencies.added, ...f.dependencies.changed].map((d) => d.name),
        }));
      })(),
      coverage: this.traceFor(work.id)
        .filter((t) => t.status)
        .map((t) => ({ requirementId: t.requirementId, priority: t.priority, status: t.status! })),
    });
    return { work, eec, evaluated };
  }

  /** Deterministic PASS / CONCERNS / FAIL for final acceptance (waivers recorded separately). */
  gateDecision(idOrAlias: string, alsoExclude: string[] = []) {
    const shown = this.contractShow(idOrAlias);
    const decisions = this.ctx.store.listDecisions(shown.work.id);
    return computeGateDecision(shown.evaluated.obligations, decisions, {
      exclude: ['obl_final_acceptance', ...alsoExclude],
      currentCommit: this.currentCommit(shown.work.id),
    });
  }

  contractValidate(idOrAlias: string) {
    const shown = this.contractShow(idOrAlias);
    // For R0, only enforce source/requirements/plan obligations before IMPLEMENTING
    const r0Ids = new Set([
      'obl_source',
      'obl_requirements_approval',
      'obl_acceptance_criteria',
      'obl_plan_approval',
    ]);
    const relevant = shown.evaluated.obligations.filter((o) => {
      if (['PLAN_APPROVED', 'REQUIREMENTS_APPROVED', 'PLAN_REVIEW', 'REQUIREMENTS_REVIEW'].includes(shown.work.currentState)) {
        return r0Ids.has(o.id);
      }
      return o.required;
    });
    const blockers = relevant
      .filter((o) => o.required && !['satisfied', 'waived-with-authority'].includes(o.derivedStatus))
      .map((o) => `${o.id}: ${o.derivedStatus}`);
    if (
      shown.work.currentState === 'PLAN_APPROVED' &&
      blockers.some((b) => b.startsWith('obl_plan_approval') || b.startsWith('obl_requirements'))
    ) {
      throw err('E_EEC_UNSATISFIED', blockers.join('; '));
    }
    if (shown.work.currentState === 'ACCEPTED' && blockers.length) {
      throw err('E_EEC_UNSATISFIED', blockers.join('; '));
    }
    return { ok: blockers.length === 0, blockers, obligations: relevant };
  }

  private currentCommit(workId: string): string | undefined {
    return this.changeCommits(workId).head;
  }

  /** Base and head commit from the latest change report (fail-closed: undefined if unknown). */
  changeCommits(workId: string): { base?: string; head?: string } {
    const change = this.ctx.store.getLatestArtifact(workId, 'change-report');
    if (!change) return {};
    try {
      const content = JSON.parse(this.ctx.store.getArtifactContent(change.id));
      return {
        base: content.baseCommit,
        head: content.headCommit ?? content.commitSha ?? change.relatedCommit,
      };
    } catch {
      return { head: change.relatedCommit };
    }
  }

  impact(idOrAlias: string) {
    const work = this.ctx.store.getWork(idOrAlias);
    return {
      edges: this.ctx.store.listEdges(work.id),
      invalidations: this.ctx.store.listInvalidations(work.id),
      recovery: this.ctx.store.getLatestRecoveryPlan(work.id),
      decisions: this.ctx.store.listDecisions(work.id),
    };
  }

  recoverDryRun(idOrAlias: string) {
    const work = this.ctx.store.getWork(idOrAlias);
    let recovery = this.ctx.store.getLatestRecoveryPlan(work.id);
    if (!recovery) {
      // synthesize from latest invalidation or propose none
      recovery = {
        id: createId('rcv'),
        workId: work.id,
        eecRevision: this.ctx.store.getLatestEec(work.id)?.revision ?? 1,
        triggerInvalidationIds: [],
        requiredStageIds: [],
        retainedArtifactRevisionIds: this.ctx.store.listArtifacts(work.id).map((a) => a.id),
        staleArtifactRevisionIds: [],
        unknownImpactIds: [],
        requiredApprovalGates: [],
        proposedRoleIds: [],
        status: 'proposed',
        createdAt: now(),
      };
    }
    return recovery;
  }

  async recoverApply(idOrAlias: string): Promise<{ work: WorkPackage; actions: string[] }> {
    const recovery = this.recoverDryRun(idOrAlias);
    if (recovery.status === 'blocked' || recovery.unknownImpactIds.length > 0) {
      throw err('E_IMPACT_UNKNOWN', 'Recovery blocked until unknown impact is resolved conservatively');
    }
    let work = this.ctx.store.getWork(idOrAlias);
    const actions: string[] = [];
    if (recovery.requiredApprovalGates.includes('plan')) {
      // regenerate plan if requirements still approved
      const reqOk = this.ctx.store
        .listDecisions(work.id)
        .some((d) => d.gate === 'requirements' && d.action === 'approve' && !d.invalidatedAt);
      if (reqOk) {
        if (work.currentState !== 'REQUIREMENTS_APPROVED' && work.currentState !== 'PLANNING') {
          work = { ...work, currentState: 'REQUIREMENTS_APPROVED', updatedAt: now() };
          this.ctx.store.saveWork(work);
        }
        await this.plan(work.id);
        actions.push('regenerated-plan');
        work = this.ctx.store.getWork(work.id);
      }
    }
    if (recovery.requiredStageIds.includes('AI_REVIEW') || recovery.requiredStageIds.includes('VERIFYING')) {
      // clear stale by requiring re-verify path
      if (['HUMAN_CODE_REVIEW', 'VERIFYING', 'HUMAN_ACCEPTANCE', 'ACCEPTED', 'AI_REVIEW'].includes(work.currentState)) {
        work = { ...work, currentState: 'AI_REVIEW', updatedAt: now(), currentRevision: work.currentRevision + 1 };
        this.ctx.store.saveWork(work);
        actions.push('returned-to-ai-review');
      }
    }
    this.ctx.store.saveRecoveryPlan({ ...recovery, status: 'in-progress' });
    return { work, actions };
  }

  explain(idOrAlias: string) {
    const work = this.ctx.store.getWork(idOrAlias);
    const events = this.ctx.store.listEvents(work.id);
    const last = events[events.length - 1];
    const blockers: string[] = [];
    if (work.currentState === 'NEEDS_CLARIFICATION') {
      blockers.push(...work.unknowns.map((u) => `unknown: ${u}`));
    }
    if (work.currentState === 'REQUIREMENTS_REVIEW') blockers.push('Awaiting requirements approval');
    if (work.currentState === 'PLAN_REVIEW') blockers.push('Awaiting plan approval');
    if (work.currentState === 'HUMAN_CODE_REVIEW') blockers.push('Awaiting human code review attestation');
    if (work.currentState === 'HUMAN_ACCEPTANCE') blockers.push('Awaiting human acceptance');
    const recovery = this.ctx.store.getLatestRecoveryPlan(work.id);
    const next = this.next(work.id);
    return {
      state: work.currentState,
      blockers,
      resumeHint: next.doNow,
      next,
      lastEvent: last,
      recovery,
    };
  }

  next(idOrAlias: string): NextStep {
    const work = this.ctx.store.getWork(idOrAlias);
    const baseBranch =
      (this.ctx.config as { git?: { defaultBaseBranch?: string } }).git?.defaultBaseBranch ??
      'staging';
    return computeNextStep({
      projectRoot: this.ctx.projectRoot,
      work,
      defaultBaseBranch: baseBranch,
    });
  }

  async execute(idOrAlias: string): Promise<{
    work: WorkPackage;
    result: { repos: RepoState[]; worktreePath?: string; branch?: string; baseCommit: string; modelNotes?: unknown };
    packetDir: string;
    openFile: string;
  }> {
    let work = this.ctx.store.getWork(idOrAlias);
    if (work.currentState !== 'PLAN_APPROVED' && work.currentState !== 'CHANGES_REQUESTED') {
      throw err('E_INVALID_TRANSITION', `Cannot execute from ${work.currentState}`);
    }
    const plan = this.ctx.store.getLatestArtifact(work.id, 'plan');
    const spec = this.ctx.store.getLatestArtifact(work.id, 'specification');
    if (!plan || !spec) throw err('E_EEC_UNSATISFIED', 'Approved plan/spec required');
    const planOk = this.ctx.store
      .listDecisions(work.id)
      .some(
        (d) =>
          d.gate === 'plan' &&
          d.action === 'approve' &&
          !d.invalidatedAt &&
          d.artifactHashes.includes(plan.contentHash),
      );
    if (!planOk) throw err('E_STALE_REVISION', 'Current plan is not approved');

    work = transition(work, 'IMPLEMENTING');
    this.ctx.store.saveWork(work);

    let eec = this.ctx.store.getLatestEec(work.id)!;
    if (!eec.obligations.some((o) => o.id === 'obl_implementation')) {
      eec = extendEecForImplementation(eec);
      this.ctx.store.saveEec(eec);
    }

    // Reuse existing worktrees (CHANGES_REQUESTED loop) or create them.
    const existing = this.repoStates(work.id);
    const repos =
      existing.length > 0
        ? observe(existing).repos
        : prepareWorktrees({
            projectRoot: this.ctx.projectRoot,
            work,
            primaryChecks: this.ctx.config.quality.checks,
            primarySetup: this.ctx.config.quality.setup,
          });

    let modelNotes: unknown;
    if (existing.length === 0) {
      const model = getModel(this.ctx.config.models.profiles.implementation?.model ?? 'mock-default');
      const skill = getSkill(this.ctx.factoryRoot, 'core/execute-code-change');
      const implementer =
        work.selectedRoles.find((r) => /-developer$/.test(r.id))?.id ??
        work.selectedRoles.find((r) => r.id === 'database-engineer')?.id ??
        'backend-developer';
      if (this.ctx.config.execution.allowNetwork) {
        throw err('E_UNSAFE_EXECUTION', 'Networked autonomous execution is disabled in R0/R1. Use manual-supervised mode.');
      }
      // Supervised mode: the implementer role only produces guidance; a human/agent writes code.
      modelNotes = (
        await this.runAsRole({
          skill,
          model,
          workId: work.id,
          roleId: implementer,
          context: `SPEC:\n${this.ctx.store.getArtifactContent(spec.id)}\n\nPLAN:\n${this.ctx.store.getArtifactContent(plan.id)}`,
          schemaId: 'implement',
          maxOutputTokens: 4000,
        })
      ).content;
      const changeArt = this.saveChangeSet(work.id, repos, {
        status: 'awaiting-commits',
        summary: 'Worktrees prepared. No code committed yet.',
        modelNotes,
        createdBy: { kind: 'tool', identifier: 'executor' },
        parentArtifactIds: [plan.id],
      });
      this.ctx.store.saveEdge(
        createEdge({
          workId: work.id,
          upstreamArtifactId: plan.id,
          upstreamRevisionHash: plan.contentHash,
          downstreamArtifactId: changeArt.id,
          downstreamRevisionHash: changeArt.contentHash,
          reason: 'plan-to-implementation',
          affectedObligationIds: ['obl_code_review', 'obl_automated_checks', 'obl_manual_sqa'],
        }),
      );
    }
    this.ctx.store.appendEvent({
      workId: work.id,
      type: 'execution.prepared',
      payload: { repos: repos.map((r) => ({ name: r.name, worktreePath: r.worktreePath, base: r.baseCommit })) },
    });

    const primary = repos[0]!;
    this.render(work.id, [
        'Work ONLY in the worktree(s) listed below; follow SPEC.md → Plan.',
        'Commit your changes there, then run: turbine task sync <id>',
        'The task stays in IMPLEMENTING until there is at least one new commit and no uncommitted files.',
      ]);

    return {
      work,
      result: {
        repos,
        worktreePath: primary.worktreePath,
        branch: primary.branch,
        baseCommit: primary.baseCommit,
        modelNotes,
      },
      packetDir: packetPaths(this.ctx.projectRoot, work.id).dir,
      openFile: packetPaths(this.ctx.projectRoot, work.id).executionBrief,
    };
  }

  /**
   * Declare another repository this task changes (e.g. a backend). Only allowed before the
   * plan is approved: adding a repo later is a scope change, so reject the plan first.
   */
  addRepository(idOrAlias: string, input: { path: string; name?: string; checks?: string[]; setup?: string[] }) {
    let work = this.ctx.store.getWork(idOrAlias);
    const allowed: WorkState[] = ['IMPORTED', 'ASSESSING', 'NEEDS_CLARIFICATION', 'REQUIREMENTS_REVIEW', 'REQUIREMENTS_APPROVED', 'PLANNING', 'PLAN_REVIEW'];
    if (!allowed.includes(work.currentState)) {
      throw err(
        'E_INVALID_TRANSITION',
        `Cannot add a repository in ${work.currentState}: it changes the approved scope. Reject the plan (turbine task reject) first.`,
      );
    }
    const root = inspectRepo(resolve(this.ctx.projectRoot, input.path)).root;
    if (root === inspectRepo(this.ctx.projectRoot).root) throw err('E_INVALID_CONFIG', 'That is the project repository itself');
    const name = (input.name ?? basename(root)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const existing = work.repositories ?? [];
    if (existing.some((r) => r.name === name || r.path === root)) throw err('E_INVALID_CONFIG', `Repository ${name} already added`);
    const repo = RepoRefSchema.parse({ name, path: root, checks: input.checks ?? [], setup: input.setup ?? [] });
    work = { ...work, repositories: [...existing, repo], currentRevision: work.currentRevision + 1, updatedAt: now() };
    this.ctx.store.transaction(() => {
      this.ctx.store.saveWork(work);
      this.ctx.store.appendEvent({ workId: work.id, type: 'repository.added', payload: { ...repo } });
    });
    this.render(work.id, [`Repository ${repo.name} added to this task (${repo.path}).`]);
    return { work, repo };
  }

  private latestJson<T = unknown>(workId: string, type: Artifact['type']): { hash: string; content: T } | undefined {
    const art = this.ctx.store.getLatestArtifact(workId, type);
    if (!art) return undefined;
    try {
      return { hash: art.contentHash, content: JSON.parse(this.ctx.store.getArtifactContent(art.id)) as T };
    } catch {
      return undefined;
    }
  }

  /**
   * Git facts for the recorded change set. Live from git while the worktrees exist; once they
   * are removed (e.g. after the PR is merged and the branch deleted) fall back to the facts
   * stored with the change report, so status / gate / documents keep working.
   */
  private factsFor(workId: string, repos: RepoState[]): RepoFacts[] {
    if (repos.every((r) => existsSync(r.worktreePath))) {
      try {
        return computeFacts(repos);
      } catch {
        /* commits no longer reachable: use stored facts */
      }
    }
    return this.latestJson<{ facts?: RepoFacts[] }>(workId, 'change-report')?.content.facts ?? [];
  }

  /** Requirement traceability for the current state (plan links + verified test links + checks). */
  traceFor(workId: string): TraceRow[] {
    const work = this.ctx.store.getWork(workId);
    const plan = this.latestJson(work.id, 'plan');
    const repos = this.repoStates(work.id);
    const implemented = repos.length > 0 && changeSetId(repos) !== baseSetId(repos);
    const facts = implemented ? this.factsFor(work.id, repos) : [];
    const review = this.latestJson<ReviewResult>(work.id, 'review')?.content;
    const cs = implemented ? changeSetId(repos) : undefined;
    // Coverage depends on the quality checks only — not the AI review, human SQA or the
    // dependency audit (which has its own obligation and can fail for pre-existing reasons).
    const current = this.ctx.store
      .listEvidence(work.id)
      .filter((e) => cs && e.commitSha === cs && !['review', 'manual-sqa', 'security'].includes(e.kind));
    const latest = new Map<string, Evidence>();
    for (const e of current.sort((x, y) => x.observedAt.localeCompare(y.observedAt))) latest.set(`${e.kind}|${e.commandOrCheck}`, e);
    const checks = latest.size === 0 ? 'not-run' : [...latest.values()].every((e) => e.result === 'passed') ? 'passed' : 'failed';
    return computeTrace({
      requirements: work.acceptanceCriteria,
      plan: plan ? normalizePlan(plan.content) : undefined,
      facts,
      coverage: review && review.changeSetId === cs ? (review.coverage ?? []) : [],
      checks,
      implemented,
    });
  }

  /** Deterministic consistency analysis across requirements, plan, diff and evidence. */
  analyzeWork(idOrAlias: string): AnalysisFinding[] {
    const work = this.ctx.store.getWork(idOrAlias);
    const plan = this.latestJson(work.id, 'plan');
    const repos = this.repoStates(work.id);
    const implemented = repos.length > 0 && changeSetId(repos) !== baseSetId(repos);
    const spec = this.latestJson(work.id, 'specification');
    const normSpec = spec ? normalizeSpec(spec.content, work.acceptanceCriteria) : undefined;
    return analyze({
      state: work.currentState,
      requirements: work.acceptanceCriteria,
      repos: (work.repositories ?? []).map((r) => r.name),
      missingPlanFiles: plan ? this.missingPlanFiles(work, normalizePlan(plan.content)) : [],
      requestItems: normSpec?.requestItems ?? [],
      requestCoverage: normSpec?.requestCoverage ?? [],
      nonGoals: work.nonGoals,
      unknowns: work.unknowns,
      plan: plan ? normalizePlan(plan.content) : undefined,
      planText: plan ? JSON.stringify(plan.content) : undefined,
      facts: implemented ? this.factsFor(work.id, repos) : [],
      trace: this.traceFor(work.id),
    });
  }

  /**
   * Planned files that do not exist on the base branch. When a sibling with the same stem
   * exists (campaign.entity.ts vs campaign.schema.ts) it is probably the intended file.
   */
  private missingPlanFiles(work: WorkPackage, plan: ReturnType<typeof normalizePlan>) {
    const roots = new Map<string, string>([['', this.ctx.projectRoot]]);
    for (const r of work.repositories ?? []) roots.set(r.name, r.path);
    const out: Array<{ file: string; suggestion?: string; dirExists: boolean }> = [];
    const seen = new Set<string>();
    for (const f of plan.steps.flatMap((s) => s.files)) {
      if (seen.has(f)) continue;
      seen.add(f);
      const m = f.match(/^([a-z0-9][a-z0-9-]*):(.+)$/i);
      const repo = m && roots.has(m[1]!) ? m[1]! : '';
      const rel = (repo ? m![2]! : f).trim();
      if (!rel || rel.endsWith('/') || !/\.[a-z0-9]+$/i.test(rel)) continue; // folders / vague entries
      const abs = join(roots.get(repo)!, rel);
      if (existsSync(abs)) continue;
      const dir = join(abs, '..');
      let suggestion: string | undefined;
      if (existsSync(dir)) {
        const stem = basename(rel).split('.')[0]!.toLowerCase();
        const sibling = readdirSync(dir).find((x) => x.toLowerCase().split('.')[0] === stem);
        if (sibling) suggestion = `${repo ? `${repo}:` : ''}${join(rel, '..', sibling)}`;
      }
      out.push({ file: f, suggestion, dirExists: existsSync(dir) });
    }
    return out;
  }

  lintWork(idOrAlias: string): LintIssue[] {
    const work = this.ctx.store.getWork(idOrAlias);
    return lintPacket(packetPaths(this.ctx.projectRoot, work.id), {
      track: trackFor(work),
      requirementIds: work.acceptanceCriteria.map((c) => c.id),
    });
  }

  /** Rebuild STATUS.md, SPEC.md, REVIEW.md and evidence/ from the store. Safe to call often. */
  render(workId: string, notes: string[] = []): void {
    const work = this.ctx.store.getWork(workId);
    const paths = packetPaths(this.ctx.projectRoot, work.id);
    const source = this.latestJson<{ text?: string }>(work.id, 'source');
    const assessment = this.latestJson(work.id, 'assessment');
    const spec = this.latestJson(work.id, 'specification');
    const plan = this.latestJson(work.id, 'plan');
    const review = this.latestJson<ReviewResult>(work.id, 'review');
    const report = this.latestJson<{ changeSetId?: string; runs?: CheckRun[] }>(work.id, 'test-report');
    const repos = this.repoStates(work.id);
    const implemented = repos.length > 0 && changeSetId(repos) !== baseSetId(repos);
    const cs = repos.length ? changeSetId(repos) : undefined;
    const changeFacts = implemented ? this.factsFor(work.id, repos) : [];
    let gate: PacketData['gate'];
    try {
      gate = implemented ? this.gateDecision(work.id) : undefined;
    } catch {
      gate = undefined;
    }
    // Raw data goes to evidence/, never inline.
    const evidence: Array<[string, unknown]> = [
      ['assessment.json', assessment?.content],
      ['spec.json', spec?.content],
      ['plan.json', plan?.content],
      ['change.json', implemented ? { repos, facts: changeFacts } : undefined],
      ['review.json', review?.content],
      ['checks.json', report?.content],
    ];
    const evidenceFiles: string[] = [];
    for (const [name, content] of evidence) {
      if (content === undefined) continue;
      writeFile(join(paths.evidenceDir, name), JSON.stringify(content, null, 2));
      evidenceFiles.push(name);
    }
    const data: PacketData = {
      projectRoot: this.ctx.projectRoot,
      work,
      track: trackFor(work),
      next: computeNextStep({ projectRoot: this.ctx.projectRoot, work }),
      notes,
      sourceText: source?.content.text ?? work.objective,
      facts: normalizeAssessment(assessment?.content).facts,
      spec: spec ? { hash: spec.hash, data: normalizeSpec(spec.content, work.acceptanceCriteria) } : undefined,
      plan: plan ? { hash: plan.hash, data: normalizePlan(plan.content) } : undefined,
      repos,
      changeSetId: cs,
      implemented,
      changeFacts,
      review: review?.content,
      runs: report && report.content.changeSetId === cs ? report.content.runs : undefined,
      decisions: this.ctx.store.listDecisions(work.id),
      gate,
      trace: this.traceFor(work.id),
      analysis: this.analyzeWork(work.id),
      evidenceFiles,
    };
    const glossary = join(this.ctx.projectRoot, '.turbine', 'GLOSSARY.md');
    if (!existsSync(glossary)) writeFile(glossary, GLOSSARY);
    renderPacket(data);
  }

  /**
   * Re-run role selection with new evidence. The profile never goes down: the current
   * profile and any human minimum are passed as the floor. Records why.
   */
  reselectRoles(
    work: WorkPackage,
    reason: string,
    evidence: { failedChecks?: string[]; dependenciesAdded?: string[] },
  ): WorkPackage {
    const result = selectRoles({
      work,
      forceProfile: maxProfile(work.risk.profile, work.risk.minimum),
      failedChecks: evidence.failedChecks,
      observed: { dependenciesAdded: evidence.dependenciesAdded },
    });
    // Keep every previously selected role: removing a role after evidence must not drop its review.
    const kept = work.selectedRoles.filter((r) => !result.roles.some((x) => x.id === r.id));
    const next: WorkPackage = {
      ...work,
      selectedRoles: [...result.roles, ...kept],
      risk: {
        profile: result.profile,
        reasons: [...new Set([...work.risk.reasons, ...result.hardTriggers, ...result.softTriggers])],
        minimum: work.risk.minimum,
      },
      updatedAt: now(),
    };
    const added = next.selectedRoles.filter((r) => !work.selectedRoles.some((x) => x.id === r.id)).map((r) => r.id);
    this.ctx.store.transaction(() => {
      this.ctx.store.saveWork(next);
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'role.selected',
        payload: { reason, evidence, profile: result.profile, from: work.risk.profile, added, explanation: result.explanation },
      });
    });
    return next;
  }

  /** Raise (never lower) the task's risk profile. Anyone may raise; downgrades are disabled. */
  raiseRisk(idOrAlias: string, profile: RiskProfile, reason: string): WorkPackage {
    const work = this.ctx.store.getWork(idOrAlias);
    if (maxProfile(work.risk.profile, profile) === work.risk.profile && profile !== work.risk.profile) {
      throw err('E_INVALID_CONFIG', `Cannot lower risk from ${work.risk.profile} to ${profile}: downgrades are disabled`);
    }
    const raised = { ...work, risk: { ...work.risk, minimum: maxProfile(work.risk.minimum, profile) } };
    const next = this.reselectRoles(raised, `raised by human: ${reason}`, {});
    this.render(next.id, [`Risk raised to ${next.risk.profile}: ${reason}`]);
    return next;
  }

  private auditCommand(worktree: string): string | undefined {
    const setting = this.ctx.config.quality.dependencyAudit;
    if (setting === 'off') return undefined;
    if (setting !== 'auto') return setting;
    if (existsSync(join(worktree, 'pnpm-lock.yaml'))) return 'pnpm audit --audit-level high';
    if (existsSync(join(worktree, 'package-lock.json'))) return 'npm audit --audit-level=high';
    if (existsSync(join(worktree, 'yarn.lock'))) return 'yarn audit --level high';
    return undefined;
  }

  /** Repo states from the latest change report (legacy single-repo reports are upgraded). */
  repoStates(workId: string): RepoState[] {
    const change = this.ctx.store.getLatestArtifact(workId, 'change-report');
    if (!change) return [];
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(this.ctx.store.getArtifactContent(change.id));
    } catch {
      return [];
    }
    if (Array.isArray(content.repos)) return content.repos as RepoState[];
    const wt = String(content.worktreePath ?? '');
    if (!wt || !content.baseCommit) return [];
    return [
      {
        name: primaryName(this.ctx.projectRoot),
        root: this.ctx.projectRoot,
        worktreePath: wt,
        branch: String(content.branch ?? `turbine/${workId}`),
        baseCommit: String(content.baseCommit),
        headCommit: String(content.headCommit ?? content.commitSha ?? content.baseCommit),
        checks: this.ctx.config.quality.checks,
        setup: this.ctx.config.quality.setup,
        primary: true,
      },
    ];
  }

  private saveChangeSet(
    workId: string,
    repos: RepoState[],
    opts: {
      status: string;
      summary: string;
      modelNotes?: unknown;
      createdBy: Artifact['createdBy'];
      parentArtifactIds?: string[];
    },
  ): Artifact {
    const headCommit = changeSetId(repos);
    const baseCommit = baseSetId(repos);
    const facts = headCommit === baseCommit ? [] : computeFacts(repos);
    const primary = repos[0]!;
    const prevChange = this.ctx.store.getLatestArtifact(workId, 'change-report');
    const saved = this.saveArtifact({
      workId,
      type: 'change-report',
      content: {
        status: opts.status,
        summary: opts.summary,
        baseCommit,
        headCommit,
        worktreePath: primary.worktreePath,
        branch: primary.branch,
        repos,
        facts,
        filesTouched: facts.flatMap((f) => f.files.map((x) => `${f.repo}:${x.path}`)),
        modelNotes: opts.modelNotes,
      },
      createdBy: opts.createdBy,
      parentArtifactIds: opts.parentArtifactIds,
      relatedCommit: headCommit,
    });
    // Each change-report revision derives from the previous one, so lineage stays connected
    // (plan → change r1 → change r2 → review/checks).
    if (prevChange) {
      this.ctx.store.saveEdge(
        createEdge({
          workId,
          upstreamArtifactId: prevChange.id,
          upstreamRevisionHash: prevChange.contentHash,
          downstreamArtifactId: saved.id,
          downstreamRevisionHash: saved.contentHash,
          reason: 'change-revision',
          affectedObligationIds: ['obl_code_review', 'obl_automated_checks', 'obl_manual_sqa'],
        }),
      );
    }
    return saved;
  }

  private writeChangePacket(work: WorkPackage, _repos: RepoState[], status: string): void {
    this.render(work.id, status === 'awaiting-commits' ? [] : ['New commit(s) recorded from git.']);
  }

  /**
   * IMPLEMENTING → AI_REVIEW only when every worktree is clean and at least one repo has a
   * commit past its base. Records the real head commit(s) and deterministic facts.
   */
  captureImplementation(idOrAlias: string): { work: WorkPackage; moved: boolean; reason: string } {
    let work = this.ctx.store.getWork(idOrAlias);
    if (work.currentState !== 'IMPLEMENTING') {
      throw err('E_INVALID_TRANSITION', `Cannot capture implementation from ${work.currentState}`);
    }
    const repos = this.repoStates(work.id);
    if (!repos.length) throw err('E_NOT_FOUND', 'No worktrees recorded; run execute first');
    const seen = observe(repos);
    const say = (reason: string) => {
      this.render(work.id, [reason, 'Commit in the worktree(s), then run: turbine task sync <id>']);
      return { work, moved: false, reason };
    };
    if (seen.uncommitted.length) {
      return say(
        `Uncommitted changes — commit or discard them first: ${seen.uncommitted
          .map((u) => `${u.repo}: ${u.paths.slice(0, 5).join(', ')}${u.paths.length > 5 ? ', …' : ''}`)
          .join('; ')}`,
      );
    }
    if (changeSetId(seen.repos) === baseSetId(seen.repos)) {
      return say('No new commits yet — the worktree HEAD still equals the base commit.');
    }
    // Observed evidence can raise risk: new dependencies bring in a security review + audit.
    const added = computeFacts(seen.repos).flatMap((f) => f.dependencies.added.map((d) => d.name));
    if (added.length) work = this.reselectRoles(work, 'observed-new-dependency', { dependenciesAdded: added });
    const prev = this.ctx.store.getLatestArtifact(work.id, 'change-report');
    this.saveChangeSet(work.id, seen.repos, {
      status: 'committed',
      summary: 'Implementation committed in the worktree(s).',
      createdBy: { kind: 'tool', identifier: 'git' },
      parentArtifactIds: prev ? [prev.id] : [],
    });
    work = transition(work, 'AI_REVIEW');
    this.ctx.store.transaction(() => {
      this.ctx.store.saveWork(work);
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'implementation.captured',
        payload: { changeSetId: changeSetId(seen.repos), repos: seen.repos.map((r) => `${r.name}@${r.headCommit}`) },
      });
    });
    this.writeChangePacket(work, seen.repos, 'committed');
    return { work, moved: true, reason: 'Implementation captured' };
  }

  /**
   * After implementation, detect new commits in any worktree. A changed head is a code
   * change: review, checks and SQA bound to the old commit become stale (via markCommitChanged).
   */
  refreshHeads(idOrAlias: string): { changed: boolean; work: WorkPackage } {
    const work = this.ctx.store.getWork(idOrAlias);
    const watched: WorkState[] = ['AI_REVIEW', 'HUMAN_CODE_REVIEW', 'VERIFYING', 'HUMAN_ACCEPTANCE', 'ACCEPTED'];
    if (!watched.includes(work.currentState)) return { changed: false, work };
    const repos = this.repoStates(work.id);
    if (!repos.length || repos.some((r) => !existsSync(r.worktreePath))) return { changed: false, work };
    const seen = observe(repos).repos;
    if (changeSetId(seen) === changeSetId(repos)) return { changed: false, work };
    return { changed: true, work: this.recordNewHeads(work.id, seen) };
  }

  /** True when the latest AI review was run on the change set currently under review. */
  aiReviewIsCurrent(workId: string): boolean {
    const repos = this.repoStates(workId);
    if (!repos.length) return false;
    const review = this.latestJson<{ changeSetId?: string }>(workId, 'review');
    return review?.content.changeSetId === changeSetId(repos);
  }

  /** Uncommitted files in any worktree (approving code with uncommitted work is refused). */
  uncommitted(workId: string): Array<{ repo: string; paths: string[] }> {
    const repos = this.repoStates(workId).filter((r) => existsSync(r.worktreePath));
    return repos.length ? observe(repos).uncommitted : [];
  }

  /**
   * Diff-grounded AI review: one model run per lens over the real diff and git facts, then
   * deterministic triage (findings must cite a changed file; quotes must be in the diff;
   * claims about dependencies/tests are checked against git). Advisory only: it moves the
   * task to HUMAN_CODE_REVIEW and never approves anything.
   */
  async aiReview(idOrAlias: string) {
    let work = this.ctx.store.getWork(idOrAlias);
    if (work.currentState === 'IMPLEMENTING') {
      const captured = this.captureImplementation(work.id);
      if (!captured.moved) throw err('E_EEC_UNSATISFIED', captured.reason);
      work = captured.work;
    }
    if (work.currentState !== 'AI_REVIEW') {
      throw err('E_INVALID_TRANSITION', `Cannot AI-review from ${work.currentState}`);
    }
    const repos = this.repoStates(work.id);
    const changeSet = changeSetId(repos);
    if (!repos.length || changeSet === baseSetId(repos)) {
      throw err('E_EEC_UNSATISFIED', 'Nothing to review: no commits past the base commit');
    }
    const facts = computeFacts(repos);
    const diff = collectDiffs(repos);
    const spec = this.ctx.store.getLatestArtifact(work.id, 'specification');
    const plan = this.ctx.store.getLatestArtifact(work.id, 'plan');
    const model = getModel(this.ctx.config.models.profiles.analysis?.model ?? 'mock-default');
    const skill = getSkill(this.ctx.factoryRoot, 'core/review-change');
    const lenses = selectLenses(work, facts);

    const findings: Finding[] = [];
    const discarded: DiscardedFinding[] = [];
    const claimMismatches: ClaimMismatch[] = [];
    const summaries: Array<{ lens: Lens; summary: string }> = [];
    const coverage: CoverageLink[] = [];
    for (const lens of lenses) {
      this.checkBudget(work.id);
      const result = await this.runAsRole({
        skill,
        model,
        workId: work.id,
        roleId: lens === 'security' ? 'security-reviewer' : 'code-reviewer',
        context: [
          LENS_INSTRUCTIONS[lens],
          REVIEW_OUTPUT_CONTRACT,
          `REQUIREMENTS:\n${work.acceptanceCriteria.map((c) => `- ${c.id} (${c.priority ?? 'P1'}): ${c.statement}`).join('\n')}`,
          `SPEC:\n${spec ? this.ctx.store.getArtifactContent(spec.id).slice(0, 6000) : '(none)'}`,
          `PLAN:\n${plan ? this.ctx.store.getArtifactContent(plan.id).slice(0, 4000) : '(none)'}`,
          `FACTS (from git):\n${factsBlock(facts)}`,
          `DIFF:\n${diff.text}`,
        ].join('\n\n'),
        schemaId: 'review',
        maxOutputTokens: 3000,
      });
      this.ctx.store.incrementBudget(work.id, 1);
      const t = triage({ lens, raw: result.content, facts, diffText: diff.text, startIndex: findings.length });
      findings.push(...t.findings);
      discarded.push(...t.discarded);
      for (const m of crossCheckClaims(result.content, facts)) {
        if (!claimMismatches.some((x) => x.claim === m.claim)) claimMismatches.push(m);
      }
      if (lens === 'tests') {
        const cov = validateCoverage(result.content, facts, work.acceptanceCriteria.map((c) => c.id));
        coverage.push(...cov.links);
        discarded.push(...cov.rejected);
      }
      const summary = (result.content as { summary?: unknown })?.summary;
      if (typeof summary === 'string' && summary.trim()) summaries.push({ lens, summary: summary.trim().slice(0, 400) });
    }
    const review: ReviewResult = {
      changeSetId: changeSet,
      lenses,
      findings,
      discarded,
      claimMismatches,
      summaries,
      truncatedRepos: diff.truncated,
      coverage,
      disposition: disposition(findings, claimMismatches),
    };

    const change = this.ctx.store.getLatestArtifact(work.id, 'change-report');
    const reviewArt = this.saveArtifact({
      workId: work.id,
      type: 'review',
      content: review,
      createdBy: { kind: 'agent', identifier: 'code-reviewer' },
      parentArtifactIds: change ? [change.id] : [],
      relatedCommit: changeSet,
    });
    if (change) {
      this.ctx.store.saveEdge(
        createEdge({
          workId: work.id,
          upstreamArtifactId: change.id,
          upstreamRevisionHash: change.contentHash,
          downstreamArtifactId: reviewArt.id,
          downstreamRevisionHash: reviewArt.contentHash,
          reason: 'change-to-review',
          affectedObligationIds: ['obl_code_review'],
        }),
      );
    }
    const evidence: Evidence = {
      id: createId('ev'),
      workId: work.id,
      kind: 'review',
      result: review.disposition === 'no-blocking-findings' ? 'passed' : 'failed',
      commitSha: changeSet,
      observedAt: now(),
      logArtifactId: reviewArt.id,
      limitations: ['AI review is advisory; a human code review is still required'],
    };
    work = transition(work, 'HUMAN_CODE_REVIEW');
    this.ctx.store.transaction(() => {
      this.ctx.store.saveEvidence(evidence);
      this.ctx.store.saveWork(work);
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'review.completed',
        payload: {
          reviewArtifactId: reviewArt.id,
          mode: 'ai',
          disposition: review.disposition,
          kept: findings.length,
          discarded: discarded.length,
          claimMismatches: claimMismatches.length,
        },
      });
    });
    this.render(work.id, [
        `AI review: ${review.disposition} (${findings.length} finding(s) kept, ${discarded.length} discarded as unverifiable).`,
        'Read REVIEW.md sections 1–3 and the diff',
        'Then a human runs, in their own terminal: turbine task approve <id>',
      ]);
    return {
      work,
      review,
      packetDir: packetPaths(this.ctx.projectRoot, work.id).dir,
      openFile: packetPaths(this.ctx.projectRoot, work.id).review,
    };
  }

  /** Throws unless `expected` (full sha or >=7-char prefix) names the commit currently under review. */
  private assertCurrentCommit(workId: string, expected: string | undefined, gate: string): string {
    const head = this.currentCommit(workId);
    if (!head) throw err('E_EEC_UNSATISFIED', `No implementation commit recorded; cannot approve ${gate}`);
    const e = (expected ?? '').trim();
    if (e.length < 7 || !head.startsWith(e)) {
      throw err(
        'E_STALE_REVISION',
        `${gate} approval must name the commit under review (${head.slice(0, 8)}); got "${e || '(none)'}"`,
      );
    }
    return head;
  }

  humanReview(
    idOrAlias: string,
    actorId: string,
    action: 'approve' | 'request-changes',
    reason?: string,
    opts: { commit?: string; presence?: string } = {},
  ) {
    let work = this.ctx.store.getWork(idOrAlias);
    if (work.currentState !== 'HUMAN_CODE_REVIEW') {
      throw err('E_INVALID_TRANSITION', `Cannot human-review from ${work.currentState}`);
    }
    if (action === 'approve') this.assertCurrentCommit(work.id, opts.commit, 'code-review');
    const change = this.ctx.store.getLatestArtifact(work.id, 'change-report');
    const decision: Decision = {
      id: createId('dec'),
      workId: work.id,
      gate: 'code-review',
      action: action === 'approve' ? 'approve' : 'request-changes',
      artifactIds: change ? [change.id] : [],
      artifactHashes: change ? [change.contentHash] : [],
      workRevision: work.currentRevision,
      commitSha: this.currentCommit(work.id),
      presence: opts.presence ?? 'engine-api',
      actorId,
      actorType: 'human',
      identityAssurance: 'local-attestation',
      rationale: reason ?? 'Local attestation — identity not independently verified',
      decidedAt: now(),
    };
    this.ctx.store.saveDecision(decision);
    if (action === 'approve') {
      work = transition(work, 'VERIFYING');
    } else {
      work = transition(work, 'CHANGES_REQUESTED');
    }
    this.ctx.store.saveWork(work);
    this.render(work.id, action === 'approve'
          ? ['Human review approved. Next: turbine task sync <id> (runs verify)']
          : ['Changes requested — fix in the worktree, commit, then: turbine task sync <id>']);
    return { work, decision };
  }

  /**
   * Run every configured setup command and quality check in each task worktree, at the
   * commit under review. Each check is its own evidence. Nothing is ever recorded as passed
   * unless it ran and exited 0; with no checks configured, verification is blocked.
   */
  async verify(idOrAlias: string) {
    let work = this.ctx.store.getWork(idOrAlias);
    if (work.currentState !== 'VERIFYING') {
      throw err('E_INVALID_TRANSITION', `Cannot verify from ${work.currentState}`);
    }
    const repos = this.repoStates(work.id);
    if (!repos.length) throw err('E_NOT_FOUND', 'No worktrees recorded for this task');
    // Checks come from current config for the project repo, and from the task for extra repos.
    const plan = repos.map((r) => ({
      repo: r,
      setup: r.primary ? this.ctx.config.quality.setup : r.setup,
      checks: r.primary ? this.ctx.config.quality.checks : r.checks,
    }));
    if (!plan[0]!.checks.length) {
      throw err(
        'E_INVALID_CONFIG',
        'No quality checks configured, so there is nothing to verify. Add commands to quality.checks in ' +
          '.turbine/project.yaml (e.g. "npm run lint", "npm run typecheck", "npm test", "npm run build"), ' +
          'and quality.setup if the worktree needs dependencies installed (e.g. "npm ci").',
      );
    }
    const missing = plan.filter((p) => !p.repo.primary && !p.checks.length).map((p) => p.repo.name);
    if (missing.length) {
      throw err('E_INVALID_CONFIG', `No checks configured for repo(s): ${missing.join(', ')}. Use: turbine task repo add … --check "<cmd>"`);
    }
    const dirty = this.uncommitted(work.id);
    if (dirty.length) {
      throw err('E_EVIDENCE_STALE', `Uncommitted changes in worktree(s): ${dirty.map((d) => d.repo).join(', ')}. Commit them and sync first.`);
    }
    // Capability policy still applies: running checks needs tests.run.
    const { allow, denied } = this.ctx.config.tools;
    if (denied.includes('tests.run') || (allow.length > 0 && !allow.includes('tests.run'))) {
      throw err('E_MISSING_CAPABILITY', 'Capability tests.run is not allowed by tools.allow / tools.denied in project.yaml');
    }
    const commitSha = changeSetId(repos);

    // Make the automated-checks obligation require exactly the kinds that are configured.
    const kinds = [...new Set(plan.flatMap((p) => p.checks.map((c) => inferCheckKind(c))))];
    const eec = this.ctx.store.getLatestEec(work.id)!;
    const obl = eec.obligations.find((o) => o.id === 'obl_automated_checks');
    if (obl && JSON.stringify([...obl.requiredEvidenceKinds].sort()) !== JSON.stringify([...kinds].sort())) {
      this.ctx.store.saveEec(
        bumpEecRevision(eec, {
          obligations: eec.obligations.map((o) => (o.id === 'obl_automated_checks' ? { ...o, requiredEvidenceKinds: kinds } : o)),
        }),
      );
    }

    const timeoutMs = this.ctx.config.quality.timeoutMs;
    const runs: CheckRun[] = [];
    for (const p of plan) {
      let setupFailed = false;
      for (const cmd of p.setup) {
        const run = runCommand({ repo: p.repo.name, command: cmd, cwd: p.repo.worktreePath, phase: 'setup', timeoutMs });
        runs.push(run);
        if (!run.passed) {
          setupFailed = true;
          break;
        }
      }
      for (const cmd of p.checks) {
        if (setupFailed) {
          runs.push({
            repo: p.repo.name, command: cmd, kind: inferCheckKind(cmd), phase: 'check', exitCode: -1,
            passed: false, durationMs: 0, stdoutTail: '', stderrTail: '', error: 'not run: setup failed',
          });
          continue;
        }
        runs.push(runCommand({ repo: p.repo.name, command: cmd, cwd: p.repo.worktreePath, phase: 'check', timeoutMs }));
      }
    }

    // Dependency audit for repos whose dependencies changed (G11). Recorded as security
    // evidence; a failing or impossible audit blocks acceptance (fix, or waive with a reason)
    // but does not send the task back to implementation.
    const auditRuns: CheckRun[] = [];
    const facts = computeFacts(repos);
    for (const p of plan) {
      const f = facts.find((x) => x.repo === p.repo.name);
      const names = f ? [...f.dependencies.added, ...f.dependencies.changed].map((d) => d.name) : [];
      if (!names.length) continue;
      const cmd = this.auditCommand(p.repo.worktreePath);
      if (!cmd) {
        auditRuns.push({
          repo: p.repo.name, command: 'dependency audit', kind: 'security', phase: 'check', exitCode: -1, passed: false,
          durationMs: 0, stdoutTail: '', stderrTail: '',
          error: this.ctx.config.quality.dependencyAudit === 'off' ? 'not run: dependencyAudit is off' : 'not run: no lockfile to audit',
        });
        continue;
      }
      const run = runCommand({ repo: p.repo.name, command: cmd, cwd: p.repo.worktreePath, phase: 'check', timeoutMs });
      auditRuns.push({ ...run, kind: 'security' });
    }
    if (!eec.obligations.some((o) => o.id === 'obl_dependency_audit') && auditRuns.length) {
      const latestEec = this.ctx.store.getLatestEec(work.id)!;
      this.ctx.store.saveEec(
        bumpEecRevision(latestEec, {
          obligations: [
            ...latestEec.obligations,
            { id: 'obl_dependency_audit', kind: 'security', acceptanceCriterionIds: [], requiredEvidenceKinds: ['security'], policyRuleIds: ['new-dependency-audit'], required: true, passRule: 'dependency-audit', dependsOnArtifactIds: [], status: 'unsatisfied' },
          ],
        }),
      );
    }

    const reportArt = this.saveArtifact({
      workId: work.id,
      type: 'test-report',
      content: { changeSetId: commitSha, runs: [...runs, ...auditRuns] },
      createdBy: { kind: 'tool', identifier: 'tests' },
      relatedCommit: commitSha,
    });
    const reportUpstream = this.ctx.store.getLatestArtifact(work.id, 'change-report');
    if (reportUpstream) {
      this.ctx.store.saveEdge(
        createEdge({
          workId: work.id,
          upstreamArtifactId: reportUpstream.id,
          upstreamRevisionHash: reportUpstream.contentHash,
          downstreamArtifactId: reportArt.id,
          downstreamRevisionHash: reportArt.contentHash,
          reason: 'change-to-checks',
          affectedObligationIds: ['obl_automated_checks', 'obl_dependency_audit'],
        }),
      );
    }
    const evidence: Evidence[] = [...runs, ...auditRuns]
      .filter((r) => r.phase === 'check')
      .map((r) => ({
        id: createId('ev'),
        workId: work.id,
        kind: r.kind,
        commandOrCheck: checkLabel(r.repo, r.command),
        exitCode: r.exitCode,
        result: r.error?.startsWith('not run') ? 'not-run' : r.passed ? 'passed' : 'failed',
        commitSha,
        environment: `${process.platform} node ${process.version}`,
        observedAt: now(),
        logArtifactId: reportArt.id,
        limitations: r.error ? [r.error] : [],
      }));
    this.ctx.store.transaction(() => {
      for (const e of evidence) this.ctx.store.saveEvidence(e);
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'evidence.recorded',
        payload: { changeSetId: commitSha, results: evidence.map((e) => `${e.commandOrCheck}=${e.result}`) },
      });
    });

    const failedRuns = runs.filter((r) => !r.passed);

    if (failedRuns.length) {
      work = this.reselectRoles(work, 'failure-informed', { failedChecks: failedRuns.map((r) => `${r.kind} ${r.command}`) });
      const roles = work.selectedRoles;
      work = transition(work, 'CHANGES_REQUESTED');
      this.ctx.store.saveWork(work);
      this.render(work.id, [
          `Verification failed: ${failedRuns.map((r) => `${r.repo}: ${r.command}`).join('; ')} — see REVIEW.md → 4. Checks`,
          'Fix in the worktree, commit, then: turbine task sync <id>',
        ]);
      return { work, evidence, runs, audits: auditRuns, failed: true, roles };
    }

    work = transition(work, 'HUMAN_ACCEPTANCE');
    this.ctx.store.saveWork(work);
    this.render(work.id, [
        'All checks passed at the commit under review (REVIEW.md → 4. Checks).',
        ...auditRuns
          .filter((a) => !a.passed)
          .map((a) => `Dependency audit (${a.repo}) did not pass: ${a.error ?? `exit ${a.exitCode}`} — acceptance is blocked until fixed or waived (obl_dependency_audit).`),
        'Try the change; tick each P0 in REVIEW.md → 5. Acceptance with what you observed,',
        'then a human runs, in their own terminal: turbine task approve <id>',
      ]);
    return { work, evidence, runs, audits: auditRuns, failed: false };
  }

  accept(
    idOrAlias: string,
    actorId: string,
    sqaNotes: { expected: string; actual: string; result: 'passed' | 'failed' },
    opts: { commit?: string; presence?: string } = {},
  ) {
    let work = this.ctx.store.getWork(idOrAlias);
    if (work.currentState !== 'HUMAN_ACCEPTANCE') {
      throw err('E_INVALID_TRANSITION', `Cannot accept from ${work.currentState}`);
    }
    if (sqaNotes.result === 'passed') this.assertCurrentCommit(work.id, opts.commit, 'acceptance');
    if (sqaNotes.result === 'passed' && (!sqaNotes.expected?.trim() || !sqaNotes.actual?.trim())) {
      throw err('E_REQUIREMENTS_INCOMPLETE', 'Acceptance needs both Expected and Actual observations');
    }
    const change = this.ctx.store.getLatestArtifact(work.id, 'change-report');
    const commitSha = this.currentCommit(work.id);

    // Check every other required obligation BEFORE recording anything, so a blocked
    // acceptance leaves no partial approval behind. The SQA obligation is excluded
    // because it is the decision being made right now (commit already verified above).
    let gate: ReturnType<Engine['gateDecision']> | undefined;
    if (sqaNotes.result === 'passed') {
      gate = this.gateDecision(work.id, ['obl_manual_sqa']);
      if (!gate.acceptable) {
        const unwaived = gate.blocking.filter((b) => !gate!.waived.some((w) => w.id === b.id));
        throw err(
          'E_EEC_UNSATISFIED',
          `Gate decision ${gate.decision}: ${unwaived.map((b) => `${b.id} (${b.status}: ${b.reason})`).join('; ')}`,
          { gate },
        );
      }
    }

    const sqaEvidence: Evidence = {
      id: createId('ev'),
      workId: work.id,
      kind: 'manual-sqa',
      result: sqaNotes.result,
      commitSha,
      environment: process.platform,
      observedAt: now(),
      limitations: [],
      reviewerId: actorId,
      commandOrCheck: `expected=${sqaNotes.expected}; actual=${sqaNotes.actual}`,
    };
    const sqaDecision: Decision = {
      id: createId('dec'),
      workId: work.id,
      gate: 'sqa-acceptance',
      action: sqaNotes.result === 'passed' ? 'approve' : 'reject',
      artifactIds: change ? [change.id] : [],
      artifactHashes: change ? [change.contentHash] : [],
      workRevision: work.currentRevision,
      commitSha,
      presence: opts.presence ?? 'engine-api',
      actorId,
      actorType: 'human',
      identityAssurance: 'local-attestation',
      rationale: 'Local attestation — identity not independently verified',
      decidedAt: now(),
    };
    this.ctx.store.transaction(() => {
      this.ctx.store.saveEvidence(sqaEvidence);
      this.ctx.store.saveDecision(sqaDecision);
    });

    if (sqaNotes.result !== 'passed') {
      work = transition(work, 'CHANGES_REQUESTED');
      this.ctx.store.saveWork(work);
      this.render(work.id, ['Acceptance failed — changes requested']);
      return { work, accepted: false };
    }

    // Re-derive with the SQA decision recorded; it must now be satisfied too.
    gate = this.gateDecision(work.id);
    if (!gate.acceptable) {
      throw err('E_EEC_UNSATISFIED', `Gate decision ${gate.decision} after SQA: ${gate.blocking.map((b) => b.id).join(', ')}`, { gate });
    }

    work = transition(work, 'ACCEPTED');
    this.ctx.store.transaction(() => {
      this.ctx.store.saveWork(work);
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'acceptance.decided',
        payload: {
          actorId,
          commitSha,
          gateDecision: gate.decision,
          waivedObligations: gate.waived,
          note: 'ACCEPTED does not mean deployed',
        },
      });
    });
    this.render(work.id, ['Accepted (not deployed). Task complete for R0/R1.']);
    return { work, accepted: true };
  }

  /**
   * MD-first control surface. Sync reads EDITS from the task packet (requirements text,
   * acceptance observations) and advances AI/tool stages. It never records a human
   * decision: Decision blocks in markdown are display-only, because any agent with file
   * access could write "Approved: yes". Humans approve with `turbine task approve` in their
   * own terminal.
   */
  async syncFromMarkdown(
    idOrAlias: string,
    _actorId = 'local-user',
  ): Promise<{ action: string; work: WorkPackage; detail?: unknown }> {
    let work = this.ctx.store.getWork(idOrAlias);
    const paths = packetPaths(this.ctx.projectRoot, work.id);
    const approveHint = `Human approves in their own terminal: turbine task approve ${work.id}`;

    // Any new commit in a worktree after implementation is a code change.
    const refreshed = this.refreshHeads(work.id);
    if (refreshed.changed) {
      work = refreshed.work;
      return {
        action: 'code.changed',
        work,
        detail: {
          hint: 'New commit(s) detected in the worktree. Review, checks and acceptance for the old commit are now stale; the next sync re-runs the AI review.',
        },
      };
    }

    if (work.currentState === 'IMPORTED' || work.currentState === 'ASSESSING') {
      const assessed = await this.assess(work.id);
      return { action: 'assess', work: assessed.work, detail: { packetDir: assessed.packetDir } };
    }

    if (work.currentState === 'NEEDS_CLARIFICATION' || work.currentState === 'REQUIREMENTS_REVIEW') {
      const md = readPacketFile(paths.requirements);
      if (!md) throw err('E_NOT_FOUND', `Missing ${paths.requirements}`);
      const parsed = parseSpecMarkdown(md);
      if (!parsed.hasRequirementsSection) {
        throw err('E_INVALID_CONFIG', `SPEC.md has no "## Requirements" section; restore it (turbine task lint ${work.id})`);
      }
      const criteria = parsed.requirements.length
        ? normalizeRequirements(
            parsed.requirements.map((r) => ({ ...r, status: 'confirmed' })),
          )
        : undefined;
      const decided = parsed.answers.map((a) => `Decided: ${a.answer} (question: ${a.question})`);
      const assumptions = [...parsed.assumptions.filter((x) => !decided.includes(x)), ...decided];
      const sameReqs =
        !criteria ||
        JSON.stringify(criteria.map((c) => [c.id, c.priority, c.kind, c.statement])) ===
          JSON.stringify(work.acceptanceCriteria.map((c) => [c.id, c.priority ?? 'P1', c.kind, c.statement]));
      const shouldEdit =
        !sameReqs ||
        JSON.stringify(parsed.openQuestions) !== JSON.stringify(work.unknowns) ||
        JSON.stringify(assumptions) !== JSON.stringify(work.assumptions) ||
        JSON.stringify(parsed.nonGoals) !== JSON.stringify(work.nonGoals);
      let edited = false;
      if (shouldEdit) {
        const before = this.ctx.store.getLatestArtifact(work.id, 'specification')?.contentHash;
        work = this.editRequirements(work.id, {
          acceptanceCriteria: criteria,
          unknowns: parsed.openQuestions,
          assumptions,
          nonGoals: parsed.nonGoals,
        });
        edited = this.ctx.store.getLatestArtifact(work.id, 'specification')?.contentHash !== before;
      }
      if (work.unknowns.length && work.currentState === 'REQUIREMENTS_REVIEW') {
        work = transition(work, 'NEEDS_CLARIFICATION');
        this.ctx.store.saveWork(work);
      }
      const spec = this.ctx.store.getLatestArtifact(work.id, 'specification');
      this.render(work.id, [
          edited
            ? 'Requirements changed — this is a NEW revision. A human must re-read it before approving.'
            : 'No requirement edits detected.',
          approveHint,
        ]);
      return {
        action: edited ? 'requirements.edit' : 'noop',
        work,
        detail: { openFile: paths.requirements, specHash: spec?.contentHash, hint: approveHint },
      };
    }

    if (work.currentState === 'REQUIREMENTS_APPROVED') {
      const planned = await this.plan(work.id);
      return { action: 'plan', work: planned.work, detail: { planHash: planned.planHash, packetDir: planned.packetDir } };
    }

    if (work.currentState === 'IMPLEMENTING') {
      const captured = this.captureImplementation(work.id);
      return {
        action: captured.moved ? 'implementation.captured' : 'waiting-for-commits',
        work: captured.work,
        detail: { reason: captured.reason },
      };
    }

    if (work.currentState === 'PLAN_APPROVED' || work.currentState === 'CHANGES_REQUESTED') {
      const executed = await this.execute(work.id);
      return {
        action: 'execute',
        work: executed.work,
        detail: { packetDir: executed.packetDir, openFile: executed.openFile, result: executed.result },
      };
    }

    if (work.currentState === 'AI_REVIEW') {
      const reviewed = await this.aiReview(work.id);
      return { action: 'review.ai', work: reviewed.work, detail: { openFile: reviewed.openFile } };
    }

    if (work.currentState === 'VERIFYING') {
      const verified = await this.verify(work.id);
      return { action: 'verify', work: verified.work, detail: verified };
    }

    if (work.currentState === 'HUMAN_CODE_REVIEW' && !this.aiReviewIsCurrent(work.id)) {
      // Tasks stuck at code review with a review for an older commit (pre-fix behaviour).
      work = transition(work, 'AI_REVIEW');
      this.ctx.store.saveWork(work);
      const reviewed = await this.aiReview(work.id);
      return { action: 'review.ai', work: reviewed.work, detail: { openFile: reviewed.openFile, reason: 'AI review was for an older commit' } };
    }

    if (
      work.currentState === 'PLAN_REVIEW' ||
      work.currentState === 'HUMAN_CODE_REVIEW' ||
      work.currentState === 'HUMAN_ACCEPTANCE'
    ) {
      const file =
        work.currentState === 'PLAN_REVIEW'
          ? paths.plan
          : work.currentState === 'HUMAN_CODE_REVIEW'
            ? paths.review
            : paths.acceptance;
      return {
        action: 'awaiting-human',
        work,
        detail: { openFile: file, hint: approveHint },
      };
    }

    this.render(work.id);
    return {
      action: 'status',
      work,
      detail: { openFile: paths.status, state: work.currentState },
    };
  }

  /** What a human is being asked to approve right now (shown before confirmation). */
  pendingApproval(idOrAlias: string): {
    work: WorkPackage;
    gate: 'requirements' | 'plan' | 'code-review' | 'acceptance';
    subject: string;
    confirmToken: string;
    openFile: string;
    notes?: { expected: string; actual: string; result: string };
    missingP0?: string[];
  } {
    const work = this.refreshHeads(idOrAlias).work;
    const paths = packetPaths(this.ctx.projectRoot, work.id);
    const token = (h: string) => h.replace(/^sha256:/, '').slice(0, 8);
    if (work.currentState === 'HUMAN_CODE_REVIEW' || work.currentState === 'HUMAN_ACCEPTANCE') {
      const dirty = this.uncommitted(work.id);
      if (dirty.length) {
        throw err(
          'E_EVIDENCE_STALE',
          `Uncommitted changes in the worktree are not part of what you would approve: ${dirty
            .map((d) => `${d.repo}: ${d.paths.slice(0, 5).join(', ')}`)
            .join('; ')}. Commit or discard them, run sync, then approve.`,
        );
      }
    }
    switch (work.currentState) {
      case 'REQUIREMENTS_REVIEW':
      case 'NEEDS_CLARIFICATION': {
        const spec = this.ctx.store.getLatestArtifact(work.id, 'specification');
        if (!spec) throw err('E_NOT_FOUND', 'No specification artifact');
        const md = readPacketFile(paths.spec);
        if (md) {
          const parsed = parseSpecMarkdown(md);
          const onDisk = JSON.stringify(parsed.requirements.map((r) => [r.id, r.priority, r.statement]));
          const stored = JSON.stringify(work.acceptanceCriteria.map((r) => [r.id, r.priority ?? 'P1', r.statement]));
          if (onDisk !== stored || JSON.stringify(parsed.openQuestions) !== JSON.stringify(work.unknowns)) {
            throw err(
              'E_STALE_REVISION',
              `SPEC.md has edits that are not synced yet, so what you see is not what you would approve. Run: turbine task sync ${work.id}`,
            );
          }
        }
        return { work, gate: 'requirements', subject: spec.contentHash, confirmToken: token(spec.contentHash), openFile: paths.requirements };
      }
      case 'PLAN_REVIEW': {
        const plan = this.ctx.store.getLatestArtifact(work.id, 'plan');
        if (!plan) throw err('E_NOT_FOUND', 'No plan artifact');
        return { work, gate: 'plan', subject: plan.contentHash, confirmToken: token(plan.contentHash), openFile: paths.plan };
      }
      case 'HUMAN_CODE_REVIEW': {
        const head = this.currentCommit(work.id);
        if (!head) throw err('E_EEC_UNSATISFIED', 'No implementation commit recorded');
        if (!this.aiReviewIsCurrent(work.id)) {
          throw err('E_EVIDENCE_STALE', `The AI review is for an older commit. Run: turbine task sync ${work.id} (re-runs the review), then approve.`);
        }
        return { work, gate: 'code-review', subject: head, confirmToken: head.slice(0, 8), openFile: paths.review };
      }
      case 'HUMAN_ACCEPTANCE': {
        const head = this.currentCommit(work.id);
        if (!head) throw err('E_EEC_UNSATISFIED', 'No implementation commit recorded');
        const checks = parseAcceptanceChecklist(readPacketFile(paths.acceptance) ?? '');
        const byId = new Map(checks.map((c) => [c.id, c]));
        const missing = work.acceptanceCriteria
          .filter((r) => (r.priority ?? 'P1') === 'P0')
          .filter((r) => !byId.get(r.id)?.checked || !byId.get(r.id)?.observed)
          .map((r) => r.id);
        const observed = work.acceptanceCriteria
          .map((r) => ({ r, c: byId.get(r.id) }))
          .filter((x) => x.c?.checked && x.c.observed);
        return {
          work,
          gate: 'acceptance',
          subject: head,
          confirmToken: head.slice(0, 8),
          openFile: paths.acceptance,
          notes: {
            expected: work.acceptanceCriteria.map((r) => `${r.id}: ${r.statement}`).join(' | '),
            actual: observed.map((x) => `${x.r.id}: ${x.c!.observed}`).join(' | '),
            result: missing.length ? 'incomplete' : 'passed',
          },
          missingP0: missing,
        };
      }
      default:
        throw err('E_INVALID_TRANSITION', `No human approval is pending in state ${work.currentState}`);
    }
  }

  /** Record a human decision for whatever gate is pending. Callers must establish human presence first. */
  decide(
    idOrAlias: string,
    input: {
      action: 'approve' | 'reject';
      reviewer: string;
      confirmToken: string;
      reason?: string;
      presence: string;
      notes?: { expected: string; actual: string };
    },
  ) {
    const pending = this.pendingApproval(idOrAlias);
    if (input.confirmToken.trim() !== pending.confirmToken) {
      throw err(
        'E_STALE_REVISION',
        `Confirmation "${input.confirmToken}" does not match the ${pending.gate} under review (${pending.confirmToken}). Re-read it and try again.`,
      );
    }
    if (!input.reviewer.trim()) throw err('E_UNTRUSTED_IDENTITY', 'Reviewer name is required');
    const id = pending.work.id;
    const reviewer = input.reviewer.trim();
    if (input.action === 'approve') this.assertDocumentsReady(id, pending.gate, pending.missingP0);
    switch (pending.gate) {
      case 'requirements':
        return input.action === 'approve'
          ? this.approveRequirements(id, pending.subject, reviewer, input.presence)
          : { work: this.rejectRequirements(id, input.reason || 'Rejected', reviewer) };
      case 'plan':
        return input.action === 'approve'
          ? this.approvePlan(id, pending.subject, reviewer, input.presence)
          : { work: this.rejectPlan(id, input.reason || 'Rejected', reviewer) };
      case 'code-review':
        if (input.action === 'approve') this.assertPrApproval(id, pending.subject);
        return this.humanReview(
          id,
          reviewer,
          input.action === 'approve' ? 'approve' : 'request-changes',
          input.reason,
          { commit: pending.subject, presence: input.presence },
        );
      case 'acceptance': {
        if (input.action === 'approve') this.assertPrApproval(id, pending.subject);
        const n = input.notes ?? pending.notes ?? { expected: '', actual: '' };
        return this.accept(
          id,
          reviewer,
          {
            expected: n.expected,
            actual: input.action === 'approve' ? n.actual : n.actual || input.reason || 'Did not match',
            result: input.action === 'approve' ? 'passed' : 'failed',
          },
          { commit: pending.subject, presence: input.presence },
        );
      }
    }
  }

  /** With humanGates.requirePrApproval, every repo's PR must be approved at its current head. */
  private assertPrApproval(workId: string, _changeSetId: string): void {
    if (!this.ctx.config.humanGates.requirePrApproval) return;
    const repos = this.repoStates(workId);
    for (const repo of repos.filter((r) => r.headCommit !== r.baseCommit)) {
      const result = this.prApprovalChecker({
        projectRoot: repo.root,
        branch: repo.branch,
        headCommit: repo.headCommit,
      });
      if (!result.approved) {
        throw err('E_UNTRUSTED_IDENTITY', `GitHub PR approval required (${repo.name}): ${result.detail}`, {
          url: result.url,
        });
      }
    }
  }

  /**
   * Before a human approves: the packet must be structurally sound (lint errors block),
   * the gate must have no CRITICAL analysis findings, and acceptance needs every P0
   * requirement ticked with an observation.
   */
  private assertDocumentsReady(workId: string, gate: string, missingP0?: string[]): void {
    const lintErrors = this.lintWork(workId).filter((i) => i.level === 'error');
    if (lintErrors.length) {
      throw err('E_INVALID_CONFIG', `Task documents are broken: ${lintErrors.map((i) => `${i.file}: ${i.message}`).join('; ')}. Fix them or run sync to regenerate.`);
    }
    const analysisGate = gate === 'acceptance' ? undefined : gate;
    const critical = this.analyzeWork(workId).filter((a) => a.severity === 'CRITICAL' && a.gate === analysisGate);
    if (critical.length) {
      throw err('E_EEC_UNSATISFIED', `CRITICAL problems block this approval: ${critical.map((c) => c.message).join('; ')}`);
    }
    if (gate === 'acceptance' && missingP0?.length) {
      throw err(
        'E_REQUIREMENTS_INCOMPLETE',
        `Tick and describe what you observed for every P0 requirement in REVIEW.md → 5. Acceptance first: ${missingP0.join(', ')}`,
      );
    }
  }

  /**
   * Record a waiver: a named human accepts the risk of one or more unmet obligations,
   * with a reason and an expiry. Waivers never change the derived gate decision.
   */
  waive(
    idOrAlias: string,
    input: { obligationIds: string[]; reason: string; expiresAt: string; reviewer: string; presence: string },
  ): Decision {
    const work = this.ctx.store.getWork(idOrAlias);
    if (!input.obligationIds.length) throw err('E_INVALID_CONFIG', 'Name at least one obligation to waive');
    if (!input.reason.trim()) throw err('E_INVALID_CONFIG', 'A waiver needs a reason');
    const expires = new Date(input.expiresAt);
    if (Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now()) {
      throw err('E_INVALID_CONFIG', 'A waiver needs a future expiry date');
    }
    const eec = this.ctx.store.getLatestEec(work.id);
    const known = new Set(eec?.obligations.map((o) => o.id) ?? []);
    const unknown = input.obligationIds.filter((o) => !known.has(o));
    if (unknown.length) throw err('E_NOT_FOUND', `Unknown obligations: ${unknown.join(', ')}`);
    const decision: Decision = {
      id: createId('dec'),
      workId: work.id,
      gate: 'exception',
      action: 'approve',
      artifactIds: [],
      artifactHashes: [],
      workRevision: work.currentRevision,
      commitSha: this.currentCommit(work.id),
      actorId: input.reviewer,
      actorType: 'human',
      identityAssurance: 'local-attestation',
      rationale: input.reason,
      decidedAt: now(),
      obligationIds: input.obligationIds,
      expiresAt: expires.toISOString(),
      presence: input.presence,
    };
    this.ctx.store.transaction(() => {
      this.ctx.store.saveDecision(decision);
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'waiver.recorded',
        payload: { decisionId: decision.id, obligationIds: input.obligationIds, expiresAt: decision.expiresAt },
      });
    });
    this.render(work.id, [`Waiver by ${input.reviewer} for ${input.obligationIds.join(', ')} until ${decision.expiresAt!.slice(0, 10)}`]);
    return decision;
  }

  /** Manually record a new head commit for the primary repo (legacy / single-repo). */
  markCommitChanged(idOrAlias: string, newCommit: string) {
    const work = this.ctx.store.getWork(idOrAlias);
    const repos = this.repoStates(work.id);
    if (!repos.length) throw err('E_NOT_FOUND', 'No change report; run execute first');
    const resolved = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${newCommit}^{commit}`], {
      cwd: repos[0]!.worktreePath,
      encoding: 'utf8',
    });
    if (resolved.status !== 0) throw err('E_NOT_FOUND', `${newCommit} is not a commit in ${repos[0]!.name}`);
    const sha = resolved.stdout.trim();
    const next = repos.map((r, i) => (i === 0 ? { ...r, headCommit: sha } : r));
    return this.recordNewHeads(work.id, next);
  }

  private recordNewHeads(workId: string, repos: RepoState[]): WorkPackage {
    const prev = this.ctx.store.getLatestArtifact(workId, 'change-report');
    const oldHash = prev?.contentHash ?? 'none';
    const art = this.saveChangeSet(workId, repos, {
      status: 'committed',
      summary: 'New commit(s) detected after implementation.',
      createdBy: { kind: 'tool', identifier: 'git' },
      parentArtifactIds: prev ? [prev.id] : [],
    });
    this.applyChangeImpact(workId, 'code', prev?.id ?? art.id, oldHash, art.contentHash);
    let next = this.ctx.store.getWork(workId);
    // A code change after review re-runs the AI review first (framework §3.2): the human must
    // never be asked to approve code that no reviewer has looked at.
    if (['HUMAN_ACCEPTANCE', 'ACCEPTED', 'VERIFYING', 'HUMAN_CODE_REVIEW'].includes(next.currentState)) {
      next = { ...next, currentState: 'AI_REVIEW', updatedAt: now(), currentRevision: next.currentRevision + 1 };
      this.ctx.store.saveWork(next);
    }
    this.writeChangePacket(next, repos, 'committed');
    return next;
  }

  // helpers for CLI metadata commands
  doctor() {
    const frameworks = listFrameworks(this.ctx.factoryRoot);
    const roles = loadRoles(this.ctx.factoryRoot);
    const skills = loadSkills(this.ctx.factoryRoot);
    const models = listModels();
    return {
      projectRoot: this.ctx.projectRoot,
      factoryRoot: this.ctx.factoryRoot,
      framework: this.ctx.config.framework,
      frameworks,
      roleCount: roles.length,
      skillCount: skills.length,
      models: models.map((m) => ({ id: m.id, provider: m.provider })),
      dbPath: this.ctx.paths.dbPath,
      dbExists: existsSync(this.ctx.paths.dbPath),
    };
  }

  frameworkShow(id: string) {
    const [fid, ver] = id.includes('@') ? id.split('@') : [id, this.ctx.config.framework.version];
    return loadFramework(this.ctx.factoryRoot, fid!, ver!);
  }

  roleShow(id: string) {
    return getRole(this.ctx.factoryRoot, id);
  }

  skillShow(id: string) {
    return getSkill(this.ctx.factoryRoot, id);
  }

  setConfig(key: string, value: string) {
    const cfg = this.ctx.config as any;
    const parts = key.split('.');
    let cur = cfg;
    for (let i = 0; i < parts.length - 1; i += 1) {
      cur = cur[parts[i]!];
      if (cur == null) throw err('E_INVALID_CONFIG', `Unknown config path: ${key}`);
    }
    const last = parts[parts.length - 1]!;
    let parsed: unknown = value;
    if (value === 'true') parsed = true;
    else if (value === 'false') parsed = false;
    else if (!Number.isNaN(Number(value)) && value.trim() !== '') parsed = Number(value);
    cur[last] = parsed;
    saveConfig(this.ctx.paths.configPath, cfg);
    return cfg;
  }

  addModel(provider: string, id: string) {
    if (provider === 'mock') {
      registerModel(createMockModelAdapter(id));
      return { provider, id, mode: 'mock' as const };
    }
    if (provider === 'openai' || provider === 'openai-compatible') {
      registerModel(createOpenAICompatibleAdapter({ id, model: id }));
      // Persist into project config profiles
      this.setConfig('models.profiles.analysis.provider', 'openai-compatible');
      this.setConfig('models.profiles.analysis.model', id);
      this.setConfig('models.profiles.implementation.provider', 'openai-compatible');
      this.setConfig('models.profiles.implementation.model', id);
      return {
        provider: 'openai-compatible',
        id,
        mode: 'real' as const,
        note: 'Requires OPENAI_API_KEY (and optional OPENAI_BASE_URL). Execute remains supervised unless a coding executor is configured.',
      };
    }
    throw err(
      'E_ADAPTER',
      `Unsupported model provider "${provider}". Use mock | openai | openai-compatible`,
    );
  }

  async testModel(id: string) {
    return testModel(id);
  }

  connectJira(siteUrl: string) {
    const cfg = this.ctx.config;
    cfg.inputs.adapters.jira = {
      enabled: true,
      siteUrl,
      credentialRef: 'env:JIRA_API_TOKEN',
    };
    saveConfig(this.ctx.paths.configPath, cfg);
    return cfg.inputs.adapters.jira;
  }
}
