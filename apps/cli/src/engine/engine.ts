import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  contentHash,
  contentHashText,
  createId,
  err,
  LANE_TRIGGER_NAMES,
  policyDecisionSubject,
  RepoRefSchema,
  parseTaskContext,
  type AcceptanceCriterion,
  type ApprovedLanePolicy,
  type Artifact,
  type LaneGate,
  type Decision,
  type Evidence,
  type RiskProfile,
  type RoleRun,
  type TaskContext,
  type UsageMethod,
  type UsageRecord,
  type UsageSummary,
  type WorkPackage,
  type WorkState,
  type WorkType,
} from '@turbine-hall/turbine-contracts';
import {
  assertTransition,
  contextBudgetFor,
  detectHardRiskTriggers,
  detectSoftTriggers,
  getRole,
  listFrameworks,
  loadFramework,
  loadRoles,
  maxProfile,
  selectRoles,
} from '@turbine-hall/turbine-core';
import type { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
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
import { createGitHubAdapter } from '@turbine-hall/turbine-adapter-github';
import { inspectRepo } from '@turbine-hall/turbine-adapter-git';
import {
  githubLinksFromText,
  mirrorLinkedIssues,
  type MirrorAdapters,
  type MirrorRunResult,
} from './issue-mirror.js';
import { hasUncommittedChanges, observeBranch, repoToplevel } from './context/git-read.js';
import { briefConfigOf, syncBriefClaimsToHead } from './context/brief.js';
import { repoHead } from './context/understand.js';
import { refreshTaskContext, requestHash, snapshotHashAt, stalenessOf, type RefreshResult } from './context/task-context.js';
import { MAX_CONTEXT_FILE_BYTES, parseContextFile, readContextFile, renderContextBody, renderContextFile, renderUnavailableFile, type Staleness } from './context/task-render.js';
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
  reviewOutputIsParseable,
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
} from './project-context.js';
import { computeNextStep, CONTEXT_READING_STATES, type NextStep } from './next-step.js';
import {
  packetPaths,
  parseAcceptanceChecklist,
  parseSpecMarkdown,
  readPacketFile,
  writeFile,
  writeFileAtomic,
} from './packet.js';
import { measuredTurbineTokens, summarizeUsage } from './usage.js';
import { policyStatuses, readPolicyFiles, resolvePolicyReviewers, type PolicyStatus } from './lane-policy.js';
import { evaluateLaneEligibility, LANE_GATE_FOR_STATE, type LaneEvaluation, type LaneFacts } from './lane-eligibility.js';
import { evaluateSuspendWhen, policyForReviewPair } from './lane-metrics.js';
import {
  configAllows,
  confirmMergeQueueProtection,
  ensureAcceptedPr,
  landingIncomplete,
  pendingMergeEvaluation,
  refreshLanePr,
  type LanePrTarget,
} from './lane-pr.js';
import {
  defaultSandboxHooks,
  planSandboxMounts,
  preflightSandbox,
  runSandboxedStateMachine,
  type AgentImplementer,
  type ContainerRuntime,
  type PhaseResult,
  type SandboxHooks,
} from '@turbine-hall/turbine-executor';

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

export type LaneFallback = {
  gate: LaneGate;
  reasons: string[];
  evaluationHash: string;
  evaluatedChangeSetId?: string;
  at: string;
};
export type LaneOutcome = {
  status: 'passed' | 'fallback' | 'out-of-lane' | 'retry';
  work: WorkPackage;
  gate: LaneGate;
  reasons: string[];
  policy?: string;
  decision?: Decision;
  evaluatedChangeSetId?: string;
};

const LANE_GATE_LABEL: Record<LaneGate, string> = {
  requirements: 'Requirements',
  plan: 'Plan',
  codeReview: 'Code review',
  acceptance: 'Acceptance',
};

/** Thrown inside the policy-pass transaction to roll it back when a final check fails. */
class LaneIneligible extends Error {}

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
  let prs: Array<{ number: number; url: string; reviewDecision: string; headRefOid: string }>;
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
  /**
   * Optional tool adapters for packet→issue mirroring (tests inject fixture adapters).
   * When unset, live adapters are built from project config + env (still gated by tools policy).
   */
  mirrorAdapters?: MirrorAdapters;
  /**
   * When true, mirroring uses only injected `mirrorAdapters` (no live adapters) and skips
   * adapter enabled / mirrorRepos gates — for offline tests.
   */
  mirrorFixtureMode = false;
  private mirrorJob: Promise<MirrorRunResult | undefined> = Promise.resolve(undefined);
  /** Fixture seam for Part C. Live mode derives owner/repo from origin. */
  lanePrTarget?: LanePrTarget;
  /** Fixture seam for Part D sandboxed-unattended (tests inject hooks + implementer). */
  sandboxHooks?: SandboxHooks;
  sandboxImplementer?: AgentImplementer;
  /** Work ids with an in-flight sandboxed run — blocks concurrent capture/sync publication. */
  private sandboxInFlight = new Set<string>();
  /** Accepted tasks wait here in order; none is dropped when another is accepted before the drain. */
  private pendingLanePrs: Array<() => Promise<void>> = [];
  private lanePrDrain: Promise<void> = Promise.resolve();

  constructor(readonly ctx: EngineContext) {
    ensureDefaultMock();
    configureModelsFromProfiles(this.ctx.config.models.profiles);
  }

  /** Await the latest packet-mirror attempt (tests / sync). */
  async waitForMirror(): Promise<MirrorRunResult | undefined> {
    return this.mirrorJob;
  }

  async waitForLanePr(): Promise<void> {
    const jobs = this.pendingLanePrs;
    this.pendingLanePrs = [];
    const errors: Error[] = [];
    this.lanePrDrain = this.lanePrDrain.then(async () => {
      for (const job of jobs) {
        try {
          await job();
        } catch (e) {
          errors.push(e as Error);
        }
      }
    });
    await this.lanePrDrain;
    if (errors.length) throw errors[0];
  }

  private lanePrAdapter() {
    return this.lanePrTarget?.adapter ?? createGitHubAdapter({ apiBaseUrl: process.env.GITHUB_API_BASE_URL });
  }

  private resolveLanePrTarget(): LanePrTarget | undefined {
    if (this.lanePrTarget) return this.lanePrTarget;
    const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: this.ctx.projectRoot, encoding: 'utf8' });
    if (remote.status !== 0) return undefined;
    const value = remote.stdout.trim().replace(/\.git$/, '');
    const match = value.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
    if (!match) return undefined;
    return {
      adapter: this.lanePrAdapter(),
      owner: match[1]!,
      repo: match[2]!,
      baseBranch: (this.ctx.config as { git?: { defaultBaseBranch?: string } }).git?.defaultBaseBranch ?? 'main',
    };
  }

  /**
   * Who authorized landing the ACCEPTED task, from the recorded acceptance decision only. A policy acceptance is
   * authorized by the exact policy approval it recorded (hash + approval decision); a newer approval of the same
   * name, an edit, or a suspension never substitutes for it, and is not human acceptance either.
   */
  private acceptanceAuthority(workId: string):
    | { kind: 'none' }
    | { kind: 'stale'; reason: string }
    | { kind: 'blocked'; reason: string; decision: Decision }
    | { kind: 'human'; decision: Decision }
    | { kind: 'policy'; decision: Decision; policy: ApprovedLanePolicy } {
    const work = this.ctx.store.getWork(workId);
    if (work.currentState !== 'ACCEPTED') return { kind: 'stale', reason: `task is ${work.currentState}, not ACCEPTED` };
    const decision = this.latestAcceptanceDecision(workId);
    if (!decision) return { kind: 'none' };
    // The acceptance transition adds one revision; anything else means the accepted revision is no longer current.
    if (decision.workRevision + 1 !== work.currentRevision) {
      return { kind: 'stale', reason: `accepted revision ${decision.workRevision + 1} is not the current revision ${work.currentRevision}` };
    }
    if (!decision.commitSha || decision.commitSha !== this.currentCommit(workId)) {
      return { kind: 'stale', reason: 'the accepted commit is not the current commit' };
    }
    if (decision.actorType !== 'policy') return { kind: 'human', decision };
    const blocked = (reason: string) => ({ kind: 'blocked' as const, reason, decision });
    if (!decision.policyId || !decision.policyHash || !decision.policyApprovalDecisionId) {
      return blocked('the policy acceptance does not record which policy approval authorized it');
    }
    let snapshot: ApprovedLanePolicy | null;
    try {
      snapshot = this.ctx.store.getLanePolicy(decision.policyId);
    } catch (e) {
      return blocked(`policy ${decision.policyId} is unreadable: ${(e as Error).message}`);
    }
    if (!snapshot) return blocked(`policy ${decision.policyId} is no longer approved`);
    if (snapshot.status !== 'active') return blocked(`policy ${decision.policyId} is ${snapshot.status}`);
    if (snapshot.contentHash !== decision.policyHash || snapshot.approvedDecisionId !== decision.policyApprovalDecisionId) {
      return blocked(`policy ${decision.policyId} was changed or re-approved after this acceptance`);
    }
    // A pending edit is not yet approved, so the store still matches. The file on disk is what a human would
    // approve next: if it no longer hashes to the accepted policy, this acceptance's terms are in doubt.
    let file: ReturnType<typeof readPolicyFiles>['files'][number] | undefined;
    try {
      file = readPolicyFiles(this.ctx.projectRoot).files.find((entry) => entry.name === decision.policyId);
    } catch (e) {
      return blocked(`policy file ${decision.policyId} is unreadable: ${(e as Error).message}`);
    }
    if (!file || file.hash !== decision.policyHash) {
      return blocked(`policy file ${decision.policyId} was edited or removed after this acceptance (pending edit)`);
    }
    return { kind: 'policy', decision, policy: snapshot };
  }

  /** The newest live sqa-acceptance approval of a task, human or policy. */
  private latestAcceptanceDecision(workId: string): Decision | undefined {
    return this.ctx.store
      .listDecisions(workId)
      .filter((entry) => entry.gate === 'sqa-acceptance' && entry.action === 'approve' && !entry.invalidatedAt)
      .sort((a, b) => a.decidedAt.localeCompare(b.decidedAt) || a.id.localeCompare(b.id))
      .at(-1);
  }

  /** The PR target a policy acceptance was evaluated against; never re-resolved from origin mid-flight. */
  private boundLanePrTarget(workId: string, decisionId: string): LanePrTarget | undefined {
    const bound = this.ctx.store
      .listEvents(workId)
      .filter((event) => event.type === 'lane.acceptance-target-bound' && event.payload.decisionId === decisionId)
      .at(-1);
    const { owner, repo, baseBranch } = (bound?.payload ?? {}) as { owner?: string; repo?: string; baseBranch?: string };
    if (!owner || !repo || !baseBranch) return undefined;
    return { adapter: this.lanePrAdapter(), owner, repo, baseBranch };
  }

  private recordLandingEvent(workId: string, type: string, reason: string, dedupe = false): void {
    if (dedupe) {
      const last = this.ctx.store.listEvents(workId).filter((event) => event.type === type).at(-1);
      if (last?.payload.reason === reason) return;
    }
    this.ctx.store.appendEvent({ workId, type, payload: { reason } });
  }

  /** The single worktree is still exactly at the accepted head; a moved head means the acceptance is stale. */
  private worktreeAtHead(workId: string, headSha: string): boolean {
    const repos = this.repoStates(workId);
    if (repos.length !== 1 || !existsSync(repos[0]!.worktreePath)) return false;
    try {
      return observe(repos).repos[0]?.headCommit === headSha;
    } catch {
      return false;
    }
  }

  private queueAcceptedPr(work: WorkPackage, authority = this.acceptanceAuthority(work.id)): void {
    if (authority.kind === 'none') return;
    if (authority.kind === 'stale') {
      this.recordLandingEvent(work.id, 'lane.pr-automation-discarded', authority.reason);
      return;
    }
    if (authority.kind === 'blocked') {
      this.recordLandingEvent(work.id, 'lane.pr-automation-blocked', authority.reason, true);
      return;
    }
    const policy = authority.kind === 'policy' ? authority.policy : undefined;
    // Human acceptance only opens a PR when the project opted in; a policy path stays strict.
    if (!policy && !configAllows(this.ctx.config.tools, 'pr.create')) {
      this.recordLandingEvent(work.id, 'lane.pr-automation-skipped', 'pr.create is not allowed by project config');
      return;
    }
    const repos = this.repoStates(work.id);
    // A multi-repo change set id is a hash, not a commit; one PR cannot carry it.
    if (repos.length > 1) {
      this.recordLandingEvent(work.id, 'lane.pr-automation-skipped', `PR automation supports one repo; this task changes ${repos.length}`);
      return;
    }
    // A policy acceptance lands on the target its protection was evaluated against; origin is not consulted again.
    const target = policy ? this.boundLanePrTarget(work.id, authority.decision.id) : this.resolveLanePrTarget();
    const headSha = this.currentCommit(work.id);
    if (policy && !target) {
      this.recordLandingEvent(work.id, 'lane.pr-automation-blocked', 'the PR target evaluated for this policy acceptance was not recorded', true);
      return;
    }
    if (!target || !headSha) return;
    const acceptedRevision = work.currentRevision;
    const decisionId = authority.decision.id;
    this.pendingLanePrs.push(async () => {
      // Queued jobs outlive the call that queued them: act only if this exact acceptance is still current.
      const live = this.acceptanceAuthority(work.id);
      const current = this.ctx.store.getWork(work.id);
      if (live.kind === 'blocked') {
        this.recordLandingEvent(work.id, 'lane.pr-automation-blocked', live.reason, true);
        return;
      }
      const stale =
        live.kind === 'none' || live.kind === 'stale'
          ? live.kind === 'stale' ? live.reason : 'no acceptance decision'
          : live.decision.id !== decisionId
            ? 'the acceptance decision was replaced'
            : current.currentRevision !== acceptedRevision
              ? 'the accepted revision is no longer current'
              : this.currentCommit(work.id) !== headSha || !this.worktreeAtHead(work.id, headSha)
                ? 'the accepted head moved'
                : undefined;
      if (stale) {
        this.recordLandingEvent(work.id, 'lane.pr-automation-discarded', stale);
        return;
      }
      try {
        // The gate result is read HERE, after the staleness checks above: a job that waited in the queue must not
        // publish a PASS computed before evidence changed. It is bound to the commit it evaluated.
        const gatePassSha = this.gateDecision(work.id).decision === 'PASS' ? headSha : undefined;
        await ensureAcceptedPr({
          store: this.ctx.store,
          work: current,
          headSha,
          authorizationId: decisionId,
          target,
          tools: this.ctx.config.tools,
          policy: live.kind === 'policy' ? live.policy : undefined,
          gatePassSha,
          // Re-check before every remote write: a suspension mid-flight must not still enqueue.
          assertStillAuthorized: () => {
            const now = this.acceptanceAuthority(work.id);
            if (now.kind === 'blocked') throw err('E_INVALID_CONFIG', now.reason);
            if (now.kind === 'stale') throw err('E_STALE_REVISION', now.reason);
            if (now.kind === 'none' || now.decision.id !== decisionId) {
              throw err('E_STALE_REVISION', 'the acceptance decision no longer authorizes landing');
            }
          },
        });
      } catch (e) {
        this.ctx.store.appendEvent({
          workId: work.id,
          type: 'lane.pr-automation-failed',
          payload: { reason: (e as Error).message },
        });
        throw e;
      }
    });
  }

  /**
   * Durable resume: an ACCEPTED task whose PR work is incomplete is queued again on the next sync. The same head
   * is not enough to call it done: a gate status that never reached GitHub, or a PR closed unmerged, still owes work.
   */
  private resumeAcceptedPr(work: WorkPackage): boolean {
    if (work.currentState !== 'ACCEPTED' || this.repoStates(work.id).length !== 1) return false;
    const authority = this.acceptanceAuthority(work.id);
    if (authority.kind === 'blocked') {
      this.recordLandingEvent(work.id, 'lane.pr-automation-blocked', authority.reason, true);
      return false;
    }
    if (authority.kind !== 'human' && authority.kind !== 'policy') return false;
    const policy = authority.kind === 'policy';
    const head = this.currentCommit(work.id);
    if (!head || (!policy && !configAllows(this.ctx.config.tools, 'pr.create'))) return false;
    // The recorded head can lag the worktree; only the accepted head, still at the worktree, may be landed.
    if (!this.worktreeAtHead(work.id, head)) return false;
    const gatePassSha = this.gateDecision(work.id).decision === 'PASS' ? head : undefined;
    const record = this.ctx.store.getLanePrRecord(work.id);
    if (!landingIncomplete(record, { headSha: head, authorizationId: authority.decision.id, gatePassSha, policy })) return false;
    this.queueAcceptedPr(work, authority);
    return true;
  }

  /**
   * True when a worktree has commits the recorded change set does not know about. Such ACCEPTED work is stale:
   * the sync step recaptures the head and leaves ACCEPTED, so nothing from GitHub may be applied to it first.
   * Unreadable worktrees count as moved (nothing can be proved); missing ones do not (a merged PR's worktree
   * may be gone, and its merge must still be recorded).
   */
  private worktreeMovedPastRecorded(workId: string): boolean {
    const repos = this.repoStates(workId);
    if (!repos.length || repos.some((r) => !existsSync(r.worktreePath))) return false;
    try {
      return changeSetId(observe(repos).repos) !== changeSetId(repos);
    } catch {
      return true;
    }
  }

  /** Poll the recorded PR of an ACCEPTED task during sync; a failed poll is recorded, never fatal to sync. */
  private async pollAcceptedPr(work: WorkPackage): Promise<void> {
    if (work.currentState !== 'ACCEPTED') return;
    const record = this.ctx.store.getLanePrRecord(work.id);
    // A merged record is done, unless its post-merge suspension check still has to be retried.
    if (!record || (record.queueState === 'merged' && !pendingMergeEvaluation(this.ctx.store, work.id))) return;
    try {
      await this.refreshLanePullRequest(work.id);
    } catch (e) {
      this.recordLandingEvent(work.id, 'lane.pr-refresh-failed', (e as Error).message, true);
    }
  }

  /** Poll the recorded PR. Queue ejection starts a fix round; merge writes Part G's merge store. */
  async refreshLanePullRequest(idOrAlias: string) {
    const work = this.ctx.store.getWork(idOrAlias);
    const recorded = this.ctx.store.getLanePrRecord(work.id);
    if (!recorded) throw err('E_NOT_FOUND', `No PR recorded for ${work.id}`);
    // Poll the repository stored on the PR — never re-resolve origin (it may be gone or retargeted).
    const target: LanePrTarget = {
      adapter: this.lanePrAdapter(),
      owner: recorded.owner,
      repo: recorded.repo,
      baseBranch: recorded.baseBranch,
    };
    const authority = work.currentState === 'ACCEPTED' ? this.acceptanceAuthority(work.id) : undefined;
    const result = await refreshLanePr({
      store: this.ctx.store,
      workId: work.id,
      target,
      policy: authority?.kind === 'policy' ? authority.policy : undefined,
    });
    if (result.kind === 'ejected' && authority && result.removalId) {
      const removalId = result.removalId;
      const decisionOf = (a: { kind: string } | undefined) => (a && 'decision' in a ? (a as { decision: Decision }).decision.id : undefined);
      let fixRound = 0;
      try {
        // The task is re-read inside the transition's transaction: GitHub's answer applies only to the exact
        // acceptance it was polled for. The fix-round event, the handled-removal mark and the state change
        // commit together or not at all.
        const next = this.toChangesRequested(work, 'queue-ejected', {
          guard: (stored) => {
            if (stored.currentRevision !== work.currentRevision) return 'the accepted revision changed while GitHub was polled';
            const nowAuthority = this.acceptanceAuthority(work.id);
            if (nowAuthority.kind === 'stale') return nowAuthority.reason;
            if (decisionOf(nowAuthority) !== decisionOf(authority)) return 'the acceptance decision was replaced while GitHub was polled';
            if (this.worktreeMovedPastRecorded(work.id)) return 'the worktree moved past the accepted head';
            const record = this.ctx.store.getLanePrRecord(work.id);
            if (
              !record ||
              record.number !== result.record.number ||
              record.authorizationId !== result.record.authorizationId ||
              record.headSha !== result.record.headSha
            ) {
              return 'the recorded PR or landing attempt changed while GitHub was polled';
            }
            if (record.queueState === 'merged') return 'the PR already merged';
            // The removal belongs to an earlier acceptance than the one that is current.
            if (record.authorizationId && decisionOf(nowAuthority) && record.authorizationId !== decisionOf(nowAuthority)) {
              return 'the removal belongs to an earlier acceptance';
            }
            if (record.handledQueueRemovalId === removalId) return 'the removal already started a fix round';
            if (this.ctx.store.listEvents(work.id).some((event) => event.type === 'lane.queue-ejected' && event.payload.removalId === removalId)) {
              return 'the removal already started a fix round';
            }
            return undefined;
          },
          atomic: () => {
            const removals = this.ctx.store.listEvents(work.id).filter((event) => event.type === 'lane.queue-ejected');
            fixRound = removals.length + 1;
            this.ctx.store.appendEvent({
              workId: work.id,
              type: 'lane.queue-ejected',
              payload: { reason: result.reason, fixRound, prNumber: result.record.number, removalId },
            });
            const record = this.ctx.store.getLanePrRecord(work.id)!;
            this.ctx.store.saveLanePrRecord({
              ...record,
              queueState: 'ejected',
              queueReason: result.reason,
              handledQueueRemovalId: removalId,
              updatedAt: new Date().toISOString(),
            });
          },
        });
        return { ...result, work: next, fixRound };
      } catch (e) {
        // Refused inside the transaction: nothing was written, and the removal stays unhandled for a later poll.
        if ((e as { code?: string }).code !== 'E_CONCURRENT') throw e;
        return { ...result, work: this.ctx.store.getWork(work.id) };
      }
    }
    return { ...result, work };
  }

  /** Turbine role_runs + external usage_records summary for a task. */
  usageSummary(idOrAlias: string): UsageSummary {
    const work = this.ctx.store.getWork(idOrAlias);
    return summarizeUsage({
      workId: work.id,
      roleRuns: this.ctx.store.listRoleRuns(work.id),
      records: this.ctx.store.listUsageRecords(work.id),
    });
  }

  /**
   * Record coding-agent (or other) usage against a task. Agents may add records; there is no
   * edit/delete API for human-entered rows (FR-006).
   */
  addUsage(input: {
    idOrAlias: string;
    source: 'turbine' | 'agent';
    agentName?: string;
    modelId?: string;
    modelProvider?: string;
    inputTokens: number | 'unknown';
    outputTokens: number | 'unknown';
    method: UsageMethod;
    note?: string;
    recordedBy: string;
    enteredBy: 'human' | 'agent';
  }): UsageRecord {
    const work = this.ctx.store.getWork(input.idOrAlias);
    if (input.source === 'agent' && !input.agentName?.trim()) {
      throw err('E_INVALID_CONFIG', 'agentName is required when source is agent');
    }
    if (input.inputTokens !== 'unknown' && (!Number.isFinite(input.inputTokens) || input.inputTokens < 0)) {
      throw err('E_INVALID_CONFIG', 'input tokens must be a non-negative number or unknown');
    }
    if (input.outputTokens !== 'unknown' && (!Number.isFinite(input.outputTokens) || input.outputTokens < 0)) {
      throw err('E_INVALID_CONFIG', 'output tokens must be a non-negative number or unknown');
    }
    const record: UsageRecord = {
      id: createId('usage'),
      workId: work.id,
      source: input.source,
      agentName: input.agentName?.trim() || undefined,
      modelId: input.modelId,
      modelProvider: input.modelProvider,
      tokens: { input: input.inputTokens, output: input.outputTokens },
      method: input.method,
      note: input.note,
      recordedAt: now(),
      recordedBy: input.recordedBy,
      enteredBy: input.enteredBy,
    };
    // Record + event commit together so a mid-write failure cannot leave a counted row without its event
    // (retry would otherwise insert a second ID and double-count in summaries).
    this.ctx.store.transaction(() => {
      this.ctx.store.saveUsageRecord(record);
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'usage.recorded',
        payload: {
          usageId: record.id,
          source: record.source,
          agentName: record.agentName,
          modelId: record.modelId,
          method: record.method,
          enteredBy: record.enteredBy,
        },
      });
    });
    // Render after commit: packet refresh must not roll back counted usage. Failures here are
    // surfaceable via sync/render; the record already exists so a blind retry would double-count —
    // callers should not re-add on render-only errors.
    try {
      this.render(work.id, [`Usage recorded (${record.source}${record.agentName ? `:${record.agentName}` : ''})`]);
    } catch {
      /* usage is committed; next sync/render refreshes the packet */
    }
    return record;
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
    /** Labels of the source issue, read by an intake adapter (lane policy eligibility). */
    labels?: string[];
  }): WorkPackage {
    const sourceText =
      input.text ??
      (input.file ? readFileSync(input.file, 'utf8') : `# ${input.title}\n\n(No body provided)`);
    const snapshotHash = contentHashText(sourceText);
    const workId = createId('work');
    const createdAt = now();
    const ghLinks = githubLinksFromText(sourceText);

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
          ...(input.labels?.length ? { labels: [...new Set(input.labels)] } : {}),
        },
        ...ghLinks.map((l) => ({ ...l.sourceRef, snapshotHash })),
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
      aliases: ghLinks.map((l) => l.alias),
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
          ...(issue.labels?.length ? { labels: [...new Set(issue.labels)] } : {}),
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
    companionSkills?: SkillManifest[];
    model: ModelAdapter;
    workId: string;
    roleId: string;
    context: string;
    schemaId: string;
    maxOutputTokens: number;
  }): Promise<{ content: unknown; usage?: { inputTokens?: number; outputTokens?: number } }> {
    const work = this.ctx.store.getWork(input.workId);
    const companions = input.companionSkills ?? [];
    const { grants } = this.roleGrants(work, input.roleId, input.skill.id);
    for (const c of companions) this.roleGrants(work, input.roleId, c.id);
    const skillIds = [input.skill.id, ...companions.map((c) => c.id)];
    const run: RoleRun = {
      id: createId('run'),
      workId: work.id,
      roleId: input.roleId,
      roleVersion: getRole(this.ctx.factoryRoot, input.roleId).version,
      skillIds,
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
      const result = await runSkill({ ...input, companionSkills: companions, grantedCapabilities: grants });
      this.ctx.store.saveRoleRun({
        ...run,
        status: 'succeeded',
        endedAt: now(),
        tokens: {
          input: typeof result.usage?.inputTokens === 'number' ? result.usage.inputTokens : 'unknown',
          output: typeof result.usage?.outputTokens === 'number' ? result.usage.outputTokens : 'unknown',
        },
      });
      return result;
    } catch (e) {
      this.ctx.store.saveRoleRun({
        ...run,
        status: 'failed',
        endedAt: now(),
        errorCode: (e as { code?: string }).code ?? 'E_RUN_FAILURE',
        // Failures still record model identity; usage is unknown unless the adapter already returned it (it did not here).
        tokens: { input: 'unknown', output: 'unknown' },
      });
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
    const maxTokens = this.ctx.config.budgets.perTask.maxTokens;
    if (maxTokens != null) {
      const used = measuredTurbineTokens(this.ctx.store.listRoleRuns(workId));
      if (used >= maxTokens) {
        throw err('E_BUDGET_EXCEEDED', `Token budget exceeded (${used}/${maxTokens} measured Turbine tokens)`);
      }
    }
  }

  // ---------------------------------------------------------------- task context (repository context, layer 3)

  /** The source text of the request (the stored source artifact holds JSON {text, snapshotHash}). */
  private sourceTextOf(work: WorkPackage): string {
    const source = this.ctx.store.getLatestArtifact(work.id, 'source');
    if (!source) return work.objective;
    const raw = this.ctx.store.getArtifactContent(source.id);
    try {
      const parsed = JSON.parse(raw) as { text?: unknown };
      return typeof parsed.text === 'string' ? parsed.text : raw;
    } catch {
      return raw;
    }
  }

  /** The request exactly as the selection reads it: "named in request" reasons quote this text. */
  private requestTextOf(work: WorkPackage): string {
    return `${work.title}\n${this.sourceTextOf(work)}`;
  }

  private factLines(facts: Array<{ text: string; source: string }>): string[] {
    return facts.map((f) => `- ${f.text} [source: ${f.source}]`);
  }

  /** The size limit for this task: the strictest `context_budget` among its roles, else the default. */
  private contextBudgetOf(work: WorkPackage) {
    const selected = new Set(work.selectedRoles.map((r) => r.id));
    return contextBudgetFor(loadRoles(this.ctx.factoryRoot).filter((r) => selected.has(r.id)));
  }

  /** Enters CHANGES_REQUESTED and records it: each entry starts a new review cycle with a fresh file selection. */
  private toChangesRequested(
    work: WorkPackage,
    cause: 'code-review' | 'verification-failed' | 'acceptance-failed' | 'queue-ejected' | 'execution-fail-cap',
    /**
     * `guard` runs inside the transaction on the freshly read task and returns why the transition must not
     * happen (E_CONCURRENT, nothing written); `atomic` writes extra records in that same transaction.
     */
    opts: { guard?: (stored: WorkPackage) => string | undefined; atomic?: () => void } = {},
  ): WorkPackage {
    const next = transition(work, 'CHANGES_REQUESTED');
    // The event and the state are saved together: a failed state write must not leave an event that would count as
    // a review cycle, and a retried transition must add exactly one.
    this.ctx.store.transaction(() => {
      // BEGIN IMMEDIATE holds the write lock: the stored state is read inside it, so two requests that both read
      // the review state before either committed cannot both record a cycle.
      const stored = this.ctx.store.getWork(work.id);
      if (stored.currentState !== work.currentState) {
        throw err('E_CONCURRENT', `${work.id} is ${stored.currentState}, not ${work.currentState}, so changes were not requested. Look at the task again.`);
      }
      const refusal = opts.guard?.(stored);
      if (refusal) throw err('E_CONCURRENT', `${work.id}: changes were not requested because ${refusal}. Look at the task again.`);
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'task.changes-requested',
        payload: { cause, fromState: work.currentState },
      });
      opts.atomic?.();
      this.ctx.store.saveWork(next);
    });
    return next;
  }

  /** How many times a reviewer sent this task back. A new cycle always gets a fresh selection. */
  private changesCycleOf(workId: string): number {
    return this.ctx.store.listEvents(workId).filter((e) => e.type === 'task.changes-requested').length;
  }

  private latestTaskContext(workId: string): TaskContext | undefined {
    const art = this.ctx.store.getLatestArtifact(workId, 'repo-context');
    return art ? parseTaskContext(this.ctx.store.getArtifactContent(art.id)) : undefined;
  }

  private contextInputs(work: WorkPackage, head: string) {
    return {
      commit: head,
      budget: this.contextBudgetOf(work),
      requestHash: requestHash(this.requestTextOf(work)),
      changesCycle: this.changesCycleOf(work.id),
    };
  }

  /** Why a stored selection is out of date for the checkout as it is now (empty = current). */
  private contextStaleness(work: WorkPackage, selection: TaskContext): Staleness[] {
    const head = repoHead(this.ctx.projectRoot);
    const commit = 'error' in head ? '' : head.head;
    // The snapshot hash counts only when the stored snapshot belongs to this HEAD, as `refreshTaskContext` does.
    const snapshotHash = commit ? snapshotHashAt(this.ctx.store, this.ctx.projectRoot, commit) : undefined;
    return stalenessOf(selection, { ...this.contextInputs(work, commit), ...(snapshotHash ? { snapshotHash } : {}) });
  }

  /** Records a selection as the next `repo-context` artifact, pinned to the Layer 1 snapshot it was read at. */
  private saveTaskContext(work: WorkPackage, selection: TaskContext): void {
    const source = this.ctx.store.getLatestArtifact(work.id, 'source');
    // The record and its audit event are one unit: if the event cannot be written, the record is rolled back too,
    // so a retry saves both instead of finding a "current" selection whose event is missing for good.
    const written: { location?: string } = {};
    try {
      this.ctx.store.transaction(() => {
        written.location = this.saveArtifact({
          workId: work.id,
          type: 'repo-context',
          content: selection,
          createdBy: { kind: 'tool', identifier: 'task-context' },
          parentArtifactIds: source ? [source.id] : [],
          relatedCommit: selection.snapshot.commit,
        }).location;
        this.ctx.store.appendEvent({
          workId: work.id,
          type: 'context.selected',
          payload: {
            snapshotHash: selection.snapshot.hash,
            commit: selection.snapshot.commit,
            files: selection.files.length,
            omitted: selection.omitted.length,
            trigger: selection.trigger,
            changesCycle: selection.changesCycle,
          },
        });
      });
    } catch (e) {
      if (written.location) rmSync(written.location, { force: true }); // the rolled-back revision's file
      throw e;
    }
  }

  /**
   * Makes sure the selection is current for the checkout as it is now (rebuilding it when the base commit,
   * the project snapshot, the size limit, the request or the review cycle changed), then rewrites CONTEXT.md.
   * Anything that points an agent at CONTEXT.md calls this first, so an old selection is never served as current.
   */
  ensureTaskContext(work: WorkPackage): RefreshResult {
    const result = refreshTaskContext({
      projectRoot: this.ctx.projectRoot,
      store: this.ctx.store,
      request: {
        workId: work.id,
        request: this.requestTextOf(work),
        budget: this.contextBudgetOf(work),
        changesCycle: this.changesCycleOf(work.id),
      },
      previous: this.latestTaskContext(work.id),
      save: (selection) => this.saveTaskContext(work, selection),
    });
    this.writeTaskContext(
      work,
      result.status === 'unavailable' ? { unavailable: result.reason } : { selection: result.selection, stale: [] },
    );
    return result;
  }

  /** The text of CONTEXT.md as it is on disk (undefined when it does not exist). Anything else that stops it being read stops the render. */
  private readContextText(work: WorkPackage, file: string): string | undefined {
    try {
      return readContextFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err('E_CONTEXT_UNAVAILABLE', `CONTEXT.md of ${work.id} cannot be read (${(e as Error).message}), so it is left as it is and its agent notes are not replaced. Fix or move the file, then retry.`, { file });
    }
  }

  /**
   * Writes evidence/context.json and CONTEXT.md (generated part from the store, agent notes kept).
   *   - The agent notes live only in CONTEXT.md. A missing file starts with empty notes; a file that cannot be read
   *     stops here with the document left as it is, never replaced by empty notes.
   *   - The new document must fit the reader's byte limit, or it is not published (the old one stays).
   *   - The file is read again right before publishing: if it changed since the notes were taken (an agent saved
   *     notes meanwhile), the document is built again from the new notes instead of overwriting them.
   *   - CONTEXT.md is published last. If the JSON cannot be written, the old CONTEXT.md still stands, and it is
   *     never newer than the JSON beside it.
   */
  private writeTaskContext(work: WorkPackage, view: { selection?: TaskContext; stale?: Staleness[]; unavailable?: string }): void {
    const paths = packetPaths(this.ctx.projectRoot, work.id);
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = this.readContextText(work, paths.context);
      const notes = raw === undefined ? '' : parseContextFile(raw).notes;
      let file: string;
      let evidence: string;
      if (view.selection) {
        const stale = view.stale ?? [];
        const body = renderContextBody(view.selection, {
          title: work.title,
          workId: work.id,
          stale,
          projectLink: existsSync(paths.projectContext) ? relative(paths.dir, paths.projectContext) : undefined,
        });
        file = renderContextFile(view.selection, body, notes);
        // `document` is the hash of the CONTEXT.md published with this JSON: a reader compares it to the file it has
        evidence = `${JSON.stringify({ current: stale.length === 0, stale, document: contentHashText(file), selection: view.selection }, null, 2)}\n`;
      } else {
        const reason = view.unavailable ?? 'no selection has been built';
        file = renderUnavailableFile(work.title, work.id, reason, notes);
        evidence = `${JSON.stringify({ current: false, document: contentHashText(file), unavailable: reason }, null, 2)}\n`;
      }
      const bytes = Buffer.byteLength(file, 'utf8');
      if (bytes > MAX_CONTEXT_FILE_BYTES) {
        throw err('E_CONTEXT_UNAVAILABLE', `The new CONTEXT.md of ${work.id} would be ${bytes} bytes, over the ${MAX_CONTEXT_FILE_BYTES} byte limit the reader accepts, so the old file is kept. Shorten the agent notes, then retry.`, { file: paths.context });
      }
      if (this.readContextText(work, paths.context) !== raw) continue; // changed while rendering: start again from the new notes
      try {
        writeFileAtomic(join(paths.evidenceDir, 'context.json'), evidence);
        writeFileAtomic(paths.context, file);
      } catch (e) {
        throw err('E_CONTEXT_UNAVAILABLE', `CONTEXT.md of ${work.id} could not be written (${(e as Error).message.split('\n')[0]}), so the previous file is kept. Fix the cause, then retry.`, { file: paths.context });
      }
      return;
    }
    throw err('E_CONTEXT_UNAVAILABLE', `CONTEXT.md of ${work.id} kept changing while it was rendered, so it was not replaced. Retry once nothing else is writing it.`, { file: paths.context });
  }

  /** The rendered selection for a model prompt. Never claims completeness, never hides what was left out. */
  private promptContext(work: WorkPackage, result: RefreshResult): string {
    if (result.status === 'unavailable') {
      return `No file selection exists: ${result.reason}. Nothing is claimed about which files matter.`;
    }
    return renderContextBody(result.selection, { title: work.title, workId: work.id, stale: [] });
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
    const sourceText = this.sourceTextOf(work);
    // The facts and the file selection must describe the same commit. HEAD can move between the two reads, so on a
    // mismatch both are read once more; if they still disagree the task stops before any model call.
    const gather = () => {
      const evidence = collectProjectEvidence(this.ctx.projectRoot, this.requestTextOf(work), { store: this.ctx.store });
      return { evidence, context: this.ensureTaskContext(work) };
    };
    const agree = (g: ReturnType<typeof gather>) =>
      g.context.status === 'unavailable' || !g.evidence.snapshot || g.context.selection.snapshot.commit === g.evidence.snapshot.commit;
    let gathered = gather();
    if (!agree(gathered)) gathered = gather();
    if (!agree(gathered)) {
      throw err('E_CONTEXT_UNAVAILABLE', 'HEAD moved twice while the project facts and the task context were read, so they cannot be pinned to one commit. Retry when the checkout is quiet.');
    }
    const projectEvidence = gathered.evidence;
    const taskContext = gathered.context;
    const model = getModel(this.ctx.config.models.profiles.analysis?.model ?? 'mock-default');
    const skill = getSkill(this.ctx.factoryRoot, 'core/assess-requirements');
    const assessContext = [
      '## REQUEST',
      sourceText,
      '',
      '## PROJECT_EVIDENCE (deterministic — treat as confirmed facts, do not re-assume; each line ends with its source)',
      ...this.factLines(projectEvidence.facts),
      '',
      '## TASK_CONTEXT (files that may matter, each with a checkable reason. A selection, NOT a complete list: a file missing here may still matter)',
      this.promptContext(work, taskContext),
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

  async plan(idOrAlias: string, opts: { onlyIfPending?: boolean } = {}): Promise<{
    work: WorkPackage;
    plan: unknown;
    planHash: string;
    packetDir: string;
    /** True when `onlyIfPending` was set and the task had already left the pending state: nothing was planned. */
    skipped?: boolean;
  }> {
    const first = this.ctx.store.getWork(idOrAlias);
    if (!['PLAN_REVIEW', 'CHANGES_REQUESTED', 'REQUIREMENTS_APPROVED', 'PLANNING'].includes(first.currentState)) {
      throw err('E_INVALID_TRANSITION', `Cannot plan from ${first.currentState}; requirements must be approved`);
    }
    // PLANNING is also where a task stays when an attempt failed (for example the project facts could not
    // be refreshed). Only one planning attempt may own the task: a second `sync` while one is running is
    // refused, and a failed attempt releases its claim so the next `sync` can resume it.
    const claim = this.ctx.store.claimWork(first.id, 'planning');
    try {
      return await this.planClaimed(first.id, claim, opts);
    } finally {
      this.ctx.store.releaseClaim(first.id, claim);
    }
  }

  private async planClaimed(idOrAlias: string, claim: string, opts: { onlyIfPending?: boolean } = {}): Promise<{
    work: WorkPackage;
    plan: unknown;
    planHash: string;
    packetDir: string;
    skipped?: boolean;
  }> {
    let work = this.ctx.store.getWork(idOrAlias);
    if (opts.onlyIfPending && work.currentState !== 'REQUIREMENTS_APPROVED' && work.currentState !== 'PLANNING') {
      // Another sync published the plan while this one waited for the claim. Planning again would replace a
      // plan that is awaiting approval, so this attempt stops here.
      return {
        work,
        plan: undefined,
        planHash: this.ctx.store.getLatestArtifact(work.id, 'plan')?.contentHash ?? '',
        packetDir: packetPaths(this.ctx.projectRoot, work.id).dir,
        skipped: true,
      };
    }
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
    const evidenceText = `${work.title}\n${specForEvidence ? this.ctx.store.getArtifactContent(specForEvidence.id) : ''}`;
    // The facts and the live git state must describe the same commit. HEAD can move between the two reads, so
    // on a mismatch both are read once more; if they still disagree, the checkout cannot be pinned and the task stops.
    const gather = () => {
      const evidence = collectProjectEvidence(this.ctx.projectRoot, evidenceText, { store: this.ctx.store });
      // Read with the same isolated Git reader as the facts (no inherited GIT_* variables). Not a git checkout:
      // the facts alone are what the planner is given.
      const h = repoHead(this.ctx.projectRoot);
      const info =
        'error' in h
          ? undefined
          : { root: h.repoRoot, head: h.head, branch: observeBranch(h.repoRoot)?.branch, dirty: hasUncommittedChanges(h.repoRoot) };
      // The file selection is read at the commit the facts are pinned to; two commits in one plan prompt would
      // make the reasons and the facts disagree.
      return { evidence, info, context: this.ensureTaskContext(work) };
    };
    // Evidence without a snapshot has nothing to pin. With a snapshot, an unreadable HEAD (no info) is not a match,
    // and neither is a file selection built at another commit than the facts.
    const pinned = (g: ReturnType<typeof gather>) =>
      !g.evidence.snapshot ||
      (g.info !== undefined &&
        g.info.head === g.evidence.snapshot.commit &&
        (g.context.status === 'unavailable' || g.context.selection.snapshot.commit === g.evidence.snapshot.commit));
    let gathered = gather();
    if (!pinned(gathered)) gathered = gather();
    if (!pinned(gathered)) {
      throw err('E_CONTEXT_UNAVAILABLE', 'HEAD moved twice while the project facts and the task context were read, so they cannot be pinned to one commit. Retry when the checkout is quiet.');
    }
    const projectEvidence = gathered.evidence;
    const taskContext = gathered.context;
    const repoContext = [
      gathered.info
        ? `Git: branch ${gathered.info.branch ?? '(detached)'}, HEAD ${gathered.info.head.slice(0, 12)}; ${gathered.info.dirty ? 'there are uncommitted changes (not read here)' : 'no uncommitted changes'}.`
        : 'Not a git checkout: only the facts below are known.',
      ...this.factLines(projectEvidence.facts),
    ].join('\n');
    const taskContextText = this.promptContext(work, taskContext);

    this.checkBudget(work.id);
    const model = getModel(this.ctx.config.models.profiles.analysis?.model ?? 'mock-default');
    const skill = getSkill(this.ctx.factoryRoot, 'core/plan-change');
    const executiveSummarySkill = getSkill(this.ctx.factoryRoot, 'core/plan-executive-summary');
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
      companionSkills: [executiveSummarySkill],
      model,
      workId: work.id,
      roleId: work.selectedRoles.some((r) => r.id === 'project-manager') || !work.selectedRoles.some((r) => r.id === 'architect')
        ? 'project-manager'
        : 'architect',
      context: `REQUIREMENTS (link every step and test to these IDs):\n${work.acceptanceCriteria.map((c) => `- ${c.id} (${c.priority ?? 'P1'}): ${c.statement}`).join('\n')}\n\nVALID REQUIREMENT IDS: ${validIds.join(', ')}. Use only these; every one needs at least one step, and every P0 at least one test.${feedback}\n\nAPPROVED SPEC CONTEXT:\n${specText}\n\nPROJECT_EVIDENCE (each line ends with its source):\n${repoContext}\n\nTASK_CONTEXT (files that may matter, each with a checkable reason; a selection, NOT a complete list):\n${taskContextText}${extraRepoEvidence ? `\n\n${extraRepoEvidence}` : ''}\n\nREPOSITORIES IN SCOPE:\n- project (this repo)\n${(work.repositories ?? []).map((r) => `- ${r.name}: ${r.path}`).join('\n')}\nOnly plan changes in these repositories; if another repo is needed, say so under risks.`,
      schemaId: 'plan',
      maxOutputTokens: 5000,
    });
    // The completed model call is charged on its own, committed before publication. Publication can roll back
    // (a failed write, a lost claim); the call still happened, so it still counts.
    this.ctx.store.transaction(() => {
      this.ctx.store.incrementBudget(work.id, 1);
      this.ctx.store.appendEvent({ workId: work.id, type: 'plan.model-call', payload: { roleId: 'project-manager', outcome: 'received' } });
    });
    // Publication is one transaction. BEGIN IMMEDIATE takes the write lock first, so the checks and every write
    // below see one consistent state. A discarded plan returns its reason as a value (a throw would roll back
    // its "plan.discarded" event).
    const outcome = this.ctx.store.transaction(() => {
      const current = this.ctx.store.getWork(work.id);
      const discard = (code: 'E_CONCURRENT' | 'E_INVALID_TRANSITION', message: string) => {
        this.ctx.store.appendEvent({ workId: work.id, type: 'plan.discarded', payload: { reason: message } });
        return { discarded: { code, message } } as const;
      };
      // The model call took a while: only save the plan if this attempt still owns the task.
      if (!this.ctx.store.holdsClaim(work.id, claim)) {
        return discard('E_CONCURRENT', `Planning for ${work.id} lost its claim while the model was running; the plan was not saved. Run sync again.`);
      }
      if (current.currentState !== 'PLANNING') {
        return discard('E_INVALID_TRANSITION', `${work.id} moved to ${current.currentState} while it was being planned; the plan was not saved.`);
      }
      // The plan was derived from the commit the facts and the file selection were pinned to. If the checkout moved
      // while the model ran, that plan describes a tree that is no longer there: it is discarded, and sync retries.
      if (gathered.info) {
        const now = repoHead(this.ctx.projectRoot);
        if ('error' in now || now.head !== gathered.info.head) {
          return discard('E_CONCURRENT', `HEAD moved from ${gathered.info.head.slice(0, 12)} while ${work.id} was being planned; the plan was not saved. Run sync again.`);
        }
      }
      if (this.ctx.store.getLatestArtifact(work.id, 'specification')?.id !== spec?.id) {
        return discard('E_CONCURRENT', `The requirements of ${work.id} changed while it was being planned; the plan was not saved. Run sync again.`);
      }
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

      const next = transition(current, 'PLAN_REVIEW');
      this.ctx.store.saveWork(next);
      this.ctx.store.appendEvent({
        workId: next.id,
        type: 'plan.created',
        payload: { planArtifactId: planArt.id, hash: planArt.contentHash },
      });
      const eec = this.ctx.store.getLatestEec(next.id)!;
      this.ctx.store.saveEec(
        bumpEecRevision(eec, {
          artifactRevisionIds: [...eec.artifactRevisionIds, planArt.id],
        }),
      );
      return { work: next, planArt };
    });
    if ('discarded' in outcome) throw err(outcome.discarded.code, outcome.discarded.message);
    work = outcome.work;
    const planArt = outcome.planArt;

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
    // Before anything points at CONTEXT.md, make it true for the checkout as it is now: rebuilt when the base
    // commit moved or the task re-entered CHANGES_REQUESTED. If the rebuild cannot run, the file says so;
    // the old selection is never left in place as if it were current.
    const briefOk = CONTEXT_READING_STATES.has(work.currentState) ? this.syncBriefForHandoff() : true;
    if (CONTEXT_READING_STATES.has(work.currentState)) {
      try {
        this.ensureTaskContext(work);
      } catch (e) {
        this.writeTaskContext(work, { unavailable: `the selection could not be rebuilt: ${(e as Error).message.split('\n')[0]}` });
      }
    }
    return computeNextStep({
      projectRoot: this.ctx.projectRoot,
      work,
      defaultBaseBranch: baseBranch,
      briefUnavailable: !briefOk,
    });
  }

  /** Deterministic brief reverify + rewrite (no model calls). Returns false when the brief must be omitted from the handoff. */
  private syncBriefForHandoff(): boolean {
    const repoRoot = repoToplevel(this.ctx.projectRoot) ?? this.ctx.projectRoot;
    const result = syncBriefClaimsToHead({
      store: this.ctx.store,
      projectRoot: this.ctx.projectRoot,
      repoRoot,
      repoPath: this.ctx.projectRoot,
      sections: briefConfigOf(this.ctx.config).sections,
    });
    return result.ok;
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

    // Reuse existing worktrees (CHANGES_REQUESTED loop) or create them on first execute.
    // Budget applies only when this path will call the model (first execute); a model-free
    // resume with existing worktrees must not be blocked by an exhausted token budget.
    const existing = this.repoStates(work.id);
    if (existing.length === 0) {
      this.checkBudget(work.id);
    }

    const executionModeEarly = this.ctx.config.execution.mode;
    const allowNetworkEarly = this.ctx.config.execution.allowNetwork;
    // FR-D3: refuse networked unattended work outside sandboxed-unattended before any state change.
    if (executionModeEarly !== 'sandboxed-unattended' && allowNetworkEarly) {
      throw err(
        'E_UNSAFE_EXECUTION',
        'Networked autonomous execution is disabled outside sandboxed-unattended. Use manual-supervised mode or sandboxed-unattended.',
      );
    }
    // FR-D3: sandboxed-unattended preflight before leaving PLAN_APPROVED so a refuse leaves the task retryable.
    // After a fix-cap / limit leave-lane, require a human `lane.retry` before another autonomous launch.
    let sandboxedPreflightRuntime: ContainerRuntime | undefined;
    if (executionModeEarly === 'sandboxed-unattended') {
      const membership = this.laneState(work.id);
      if (!membership.inLane) {
        // Supervised recovery only: prepare/reuse worktrees below without running the sandbox.
      } else {
        if (!this.sandboxImplementer) {
          throw err(
            'E_UNSAFE_EXECUTION',
            'sandboxed-unattended requires a bound agent implementer (Engine.sandboxImplementer). It will not start with the default fixture or fall back to unsandboxed execution.',
          );
        }
        sandboxedPreflightRuntime = preflightSandbox(this.sandboxHooks ?? defaultSandboxHooks()).runtime;
      }
    }

    // Rebuilt when the base commit moved or this is a new CHANGES_REQUESTED cycle, before anything points at it.
    // It runs before the task leaves PLAN_APPROVED / CHANGES_REQUESTED and before any worktree exists, so a
    // failure here (an unreadable repository, an unwritable packet folder) leaves the task retryable.
    this.syncBriefForHandoff();
    const taskContext = this.ensureTaskContext(work);

    work = transition(work, 'IMPLEMENTING');
    this.ctx.store.saveWork(work);

    let eec = this.ctx.store.getLatestEec(work.id)!;
    if (!eec.obligations.some((o) => o.id === 'obl_implementation')) {
      eec = extendEecForImplementation(eec);
      this.ctx.store.saveEec(eec);
    }

    const repos =
      existing.length > 0
        ? observe(existing).repos
        : prepareWorktrees({
            projectRoot: this.ctx.projectRoot,
            work,
            primaryChecks: this.ctx.config.quality.checks,
            primarySetup: this.ctx.config.quality.setup,
          });

    const executionMode = this.ctx.config.execution.mode;

    let modelNotes: unknown;
    const primary = repos[0]!;

    if (executionMode === 'sandboxed-unattended' && this.laneState(work.id).inLane) {
      work = await this.runSandboxedUnattended({
        work,
        plan,
        spec,
        taskContext,
        repos,
        primary,
        preflightRuntime: sandboxedPreflightRuntime!,
      });
      return {
        work,
        result: {
          repos: this.repoStates(work.id).length ? observe(this.repoStates(work.id)).repos : repos,
          worktreePath: primary.worktreePath,
          branch: primary.branch,
          baseCommit: primary.baseCommit,
          modelNotes: undefined,
        },
        packetDir: packetPaths(this.ctx.projectRoot, work.id).dir,
        openFile: packetPaths(this.ctx.projectRoot, work.id).executionBrief,
      };
    }

    if (existing.length === 0) {
      const model = getModel(this.ctx.config.models.profiles.implementation?.model ?? 'mock-default');
      const skill = getSkill(this.ctx.factoryRoot, 'core/execute-code-change');
      const implementer =
        work.selectedRoles.find((r) => /-developer$/.test(r.id))?.id ??
        work.selectedRoles.find((r) => r.id === 'database-engineer')?.id ??
        'backend-developer';
      // Supervised mode: the implementer role only produces guidance; a human/agent writes code.
      modelNotes = (
        await this.runAsRole({
          skill,
          model,
          workId: work.id,
          roleId: implementer,
          context: `SPEC:\n${this.ctx.store.getArtifactContent(spec.id)}\n\nPLAN:\n${this.ctx.store.getArtifactContent(plan.id)}\n\nTASK_CONTEXT (files that may matter, each with a checkable reason; a selection, NOT a complete list):\n${this.promptContext(work, taskContext)}`,
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
   * Part D: run the implementer inside Docker/Podman after fail-closed preflight.
   * Agent prose is never evidence — only commits + later check results count (FR-D5).
   */
  private async runSandboxedUnattended(input: {
    work: WorkPackage;
    plan: Artifact;
    spec: Artifact;
    taskContext: RefreshResult;
    repos: RepoState[];
    primary: RepoState;
    preflightRuntime: ContainerRuntime;
  }): Promise<WorkPackage> {
    let work = input.work;
    const startedRevision = work.currentRevision;
    if (this.sandboxInFlight.has(work.id)) {
      throw err('E_CONCURRENT', `${work.id} already has a sandboxed-unattended run in flight`);
    }
    this.sandboxInFlight.add(work.id);

    const failInit = (reason: string): WorkPackage => {
      this.saveChangeSet(work.id, input.repos, {
        status: 'sandboxed-incomplete',
        summary: `${reason}. Worktrees preserved.`,
        createdBy: { kind: 'tool', identifier: 'sandboxed-executor' },
        parentArtifactIds: [input.plan.id],
      });
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'execution.phase-failed',
        payload: { reason, runtime: input.preflightRuntime },
      });
      return this.toChangesRequested(work, 'execution-fail-cap', {
        atomic: () => {
          this.ctx.store.appendEvent({
            workId: work.id,
            type: 'lane.fallback',
            payload: {
              gate: 'codeReview',
              workRevision: work.currentRevision,
              reasons: [reason],
              evaluationHash: contentHash({ workId: work.id, reason, status: 'sandbox-init-failed' }),
            },
          });
        },
      });
    };

    // Record worktree ownership before any further init so a mid-setup throw stays recoverable.
    this.saveChangeSet(work.id, input.repos, {
      status: 'sandboxed-running',
      summary: 'Sandboxed-unattended run started; worktrees recorded.',
      createdBy: { kind: 'tool', identifier: 'sandboxed-executor' },
      parentArtifactIds: [input.plan.id],
    });

    try {
    const customHooks = this.sandboxHooks;
    const hooks = customHooks ?? defaultSandboxHooks();
    // Bind the workload to the runtime preflight probed — do not silently switch.
    const detected = hooks.detectRuntime();
    if (!detected || detected !== input.preflightRuntime) {
      work = failInit(
        `sandboxed-unattended runtime mismatch after preflight (expected ${input.preflightRuntime}, got ${detected ?? 'none'})`,
      );
      this.render(work.id, [`Sandboxed-unattended init failed: runtime mismatch.`, 'Task left the autonomous lane.']);
      return work;
    }
    const runtime = input.preflightRuntime;
    let mount;
    try {
      mount = planSandboxMounts({
        worktreePath: input.primary.worktreePath,
        projectRoot: this.ctx.projectRoot,
        runtime,
      });
    } catch (e) {
      work = failInit(`sandbox mount plan refused: ${(e as Error).message.split('\n')[0]}`);
      this.render(work.id, [`Sandboxed-unattended init failed: mount plan.`, 'Task left the autonomous lane.']);
      return work;
    }

    const knowledgePath = join(this.ctx.projectRoot, '.turbine', 'knowledge', 'index.md');
    let knowledge = 'No knowledge index is available for this project.';
    if (existsSync(knowledgePath)) {
      try {
        knowledge = readFileSync(knowledgePath, 'utf8').slice(0, 64_000);
      } catch (e) {
        knowledge = `Knowledge index could not be read (${(e as Error).message.split('\n')[0]}); nothing is claimed about prior knowledge.`;
      }
    }

    const implementer = this.sandboxImplementer;
    if (!implementer) {
      work = failInit('sandboxed-unattended requires a bound agent implementer (Engine.sandboxImplementer).');
      this.render(work.id, [`Sandboxed-unattended init failed: no implementer.`, 'Task left the autonomous lane.']);
      return work;
    }

    this.ctx.store.appendEvent({
      workId: work.id,
      type: 'execution.prepared',
      payload: {
        mode: 'sandboxed-unattended',
        runtime,
        repos: input.repos.map((r) => ({ name: r.name, worktreePath: r.worktreePath, base: r.baseCommit })),
        forbiddenMounts: mount.forbiddenMounts,
        worktreePath: mount.worktreePath,
      },
    });

    const allow = this.ctx.config.tools.allow;
    const denied = this.ctx.config.tools.denied;
    const testsRunAllowed = !denied.includes('tests.run') && (allow.length === 0 || allow.includes('tests.run'));

    /**
     * Host `runCommand` is not a sandbox. Until a container phase runner is bound via
     * `sandboxHooks`, refuse to execute configured setup/checks on the host (fail closed).
     * Empty command lists succeed without running anything. Tests inject `sandboxHooks`.
     */
    const refuseHostPhase = (phase: 'setup' | 'checks', commands: string[]): PhaseResult => {
      if (commands.length === 0) {
        return {
          ok: true,
          report: phase === 'setup' ? 'no setup commands' : 'no quality.checks configured',
          outputBytes: 24,
        };
      }
      return {
        ok: false,
        report: `${phase}: host execution refused until the container phase runner is bound (sandboxHooks); ${commands.length} command(s) not run`,
        outputBytes: 96,
      };
    };

    const phaseHooks: SandboxHooks = {
      ...hooks,
      runPhase: async (phase, ctx) => {
        if (ctx.signal.aborted) {
          return { ok: false, report: `${phase} aborted (wall-clock)`, outputBytes: 0 };
        }
        if (phase === 'setup') {
          if (customHooks) return customHooks.runPhase(phase, ctx);
          return refuseHostPhase('setup', this.ctx.config.quality.setup ?? []);
        }
        if (phase === 'implement' || phase === 'fix') {
          const result = await implementer.run({
            workId: work.id,
            spec: this.ctx.store.getArtifactContent(input.spec.id),
            plan: this.ctx.store.getArtifactContent(input.plan.id),
            context: this.promptContext(work, input.taskContext),
            knowledge,
            signal: ctx.signal,
          });
          // FR-D5: report is unverified; only commits + usage are recorded as structured facts.
          if (result.usage) {
            try {
              this.addUsage({
                idOrAlias: work.id,
                source: 'agent',
                agentName: implementer.id,
                modelId: result.usage.modelId ?? 'unknown',
                modelProvider: result.usage.provider ?? 'unknown',
                inputTokens: result.usage.inputTokens ?? 'unknown',
                outputTokens: result.usage.outputTokens ?? 'unknown',
                method: 'reported',
                note: `sandboxed ${phase} (report unverified)`,
                recordedBy: 'executor',
                enteredBy: 'agent',
              });
            } catch {
              // Usage recording must not abort the sandbox; missing usage stays unknown in metrics.
            }
          }
          return {
            ok: result.ok,
            report: result.report,
            commits: result.commits,
            usage: result.usage
              ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, modelId: result.usage.modelId }
              : undefined,
            outputBytes: Buffer.byteLength(result.report ?? '', 'utf8'),
          } satisfies PhaseResult;
        }
        if (phase === 'checks') {
          if (!testsRunAllowed) {
            return {
              ok: false,
              report: 'Capability tests.run is not allowed by tools.allow / tools.denied; sandbox checks not run',
              outputBytes: 64,
            };
          }
          // Deterministic checks with no network (FR-D2). Host execution is refused without sandboxHooks.
          if (customHooks) return customHooks.runPhase(phase, ctx);
          return refuseHostPhase('checks', this.ctx.config.quality.checks ?? []);
        }
        // commit — git commits are produced by the implementer; this phase confirms the worktree is clean.
        if (customHooks) return customHooks.runPhase(phase, ctx);
        const dirty = this.uncommitted(work.id);
        if (dirty.length) {
          return {
            ok: false,
            report: `commit phase refused: uncommitted files remain (${dirty.map((d) => d.repo).join(', ')})`,
            outputBytes: 64,
          };
        }
        return { ok: true, report: 'commit phase complete', outputBytes: 24 };
      },
    };

    const limits = {
      wallClockMs: this.ctx.config.execution.sandboxWallClockMs,
      maxOutputBytes: this.ctx.config.execution.sandboxMaxOutputBytes,
      maxExecutionAttempts: this.ctx.config.budgets.perTask.maxExecutionAttempts,
    };

    const stillOwnsExecution = (): boolean => {
      const live = this.ctx.store.getWork(work.id);
      return live.currentState === 'IMPLEMENTING' && live.currentRevision === startedRevision;
    };

    let run: Awaited<ReturnType<typeof runSandboxedStateMachine>>;
    try {
      run = await runSandboxedStateMachine({ hooks: phaseHooks, limits, mount });
    } catch (e) {
      const reason = `sandboxed phase threw: ${(e as Error).message.split('\n')[0]}`;
      if (!stillOwnsExecution()) {
        return this.ctx.store.getWork(work.id);
      }
      const observed = observe(input.repos).repos;
      this.saveChangeSet(work.id, observed, {
        status: 'sandboxed-incomplete',
        summary: `${reason}. Worktrees preserved; agent reports unverified.`,
        modelNotes: { error: reason },
        createdBy: { kind: 'tool', identifier: 'sandboxed-executor' },
        parentArtifactIds: [input.plan.id],
      });
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'execution.phase-failed',
        payload: { reason, runtime },
      });
      work = this.toChangesRequested(work, 'execution-fail-cap', {
        atomic: () => {
          this.ctx.store.appendEvent({
            workId: work.id,
            type: 'lane.fallback',
            payload: {
              gate: 'codeReview',
              workRevision: work.currentRevision,
              reasons: [reason],
              evaluationHash: contentHash({ workId: work.id, reason, status: 'phase-threw' }),
            },
          });
        },
      });
      this.render(work.id, [
        `Sandboxed-unattended failed: ${reason}`,
        'Task left the autonomous lane. Worktrees are preserved for recovery.',
      ]);
      return work;
    }

    if (!stillOwnsExecution()) {
      // Another sync advanced the task while the implementer ran — do not publish over it.
      return this.ctx.store.getWork(work.id);
    }

    this.ctx.store.appendEvent({
      workId: work.id,
      type:
        run.status === 'limit-exceeded'
          ? 'execution.limit-exceeded'
          : run.status === 'fix-cap'
            ? 'execution.fix-cap'
            : run.status === 'phase-failed'
              ? 'execution.phase-failed'
              : 'execution.sandboxed',
      payload: {
        status: run.status,
        runtime: run.runtime,
        attempts: run.attempts,
        outputBytes: run.outputBytes,
        commits: run.commits,
        // Agent reports are stored for audit but must not be treated as evidence (FR-D5).
        reportsUnverified: run.reports,
        ...(run.status === 'limit-exceeded' ? { limitName: run.limitName, reason: run.reason } : {}),
        ...(run.status === 'fix-cap' || run.status === 'phase-failed' ? { reason: run.reason } : {}),
      },
    });

    const observedRepos = observe(input.repos).repos;
    const hasCommitPastBase = changeSetId(observedRepos) !== baseSetId(observedRepos);
    const completedWithCommit = run.status === 'completed' && hasCommitPastBase;
    // Never promote agent reports into the change-set summary as verified evidence.
    this.saveChangeSet(work.id, observedRepos, {
      status: completedWithCommit ? 'committed' : 'sandboxed-incomplete',
      summary: completedWithCommit
        ? `Sandboxed run completed (observed commit past base; agent reports unverified).`
        : run.status === 'completed'
          ? 'Sandboxed run finished without an observed commit past the base; agent reports unverified.'
          : `Sandboxed run ${run.status}: ${'reason' in run ? run.reason : 'incomplete'}. Agent reports are unverified.`,
      modelNotes: { unverifiedReports: run.reports, adapterCommits: run.commits, observedPastBase: hasCommitPastBase },
      createdBy: { kind: 'tool', identifier: 'sandboxed-executor' },
      parentArtifactIds: [input.plan.id],
    });

    if (run.status === 'fix-cap' || run.status === 'limit-exceeded' || run.status === 'phase-failed') {
      const reason =
        run.status === 'limit-exceeded'
          ? `sandboxed run hit ${run.limitName ?? 'limit'}: ${run.reason}`
          : run.reason;
      work = this.toChangesRequested(work, 'execution-fail-cap', {
        atomic: () => {
          this.ctx.store.appendEvent({
            workId: work.id,
            type: 'lane.fallback',
            payload: {
              gate: 'codeReview',
              workRevision: work.currentRevision,
              reasons: [reason],
              evaluationHash: contentHash({ workId: work.id, reason, status: run.status }),
            },
          });
        },
      });
      this.render(work.id, [
        `Sandboxed-unattended ${run.status}: ${reason}`,
        'Task left the autonomous lane. Fix in the worktree, then a human may retry the lane.',
      ]);
      return work;
    }

    this.render(
      work.id,
      completedWithCommit
        ? [
            `Sandboxed-unattended completed via ${run.runtime} (${run.attempts} check attempt(s)).`,
            'Only git commits and check results are evidence; agent reports are unverified.',
            'Next: turbine task sync <id>',
          ]
        : [
            `Sandboxed-unattended finished via ${run.runtime} without an observed commit past the base.`,
            'Agent reports are unverified. Commit in the worktree, then turbine task sync <id>.',
          ],
    );
    return work;
    } finally {
      this.sandboxInFlight.delete(work.id);
    }
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
    const hasPlan = Boolean(this.ctx.store.getLatestArtifact(work.id, 'plan'));
    return lintPacket(packetPaths(this.ctx.projectRoot, work.id), {
      track: trackFor(work),
      requirementIds: work.acceptanceCriteria.map((c) => c.id),
      hasPlan,
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
    const dualReviews: ReviewResult[] = [];
    for (const artifact of this.ctx.store.listArtifacts(work.id, 'review')) {
      if (artifact.relatedCommit !== cs) continue;
      try {
        const parsed = JSON.parse(this.ctx.store.getArtifactContent(artifact.id)) as ReviewResult;
        if (parsed.reviewer && parsed.changeSetId === cs) dualReviews.push(parsed);
      } catch (e) {
        notes.push(`Dual review artifact ${artifact.id} is unreadable: ${(e as Error).message}`);
      }
    }
    const changeFacts = implemented ? this.factsFor(work.id, repos) : [];
    let gate: PacketData['gate'];
    try {
      gate = implemented ? this.gateDecision(work.id) : undefined;
    } catch {
      gate = undefined;
    }
    const mirrorNotes: string[] = [];
    const lastMirrorPath = join(paths.evidenceDir, 'issue-mirror-last.json');
    if (existsSync(lastMirrorPath)) {
      try {
        const last = JSON.parse(readFileSync(lastMirrorPath, 'utf8')) as MirrorRunResult;
        for (const t of last.targets ?? []) {
          if (t.status === 'mirrored') mirrorNotes.push(`Issue mirror → ${t.provider}:${t.key} updated (comment ${t.commentId ?? '—'})`);
          else if (t.status === 'skipped') mirrorNotes.push(`Issue mirror skipped for ${t.provider}:${t.key}: ${t.reason ?? 'unknown'}`);
          else mirrorNotes.push(`Issue mirror FAILED for ${t.provider}:${t.key}: ${t.reason ?? 'unknown'}`);
        }
      } catch {
        mirrorNotes.push('Issue mirror: previous result file was unreadable');
      }
    }
    const renderNotes = [...notes, ...mirrorNotes];
    // Raw data goes to evidence/, never inline.
    const evidence: Array<[string, unknown]> = [
      ['assessment.json', assessment?.content],
      ['spec.json', spec?.content],
      ['plan.json', plan?.content],
      ['change.json', implemented ? { repos, facts: changeFacts } : undefined],
      ['review.json', review?.content],
      ['dual-reviews.json', dualReviews.length ? dualReviews : undefined],
      ['checks.json', report?.content],
    ];
    const evidenceFiles: string[] = [];
    for (const [name, content] of evidence) {
      if (content === undefined) continue;
      writeFile(join(paths.evidenceDir, name), JSON.stringify(content, null, 2));
      evidenceFiles.push(name);
    }
    // CONTEXT.md and evidence/context.json come from the stored selection, re-rendered every time. No rebuild
    // here: if it no longer matches the checkout, the file says it is stale and why (`next` rebuilds it).
    const taskContext = this.latestTaskContext(work.id);
    if (taskContext) {
      try {
        this.writeTaskContext(work, { selection: taskContext, stale: this.contextStaleness(work, taskContext) });
        evidenceFiles.push('context.json');
      } catch (e) {
        // A transition that already happened must not look failed because CONTEXT.md could not be written: the
        // file is left as it is, the failure is recorded, and `turbine lint` and `next` report it until it is fixed.
        if ((e as { code?: string }).code !== 'E_CONTEXT_UNAVAILABLE') throw e;
        this.ctx.store.appendEvent({ workId: work.id, type: 'context.render-failed', payload: { message: (e as Error).message.split('\n')[0] } });
      }
    }
    const decisions = this.ctx.store.listDecisions(work.id);
    const policyApprovals: Record<string, { by: string; on: string }> = {};
    for (const d of decisions) {
      if (d.actorType !== 'policy' || !d.policyId || !d.policyApprovalDecisionId) continue;
      const approval = this.ctx.store.listDecisions(policyDecisionSubject(d.policyId)).find((a) => a.id === d.policyApprovalDecisionId);
      if (approval) policyApprovals[d.id] = { by: approval.actorId, on: approval.decidedAt.slice(0, 10) };
    }
    const lane = this.laneState(work.id);
    const data: PacketData = {
      projectRoot: this.ctx.projectRoot,
      work,
      policyApprovals,
      laneFallback: lane.fallback,
      track: trackFor(work),
      next: computeNextStep({ projectRoot: this.ctx.projectRoot, work }),
      notes: renderNotes,
      sourceText: source?.content.text ?? work.objective,
      facts: normalizeAssessment(assessment?.content).facts,
      spec: spec ? { hash: spec.hash, data: normalizeSpec(spec.content, work.acceptanceCriteria) } : undefined,
      plan: plan ? { hash: plan.hash, data: normalizePlan(plan.content) } : undefined,
      repos,
      changeSetId: cs,
      implemented,
      changeFacts,
      review: review?.content,
      dualReviews,
      runs: report && report.content.changeSetId === cs ? report.content.runs : undefined,
      decisions,
      gate,
      trace: this.traceFor(work.id),
      analysis: this.analyzeWork(work.id),
      evidenceFiles,
      contextFile: existsSync(paths.context),
      usage: summarizeUsage({
        workId: work.id,
        roleRuns: this.ctx.store.listRoleRuns(work.id),
        records: this.ctx.store.listUsageRecords(work.id),
      }),
    };
    const glossary = join(this.ctx.projectRoot, '.turbine', 'GLOSSARY.md');
    if (!existsSync(glossary)) writeFile(glossary, GLOSSARY);
    renderPacket(data);
    // Packet → linked GitHub/Jira sticky comment (capability + adapter gated). Serialize jobs so
    // concurrent renders cannot create duplicate sticky comments or race stale bodies.
    const sourceText = source?.content.text;
    this.mirrorJob = this.mirrorJob
      .catch(() => undefined)
      .then(async () => {
        try {
          const fresh = this.ctx.store.getWork(workId);
          return await this.runIssueMirror(fresh, sourceText);
        } catch {
          return undefined;
        }
      });
  }

  private async runIssueMirror(work: WorkPackage, sourceText?: string): Promise<MirrorRunResult | undefined> {
    try {
      const adapters: MirrorAdapters = this.mirrorFixtureMode
        ? {
            // Fixture mode: never invent live adapters — missing provider → explicit skip.
            github: this.mirrorAdapters?.github,
            jira: this.mirrorAdapters?.jira,
          }
        : {
            github:
              this.mirrorAdapters?.github ??
              createGitHubAdapter({
                // Host trust is env-only — never take apiBaseUrl from repo project.yaml with the env token.
                apiBaseUrl: process.env.GITHUB_API_BASE_URL || undefined,
                token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
              }),
            jira:
              this.mirrorAdapters?.jira ??
              createJiraAdapter({
                // Host trust is env-only — never take siteUrl from repo project.yaml with the env token.
                siteUrl: process.env.JIRA_SITE_URL || '',
                email: process.env.JIRA_EMAIL,
                apiToken: process.env.JIRA_API_TOKEN,
              }),
          };
      const result = await mirrorLinkedIssues({
        projectRoot: this.ctx.projectRoot,
        work,
        config: this.ctx.config,
        sourceText,
        adapters,
        fixtureMode: this.mirrorFixtureMode,
      });
      if (result.targets.length) {
        try {
          this.ctx.store.appendEvent({
            workId: work.id,
            type: 'issue.mirror',
            payload: {
              targets: result.targets.map((t) => ({
                provider: t.provider,
                key: t.key,
                status: t.status,
                reason: t.reason,
                commentId: t.commentId,
              })),
            },
          });
        } catch {
          // Store may already be closed (tests); evidence file is the durable record.
        }
      }
      return result;
    } catch (e) {
      const paths = packetPaths(this.ctx.projectRoot, work.id);
      mkdirSync(paths.evidenceDir, { recursive: true });
      const failed: MirrorRunResult = {
        at: new Date().toISOString(),
        workId: work.id,
        targets: [
          {
            provider: 'github',
            key: '—',
            status: 'failed',
            reason: (e as Error).message,
          },
        ],
      };
      writeFileSync(join(paths.evidenceDir, 'issue-mirror-last.json'), JSON.stringify(failed, null, 2) + '\n');
      try {
        this.ctx.store.appendEvent({
          workId: work.id,
          type: 'issue.mirror',
          payload: { error: (e as Error).message },
        });
      } catch {
        // Store may already be closed (tests); evidence file is the durable record.
      }
      return failed;
    }
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
    let content: Record<string, unknown>;
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
    if (this.sandboxInFlight.has(work.id)) {
      return {
        work,
        moved: false,
        reason: 'Sandboxed-unattended run still in flight; wait for it to finish before capturing commits.',
      };
    }
    // Cross-Engine instances share the store: refuse capture while the latest change report is still running.
    const latestChange = this.ctx.store.getLatestArtifact(work.id, 'change-report');
    if (latestChange) {
      try {
        const body = JSON.parse(this.ctx.store.getArtifactContent(latestChange.id)) as { status?: string };
        if (body.status === 'sandboxed-running') {
          return {
            work,
            moved: false,
            reason: 'Sandboxed-unattended run still marked sandboxed-running in the change report; wait for it to finish.',
          };
        }
      } catch {
        // Unreadable change report is handled elsewhere; do not block capture here.
      }
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

  /** A failed-closed dual-review handoff is valid only for the exact recorded change set. */
  private dualReviewHandoffIsCurrent(workId: string): boolean {
    const repos = this.repoStates(workId);
    if (!repos.length) return false;
    const handoff = this.ctx.store
      .listEvents(workId)
      .filter((event) => event.type === 'review.handed-off')
      .at(-1);
    return (
      handoff?.payload.mode === 'dual-review-failed-closed' &&
      handoff.payload.changeSetId === changeSetId(repos)
    );
  }

  /** Uncommitted files in any worktree (approving code with uncommitted work is refused). */
  uncommitted(workId: string): Array<{ repo: string; paths: string[] }> {
    const repos = this.repoStates(workId).filter((r) => existsSync(r.worktreePath));
    return repos.length ? observe(repos).uncommitted : [];
  }

  private async runReviewWithModel(input: {
    work: WorkPackage;
    facts: RepoFacts[];
    diffText: string;
    changeSetId: string;
    model: ModelAdapter;
    maxOutputTokens: number;
    reviewer?: ReviewResult['reviewer'];
    requireParseable?: boolean;
  }): Promise<ReviewResult> {
    const { work, facts, diffText } = input;
    const spec = this.ctx.store.getLatestArtifact(work.id, 'specification');
    const plan = this.ctx.store.getLatestArtifact(work.id, 'plan');
    const skill = getSkill(this.ctx.factoryRoot, 'core/review-change');
    const lenses = selectLenses(work, facts);
    const findings: Finding[] = [];
    const discarded: DiscardedFinding[] = [];
    const claimMismatches: ClaimMismatch[] = [];
    const summaries: Array<{ lens: Lens; summary: string }> = [];
    const coverage: CoverageLink[] = [];
    for (const lens of lenses) {
      this.checkBudget(work.id);
      let result: Awaited<ReturnType<Engine['runAsRole']>>;
      try {
        result = await this.runAsRole({
          skill,
          model: input.model,
          workId: work.id,
          roleId: lens === 'security' ? 'security-reviewer' : 'code-reviewer',
          context: [
            LENS_INSTRUCTIONS[lens],
            REVIEW_OUTPUT_CONTRACT,
            `REQUIREMENTS:\n${work.acceptanceCriteria.map((c) => `- ${c.id} (${c.priority ?? 'P1'}): ${c.statement}`).join('\n')}`,
            `SPEC:\n${spec ? this.ctx.store.getArtifactContent(spec.id).slice(0, 6000) : '(none)'}`,
            `PLAN:\n${plan ? this.ctx.store.getArtifactContent(plan.id).slice(0, 4000) : '(none)'}`,
            `FACTS (from git):\n${factsBlock(facts)}`,
            `DIFF:\n${diffText}`,
          ].join('\n\n'),
          schemaId: 'review',
          maxOutputTokens: input.maxOutputTokens,
        });
      } finally {
        this.ctx.store.incrementBudget(work.id, 1);
      }
      if (input.requireParseable && !reviewOutputIsParseable(result.content)) {
        throw new LaneIneligible(`${input.reviewer?.profile ?? input.model.id} returned incomplete or unparseable review output for ${lens}`);
      }
      const t = triage({ lens, raw: result.content, facts, diffText, startIndex: findings.length });
      findings.push(...t.findings);
      discarded.push(...t.discarded);
      for (const mismatch of crossCheckClaims(result.content, facts)) {
        if (!claimMismatches.some((x) => x.claim === mismatch.claim)) claimMismatches.push(mismatch);
      }
      if (lens === 'tests') {
        const checked = validateCoverage(result.content, facts, work.acceptanceCriteria.map((c) => c.id));
        coverage.push(...checked.links);
        discarded.push(...checked.rejected);
      }
      const summary = (result.content as { summary?: unknown })?.summary;
      if (typeof summary === 'string' && summary.trim()) summaries.push({ lens, summary: summary.trim().slice(0, 400) });
    }
    return {
      changeSetId: input.changeSetId,
      reviewer: input.reviewer,
      lenses,
      findings,
      discarded,
      claimMismatches,
      summaries,
      truncatedRepos: [],
      coverage,
      disposition: disposition(findings, claimMismatches),
    };
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
    const model = getModel(this.ctx.config.models.profiles.analysis?.model ?? 'mock-default');
    const review = await this.runReviewWithModel({
      work,
      facts,
      diffText: diff.text,
      changeSetId: changeSet,
      model,
      maxOutputTokens: this.ctx.config.models.profiles.analysis?.maxOutputTokens ?? 3000,
    });
    review.truncatedRepos = diff.truncated;

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
          kept: review.findings.length,
          discarded: review.discarded.length,
          claimMismatches: review.claimMismatches.length,
        },
      });
    });
    this.render(work.id, [
        `AI review: ${review.disposition} (${review.findings.length} finding(s) kept, ${review.discarded.length} discarded as unverifiable).`,
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

  private async runDualLaneReview(
    work: WorkPackage,
    policy: ApprovedLanePolicy,
    expectedChangeSetId: string,
  ): Promise<{
    reviews: [ReviewResult, ReviewResult];
    artifacts: Array<{ id: string; contentHash: string }>;
    clean: boolean;
    disagreement: boolean;
  }> {
    const profiles = resolvePolicyReviewers(policy.policy, this.ctx.config.models.profiles);
    if (!profiles) throw new LaneIneligible(`policy ${policy.name} does not configure codeReview`);
    const repos = this.repoStates(work.id);
    if (!repos.length || changeSetId(repos) !== expectedChangeSetId) {
      throw new LaneIneligible('the change set moved before dual review started');
    }
    const facts = computeFacts(repos);
    const diff = collectDiffs(repos);
    if (diff.truncated.length) {
      throw new LaneIneligible(
        `dual review cannot cover truncated diff content in: ${diff.truncated.join(', ')}`,
      );
    }
    const reviews: ReviewResult[] = [];
    for (const profile of profiles) {
      const model = getModel(profile.model);
      if (model.provider !== profile.provider) {
        throw new LaneIneligible(
          `reviewer profile ${profile.name} requires provider ${profile.provider}, but model ${profile.model} resolved to ${model.provider}`,
        );
      }
      const review = await this.runReviewWithModel({
        work,
        facts,
        diffText: diff.text,
        changeSetId: expectedChangeSetId,
        model,
        maxOutputTokens: profile.maxOutputTokens,
        reviewer: { profile: profile.name, provider: profile.provider, model: profile.model },
        requireParseable: true,
      });
      review.truncatedRepos = diff.truncated;
      reviews.push(review);
      const observed = observe(this.repoStates(work.id));
      if (observed.uncommitted.length || changeSetId(observed.repos) !== expectedChangeSetId) {
        throw new LaneIneligible('the change set moved while dual review was running');
      }
    }
    const pair = reviews as [ReviewResult, ReviewResult];
    const blocking = pair.map((r) => r.disposition === 'needs-attention') as [boolean, boolean];
    const disagreement = blocking[0] !== blocking[1];
    const clean = !blocking[0] && !blocking[1];
    const change = this.ctx.store.getLatestArtifact(work.id, 'change-report');
    this.dualReviewBeforePublish?.();
    const artifacts = this.ctx.store.transaction(() => {
      const current = this.ctx.store.getWork(work.id);
      if (current.currentState !== work.currentState || current.currentRevision !== work.currentRevision) {
        throw new LaneIneligible('task state or revision changed while dual review was running');
      }
      if (!this.laneState(work.id).inLane) {
        throw new LaneIneligible('task left the autonomous lane while dual review was running');
      }
      const observed = observe(this.repoStates(work.id));
      if (observed.uncommitted.length || changeSetId(observed.repos) !== expectedChangeSetId) {
        throw new LaneIneligible('the change set moved before dual review was published');
      }
      const artifacts = pair.map((review) =>
        this.saveArtifact({
          workId: work.id,
          type: 'review',
          content: review,
          createdBy: { kind: 'agent', identifier: `code-reviewer:${review.reviewer!.profile}` },
          parentArtifactIds: change ? [change.id] : [],
          relatedCommit: expectedChangeSetId,
        }),
      );
      if (change) {
        for (const artifact of artifacts) {
          this.ctx.store.saveEdge(
            createEdge({
              workId: work.id,
              upstreamArtifactId: change.id,
              upstreamRevisionHash: change.contentHash,
              downstreamArtifactId: artifact.id,
              downstreamRevisionHash: artifact.contentHash,
              reason: 'change-to-dual-review',
              affectedObligationIds: ['obl_code_review'],
            }),
          );
        }
      }
      pair[0].lenses.forEach((lens) => {
        const lensBlocking = pair.map(
          (review) =>
            review.findings.some((finding) => finding.lens === lens && finding.severity === 'high') ||
            (lens === 'spec-compliance' && review.claimMismatches.length > 0),
        ) as [boolean, boolean];
        this.ctx.store.saveReviewerAgreement({
          workId: work.id,
          changeSetId: expectedChangeSetId,
          policyId: policy.name,
          policyHash: policy.contentHash,
          lens,
          reviewerProfiles: [profiles[0].name, profiles[1].name],
          blocking: lensBlocking,
          agreed: lensBlocking[0] === lensBlocking[1],
        });
      });
      artifacts.forEach((artifact, index) => {
        const review = pair[index]!;
        this.ctx.store.saveEvidence({
          id: createId('ev'),
          workId: work.id,
          kind: 'review',
          reviewerId: review.reviewer!.profile,
          result: review.disposition === 'no-blocking-findings' ? 'passed' : 'failed',
          commitSha: expectedChangeSetId,
          observedAt: now(),
          logArtifactId: artifact.id,
          limitations: ['Autonomous AI reviewer; policy pass requires both configured reviewers to complete cleanly'],
        });
      });
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'review.dual-completed',
        payload: {
          policy: policy.name,
          changeSetId: expectedChangeSetId,
          reviewers: profiles.map((p) => ({ profile: p.name, provider: p.provider, model: p.model })),
          artifacts: artifacts.map((a) => a.id),
          dispositions: pair.map((r) => r.disposition),
          disagreement,
        },
      });
      return artifacts;
    });
    this.render(work.id, [
      disagreement
        ? 'Dual reviewers disagree; a human decides code review.'
        : clean
          ? `Dual review completed cleanly for policy ${policy.name}.`
          : 'Both autonomous reviewers found blocking issues; a human decides code review.',
    ]);
    return {
      reviews: pair,
      artifacts: artifacts.map((artifact) => ({ id: artifact.id, contentHash: artifact.contentHash })),
      clean,
      disagreement,
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
      work = this.toChangesRequested(work, 'code-review');
    }
    if (work.currentState !== 'CHANGES_REQUESTED') this.ctx.store.saveWork(work);
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
      work = this.toChangesRequested(work, 'verification-failed');
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
      work = this.toChangesRequested(work, 'acceptance-failed');
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
    this.queueAcceptedPr(work);
    return { work, accepted: true };
  }

  /**
   * MD-first control surface. Sync reads EDITS from the task packet (requirements text,
   * acceptance observations) and advances AI/tool stages. It never records a human
   * decision: Decision blocks in markdown are display-only, because any agent with file
   * access could write "Approved: yes". Humans approve with `turbine task approve` in their
   * own terminal. When the step leaves the task at a human gate, an approved lane policy may pass it
   * (recorded as a policy decision, never as a human one).
   */
  async syncFromMarkdown(
    idOrAlias: string,
    actorId = 'local-user',
  ): Promise<{ action: string; work: WorkPackage; detail?: unknown }> {
    let pending = this.ctx.store.getWork(idOrAlias);
    // A worktree that moved past the accepted head makes the ACCEPTED task stale: the sync step recaptures the
    // head, so neither GitHub's answer (an ejection would send stale work to CHANGES_REQUESTED) nor a landing
    // retry may be applied to it first.
    if (pending.currentState !== 'ACCEPTED' || !this.worktreeMovedPastRecorded(pending.id)) {
      // Reconcile GitHub first: an ejection or merge decides whether a landing retry is still owed at all.
      await this.pollAcceptedPr(pending);
      pending = this.ctx.store.getWork(pending.id);
      // Landing resumes only for the accepted head still in the worktree.
      if (this.resumeAcceptedPr(pending)) await this.waitForLanePr();
      pending = this.ctx.store.getWork(pending.id);
    }
    if (pending.currentState === 'AI_REVIEW') {
      pending = this.refreshHeads(pending.id).work;
      const lane = await this.tryLanePass(pending.id);
      if (
        lane &&
        (lane.status === 'passed' || lane.status === 'retry' || !!lane.evaluatedChangeSetId)
      ) {
        return this.finishLaneSync({ action: 'status', work: pending }, lane);
      }
    }
    const result = await this.syncStep(idOrAlias, actorId);
    const lane = await this.tryLanePass(result.work.id);
    if (!lane) return result;
    return this.finishLaneSync(result, lane);
  }

  private async finishLaneSync(
    result: { action: string; work: WorkPackage; detail?: unknown },
    lane: LaneOutcome,
  ): Promise<{ action: string; work: WorkPackage; detail?: unknown }> {
    const laneDetail = { status: lane.status, gate: lane.gate, policy: lane.policy, decisionId: lane.decision?.id, reasons: lane.reasons };
    const detail = { ...(result.detail && typeof result.detail === 'object' ? result.detail : {}), lane: laneDetail };
    try {
      const evaluatedPolicy =
        lane.policy ??
        (lane.evaluatedChangeSetId
          ? policyForReviewPair(this.ctx.store, lane.work.id, lane.evaluatedChangeSetId)
          : null);
      if ((lane.status === 'passed' || lane.status === 'fallback') && evaluatedPolicy) {
        evaluateSuspendWhen(this.ctx.store, evaluatedPolicy);
      }
      if (lane.status === 'passed') {
        return { action: 'lane.passed', work: lane.work, detail };
      }
      if (
        lane.gate === 'codeReview' &&
        lane.evaluatedChangeSetId &&
        lane.work.currentState === 'AI_REVIEW' &&
        (lane.status === 'fallback' || lane.status === 'out-of-lane')
      ) {
        this.laneBeforeHandoff?.();
        const refreshed = this.refreshHeads(lane.work.id).work;
        const handedOff = this.handoffDualReviewToHuman(
          refreshed,
          lane.evaluatedChangeSetId,
          lane.reasons,
        );
        if (handedOff.currentState === 'HUMAN_CODE_REVIEW') {
          return {
            action: 'review.human',
            work: handedOff,
            detail: { ...detail, openFile: packetPaths(this.ctx.projectRoot, handedOff.id).review },
          };
        }
        return { ...result, work: handedOff, detail };
      }
      return { ...result, work: lane.work, detail };
    } finally {
      await this.waitForMirror();
    }
  }

  private async syncStep(
    idOrAlias: string,
    _actorId = 'local-user',
  ): Promise<{ action: string; work: WorkPackage; detail?: unknown }> {
    try {
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

    // PLANNING is where a task stays when the project facts could not be refreshed; re-running
    // `sync` after the repository is repaired resumes planning (requirements are already approved).
    if (work.currentState === 'REQUIREMENTS_APPROVED' || work.currentState === 'PLANNING') {
      const planned = await this.plan(work.id, { onlyIfPending: true });
      return { action: 'plan', work: planned.work, detail: { planHash: planned.planHash, packetDir: planned.packetDir, ...(planned.skipped ? { skipped: true } : {}) } };
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

    if (
      work.currentState === 'HUMAN_CODE_REVIEW' &&
      !this.aiReviewIsCurrent(work.id) &&
      !this.dualReviewHandoffIsCurrent(work.id)
    ) {
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
    } finally {
      await this.waitForMirror();
    }
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
        if (!this.aiReviewIsCurrent(work.id) && !this.dualReviewHandoffIsCurrent(work.id)) {
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

  /**
   * Lane membership from the event log: a `lane.fallback` takes the task out of the lane until a human's
   * `lane.retry` (turbine task lane <id> --retry) puts it back.
   */
  laneState(idOrAlias: string): { inLane: boolean; fallback?: LaneFallback } {
    const work = this.ctx.store.getWork(idOrAlias);
    const last = this.ctx.store
      .listEvents(work.id)
      .filter((e) => e.type === 'lane.fallback' || e.type === 'lane.retry')
      .at(-1);
    if (!last || last.type === 'lane.retry') return { inLane: true };
    const p = last.payload as Partial<LaneFallback>;
    if (typeof p.evaluatedChangeSetId === 'string') {
      const repos = this.repoStates(work.id);
      if (!repos.length || changeSetId(repos) !== p.evaluatedChangeSetId) return { inLane: true };
    }
    return {
      inLane: false,
      fallback: {
        gate: p.gate ?? 'requirements',
        reasons: Array.isArray(p.reasons) ? p.reasons.map(String) : ['(reasons not recorded)'],
        evaluationHash: typeof p.evaluationHash === 'string' ? p.evaluationHash : contentHash(last.payload),
        evaluatedChangeSetId:
          typeof p.evaluatedChangeSetId === 'string' ? p.evaluatedChangeSetId : undefined,
        at: last.createdAt,
      },
    };
  }

  /** Human-only (callers establish presence): put a task that fell back to the human flow back in the lane. */
  laneRetry(idOrAlias: string, input: { actor: string; confirmToken: string; presence: string }) {
    // Read, token check, and append under one write lock so a newer fallback cannot slip in between.
    const result = this.ctx.store.transaction(() => {
      const work = this.ctx.store.getWork(idOrAlias);
      const state = this.laneState(work.id);
      if (state.inLane || !state.fallback) {
        throw err('E_INVALID_TRANSITION', `${work.id} has not fallen back to the human flow; it is still in the lane`);
      }
      const token = state.fallback.evaluationHash.replace(/^sha256:/, '').slice(0, 8);
      if (input.confirmToken.trim() !== token) {
        throw err('E_STALE_REVISION', `Confirmation "${input.confirmToken}" does not match the fallback being retried (${token}).`);
      }
      if (!input.actor.trim()) throw err('E_UNTRUSTED_IDENTITY', 'Reviewer name is required');
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'lane.retry',
        payload: { by: input.actor.trim(), presence: input.presence, fallbackEvaluationHash: state.fallback.evaluationHash },
      });
      return { work, retried: state.fallback, actor: input.actor.trim() };
    });
    this.render(result.work.id, [`Put back in the autonomous lane by ${result.actor}. Next: turbine task sync ${result.work.id}`]);
    return { work: result.work, retried: result.retried };
  }

  /** The confirmation code `task lane --retry` asks for, with the fallback it retries. */
  pendingLaneRetry(idOrAlias: string) {
    const state = this.laneState(idOrAlias);
    if (state.inLane || !state.fallback) throw err('E_INVALID_TRANSITION', 'This task has not fallen back to the human flow; it is still in the lane');
    return { fallback: state.fallback, confirmToken: state.fallback.evaluationHash.replace(/^sha256:/, '').slice(0, 8) };
  }

  /** Every fact the eligibility evaluation needs, read at one commit. Read failures become `readErrors`. */
  private laneFacts(work: WorkPackage, gate: LaneGate): LaneFacts {
    const readErrors: string[] = [];
    const attempt = <T>(label: string, fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch (e) {
        readErrors.push(`${label}: ${(e as Error).message.split('\n')[0]}`);
        return fallback;
      }
    };
    const codeGate = gate === 'codeReview' || gate === 'acceptance';
    const repos = codeGate ? this.repoStates(work.id) : [];
    const commit = attempt('commit', () => this.laneCommit(work.id, codeGate), '');
    const subject = codeGate
      ? commit
      : (this.ctx.store.getLatestArtifact(work.id, gate === 'requirements' ? 'specification' : 'plan')?.contentHash ?? '');
    if (!subject) readErrors.push(`no ${gate === 'requirements' ? 'specification' : gate === 'plan' ? 'plan' : 'change set'} to decide on`);
    // At AI_REVIEW there is intentionally no advisory review yet. Check the preconditions that
    // do not depend on that advisory artifact; the lane's own dual pair supplies review evidence.
    if (work.currentState === 'AI_REVIEW' && gate === 'codeReview') {
      attempt(
        'approval preconditions',
        () => {
          const dirty = this.uncommitted(work.id);
          if (dirty.length) throw new Error('worktree has uncommitted changes');
        },
        undefined,
      );
    } else {
      attempt('approval preconditions', () => this.pendingApproval(work.id), undefined);
    }
    const lintErrors = attempt('task lint', () => this.lintWork(work.id).filter((i) => i.level === 'error').map((i) => `${i.file}: ${i.message}`), []);
    const analysisGate = gate === 'acceptance' ? undefined : gate === 'codeReview' ? 'code-review' : gate;
    const criticalFindings = attempt(
      'task analyze',
      () => this.analyzeWork(work.id).filter((a) => a.severity === 'CRITICAL' && a.gate === analysisGate).map((a) => a.message),
      [],
    );
    let change: LaneFacts['change'];
    if (codeGate) {
      change = attempt(
        'change facts',
        () => {
          if (!repos.length) throw new Error('no worktrees recorded');
          const facts = computeFacts(repos);
          return {
            files: facts.flatMap((f) => f.files.map((x) => x.path)),
            changedLines: facts.reduce((n, f) => n + f.insertions + f.deletions, 0),
            dependencyChanges: facts.flatMap((f) => [...f.dependencies.added, ...f.dependencies.changed, ...f.dependencies.removed].map((d) => `${f.repo}:${d.name}`)),
          };
        },
        undefined,
      );
    }
    const triggers = [
      ...work.risk.reasons,
      ...detectHardRiskTriggers(work),
      ...detectSoftTriggers(work),
      ...(change?.dependencyChanges.length ? ['new-dependency'] : []),
    ].filter((t) => LANE_TRIGGER_NAMES.includes(t));
    let acceptance: LaneFacts['acceptance'];
    if (gate === 'acceptance') {
      acceptance = attempt(
        'acceptance evidence',
        () => {
          const p0 = this.traceFor(work.id)
            .filter((r) => r.priority === 'P0')
            .map((r) => ({ id: r.requirementId, status: r.status ?? ('unknown' as const) }));
          const evidence = this.ctx.store.listEvidence(work.id).filter((e) => e.commitSha === commit);
          const checks = repos.flatMap((r) =>
            (r.primary ? this.ctx.config.quality.checks : r.checks).map((cmd) => {
              const label = checkLabel(r.name, cmd);
              const latest = evidence
                .filter((e) => e.commandOrCheck === label)
                .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
              return { command: label, result: latest?.result ?? 'not-run' };
            }),
          );
          // Waivers are a human's risk acceptance: a policy pass needs the obligations actually satisfied.
          const gateBlocking = this.gateDecision(work.id, ['obl_manual_sqa']).blocking.map((b) => `${b.id} (${b.status})`);
          return { p0, checks, gateBlocking };
        },
        undefined,
      );
    }
    return {
      gate,
      workId: work.id,
      workRevision: work.currentRevision,
      state: work.currentState,
      commit,
      subject,
      riskProfile: work.risk.profile,
      triggers: [...new Set(triggers)].sort(),
      labels: [...new Set(work.sourceRefs.flatMap((s) => s.labels ?? []))].sort(),
      repoCount: 1 + (work.repositories?.length ?? 0),
      unknowns: work.unknowns,
      criteriaCount: work.acceptanceCriteria.length,
      lintErrors,
      criticalFindings,
      change,
      acceptance,
      readErrors,
      reviewerProfiles: this.ctx.config.models.profiles,
    };
  }

  /** Project HEAD before code exists; the observed change set id (every worktree HEAD) after. */
  private laneCommit(workId: string, codeGate: boolean): string {
    if (!codeGate) {
      const h = repoHead(this.ctx.projectRoot);
      if ('error' in h) throw new Error(`project HEAD is unreadable (${h.error})`);
      return h.head;
    }
    const repos = this.repoStates(workId);
    if (!repos.length) throw new Error('no worktrees recorded');
    const seen = observe(repos).repos;
    if (changeSetId(seen) !== changeSetId(repos)) throw new Error('a worktree has commits that are not captured yet; run sync');
    return changeSetId(seen);
  }

  /** Move a failed autonomous review to the human gate only for the change set it evaluated. */
  private handoffDualReviewToHuman(
    work: WorkPackage,
    evaluatedChangeSetId: string,
    reasons: string[],
  ): WorkPackage {
    const next = this.ctx.store.transaction(() => {
      const current = this.ctx.store.getWork(work.id);
      if (current.currentState !== 'AI_REVIEW' || current.currentRevision !== work.currentRevision) {
        return current;
      }
      const repos = this.repoStates(work.id);
      const observed = repos.length ? observe(repos) : undefined;
      if (
        !observed ||
        observed.uncommitted.length ||
        changeSetId(repos) !== evaluatedChangeSetId ||
        changeSetId(observed.repos) !== evaluatedChangeSetId
      ) {
        return current;
      }
      const transitioned = transition(current, 'HUMAN_CODE_REVIEW');
      this.ctx.store.saveWork(transitioned);
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'review.handed-off',
        payload: {
          mode: 'dual-review-failed-closed',
          changeSetId: evaluatedChangeSetId,
          reasons,
        },
      });
      return transitioned;
    });
    this.render(work.id, [
      'Autonomous dual review did not pass; a human decides code review.',
      ...reasons.slice(0, 3),
    ]);
    return next;
  }

  /**
   * At a gate that waits for a human, try to pass it with an approved, active lane policy. Never records a
   * human decision. Returns undefined when no lane policy has ever been approved (the lane is not in use).
   */
  async tryLanePass(idOrAlias: string): Promise<LaneOutcome | undefined> {
    let work = this.ctx.store.getWork(idOrAlias);
    const gate = LANE_GATE_FOR_STATE[work.currentState];
    if (!gate) return undefined;
    let stored: ReturnType<WorkStore['listLanePolicies']>;
    try {
      stored = this.ctx.store.listLanePolicies();
    } catch (e) {
      return this.laneFallback(work, gate, [], [`lane policy store unreadable: ${(e as Error).message}`]);
    }
    if (!stored.length) return undefined;
    const lane = this.laneState(work.id);
    if (!lane.inLane) {
      return {
        status: 'out-of-lane',
        work,
        gate,
        reasons: lane.fallback?.reasons ?? [],
        evaluatedChangeSetId: lane.fallback?.evaluatedChangeSetId,
      };
    }

    let statuses: PolicyStatus[];
    try {
      statuses = policyStatuses(this.ctx.store, this.ctx.projectRoot).policies;
    } catch (e) {
      return this.laneFallback(work, gate, [], [`lane policies unreadable: ${(e as Error).message}`]);
    }
    const unusable = statuses
      .filter((s) => s.approved || s.state === 'invalid')
      .filter((s) => s.state !== 'active')
      .map((s) => `policy ${s.name} is ${s.state}${s.reason ? `: ${s.reason}` : ''}`);
    const active = statuses.filter((s) => s.state === 'active').map((s) => s.approved!);

    let moved = '';
    let reviewedChangeSet: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        work = this.ctx.store.getWork(work.id);
        if (LANE_GATE_FOR_STATE[work.currentState] !== gate) return { status: 'retry', work, gate, reasons: [moved] };
      }
      let reviewClaim: string | undefined;
      try {
      // Re-check membership each attempt: a concurrent sync may have recorded lane.fallback after evaluation.
      const membership = this.laneState(work.id);
      if (!membership.inLane) {
        return {
          status: 'out-of-lane',
          work,
          gate,
          reasons: membership.fallback?.reasons ?? [moved || 'task left the lane during evaluation'],
          evaluatedChangeSetId: membership.fallback?.evaluatedChangeSetId,
        };
      }
      const facts = this.laneFacts(work, gate);
      // The PR target whose protection is evaluated is the one the acceptance lands on.
      let acceptanceTarget: LanePrTarget | undefined;
      if (gate === 'acceptance') {
        const target = (acceptanceTarget = this.resolveLanePrTarget());
        const protection = target
          ? await confirmMergeQueueProtection(target, work.id)
          : {
              status: 'unknown' as const,
              mergeQueueRequired: false,
              turbineGateRequired: false,
              reason: 'GitHub repository or adapter is unavailable',
            };
        facts.lanePr = {
          configAllowsCreate: configAllows(this.ctx.config.tools, 'pr.create'),
          configAllowsMerge: configAllows(this.ctx.config.tools, 'pr.merge'),
          protection,
        };
      }
      let evaluations = active.map((p) => evaluateLaneEligibility(p, facts));
      const winnerIdx = evaluations.findIndex((e) => e.status === 'eligible');
      if (winnerIdx < 0) return this.laneFallback(work, gate, evaluations, unusable);
      const winner = active[winnerIdx]!;
      if (gate === 'codeReview') {
        reviewedChangeSet = facts.commit;
        try {
          reviewClaim = this.ctx.store.claimWork(work.id, 'dual review');
        } catch (e) {
          return {
            status: 'retry',
            work: this.ctx.store.getWork(work.id),
            gate,
            reasons: [(e as Error).message],
            evaluatedChangeSetId: facts.commit,
          };
        }
        try {
          const dual = await this.runDualLaneReview(work, winner, facts.commit);
          facts.dualReview = {
            changeSetId: facts.commit,
            complete: true,
            clean: dual.clean,
            disagreement: dual.disagreement,
            artifacts: dual.artifacts,
          };
        } catch (e) {
          const refreshed = this.refreshHeads(work.id);
          if (refreshed.changed) {
            moved = `the change set moved during dual review; recaptured ${this.currentCommit(work.id)?.slice(0, 12) ?? 'new HEAD'}`;
            this.ctx.store.appendEvent({
              workId: work.id,
              type: 'lane.discarded',
              payload: { gate, reason: moved, evaluationHash: evaluations[winnerIdx]!.evaluationHash },
            });
            continue;
          }
          facts.dualReview = {
            changeSetId: facts.commit,
            complete: false,
            clean: false,
            disagreement: false,
            reason: `dual review incomplete: ${(e as Error).message}`,
          };
        }
        evaluations = active.map((p, index) =>
          index === winnerIdx ? evaluateLaneEligibility(p, facts, { requireDualReview: true }) : evaluations[index]!,
        );
        if (evaluations[winnerIdx]!.status !== 'eligible') {
          return this.laneFallback(work, gate, evaluations, unusable, facts.commit, winner.name);
        }
      }
      this.laneBeforeSave?.();
      const saved = this.savePolicyPass(work, facts, winner, evaluations[winnerIdx]!, acceptanceTarget);
      if ('work' in saved) {
        this.render(work.id, [`${LANE_GATE_LABEL[gate]} ${saved.decision.rationale}.`]);
        // The pass is committed: its suspension check must run even when PR automation throws. The landing
        // error (if any) is rethrown afterwards, so a failing GitHub can neither hide a due suspension nor be
        // hidden by it.
        let landingError: unknown;
        if (saved.work.currentState === 'ACCEPTED') {
          try {
            this.queueAcceptedPr(saved.work);
            await this.waitForLanePr();
          } catch (e) {
            landingError = e;
          }
        }
        let suspendError: unknown;
        try {
          evaluateSuspendWhen(this.ctx.store, winner.name);
        } catch (e) {
          suspendError = e;
        }
        if (landingError) throw landingError;
        if (suspendError) throw suspendError;
        return { status: 'passed', work: saved.work, gate, policy: winner.name, decision: saved.decision, reasons: [] };
      }
      if ('ineligible' in saved) {
        return this.laneFallback(work, gate, evaluations, [saved.ineligible], reviewedChangeSet, winner.name);
      }
      moved = saved.moved;
      if (gate === 'codeReview') this.refreshHeads(work.id);
      this.ctx.store.appendEvent({ workId: work.id, type: 'lane.discarded', payload: { gate, reason: moved, evaluationHash: evaluations[winnerIdx]!.evaluationHash } });
      } finally {
        if (reviewClaim) this.ctx.store.releaseClaim(work.id, reviewClaim);
      }
    }
    // Facts kept moving: nothing was saved and the task stays in the lane, so the next sync evaluates again.
    this.render(work.id, [`Autonomous lane: ${moved}; no policy decision was saved. Run sync again.`]);
    return { status: 'retry', work: this.ctx.store.getWork(work.id), gate, reasons: [moved] };
  }

  /** Test seam: runs after a lane evaluation and before its decision is saved. */
  laneBeforeSave?: () => void;

  /** Test seam: runs after model calls and before completed dual reviews are published. */
  dualReviewBeforePublish?: () => void;

  /** Test seam: runs after lane fallback and before its human handoff. */
  laneBeforeHandoff?: () => void;

  private laneFallback(
    work: WorkPackage,
    gate: LaneGate,
    evaluations: LaneEvaluation[],
    extra: string[],
    evaluatedChangeSetId?: string,
    evaluatedPolicy?: string,
  ): LaneOutcome {
    const reasons = [
      ...extra,
      ...evaluations.flatMap((e) => e.reasons.map((r) => `${e.policy}: ${r}`)),
    ];
    if (!reasons.length) reasons.push('no active lane policy');
    const evaluationHash = contentHash({ workId: work.id, revision: work.currentRevision, gate, evaluations: evaluations.map((e) => e.evaluationHash), extra });
    // Recheck gate / revision / membership under the same write lock as the append so a human
    // approval that lands mid-sync cannot leave a stale fallback blocking the next gate.
    const outcome = this.ctx.store.transaction(() => {
      const current = this.ctx.store.getWork(work.id);
      if (current.currentState !== work.currentState || current.currentRevision !== work.currentRevision) {
        return { status: 'retry' as const, work: current, gate, reasons: ['task moved before the fallback was recorded'] };
      }
      if (LANE_GATE_FOR_STATE[current.currentState] !== gate) {
        return { status: 'retry' as const, work: current, gate, reasons: ['gate changed before the fallback was recorded'] };
      }
      const membership = this.laneState(work.id);
      if (!membership.inLane) {
        return {
          status: 'out-of-lane' as const,
          work: current,
          gate,
          reasons: membership.fallback?.reasons ?? ['task left the lane before the fallback was recorded'],
        };
      }
      this.ctx.store.appendEvent({
        workId: work.id,
        type: 'lane.fallback',
        payload: {
          gate,
          workRevision: current.currentRevision,
          reasons,
          evaluationHash,
          evaluatedChangeSetId,
          evaluations: evaluations.map((e) => ({ policy: e.policy, policyHash: e.policyHash, status: e.status, evaluationHash: e.evaluationHash })),
        },
      });
      return { status: 'fallback' as const, work: current, gate, reasons, evaluatedChangeSetId, policy: evaluatedPolicy };
    });
    if (outcome.status === 'fallback') {
      this.render(work.id, [`Autonomous lane: a human decides the ${gate} gate — ${reasons.slice(0, 3).join('; ')}${reasons.length > 3 ? '; …' : ''}`]);
    }
    return outcome;
  }

  /**
   * Save the policy decision and the transition in ONE transaction that first re-reads the task state, the
   * commit, the subject hash and the policy snapshot. Anything that moved discards the evaluation (rule 5).
   */
  private savePolicyPass(
    work: WorkPackage,
    facts: LaneFacts,
    policy: ApprovedLanePolicy,
    evaluation: LaneEvaluation,
    /** For the acceptance gate: the PR target whose protection was evaluated; it is recorded with the decision. */
    acceptanceTarget?: LanePrTarget,
  ): { work: WorkPackage; decision: Decision } | { moved: string } | { ineligible: string } {
    const approval = this.ctx.store
      .listDecisions(policyDecisionSubject(policy.name))
      .find((d) => d.id === policy.approvedDecisionId && d.actorType === 'human' && d.gate === 'policy');
    if (!approval) return { ineligible: `policy ${policy.name}: its approval decision ${policy.approvedDecisionId} cannot be read` };
    const codeGate = facts.gate === 'codeReview' || facts.gate === 'acceptance';
    try {
      return this.ctx.store.transaction(() => {
        const current = this.ctx.store.getWork(work.id);
        if (current.currentState !== facts.state || current.currentRevision !== facts.workRevision) {
          return { moved: `${work.id} changed (${facts.state} r${facts.workRevision} → ${current.currentState} r${current.currentRevision}) during evaluation` };
        }
        // raiseRisk / reselectRoles can change eligibility without bumping currentRevision.
        if (current.risk.profile !== facts.riskProfile) {
          return { moved: `risk changed from ${facts.riskProfile} to ${current.risk.profile} during evaluation` };
        }
        // Dependency triggers for code gates come from the pinned commit's change facts, not live HEAD.
        const triggersNow = [
          ...current.risk.reasons,
          ...detectHardRiskTriggers(current),
          ...detectSoftTriggers(current),
          ...(facts.change?.dependencyChanges.length ? ['new-dependency'] : []),
        ].filter((t) => LANE_TRIGGER_NAMES.includes(t));
        const triggersSorted = [...new Set(triggersNow)].sort();
        if (JSON.stringify(triggersSorted) !== JSON.stringify(facts.triggers)) {
          return { moved: 'risk triggers changed during evaluation' };
        }
        const labelsNow = [...new Set(current.sourceRefs.flatMap((s) => s.labels ?? []))].sort();
        if (JSON.stringify(labelsNow) !== JSON.stringify(facts.labels)) {
          return { moved: 'source labels changed during evaluation' };
        }
        if (1 + (current.repositories?.length ?? 0) !== facts.repoCount) {
          return { moved: 'repository set changed during evaluation' };
        }
        if (JSON.stringify(current.unknowns) !== JSON.stringify(facts.unknowns)) {
          return { moved: 'open questions changed during evaluation' };
        }
        if (current.acceptanceCriteria.length !== facts.criteriaCount) {
          return { moved: 'acceptance criteria changed during evaluation' };
        }
        const laneNow = this.laneState(work.id);
        if (!laneNow.inLane) {
          return { moved: 'task fell back to the human flow during evaluation' };
        }
        let commitNow: string;
        try {
          commitNow = this.laneCommit(work.id, codeGate);
        } catch (e) {
          return { moved: `commit unreadable before save: ${(e as Error).message}` };
        }
        if (commitNow !== facts.commit) return { moved: `HEAD moved from ${facts.commit.slice(0, 12)} to ${commitNow.slice(0, 12)} during evaluation` };
        let snap: ReturnType<WorkStore['getLanePolicy']>;
        let file: ReturnType<typeof readPolicyFiles>['files'][number] | undefined;
        try {
          snap = this.ctx.store.getLanePolicy(policy.name);
          file = readPolicyFiles(this.ctx.projectRoot).files.find((f) => f.name === policy.name);
        } catch (e) {
          throw new LaneIneligible(`policy ${policy.name} cannot be read: ${(e as Error).message}`);
        }
        if (!snap || snap.status !== 'active' || snap.contentHash !== policy.contentHash || file?.hash !== policy.contentHash) {
          return { moved: `policy ${policy.name} changed during evaluation` };
        }
        const base = {
          id: createId('dec'),
          workId: work.id,
          action: 'approve' as const,
          workRevision: current.currentRevision,
          actorId: `policy:${policy.name}`,
          actorType: 'policy' as const,
          identityAssurance: 'local-attestation' as const,
          rationale: `Passed by policy ${policy.name} (approved by ${approval.actorId} on ${approval.decidedAt.slice(0, 10)})`,
          decidedAt: now(),
          presence: 'lane-policy',
          policyId: policy.name,
          policyHash: policy.contentHash,
          policyApprovalDecisionId: approval.id,
          evaluationHash: evaluation.evaluationHash,
        };
        if (facts.gate === 'requirements') {
          const spec = this.ctx.store.getLatestArtifact(work.id, 'specification');
          if (spec?.contentHash !== facts.subject) return { moved: 'the requirements changed during evaluation' };
          const decision: Decision = { ...base, gate: 'requirements', artifactIds: [spec.id], artifactHashes: [spec.contentHash] };
          const next = transition(
            { ...current, acceptanceCriteria: current.acceptanceCriteria.map((c) => ({ ...c, status: 'confirmed' as const })) },
            'REQUIREMENTS_APPROVED',
          );
          this.ctx.store.saveDecision(decision);
          this.ctx.store.saveWork(next);
          this.ctx.store.appendEvent({ workId: work.id, type: 'requirements.passed-by-policy', payload: { decisionId: decision.id, hash: spec.contentHash, policy: policy.name } });
          const eec = this.ctx.store.getLatestEec(work.id)!;
          this.ctx.store.saveEec(bumpEecRevision(eec, { approvedSpecHash: spec.contentHash, approvalDecisionIds: [...eec.approvalDecisionIds, decision.id] }));
          return { work: next, decision };
        }
        if (facts.gate === 'plan') {
          const plan = this.ctx.store.getLatestArtifact(work.id, 'plan');
          if (plan?.contentHash !== facts.subject) return { moved: 'the plan changed during evaluation' };
          const spec = this.ctx.store.getLatestArtifact(work.id, 'specification');
          const req = this.ctx.store
            .listDecisions(work.id)
            .find((d) => d.gate === 'requirements' && d.action === 'approve' && !d.invalidatedAt && !!spec && d.artifactHashes.includes(spec.contentHash));
          if (!req) throw new LaneIneligible('requirements approval missing or not bound to the current specification');
          const decision: Decision = { ...base, gate: 'plan', artifactIds: [plan.id], artifactHashes: [plan.contentHash] };
          const next = transition(current, 'PLAN_APPROVED');
          this.ctx.store.saveDecision(decision);
          this.ctx.store.saveWork(next);
          this.ctx.store.appendEvent({ workId: work.id, type: 'plan.passed-by-policy', payload: { decisionId: decision.id, hash: plan.contentHash, policy: policy.name } });
          const eec = this.ctx.store.getLatestEec(work.id)!;
          this.ctx.store.saveEec(bumpEecRevision(eec, { approvedPlanHash: plan.contentHash, approvalDecisionIds: [...eec.approvalDecisionIds, decision.id] }));
          return { work: next, decision };
        }
        if (facts.gate === 'codeReview') {
          const profiles = resolvePolicyReviewers(policy.policy, this.ctx.config.models.profiles);
          if (!profiles) throw new LaneIneligible(`policy ${policy.name} does not configure codeReview`);
          if (facts.dualReview?.changeSetId !== commitNow || facts.dualReview.artifacts?.length !== 2) {
            throw new LaneIneligible('the exact evaluated review pair is missing or stale');
          }
          const selected = facts.dualReview.artifacts.map((expected, index) => {
            const artifact = this.ctx.store.listArtifacts(work.id, 'review').find((entry) => entry.id === expected.id);
            if (
              !artifact ||
              artifact.contentHash !== expected.contentHash ||
              artifact.relatedCommit !== commitNow
            ) {
              throw new LaneIneligible(`evaluated review artifact ${expected.id} is no longer current`);
            }
            let review: ReviewResult;
            try {
              review = JSON.parse(this.ctx.store.getArtifactContent(artifact.id)) as ReviewResult;
            } catch {
              throw new LaneIneligible(`review artifact ${artifact.id} is unreadable`);
            }
            const profile = profiles[index]!;
            if (
              review.changeSetId !== commitNow ||
              review.reviewer?.profile !== profile.name ||
              review.reviewer.provider !== profile.provider ||
              review.reviewer.model !== profile.model
            ) {
              throw new LaneIneligible(`evaluated review artifact ${artifact.id} no longer matches reviewer ${profile.name}`);
            }
            return { artifact, review };
          });
          if (selected.some((entry) => entry!.review.disposition !== 'no-blocking-findings')) {
            throw new LaneIneligible('both configured reviewers must have no kept blocking findings');
          }
          try {
            this.assertPrApproval(work.id, commitNow);
          } catch (e) {
            throw new LaneIneligible((e as Error).message);
          }
          // A PR lookup can block while a worktree advances. Never bind its result to newer heads.
          const afterPr = observe(this.repoStates(work.id));
          if (afterPr.uncommitted.length) {
            return { moved: 'a worktree became dirty during the PR check' };
          }
          if (changeSetId(afterPr.repos) !== commitNow) {
            return { moved: 'a worktree advanced during the PR check' };
          }
          const decision: Decision = {
            ...base,
            gate: 'code-review',
            artifactIds: selected.map((entry) => entry!.artifact.id),
            artifactHashes: selected.map((entry) => entry!.artifact.contentHash),
            commitSha: commitNow,
          };
          const next =
            current.currentState === 'AI_REVIEW'
              ? transition(transition(current, 'HUMAN_CODE_REVIEW'), 'VERIFYING')
              : transition(current, 'VERIFYING');
          this.ctx.store.saveDecision(decision);
          this.ctx.store.saveWork(next);
          this.ctx.store.appendEvent({
            workId: work.id,
            type: 'code-review.passed-by-policy',
            payload: {
              decisionId: decision.id,
              commitSha: commitNow,
              policy: policy.name,
              reviewers: profiles.map((profile) => profile.name),
            },
          });
          const eec = this.ctx.store.getLatestEec(work.id)!;
          this.ctx.store.saveEec(
            bumpEecRevision(eec, {
              approvalDecisionIds: [...eec.approvalDecisionIds, decision.id],
            }),
          );
          return { work: next, decision };
        }
        if (facts.gate === 'acceptance') {
          if (!acceptanceTarget) throw new LaneIneligible('the PR target whose protection was evaluated is missing');
          try {
            this.assertPrApproval(work.id, commitNow);
          } catch (e) {
            throw new LaneIneligible((e as Error).message);
          }
          // PR landing carries one repository; eligibility already routes multi-repo work to a human.
          if (this.repoStates(work.id).length !== 1) {
            throw new LaneIneligible(`PR landing supports one repository; the task changes ${this.repoStates(work.id).length}`);
          }
          // assertPrApproval can block on a network call; a worktree may advance meanwhile.
          if (changeSetId(observe(this.repoStates(work.id)).repos) !== commitNow) {
            return { moved: 'a worktree advanced during the PR check' };
          }
          const change = this.ctx.store.getLatestArtifact(work.id, 'change-report');
          const decision: Decision = {
            ...base,
            gate: 'sqa-acceptance',
            artifactIds: change ? [change.id] : [],
            artifactHashes: change ? [change.contentHash] : [],
            commitSha: this.currentCommit(work.id),
          };
          this.ctx.store.saveDecision(decision);
          // Landing uses exactly this target; a later resume must not re-resolve origin.
          this.ctx.store.appendEvent({
            workId: work.id,
            type: 'lane.acceptance-target-bound',
            payload: {
              decisionId: decision.id,
              owner: acceptanceTarget.owner,
              repo: acceptanceTarget.repo,
              baseBranch: acceptanceTarget.baseBranch,
              protection: facts.lanePr?.protection,
            },
          });
          // With the decision recorded every required obligation must hold, without waivers; otherwise roll back.
          const gateNow = this.gateDecision(work.id);
          if (gateNow.blocking.length) {
            throw new LaneIneligible(`evidence gate ${gateNow.decision} after the policy decision: ${gateNow.blocking.map((b) => b.id).join(', ')}`);
          }
          const next = transition(current, 'ACCEPTED');
          this.ctx.store.saveWork(next);
          this.ctx.store.appendEvent({
            workId: work.id,
            type: 'acceptance.decided',
            payload: { actorId: base.actorId, policy: policy.name, commitSha: decision.commitSha, gateDecision: gateNow.decision, note: 'ACCEPTED does not mean deployed' },
          });
          return { work: next, decision };
        }
        throw new LaneIneligible(`unsupported lane gate ${facts.gate}`);
      });
    } catch (e) {
      if (e instanceof LaneIneligible) return { ineligible: e.message };
      throw e;
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
    // Edit a copy: a value the schema refuses must not linger in the live config.
    const cfg = structuredClone(this.ctx.config) as any;
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
    this.ctx.config = cfg;
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
