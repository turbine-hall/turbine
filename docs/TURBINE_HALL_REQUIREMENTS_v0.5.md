# Turbine Hall — Full Application Requirements

**Version:** v0.5 implementation baseline (document revision 2); implementation pending  
**Date:** 2026-11-11  
**Status:** Proposed v0.5 baseline, NOT implemented; ready for bounded Cursor Phase 0 after repository ownership/security approval  
**Companion:** [`TURBINE_FRAMEWORK_v0.5.md`](./TURBINE_FRAMEWORK_v0.5.md)  
**Primary delivery:** Open-source-capable TypeScript CLI and reusable engine packages; no web dashboard in v0.1  
**Decision:** **TEST FIRST**. This is a complete target blueprint with explicit release boundaries, not a request to build every item in the first sprint.

> **Product statement:** A vendor-neutral software-engineering execution engine that receives intent from text, files, or connected management tools; runs a versioned framework using selectively activated human/AI roles, skills, models and tool capabilities; and manages a canonical **Engineering Evidence Contract (EEC)** binding obligations, artifacts, checks, revisions, human approvals, and safe recovery. Jira and source repositories are tools, not the engine's underlying architecture.

## 0. Read this before implementing

- This document **MUST** be implemented alongside `TURBINE_FRAMEWORK_v0.5.md`; framework terminology and mandatory gates take precedence over illustrative examples.
- **Release R0** proves portable intake → versioned EEC → requirements assessment → human approval → planning → human approval → deterministic change impact/recovery for requirements and plan, with persistent state. **Release R1** adds bounded AI coding, independent review, deterministic tests, human acceptance and code/verification evidence invalidation with safe selective recovery for a single task. **R2+** adds robust team service and integrations. Do **not** treat future release requirements as blockers to R0 unless explicitly marked cross-cutting.
- There is **no Paperclip or Hermes** dependency. Do not reintroduce either.
- The implementation MUST NOT copy upstream BMad/Spec Kit/OpenSpec/Superpowers source or skills into this repository by default. We author original core skills and add optional externally sourced skills only after reviewing licenses, exact pinned versions, trust and compatibility.
- CLI commands, JSON contracts and database tables below are **our proposed design**; they are not commands or API promises of existing products.
- Use **stable, mutually compatible** package versions available at implementation time, commit lockfiles, and document the exact versions. Do not hardcode speculative latest version numbers.
- **Stop rather than silently bypassing** a safety/authorization, unsupported capability, failed validation, stale approval, or missing evidence condition.

### 0.1 Product principles / acceptance priorities

1. One canonical work model independent of input source.
2. Workflows and roles are versioned declarative contracts.
3. AI produces proposals and bounded artifacts; deterministic engine enforces state and authority.
4. Specialist roles are activated only when justified by task scope, risk and required evidence.
5. Real human decisions are distinguishable from model outputs and local unauthenticated attestations.
6. **EEC is the central acceptance model:** replayable provenance and dependency-bound obligations connect input, decisions, revision hashes, runs, evidence and final disposition.
7. Useful CLI UX; discoverable commands, dry runs, meaningful validation errors and recovery.
8. No automatically pushed code, merged PRs, production deployments, destructive migrations or silent external writes in R0/R1.
9. A single task fully tested on an authorized 6sense noncritical repository matters more than an impressive empty dashboard.

### 0.2 Target audience

| User | Job to be done | Primary interface |
|---|---|---|
| PM / product owner | Import a task, resolve ambiguity, approve requirements | CLI for pilot; later shared review surface |
| Developer | Consume an approved spec/plan, execute and review code | CLI + existing IDE/repo |
| Architect | Review impact and approve technical approach | CLI + artifacts |
| SQA | Generate/execute cases and accept actual behavior | CLI + existing test runners |
| CTO / engineering manager | Control cost, policy, accountability and outcomes | CLI/status/report; shared UI later |
| OSS adopter | Install, configure, customize roles/tools/models safely | CLI, local docs, examples |
| Adapter/skill contributor | Extend capabilities without modifying core orchestration | Packages, manifests, conformance tests |

**First operating environment:** an authorized non-production 6sense work item with one accountable human; do not assume real company data can be published.

---

## 1. Scope, delivery stages and explicit exclusions

### 1.1 Release matrix

| Capability | R0 — first usable slice | R1 — end-to-end pilot | R2 — team/OSS maturity | Later |
|---|---|---|---|---|
| CLI initialization, config, diagnostics | **Required** | Improve | Stable | — |
| Text/Markdown/file task intake | **Required** | Improve | Stable | — |
| Jira issue read adapter | **Required after local intake works** | Support pilot | OAuth app lifecycle | More providers |
| Workflow persistence, revision hashes | **Required** | Required | Team store | Distributed execution |
| EEC contract, obligations and artifact lineage | **Required: source/spec/plan** | Extend to code/review/tests | External export/conformance | Broader organizational evidence |
| Deterministic invalidation/change impact | **Required: requirements/plan** | **Required: commit/test/review** | Cross-tool freshness checks | Assisted fine-grained semantic impact |
| Selective recovery with conservative fallback | **Required: R0-level plan regeneration/reapproval** | **Required: safe affected-stage re-execution** | Impact tuning and recovery analytics | Advanced distributed recovery |
| Failure/cost-informed role selection | Record observations and hard-risk triggers | **Required: reselect after failures or risk changes** | Aggregate role outcomes | Optimized learned policy (only after validation) |
| Role registry + adaptive selection | **Required (minimum rule set)** | Extend | Plugin roles | Advanced tuning |
| Original requirements and planning skills | **Required** | Extend | More skills | Marketplace |
| One configurable model adapter | **Required** | Extend | Provider plugins | Model routing |
| CLI local human attestations | **Required, labeled as unverified** | Required | Authenticated approvals | SSO/enterprise RBAC |
| Local Git context reader | Optional in R0, required for repo-aware plans | **Required** | Repo plugins | Multi-repo |
| Coding execution in isolated worktree | No | **Required** | Multiple executors | Distributed workers |
| AI review + deterministic test evidence | No | **Required** | Policy-driven | Advanced benchmarking |
| Manual SQA acceptance + final report | No | **Required** | Authenticated team grade | External audit/export |
| GitHub PR integration / CI read | No; artifact-only acceptable | Optional if access permits | Required for true PR/CI claims | More SCMs |
| Agent parallelism | No | No by default | Controlled dependency DAG | Distributed scheduling |
| Web app, multi-tenancy, billing | No | No | No unless proven | Potential business |

### 1.2 Hard non-goals in R0/R1

No custom IDE, autonomous multi-agent corporation, agent marketplace, Jira replacement, project-management UI, foundation-model training, arbitrary shell execution from untrusted inputs, self-modifying policy, remote skill auto-install, automatic production deployments, direct or admin-bypass merges of any kind (the guarded autonomous lane only enables merge-queue auto-merge), cross-tenant hosted service, enterprise identity claims, unsupported “security certification,” or guaranteed development productivity improvements.

### 1.3 Build-vs-reuse

- Reuse SQLite, Git, testing libraries, model SDKs and Jira APIs; build our **framework contracts, state machine, role selection, evidence and approval binding**.
- Use an optional coding-agent executable/provider only behind a bounded adapter; no provider name is allowed in framework manifests.
- Manual BMad/Spec Kit/Superpowers plus Jira/GitHub is the **control condition**, not a required engine dependency.
- If a core workflow cannot outperform a manual control in usefulness, reconsider the product rather than adding features.

---

## 2. User journeys

### UJ-01 — Initialize factory

`sf init` detects an authorized Git working directory (or an explicit project path), creates a project-level config and local engine state directory, prompts for defaults, and prints **exactly what it changed**. Re-running is idempotent and does not overwrite user edits without approval.

### UJ-02 — Receive work from any source

`sf task create --title '...' --file request.md` or `sf task takeover jira:OPS-123` normalizes input to the same immutable-source `WorkPackage` format. The Jira source remains unchanged until an explicit authorized sync. Missing Jira configuration returns a helpful error, not silent fallback.

### UJ-03 — Assess and improve requirements

The engine runs `requirements-analyst` with `core/assess-requirements`, selects `spec-writer` if the type/scope requires it, emits a readiness report, draft spec, testable acceptance criteria *suggestions*, non-goals, assumptions and human clarification questions. It MUST distinguish proposed answers from confirmed facts. If critical uncertainty exists it stops in `NEEDS_CLARIFICATION`.

### UJ-04 — Human review and approve requirements

The reviewer sees original and proposed content, differences, remaining unknowns, role/risk assessment, and artifact hash. They can edit, reject, answer questions or approve the **exact revision**. After approval, changes produce a new revision and invalidate dependent approvals.

### UJ-05 — Plan work

The engine uses the approved spec, repository context if available, necessary specialist roles, dependency/risk analysis, and testing expectations to produce a bounded implementation plan. It discloses tools and capabilities that are missing. Human technical owner approves the exact plan hash; no execution before that gate.

### UJ-06 — Execute, review, test and accept (R1)

An approved plan creates a task-scoped workspace. A configured coding executor receives only the necessary context, skills and tools. It creates code and test artifacts, reports real executed checks, and stops on error/budget limit. A separate review run checks the actual diff; deterministic lint/type/tests and applicable SQA evidence are recorded. Human technical review and acceptance are explicit, distinguishable decisions. `ACCEPTED` does not equal deployed.

### UJ-07 — Pause, resume, explain and recover

On process interruption, tool errors, insufficient budget, or denied approval, persist state and exact artifacts. `sf task status` and `sf task explain` show *why* it is blocked and what action can unblock it. `sf task resume` is idempotent and only restarts eligible operations.

### UJ-09 — Change an approved requirement and recover safely (R0)

After `PLAN_APPROVED`, an authorized user revises an acceptance criterion. The engine creates a new immutable EEC/spec revision, detects the transitive dependency from requirements to plan, shows the affected approvals and a recovery proposal, rejects stale plan approval, and allows a reviewer to reapprove a newly generated/revalidated plan. The audit trail retains earlier decisions. On uncertain impact, it must choose conservative reapproval rather than claim existing work is valid.

### UJ-10 — Change code after review and recover safely (R1)

After review/tests pass, a changed commit or test contract makes bound evidence stale. The engine blocks `ACCEPTED`, explains which checks and approvals must be repeated, runs applicable checks on the current commit, and requests current-revision human decisions. A successful historical check remains historical, not current proof.

### UJ-08 — Replace input/model provider

Run the same requirements → plan path for a local Markdown file and a Jira issue without modifying the framework definition, role manifests or skills. Replace configured model provider through an adapter (with regression tests) without editing workflow logic.

---

## 3. Architecture: independent core with capability adapters

```text
                 INPUT ADAPTERS                         OUTPUT ADAPTERS
          ┌──────────┬───────────┐               ┌──────────┬────────────┐
          │ text/file│ Jira/read │   ...         │ files    │ Jira/write │ ...
          └─────┬────┴─────┬─────┘               └─────▲────┴─────▲──────┘
                └─────┬────┘                             │          │
                      ▼                                  │          │
              NORMALIZED WORK CONTRACT + EEC ─────── ARTIFACTS / EVIDENCE
                      │                                  ▲
                      ▼                                  │
              WORKFLOW + EEC/IMPACT ENGINE ◄──── HUMAN APPROVAL GATES
                      │
              ┌───────┴───────────┐
              ▼                   ▼
       ADAPTIVE ROLE SELECTOR   STATE/EVENT STORE
              │
              ▼
         ROLE RUNNER ──► SKILL REGISTRY ──► MODEL ADAPTERS
              │
              └────────► TOOL CAPABILITY BROKER ──► GIT / TEST / ISSUE / CI
```

### 3.1 Component boundaries

| Component | Responsibility | Must NOT do |
|---|---|---|
| `core-contracts` | Validated JSON schemas and TS types | Import Jira SDK or a model client |
| `framework-runtime` | Load/version lifecycle rules, evaluate gates | Allow model to mutate state directly |
| `eec-service` | Version Engineering Evidence Contracts, obligations and gate validity | Treat an AI assertion as verified evidence |
| `lineage-impact` | Manage typed artifact graph, transitive invalidations and safe recovery plans | Reuse stale evidence or infer certainty from unknown dependencies |
| `work-store` | Persist work, revisions, audit events and runs | Pretend local data gives trusted human identity |
| `role-registry` | Validate role manifests | Treat each role as a resident agent |
| `role-selector` | Recommend minimal sufficient roles under risk policy | Downgrade mandatory security triggers |
| `skill-registry` | Load pinned, reviewed skills with manifests | Grant permissions from skill text |
| `model-runtime` | Send bounded structured requests, normalize outputs and usage | Store provider secrets in task logs |
| `tool-broker` | Enforce capability grants and audit calls | Give unrestricted shell privileges to LLM output |
| `execution-runner` | Isolated task workspace, bounded attempts, artifacts | Claim worktree is a security sandbox |
| `approval-service` | Validate exact revision, gate and actor | Accept AI self-approval |
| `adapters-*` | Translate provider data and capabilities | Define universal framework semantics |
| `cli` | Command parsing, interactive human UX and text/JSON output | Contain business logic that bypasses engine APIs |

### 3.2 Recommended repository layout

```text
turbine-hall/
├── apps/
│   └── cli/                       # `sf` executable
├── packages/
│   ├── contracts/                 # schema, validators, types
│   ├── core/                      # workflow/gates/selection
│   ├── evidence-contract/         # EEC, obligations, validity and revision binding
│   ├── lineage-impact/            # typed graph, invalidation, selective recovery
│   ├── storage-sqlite/            # storage adapter and migrations
│   ├── skills/                    # original internal skill loader
│   ├── models/                    # model provider contract
│   ├── tools/                     # capability broker
│   ├── executor/                  # isolated worker runtime (R1)
│   ├── adapter-jira/              # Jira read, then authorized write
│   ├── adapter-git/               # repo/worktree/diff
│   └── adapter-tests/             # deterministic test/CI evidence
├── frameworks/
│   └── turbine/0.5.0/                 # proposed framework definition & policy
├── roles/                         # role manifests, versioned
├── skills/core/                   # original Turbine skills, versioned
├── examples/
│   ├── plain-text-task/
│   ├── jira-readonly/
│   └── backend-api-change/        # R1
├── tests/
│   ├── integration/
│   ├── security/
│   ├── fixtures/
│   └── e2e/
├── docs/
│   ├── ARCHITECTURE.md
│   ├── USER_GUIDE.md
│   ├── DEVELOPMENT.md
│   ├── ADR/
│   └── ROADMAP.md
├── package.json
├── pnpm-lock.yaml
├── tsconfig.base.json
├── README.md
└── LICENSE                            # after ownership/license decision
```

### 3.3 Implementation stack

- Runtime: **Node.js active LTS at setup time**, TypeScript strict mode, ESM consistently; package manager **pnpm** with committed lockfile.
- CLI: a well-maintained command parser such as `commander` or `citty`; use one consistently. Interactive prompts MUST have noninteractive flags and `--json` support for automation.
- Schemas: **Zod** at all inbound and persistent data boundaries; generate/maintain JSON Schema for external integration.
- Local store: **SQLite** (choose a maintained binding compatible with chosen Node LTS); migrations with transactional upgrades; content-addressed artifact files.
- Model integration: adapter interface using a selected supported provider SDK. **Do not assume all providers share context, tool-calling, structured output or token accounting features.**
- Git: invoke Git with fixed arguments and safe subprocess execution; no `shell: true` for dynamic arguments.
- Tests: **Vitest** or Node built-in test runner; use TypeScript checker, ESLint, formatter and targeted integration fixtures.
- No HTTP backend, Redis, Kubernetes, hosted database or external auth in R0/R1.

---

## 4. Canonical contracts and persistent data model

### 4.1 Core identifiers and schemas

Use UUIDv7 or ULID for internal IDs (consistent choice); never use Jira key as primary key. Every work item may have many source references. Suggested TypeScript representation:

```ts
type WorkType = 'bug' | 'feature' | 'refactor' | 'migration' | 'maintenance' | 'investigation';
type WorkState =
  | 'IMPORTED' | 'ASSESSING' | 'REQUIREMENTS_REVIEW' | 'REQUIREMENTS_APPROVED'
  | 'PLANNING' | 'PLAN_REVIEW' | 'PLAN_APPROVED' | 'IMPLEMENTING'
  | 'AI_REVIEW' | 'HUMAN_CODE_REVIEW' | 'VERIFYING'
  | 'HUMAN_ACCEPTANCE' | 'ACCEPTED' | 'NEEDS_CLARIFICATION'
  | 'BLOCKED' | 'CHANGES_REQUESTED' | 'PAUSED_BUDGET'
  | 'PAUSED_POLICY' | 'CANCELLED' | 'FAILED';

type SourceRef = {
  provider: 'text' | 'file' | string;
  externalId?: string;
  url?: string;
  sourceUpdatedAt?: string;
  sourceVersion?: string;
  snapshotHash: string;
};

type AcceptanceCriterion = {
  id: string;
  statement: string;
  kind: 'behavioral' | 'technical' | 'nonfunctional';
  status: 'confirmed' | 'proposed';
};

type WorkPackage = {
  id: string;
  frameworkId: string; frameworkVersion: string;
  type: WorkType; title: string; objective: string;
  why?: string; sourceRefs: SourceRef[];
  acceptanceCriteria: AcceptanceCriterion[];
  constraints: string[]; nonGoals: string[];
  unknowns: string[]; assumptions: string[];
  accountableHuman?: string;
  risk: { profile: 'lightweight' | 'standard' | 'comprehensive'; reasons: string[] };
  selectedRoles: { id: string; version: string; why: string; mode: 'ai' | 'human' | 'tool' }[];
  currentState: WorkState; currentRevision: number;
  createdAt: string; updatedAt: string;
};
```

**Schema rules:** Required arrays may be empty during `IMPORTED` but gate validators must enforce completeness before `REQUIREMENTS_APPROVED` and `PLAN_APPROVED`. All dates ISO 8601 UTC, hashes SHA-256 with canonical serialization and explicit hash algorithm label. Validate source lengths and size caps. Support both internal `id` and external aliases for command lookup; ambiguity errors must show choices.

### 4.2 Artifact contract

```ts
type Artifact = {
  id: string; workId: string;
  type: 'source' | 'assessment' | 'specification' | 'plan' | 'test-plan'
      | 'architecture' | 'change-report' | 'diff' | 'review' | 'test-report'
      | 'release-readiness' | 'other';
  revision: number;
  contentHash: string; contentType: string; location: string;
  createdBy: { kind: 'human' | 'agent' | 'tool'; identifier: string };
  createdAt: string; parentArtifactIds: string[];
  relatedCommit?: string;
};
```

Artifacts are immutable revisions; `latest` is a pointer, never an overwrite of earlier approved content. Sensitive contents may be redacted from logs, and external sharing requires authorization.

### 4.3 Approval contract

```ts
type Decision = {
  id: string; workId: string;
  gate: 'requirements' | 'plan' | 'code-review' | 'sqa-acceptance' | 'exception';
  action: 'approve' | 'reject' | 'request-changes';
  artifactIds: string[]; artifactHashes: string[];
  workRevision: number; commitSha?: string;
  actorId: string; actorType: 'human';
  identityAssurance: 'local-attestation' | 'authenticated';
  rationale?: string; decidedAt: string;
  invalidatedAt?: string; invalidationReason?: string;
};
```

R0/R1 local approvals are **local attestations**. CLI MUST display `Local attestation — identity not independently verified`. No remote/team-grade claim until authenticated identity and role-based permissions are implemented. The engine MUST reject an agent claiming to be a human reviewer.

### 4.4 Execution and evidence

```ts
type RoleRun = {
  id: string; workId: string; roleId: string; roleVersion: string;
  skillIds: string[]; toolCapabilityGrants: string[];
  modelProvider?: string; modelId?: string;
  promptArtifactHash?: string;
  startedAt: string; endedAt?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
  inputArtifactIds: string[]; outputArtifactIds: string[];
  attempts: number; tokens?: { input?: number; output?: number };
  cost?: { actual?: number; estimated?: number; currency: string; basis?: string };
  errorCode?: string;
};

type Evidence = {
  id: string; workId: string; kind: 'unit' | 'lint' | 'typecheck'
    | 'api' | 'e2e' | 'security' | 'manual-sqa' | 'review' | 'other';
  producedByRunId?: string; reviewerId?: string;
  commandOrCheck?: string; exitCode?: number;
  result: 'passed' | 'failed' | 'blocked' | 'not-run';
  commitSha?: string; environment?: string; observedAt: string;
  logArtifactId?: string; limitations: string[];
};
```

A model assertion “tests pass” is **never** automatically converted into `passed` evidence. Execution evidence requires actual tools, exit code/check ID, log reference and relevant code revision. Manual QA requires a human-authored step/expected/actual record.

### 4.4A Engineering Evidence Contract and dependency contracts (v0.5 normative)

The EEC is **the central data model for acceptance**, linked one-to-one to a current Work Package revision, with immutable revision history. Requirements, plans, role selections, execution, reviews and tests are producers/consumers of the same EEC obligations. Implement the conceptual contract below as validated Zod schemas and TS types (split types across packages when useful):

```ts
type ObligationStatus = 'unsatisfied' | 'satisfied' | 'stale' | 'blocked' | 'waived-with-authority';
type ObligationKind = 'requirement' | 'planning' | 'implementation' | 'review' | 'automated-check' | 'manual-sqa' | 'security' | 'acceptance';
type EvidenceObligation = {
  id: string; kind: ObligationKind; acceptanceCriterionIds: string[];
  requiredEvidenceKinds: string[]; policyRuleIds: string[];
  required: boolean; passRule: string; // reference to registered deterministic gate predicate
  dependsOnArtifactIds: string[];
};
type EngineeringEvidenceContract = {
  id: string; workId: string; revision: number;
  frameworkId: string; frameworkVersion: string;
  sourceSnapshotHashes: string[]; approvedSpecHash?: string; approvedPlanHash?: string;
  accountableHumanId?: string; riskProfile: 'lightweight' | 'standard' | 'comprehensive';
  obligations: EvidenceObligation[]; artifactRevisionIds: string[];
  approvalDecisionIds: string[]; evidenceIds: string[];
  roleSelectionDecisionIds: string[]; dependencyEdgeIds: string[];
  createdAt: string; creationEventId: string;
};
type ArtifactDependencyEdge = {
  id: string; workId: string;
  upstreamArtifactId: string; upstreamRevisionHash: string;
  downstreamArtifactId: string; downstreamRevisionHash: string;
  reason: string; affectedObligationIds: string[];
};
type EecInvalidationEvent = {
  id: string; workId: string; triggerEventId: string; changedArtifactId: string;
  oldRevisionHash: string; newRevisionHash: string;
  affectedArtifactIds: string[]; affectedDecisionIds: string[];
  affectedEvidenceIds: string[]; affectedObligationIds: string[];
  rationale: string; createdAt: string;
};
type RecoveryPlan = {
  id: string; workId: string; eecRevision: number;
  triggerInvalidationIds: string[];
  requiredStageIds: string[]; retainedArtifactRevisionIds: string[];
  staleArtifactRevisionIds: string[]; unknownImpactIds: string[];
  requiredApprovalGates: string[]; proposedRoleIds: string[];
  estimatedCost?: { amount: number; currency: string; basis: string };
  status: 'proposed' | 'authorized' | 'in-progress' | 'completed' | 'blocked';
  createdAt: string;
};
```

**Important semantics:** Current obligation validity is **computed** by the gate evaluator from current artifacts, exact revision bindings, policy rules, verified evidence and invalidation events. Do not trust or store a mutable “testsPassed=true” truth flag. `passRule` points to a code-defined predicate ID; no arbitrary expression evaluation. Revisions have stable opaque IDs; hashes use canonical serialization with an explicit hash algorithm/version. An EEC revision references immutable record IDs. Historical approval and evidence objects remain visible even after invalidation, but do not satisfy current gates. On incomplete lineage, conservative invalidation is mandatory.

**R0:** implement source/spec/plan obligations and their dependency edges, reasoned invalidation and safe plan reapproval. **R1:** extend the same model to worktree/commit, review, automated test and human SQA evidence. **R2+:** optional fine-grained semantics, external authenticated approvals and organizational evidence portability. There must be no second competing task-acceptance schema.

### 4.5 Database entities

`projects`, `work_items`, `source_snapshots`, `artifacts`, `artifact_revisions`, `role_definitions`, `skill_definitions`, `role_runs`, `run_attempts`, `events`, `approvals`, `evidence`, `tool_connections`, `model_profiles`, `policy_decisions`, `budget_counters`, `sync_operations`.

- Use foreign keys and transactions for state/approval writes; WAL mode where suitable.
- `events` and `eec_invalidation_events` are append-only at application level; updates to existing records forbidden by API.
- Required additional entities: `eec_contracts`, `eec_revisions`, `eec_obligations`, `artifact_dependency_edges`, `eec_invalidation_events`, `recovery_plans`, `role_selection_observations`.
- `repo_snapshots` (migration v2): `hash` and `repo_path` (together the primary key, so two clones at the same commit each keep their own row), `commit`, `commit`, `data`, `created_at`. Holds the project-facts snapshot of FR-CTX-01. The hash covers the snapshot content only (no timestamps), so the same commit always gives the same hash; the schema re-checks the hash on every save and read.
- EEC version and obligated evidence/approval IDs must be reconstructible from events after a restart; current obligation validity is a derived projection, **not a mutable assertion of historical truth**.
- Dependencies are versioned edges: `upstream_artifact_id`, `upstream_revision_hash`, `downstream_artifact_id`, `reason`, `affected_obligation_ids`; validate referential integrity and acyclicity.
- Persist monotonic event sequence per work item and timestamps. State updates and event append happen in a single transaction.
- Store bulky artifacts/logs as versioned files with content hashes and DB references.
- `tool_connections` persists metadata and secret references only, never raw tokens.
- Import/export schema version recorded; migrations forward-compatible where feasible.

### 4.6 Project directory layout

```text
user-repository/
├── .turbine/
│   ├── project.yaml                # reviewable, safe to commit
│   ├── frameworks.lock.json        # exact framework + role/skill hashes
│   ├── .gitignore                  # local secrets/state ignored
│   ├── context/                    # generated by `turbine understand` (ignored): snapshot.json, PROJECT.md
│   ├── knowledge/                  # OKF v0.3 bundle (ignored by default); export with `turbine knowledge export`
│   └── state/                      # local DB, artifacts and execution logs (ignored)
└── source...
```

Never commit local tokens, credential references containing secrets, task transcripts, unredacted client issues or run logs by default. Provide `sf task export` with explicit allowlist/redaction controls for sharing results.

---

## 5. Framework loader and deterministic workflow runtime

### FR-WF-01 Load and validate a pinned framework

`sf framework list/show/use` loads a versioned framework manifest and its checksums. Reject incompatible schema versions, missing required stages, invalid transition rules, duplicate IDs and unresolved role/skill references. Never silently substitute an unpinned upstream framework revision.

### FR-WF-02 State machine

The required main path is:

```text
IMPORTED → ASSESSING → REQUIREMENTS_REVIEW → REQUIREMENTS_APPROVED
→ PLANNING → PLAN_REVIEW → PLAN_APPROVED → IMPLEMENTING
→ AI_REVIEW → HUMAN_CODE_REVIEW → VERIFYING
→ HUMAN_ACCEPTANCE → ACCEPTED
```

R0 stops after `PLAN_APPROVED` and can export an execution brief; R1 implements the full path. Exceptional states: `NEEDS_CLARIFICATION`, `BLOCKED`, `CHANGES_REQUESTED`, `PAUSED_BUDGET`, `PAUSED_POLICY`, `CANCELLED`, `FAILED`. Resume target and reason must be persisted. Invalid transition returns nonzero exit and `E_INVALID_TRANSITION` without mutation.

### FR-WF-03 Revision binding and invalidation

- Requirements decision references exact spec hash/revision and source context.
- Plan decision references approved requirements hash.
- Implementation references approved plan hash, base commit and branch.
- Code-review evidence references implementation commit/diff hash.
- Final verification references tested commit/environment.
- Changed requirements invalidate relevant plan and downstream gates; changed plan invalidates implementation authorization; changed code invalidates commit-bound review/verification. **R1 conservatively reruns all affected gates**.
- Previously approved history remains inspectable and is considered `invalidated` by event-derived current validity, never erased; historic decisions/evidence remain append-only. See FR-WF-03A/03B.

### FR-WF-03A EEC creation, validation and obligation coverage

At intake, create draft EEC with unique contract ID and current revision. Assessment maps each approved acceptance-criterion ID to explicit testable obligations, marks proposed business facts as unconfirmed, and records required human gates for the current risk profile. Planning adds plan/architecture/test-intent obligations and exact spec dependencies. Implementation/review/verification extend the **same EEC** rather than create a separate acceptance record. Any missing mandatory obligation or unsupported evidence kind blocks advancement with an actionable reason. Include a deterministic `sf task contract validate` command that explains unsatisfied, stale and blocked obligations.

### FR-WF-03B Dependency impact, invalidation and recovery

On every relevant change:

1. Store new immutable artifact/source snapshot and append event transactionally; retain old revision.
2. Load explicit dependency edges, verify no cycle/missing references, compute transitive closure to downstream artifacts, decisions and evidence. For unknown impact, conservatively invalidate all potentially downstream gates.
3. Append one idempotency-keyed invalidation event with changed hashes and affected IDs, update current EEC projection and block previously valid gates as needed.
4. Reassess hard-risk triggers and role selection using new scope, failed tests/reviews and observed cost. An LLM's desire to avoid a role cannot bypass mandatory policy.
5. Create an inspectable recovery plan: `required`, `retained` (with revision proof), and `unknown`. Return **blocked** for unknowns until safe fallback/clarification.
6. Apply recovery only upon required approval/authorization. Never mutate an old decision into one for a new revision; rerun exact affected human gates and checks.
7. Verify current EEC obligations before `ACCEPTED`; show old evidence as history only.

**R0 deterministic minimum:** changed source requires explicit adoption; changed approved requirements invalidate plan approval and later gates; new plan requires plan reapproval; unchanged unaffected source snapshot does not create repeated events. The engine may conservatively replan everything downstream. **R1:** changed commit invalidates code review and commit-bound checks; changed test requirements invalidate verification; selective recovery may keep unrelated valid artifacts only when independent lineage and unchanged context are demonstrable. The smallest rerun is not always the safest rerun.

### FR-WF-04 Deterministic gates

At minimum: readiness; complete approved acceptance criteria; plan with impact/tests; allowed tools and model budget; independent review; passed configured checks; relevant SQA evidence; accountable human acceptance. Missing critical business answers cannot be “auto-approved” by the model.

### FR-WF-05 Failure/retry/cancellation

Idempotent commands where possible; bounded retries with explicit per-tool policy; no accidental duplicate Jira comments or code commits; graceful cancellation and run status recovery; crash restart resumes only safe checkpoints. For ambiguous external write outcomes, stop for reconciliation.

### FR-WF-06 Events

Record `work.created`, `source.imported`, `requirements.assessed`, `requirements.approved`, `plan.created`, `plan.approved`, `role.selected`, `skill.executed`, `tool.called`, `model.called`, `policy.blocked`, `execution.started`, `execution.finished`, `review.completed`, `evidence.recorded`, `acceptance.decided`, `sync.requested`, `sync.completed` and failure/retry events, each with correlation/run/work IDs. Audit logs MUST NOT include secrets or unnecessary sensitive issue contents.

---

## 6. Roles, skills, models and adaptive role selection

### 6.1 Role registry (16 defined roles, not 16 resident agents)

Implement the catalog from the framework document exactly:

`requirements-analyst`, `spec-writer`, `project-manager`, `architect`, `ux-designer`, `frontend-developer`, `backend-developer`, `database-engineer`, `unit-tester`, `code-quality-checker`, `code-reviewer`, `test-case-sqa`, `api-sqa`, `e2e-sqa`, `security-reviewer`, `release-engineer`.

Role manifest fields: id, semantic version, responsibility, required/optional skills, required/prohibited capabilities, allowed input/output artifact types, model policy, run limits, escalation conditions, supported execution modes. Role selection is dynamic per task; do not automatically create a model session for each role.

### 6.2 Skill registry

Implement original `core/assess-requirements`, `core/write-specification`, `core/plan-change` in R0; `core/execute-code-change`, `core/review-change`, `core/verify-acceptance`, `core/systematic-debugging`, `core/surgical-changes` in R1. Define `{id, version, source, license, contentHash, runnerCompatibility, inputs, outputs, requiredCapabilities, resourceLimits}`.

Skill text is **untrusted**. Users may import external skills only with explicit confirmation after metadata, license and capability inspection; default registry never fetches or executes arbitrary remote scripts. An external skill's instructions cannot expand tool grants, override engine policies or make human approvals.

### 6.3 External inspiration, optional future imports

- BMad: granular roles, structured agent/workflow capabilities.
- Spec Kit: spec quality, task planning and verification artifacts.
- OpenSpec: incremental/spec evolution and change proposals.
- Superpowers: reusable planning, debugging, TDD, review skills.
- Karpathy-inspired guidelines: avoid speculative refactors, simplify changes, acknowledge uncertainty.

**No upstream bundles in R0/R1.** Future imports require per-source version pinning, license/trademark review, compatibility tests and authorization. The Karpathy-inspired third-party skill is not official Karpathy endorsement.

### 6.4 Adaptive Role Selection Policy (ARSP)

Input: normalized task type, affected surfaces, complexity, uncertainty, dependencies, data/security risk, required QA types, project profile, **observed failed checks/review findings, retry/handoff costs and previous role effectiveness where actually measured**. Output: profile, selected roles, combined runs, tool-only checks, omitted roles with reasons, mandatory guards and human override availability.

Three profiles:

- **Lightweight:** small isolated low-risk change; one implementer may do coding + unit skills; deterministic checks; **pilot still retains required human lifecycle approvals**.
- **Standard:** normal API/feature work; spec/implementation + independent review and targeted QA, architecture conditional.
- **Comprehensive:** auth/authz, privacy, payments, destructive migrations or broad coupled scope; dedicated security/DB/architect review and explicit human checks.

Hard rules:

```text
IF auth/authz/session/permissions affected → security-reviewer + API auth tests + comprehensive
IF schema migration or destructive data change → database-engineer + backup/rollback + comprehensive
IF payments or financial integrity affected → comprehensive + independent verification
IF secrets or sensitive data → restricted data exposure + security-reviewer
IF risk cannot be classified → standard or comprehensive; human clarification
IF only local frontend copy/isolated style → lightweight candidate, never auto-skip mandatory pilot gates
```

LLM may recommend roles, but **policy determines the lower bound**. Default model call is not required for deterministic risk triggers. Human can escalate; R0/R1 cannot downgrade mandatory protections. Reassess after requirements approval, codebase inspection, material requirement/plan/code changes, failed verification, repeated review findings or exceeded role-level cost estimates. Every selection must be explainable via `sf task roles`. Each decision records `input_evidence_ids`, mandatory roles, optional roles, omitted role reasons, model/tool execution mode, cost basis and escalation reason. **Deterministic hard rules always outrank learned/advisory cost preferences.** R0 records observations but need not optimize using historical data. R1 must demonstrate one failure-triggered reassessment. Do not infer agent competence from self-reported success.

### 6.5 Role execution modes

`ai`: bounded LLM/agent invocation. `human`: manual execution using the same artifact contract. `tool`: no LLM, deterministic checks. Consolidate compatible skills/roles in one AI run when independence is unnecessary. Keep a separate context for objective code review when feasible.

### 6.6 Model provider contract

```ts
interface ModelAdapter {
  id: string;
  capabilities: {
    text: boolean; structuredOutput: boolean; toolCalling: boolean;
    maxContextTokens?: number;
  };
  run(request: {
    workId: string; roleId: string; skillIds: string[];
    prompt: string; schemaId: string;
    maxOutputTokens: number; budgetId: string;
  }): Promise<{
    content: unknown; usage?: { inputTokens?: number; outputTokens?: number };
    providerRequestId?: string;
  }>;
}
```

Model output is parsed and validated; invalid output triggers a bounded repair attempt, then explicit failure/clarification. Provider tokens/cost can be unavailable: distinguish actual, estimated and unknown. No ungrounded cost figures in outputs. Provider API keys in system keychain or OS-protected secret store preferred; environment variable references supported with masking and safe permissions.

---

## 7. Tool adapters and capability broker

### 7.1 Capability contract

```ts
type Capability =
  | 'issue.read' | 'issue.comment' | 'issue.edit' | 'issue.transition'
  | 'repo.inspect' | 'repo.read' | 'workspace.write' | 'git.diff'
  | 'git.branch.create' | 'pr.create' | 'pr.review.read'
  | 'tests.run' | 'ci.read' | 'secrets.read_ref';

interface ToolAdapter {
  id: string;
  capabilities: Capability[];
  healthCheck(): Promise<{ ok: boolean; details?: string }>;
  invoke(input: {
    capability: Capability; workId: string;
    arguments: Record<string, unknown>; correlationId: string;
  }): Promise<{ data: unknown; externalOperationId?: string }>;
}
```

Broker checks actor grants, framework state, tool availability, argument schema, data policy and budget before invocation. Tool calls have timeouts, rate limits and correlation IDs. Sensitive operations (`issue.edit`, `pr.create`, branch pushes, external comments) are disabled by default until separately authorized by command and/or approval.

### 7.2 Jira adapter (read-first)

Commands: `sf tool connect jira`, `sf tool test jira`, `sf task takeover jira:OPS-123`. Support Jira Cloud; initial implementation may use an explicitly authorized personal API token for controlled local testing, stored outside source and logs, with **read-only CLI behavior**. For distributable app, support OAuth 2.0 3LO with minimum scopes; do not request project-admin/manage scopes without need. API token authentication is not an acceptable long-term public installation default. The app must respect Jira's own permissions and rate limits.

Normalized input: issue key/id, summary, description (Atlassian Document Format converted carefully), issue type, priority, status, labels, acceptance criteria/custom fields if configured, links, assignee, updatedAt, source URL. Unknown custom-field mapping must be configurable; don't assume every Jira project stores acceptance criteria in the same field.

- `takeover` never updates Jira automatically.
- For later write sync, show exact diff, require explicit human authorization and confirm source update/version has not changed; queue a conflict if it has.
- Convert Markdown back to Atlassian Document Format using a tested serializer; never blindly inject raw Markdown.
- `issue.transition` is different from `issue.edit`, checks workflow constraints, and cannot infer arbitrary transition IDs.
- Persist credential *references*, not credentials.

### 7.3 Git/repository adapter

Detect Git root, branch, clean/dirty state, base commit, remote metadata, primary languages and test commands (with user verification). R1 creates isolated task worktrees and branches with name collision/restart handling. Worktrees prevent accidental working-tree overlap **but are not a security boundary**. Restrict executable tools separately via OS/container sandbox or documented, approved local trust mode. Never run LLM-supplied shell commands unrestricted. No pushing/merging/deleting branches without explicit user action.

### 7.3A Repository context: project facts (FR-CTX-01, layer 1 of #5)

`turbine understand` builds a **snapshot of the repository at one commit** so agents start from facts instead of rediscovering the project. It is deterministic: no model is involved. Implemented in `apps/cli/src/engine/context/` with schemas in `packages/contracts/src/context.ts` (`RepoSnapshot`, `ContextFact`, `DependencyFact`, `Convention`) and storage in `repo_snapshots` (migration v2).

**Correctness rule: nothing unverified is stated as fact.**

- **Read the commit, not the disk.** Paths and object ids come from `git ls-tree -r -l <commit>` (the equivalent of `git ls-files -s` for a commit; `ls-files` itself reads the index) and contents from one `git cat-file --batch` process. The working tree is never read for facts. If the checkout is dirty the only output is "uncommitted changes exist (not included)"; it is not stored in the snapshot, so a dirty tree cannot change the hash.
- **Every fact has a source** `{path, commit, blob}` plus a line range where one applies (`blob` is the tree id for a directory or whole-repo measurement). The Zod schema rejects a fact without a source and any source that names a different commit than the snapshot.
- **Conventions are measurements.** `confirmed` only when a config file sets it (tsconfig `strict`, Prettier options, `.editorconfig` `[*]`) or an exhaustive count over the tracked files is 100%. Anything else is `unconfirmed` and carries its counts, e.g. "47 of 50 relative import specifiers end in .js", with up to three counterexamples. The schema enforces both directions. Counts are textual (comments and strings are not parsed); executable configs (ESLint, `prettier.config.js`) are not evaluated and are listed as not confirmed.
- **Declared and installed versions are separate fields.** Declared comes from `package.json`; installed comes from the lockfile (`pnpm-lock.yaml`, `package-lock.json`). Drift is shown with both values. The relation is `match` / `mismatch` only for forms the checker fully understands, otherwise `unchecked`. `yarn.lock` (and bun lockfiles) are not parsed: dependencies report `lockfile-not-parsed` and the gap is listed as not confirmed. Nothing that needs running code or the network (latest versions, "build passes") is ever stated.
- **A stale snapshot is never served.** Before `task assess` / `task plan` use it, HEAD is compared with the snapshot commit; if they differ it is rebuilt first. If the rebuild fails the task stops with `E_CONTEXT_UNAVAILABLE` (exit 3) naming the stale and current commits. The old snapshot is not used as a fallback.

**Content:** top-level layout, workspace packages (`pnpm-workspace.yaml` / `package.json` workspaces), package entry points (`main`, `module`, `types`, `bin`, `exports`), every script, test / lint / typecheck / build commands, versions (`engines`, `packageManager`, `.nvmrc`, tsconfig target/module), dependencies, conventions, and anything not confirmed.

**Commands:** `turbine understand` (no snapshot: build; up to date: print `Project understood (snapshot <sha8>)` and leave the two generated files unchanged; stale: rebuild and print the added / removed / changed facts) and `turbine lint` (reports hand edits as errors, and generated files tracked by git as warnings). `turbine init` runs `understand` automatically when the repository has commits.

**Generated files** (never hand-edited, git-ignored because they cite the commit they were built from): `.turbine/context/snapshot.json` and the Facts section of `.turbine/context/PROJECT.md` (generated header + content hash). `turbine lint` reports a hand edit. Repair path: when HEAD has not moved and the generated files are intact, `turbine understand` prints `Project understood (snapshot <sha8>)` and leaves both generated files byte-for-byte unchanged. The only file it may still write is `.turbine/.gitignore`, and only when git does not already ignore the generated files (a missing rule, or one overridden by a later rule); the generated files must stay out of git. When a generated file is missing or was edited by hand it regenerates the files and says so. Text outside the Facts markers is preserved. A damaged marker (for example a deleted end line) is not guessed at: `understand` stops and names the marker to restore. Generated files are never written through a symlink. Writes are serialised per project by a publish lock, and nothing is published (and the store is not updated) if HEAD moves before publication.

| ID | Scenario | Pass condition (test in `tests/integration/context-snapshot.test.ts`) |
|---|---|---|
| AT-CTX-01 | Fresh repo | `understand` builds a snapshot; every fact, dependency, convention and unconfirmed item carries a source whose blob id and lines match git |
| AT-CTX-02 | Idempotent | Second run at the same commit, with both generated files intact, prints `Project understood (snapshot <sha8>)` and leaves the bytes of `snapshot.json` and `PROJECT.md` unchanged (`.turbine/.gitignore` is written only if git does not already ignore the generated files). A missing or edited generated file is regenerated (AT-CTX-02 does not apply). The same hash results in a clone |
| AT-CTX-03 | New commit | Snapshot is rebuilt and the printed diff lists exactly the added, removed and changed facts |
| AT-CTX-04 | Dirty tree | Dirty, staged and untracked files that contradict the commit change no fact and no hash; only the "not included" notice appears |
| AT-CTX-05 | Partial convention | Under 100% and no enforcing config: listed `unconfirmed` with counts, never as a fact; the schema refuses an unproven `confirmed` |
| AT-CTX-06 | Version drift | Declared and installed versions are both shown; unparsed lockfiles are reported as unknown |
| AT-CTX-07 | Stale / failed rebuild | A task never uses a stale snapshot; a failed rebuild throws `E_CONTEXT_UNAVAILABLE` and the old snapshot is not used |
| AT-CTX-08 | Generated files | `snapshot.json` and `PROJECT.md` carry the generated header and content hash; `turbine lint` flags hand edits |

### 7.3B Repository context: task context (FR-CTX-03, layer 3 of #5)

Each task gets `CONTEXT.md` next to STATUS/SPEC/REVIEW: a ranked, size-limited **selection** of the files that matter to that task's request. It is built by `apps/cli/src/engine/context/` (`relevance.ts`, `import-graph.ts`, `js-scan.ts`, `task-context.ts`, `task-render.ts`) with schemas in `packages/contracts/src/task-context.ts`, stored as a `repo-context` artifact bound to the Layer 1 snapshot hash, and rendered to `.turbine/tasks/<id>/CONTEXT.md` and `evidence/context.json`.

- **Only committed text.** Files and contents come from the commit the project snapshot is pinned to; the working tree is never read, so an import that exists only in an uncommitted file cannot give a reason.
- **No reason, no file.** Every listed file has at least one reason that is structured evidence, re-derivable from the blobs at the recorded commit: a resolved import edge (`file`, `line`, `statement`, `specifier`, target, resolution rule), a quote of the request with its offset, or a stated rule (test rule, package, CODEOWNERS line). The text shown is rendered from that evidence.
- **Signals, strongest first:** paths/basenames named in the request; exported symbols the request mentions; one hop on the import graph (relative imports and workspace package names); related tests; owning package and CODEOWNERS; the path-word (IDF) match as the weakest signal.
- **A selection, never a complete list.** The document states how files were chosen, what could not be read or resolved, and lists every file the size limit left out with its score. A role may declare `context_budget {maxFiles, maxChars}` (default 20 / 8000).
- **Never stale.** `turbine task next`, `plan` and `execute` rebuild the selection first when the base commit, the project snapshot, the size limit or the request changed, or the task re-entered CHANGES_REQUESTED. A rebuild that cannot run is stated in the file; the old selection is not served. When the base commit changed, the diff against the previous selection is shown.
- **Generated part vs agent notes.** The generated part is re-rendered from the store every time and carries a content hash; `turbine lint` and `turbine task lint` report a hand edit. `## Agent notes` is kept verbatim, labelled as unverified and never merged into the facts.
- **Agents are told to read it.** In REQUIREMENTS_APPROVED, PLANNING, PLAN_APPROVED, IMPLEMENTING and CHANGES_REQUESTED, `turbine task next` lists PROJECT.md and CONTEXT.md and says to read them before planning/implementing.

| ID | Scenario | Pass condition (test in `tests/integration/context-task.test.ts`) |
|---|---|---|
| AT-CTX-09 | Traceable reasons | Every listed file has a reason that re-derives from the commit's blobs (checked with plain git and `verifyRelevantFiles`); a falsified reason is rejected; an import only in an uncommitted file never appears |
| AT-CTX-10 | Size limit | The role limit is respected; omitted files are listed with scores and why |
| AT-CTX-11 | Staleness | A moved base commit or a CHANGES_REQUESTED re-entry makes `next` rebuild first; before that the file says STALE; a failed rebuild is stated, never papered over |
| AT-CTX-12 | Notes and edits | Agent notes survive every re-render; a hand edit of the generated part is overwritten and reported by lint |
| AT-CTX-13 | Agent instructions | `next` opens PROJECT.md and CONTEXT.md and tells agents to read them in the five states |

### 7.4 Test and CI adapters

Execute explicitly configured allowlisted commands with bounded time/output in approved environment. Collect exit code, stdout/stderr artifact refs, env summary and tested commit. The command's *actual* exit code determines pass/fail. `ci.read` may read GitHub Actions / other CI if configured; don't invent PR/CI status when no provider exists.

### 7.5 Adapter conformance test

Every input adapter MUST normalize data to the same `WorkPackage` schema. Every tool adapter MUST prove capability discovery, denied capability handling, timeout/rate-limit behavior, safe log redaction and idempotent replay or explicit reconciliation. The framework must never import a provider SDK directly.

---

## 8. CLI specification — exact command surface

### 8.1 Principles

Binary name `sf` is **provisional** and must be checked for package name collisions before publication. All commands provide `--help`, `--version`, `--json` where applicable, understandable errors, `--yes` only for low-risk prompts (NEVER bypass approvals), and `--dry-run` for potentially modifying commands. Exit codes: `0` success, `2` user validation, `3` policy/gate blocked, `4` adapter/network, `5` run failure, `6` concurrent/stale state, `7` budget exceeded, `130` interrupted.

### 8.2 R0 commands

The shipped binary is `turbine`. `understand` and `lint` already exist, so they are written with the name users can run today; the other commands keep the provisional `sf` prefix until the binary-name decision in 8.1 is made.

```bash
sf init [--project PATH] [--non-interactive]
sf doctor [--json]
turbine understand [--json]            # build/refresh project facts + brief + OKF knowledge bundle at HEAD; `init` runs it when the repo has commits
turbine lint [--json]                  # report hand edits to generated .turbine/context/ and .turbine/knowledge/ files
turbine knowledge validate [dir]       # OKF + turbine-okf/1 checks (exit 3 on issues)
turbine knowledge show [concept]       # list concepts and trust tiers
turbine knowledge export <dir> [--force]  # validated copy for commit/share (live bundle stays git-ignored)
sf config show | set <key> <value>
sf framework list | show <id> | use <id>@<version>
sf role list | show <role-id>
sf skill list | show <skill-id>
sf model add | list | test
sf tool list | connect jira | test jira
sf task create --title "..." [--file request.md] [--type feature]
sf task takeover jira:OPS-123
sf task list [--state STATE]
sf task status <id-or-alias>
sf task show <id-or-alias> [source|assessment|requirements|plan]
sf task contract show <id-or-alias> [--json]
sf task contract validate <id-or-alias> [--json]
sf task impact <id-or-alias> [--json]
sf task recover <id-or-alias> --dry-run
sf task explain <id-or-alias>
sf task assess <id-or-alias>
sf task requirements edit <id-or-alias>
sf task source refresh <id-or-alias>  # read source and report changes; never adopt silently
sf task requirements approve <id-or-alias> [--revision HASH]
sf task requirements reject <id-or-alias> --reason TEXT
sf task plan <id-or-alias>
sf task plan approve <id-or-alias> [--revision HASH]
sf task plan reject <id-or-alias> --reason TEXT
sf task roles <id-or-alias>
sf task resume <id-or-alias>
sf task history <id-or-alias>
sf task export <id-or-alias> --format json|md [--redact]
```

**Grammar:** The initial implementation may use simple subcommands (`sf config set`, etc.) but documentation and tests must agree exactly with the shipped CLI; don't present unimplemented commands as working. `--revision` is required in noninteractive approvals; interactive mode shows revision/hash and requires confirmation.

### 8.3 R1 commands

```bash
sf task execute <id-or-alias> [--executor <configured-id>]
sf task run <id-or-alias>              # run next eligible stage
sf task review <id-or-alias> --ai
sf task review <id-or-alias> --human
sf task verify <id-or-alias>
sf task accept <id-or-alias>
sf task changes-requested <id-or-alias> --reason TEXT
sf task cancel <id-or-alias> --reason TEXT
sf task runs <id-or-alias>
sf task costs <id-or-alias>
sf task usage <id-or-alias>            # per-source / per-model token totals (Turbine + agents)
sf task usage add <id-or-alias> --source <agent> --input <n|unknown> --output <n|unknown> [--model <id>] [--method measured|reported|estimated]
sf task recover <id-or-alias> --apply  # only approved, safely executable affected stages
```

Token usage: every Turbine model call records `modelProvider`, `modelId`, and input/output tokens on its `role_run` (`unknown` when the adapter omits usage — never silent 0). Coding-agent usage is append-only via `turbine task usage add` (`usage_records`, migration v8). Packet STATUS/REVIEW (including ACCEPTED) render a Usage section from the store; `turbine task export` includes usage. Optional `budgets.perTask.maxTokens` is a retrospective cap: subsequent checked Turbine model calls are refused with `E_BUDGET_EXCEEDED` once measured Turbine input+output tokens have already reached the limit (unknown counts do not count toward the cap); a single in-flight call may still finish above the remaining allowance because the check uses completed usage, not a prediction of the next call. Agents may add records but there is no edit/delete API for human-entered rows.

### 8.3A Autonomous lane commands (#26 part A)

```bash
turbine policy list                       # active / suspended / pending / unapproved / invalid
turbine policy show <name>                # content, state, and approved → file diff when pending
turbine policy approve <name>             # HUMAN ONLY: TTY + typed short hash of the file content
turbine policy suspend <name> --reason T  # anyone, agents included (only removes autonomy)
turbine policy resume <name>              # HUMAN ONLY: re-activates the approved snapshot
turbine task lane <id>                    # is the task in the lane, or why it fell back
turbine task lane <id> --retry            # HUMAN ONLY: put a fallen-back task back in the lane
```

Policies are `.turbine/policies/<name>.yaml` (schema `LanePolicySchema` in `packages/contracts/src/lane-policy.ts`). Policy passes are `Decision`s with `actorType: 'policy'` and render as "Passed by policy `<name>` (approved by `<human>` on `<date>`)". `humanGates.{requirements,plan,codeReview,sqaAcceptance}` cannot be `false` (`E_CONFIG`); gates are relaxed only through approved lane policies.

For `codeReview`, a policy must name exactly two model profiles that resolve to different provider/model identities. Approval and evaluation both fail closed if either profile is missing or the resolved identities collide. Each reviewer runs every selected lens over the same pinned diff/change-set and is triaged independently. A policy decision may pass code review only when both outputs are complete and parseable and neither has a kept blocking finding. Timeout, refusal, parse or budget failure, disagreement, blocking findings, or a changed HEAD leaves the gate for a human. REVIEW.md renders completed dual reviews side by side, a new commit stales both, and per-lens agreement is retained for later metrics. The ordinary human lane keeps its single advisory AI review.

### 8.3B Autonomous lane metrics and audits (#30 part G)

```bash
turbine metrics [--policy <name|human>] [--since <date>] [--json]
turbine audit next
turbine audit record <id> --ok                         # HUMAN ONLY
turbine audit record <id> --problem "what went wrong" # HUMAN ONLY
```

Metrics cover every approved policy plus the human lane: merged PRs/week, merge/revert rates, fix rounds and cost per merged PR, reviewer disagreement, and fallback share with reasons. Every value carries its period, denominator and unknown count. Until Part C records merge/revert facts, merge-dependent values remain `unknown`; reviewer agreement and `lane.fallback` evidence are still reported.

A policy merge is sampled reproducibly at `sampling.rate` (default `0.1`). The merge record stores the SHA-256 seed, numeric draw, rate and selection result; selected merges enter `lane_audit_queue` (migration v11). `audit next` is read-only. `audit record` requires a real TTY, rejects agent markers, is blocked by the installed Cursor guard, and records the human reviewer.

After policy passes, merge records and audit outcomes, Turbine evaluates `suspendWhen`. Omitted thresholds use the safety defaults: revert rate above 2% over the last 50 known merges, at least two problems in the last 20 completed audits, or reviewer disagreement above 30%. Unknown revert facts cannot trigger a rate suspension. Crossing a threshold records an engine reason through `policy suspend`; the policy stays suspended until a human explicitly resumes it, and subsequent eligible tasks follow the human flow.

### 8.3C Autonomous lane PR and merge-queue landing (#32 part C)

When a task reaches `ACCEPTED`, the GitHub adapter creates or reuses the PR for `turbine/<work-id>` when project config allows `pr.create`; a lane task additionally requires that exact capability in its approved policy. The store records the PR number and head SHA. Turbine publishes `turbine/gate` on that SHA: only a PASS bound to the exact head is `success`; a changed head resets it to `pending`. Turbine publishes the status only on the PR head SHA. A merge queue evaluates required checks on the temporary merge-group commit, so the repository must name a trusted publisher (for example a CI workflow on the `merge_group` event) that republishes `turbine/gate` on that merge-group SHA; Turbine does not publish or vouch for it, and a queue without one cannot land the PR.

Before policy acceptance, GitHub rulesets must confirm that the base branch requires both merge queue and `turbine/gate`. Missing rules, API errors or insufficient permissions are `unknown` and leave acceptance to a human. Lane landing requires `pr.merge` in both project config and the approved policy, and only enables GitHub auto-merge into the queue; the task is recorded as queued only when GitHub reports queue membership. Before enabling it, Turbine re-reads the PR and refuses if its repo, base, head branch or head SHA differ from the record and configuration. A PR closed without merging is replaced, never reused. The policy's sampling rate is snapshotted when landing is authorized and is the rate used for the merge record. Auto-merge is enabled for exactly the accepted head (`expectedHeadOid`), and the base branch's rules are read from GitHub's "Get rules for a branch" for that exact branch (never matched locally; unreadable is `unknown`). Automation covers single-repo tasks only. Each queued job acts only if its exact acceptance (decision, revision, commit and worktree head) is still current, and the gate result is bound to the commit it evaluated. Unfinished automation for an ACCEPTED task (including a gate status that never reached GitHub, or a PR closed without merging, at an unchanged head) resumes on the next `sync`, only for the accepted head still in the worktree; a policy acceptance resumes only under the exact policy approval it recorded and on the PR target its protection was evaluated against, so a newer approval, an edit or a suspension blocks the retry and is never treated as human acceptance. A queue removal counts as an ejection only if it is newer than the removal GitHub showed when the landing attempt began and has not already started a fix round. `sync` polls the recorded PR of an ACCEPTED task and `turbine task pr-refresh <id>` does so on demand. It never pushes to the base, invokes direct merge or requests admin bypass. Queue ejection returns the task to `CHANGES_REQUESTED` with the reason and increments its fix-round record. A successful merge writes merged SHA/time to the Part G store; later revert detection and stacked PRs remain deferred.

### 8.4 R2+ commands (not implemented in R0/R1)

```bash
sf tool connect github
sf task sync <id> --target jira --dry-run
sf task sync <id> --target jira --confirm
sf auth login
sf org members
sf policy exception request
sf service start
```

Do not advertise these as available until implemented.

### 8.5 CLI example: text intake to approved plan

```bash
sf init
sf model add
sf task create --title "Add leave approval endpoint" --file examples/leave-approval.md
# Returns internal ID, e.g. work_01...; save it as $WORK_ID
sf task assess "$WORK_ID"
sf task show "$WORK_ID" requirements
sf task requirements approve "$WORK_ID" --revision <exact-hash>
sf task plan "$WORK_ID"
sf task show "$WORK_ID" plan
sf task plan approve "$WORK_ID" --revision <exact-hash>
sf task contract show "$WORK_ID"
sf task contract validate "$WORK_ID"
sf task status "$WORK_ID"
```

### 8.6 CLI example: Jira intake

```bash
sf tool connect jira
sf tool test jira
sf task takeover jira:OPS-123
sf task status OPS-123
# Continue identical requirements/plan workflow against resolved internal work ID
```

### 8.7 Error semantics

```text
E_REQUIREMENTS_INCOMPLETE: Unanswered authorization question blocks approval.
E_STALE_REVISION: Target artifact changed; review latest version before approval.
E_MISSING_CAPABILITY: `repo.inspect` is required but no authorized tool provides it.
E_UNTRUSTED_IDENTITY: This local attestation cannot satisfy authenticated-team policy.
E_BUDGET_EXCEEDED: Execution paused; no further model calls occurred.
E_SOURCE_CONFLICT: Jira changed since import; inspect before syncing.
E_EEC_UNSATISFIED: Mandatory current-revision obligation has no acceptable evidence.
E_EVIDENCE_STALE: Current commit/spec/plan differs from evidence-bound revision.
E_IMPACT_UNKNOWN: Artifact dependency coverage is incomplete; conservative recovery is required.
E_RECOVERY_UNAUTHORIZED: Proposed recovery needs human authorization or a new approval.
E_UNSAFE_EXECUTION: The requested command is not allowlisted/authorized.
E_INVALID_TRANSITION: Work is in PLAN_REVIEW, cannot execute until approved.
```

---

## 9. Approval, review and verification behavior

### 9.1 Approval UX

Interactive approval shows: work ID, stage, actor/identity assurance, proposed artifact revision/hash, source snapshot, diff vs previous version, critical questions, role/risk classification, relevant impacts, and choices `[approve / request changes / reject / view more]`. If no TTY, require exact `--revision`, and never default to approve. CLI records approval transactionally.

### 9.2 Permissions

| Operation | Default R0/R1 | Later team-grade |
|---|---|---|
| Read public/source task | Configured adapter grants | Scoped service identity |
| Run assessment/plan | Local user if model configured | Member with project permission |
| Approve requirements/plan | Local **attestation**, clearly labeled | Authenticated PM/tech role |
| Execute code | Explicit authorized local project | Authenticated bounded worker |
| Approve own AI output | **Forbidden for AI** | Forbidden |
| Approve / resume a lane policy, retry the lane | Local human attestation (TTY + typed hash) | Authenticated role |
| Suspend a lane policy | Anyone, agents included | Anyone |
| Approve code/SQA | Local human attestations, or a recorded eligible lane-policy pass (dual AI evidence for code review) | Independent authenticated human roles |
| Sync Jira/edit remote | Disabled until explicit R2 feature | Permission + diff-bound approval |
| Push/merge/deploy | Base push, direct/admin merge and deploy are forbidden; an approved lane may enable merge-queue auto-merge under §8.3C | Separate guarded workflows |

### 9.3 Evidence and invalidation rules

- If spec changes after plan approval, plan approval invalidates and plan regenerates or is revalidated.
- If plan changes after execution authorization, execution must pause until new approval.
- If source commit changes after review/verification, affected checks and approvals must rerun.
- A rejected review links findings to the commit and moves to `CHANGES_REQUESTED` with a valid return target.
- Passing tests do not override a failed manual acceptance criterion. An LLM statement does not count as a test run.
- `ACCEPTED` requires completed requirements, plan, implementation, applicable independent review, target checks, human SQA evidence and explicit human acceptance for the current revision. **Exception (autonomous lane, #26/#28/#32):** an active, human-approved lane policy that lists `acceptance` may replace the human SQA evidence and acceptance decision with a `policy` decision for that revision, only when every P0 requirement has FULL traceability, every configured quality check passed at the current commit, no required obligation is unmet or waived, code review for that commit was passed either by a human or by the policy's complete clean dual-review evidence, project config and policy both grant `pr.create`/`pr.merge`, and GitHub confirms the base requires merge queue plus `turbine/gate`. The human approval behind it covers the policy file, not this revision's evidence; any failed or unknown condition sends the task to a human.

### 9.3A EEC gate and recovery UX

`sf task contract show` displays each obligation, associated acceptance criterion, current source/spec/plan/commit revision, required evidence, current evidence, and derived status. `validate` exits with policy error when mandatory obligations are stale/blocked/unsatisfied. `sf task impact` prints changed hashes, all deterministic affected edges, unknown coverage and invalidated decisions. `sf task recover --dry-run` never mutates state: it describes affected stages, work that can be retained, reapproval needs and potential cost. `--apply` in R1 only executes stages that are **already approved and authorized**, and never grants a missing human approval. Every command supports JSON output where practical.

An EEC cannot be accepted if a required obligation refers to an older spec, plan, diff, commit, test definition or environment outside the declared validity policy. Marking a check stale requires an invalidation event, not deleting its old successful result. Correctness is never inferred from a green status string alone.

### 9.4 Role independence and adaptive overhead

A role may execute several compatible skills in one session. Separate reviewer context when value/risk warrants. Deterministic `code-quality-checker` requires no paid LLM by default. Record role handoffs and costs. The engine MUST be capable of explaining omitted roles. R0/R1 retains human gates even for lightweight tasks, prioritizing learnability and integrity over premature speed claims.

---

## 10. Security, privacy and safety — nonfunctional acceptance blockers

### NFR-SEC-01 Threat model

Explicitly assess prompt injection from issue descriptions, source files, skill text, malicious dependency files and tool outputs; credential leakage; unauthorized Git/Jira writes; arbitrary command execution; unsafe model output; excessive permissions; cross-task contamination; stale-approval replay; malicious skills; leaked client information.

### NFR-SEC-02 Least privilege by capability

Every run receives a task-specific allowlist. Model text is untrusted and cannot authorize tool grants. Forbidden operations include reading OS secrets, arbitrary network exfiltration, modifying files outside designated workspace, changing Git remotes, uploading artifacts, and production actions without explicit policy. Policy MUST be enforced by code, not solely by prompt.

### NFR-SEC-03 Worktree is not sandbox

A Git worktree protects against accidental working-tree overlap, not hostile code. `execution.mode: sandboxed-unattended` runs the implementer in Docker or Podman with only the task worktree mounted (no home, SSH agent, git credentials, or `.turbine/state/`), fail-closed runtime + egress preflight, per-phase network scopes, and wall-clock / output-size limits. Default remains `manual-supervised` handoff. Other modes still raise `E_UNSAFE_EXECUTION` for networked unattended work and never fall back to unsandboxed execution when sandbox preflight fails.

### NFR-SEC-04 Secrets and logs

Store secrets in a user-managed secret backend/keychain or environment variables with masked values; never in YAML, SQLite, test fixtures, prompts or logs. Prevent stdout/stderr containing credentials from being exported without redaction. File permissions restricted; backup/export defaults exclude secrets and sensitive client data. No provider telemetry by default without explicit opt-in.

### NFR-SEC-05 External writes and idempotency

Jira edits/comments, remote branches and PRs are side effects. Show exact target/diff, check stale source revisions, require human authorization, use idempotency tokens or reconciliation, and log provider response IDs. Disable destructive Jira transitions, auto-merge and deploy in first releases.

### NFR-SEC-06 Dependency/security checks

Pin dependencies and skill revisions; review licenses, run dependency scanning, verify artifact integrity, validate input content size/paths, neutralize shell injection, detect symlink escape/path traversal, cap model prompt sizes and subprocess output. No dynamic code evaluation of skill manifests.

### NFR-SEC-07 Human approval integrity

Authenticated audit trails require verified identity and authorization. Local CLI approvals cannot claim tamper resistance or server-side attestation. Human authorization must be distinguishable from AI-proposed content.

---

## 11. Operational qualities and target constraints

| NFR | Target/contract |
|---|---|
| Performance | Local `sf doctor`, `sf task list/status` should normally complete within 2 seconds on reasonable developer hardware excluding remote calls; benchmark and report actual results |
| Reliability | Restart and resume after forced interruption without losing last committed event or duplicating approved artifacts |
| Idempotence | Re-running intake with same source snapshot offers reuse/new-revision choice; never silently duplicates external writes |
| Availability | Offline operations (`list`, `status`, `show`, local history) function without network; remote intake/models fail informatively |
| Extensibility | New input adapter or model adapter requires no framework schema changes if existing capabilities suffice |
| Testability | Deterministic state/gate logic has unit tests; LLM integration uses mock adapter fixtures; end-to-end tests run offline |
| Cost control | Configurable task/run budgets; hard stop before a call that is known to exceed remaining budget; unknown provider costs disclosed |
| Observability | Structured event logs with role, skill, provider, tool capability, revisions, cost, outcomes, errors, redaction |
| Privacy | Task storage and export local by default; opt-in telemetry only; company/client data handled under authorization |
| Accessibility | CLI readable terminal outputs, no color-only cues; `--no-color`, JSON output, meaningful nonzero exit codes |
| Portability | macOS + Linux in R0/R1; Windows support targeted after platform-specific validation |
| Compatibility | Node version, OS, SQLite driver and executable providers validated in CI; lockfile checked |
| Documentation | Installation, troubleshooting, migration, threat model and safe-run guide included |

No invented SLA, SOC 2/ISO certification, or guaranteed efficiency claim is permitted in product messaging.

---

## 12. Configuration schema (illustrative target)

```yaml
schemaVersion: 1
project:
  name: ops4
  root: .
  nonProductionOnly: true
framework:
  id: turbine
  version: 1.0.0
  policyProfile: standard
inputs:
  default: file
  adapters:
    jira:
      enabled: false
      siteUrl: null
      credentialRef: null
models:
  defaultProfile: analysis
  profiles:
    analysis:
      provider: configured-provider
      model: configured-model-id
      maxOutputTokens: 4000
    implementation:
      provider: configured-provider
      model: configured-model-id
      maxOutputTokens: 8000
budgets:
  perTask:
    currency: USD
    maxEstimatedCost: 5.00      # user-configurable EXAMPLE, not a pricing claim
    maxModelCalls: 15
    maxExecutionAttempts: 2
    maxTokens: null             # optional cap on measured Turbine input+output tokens; null = no cap
tools:
  allow:
    - issue.read
    - repo.inspect
    - repo.read
    - git.diff
    - tests.run
  denied:
    - issue.edit
    - issue.transition
    - pr.merge
    - production.deploy
execution:
  mode: manual-supervised       # or sandboxed-unattended (Docker/Podman; worktree-only mounts; fail-closed preflight)
  requireIsolatedWorktree: true
  allowNetwork: false           # networked unattended work only in sandboxed-unattended after preflight
  sandboxWallClockMs: 1800000   # sandboxed-unattended wall-clock limit (FR-D6)
  sandboxMaxOutputBytes: 8000000
quality:
  checks: []                    # determined from repo and approved by human
humanGates:                     # these four cannot be false (E_CONFIG); relax gates only via approved lane policies
  requirements: true
  plan: true
  codeReview: true
  sqaAcceptance: true
```

Configuration precedence: defaults < versioned framework policies < project config < explicit user overrides **for non-security settings only**. Security policy and mandatory hard triggers take precedence over project/operator options. Every override is recorded; no local setting can bypass engine-level security control silently.

---

## 13. R0 acceptance criteria — implementation gate

| ID | Scenario | Pass condition |
|---|---|---|
| AT-001 | Fresh repo initializes | `sf init` creates valid config/state and explains changes; second invocation is safe |
| AT-002 | Invalid config | CLI refuses with field-level errors and no data loss |
| AT-003 | Text input | Creates normalized work item and retains original content/hash |
| AT-004 | Jira input | Read-only adapter imports a fake/test issue and retains source/version; live access optional behind credentials |
| AT-005 | Source portability | Text and Jira inputs use the same core assessment/plan pipeline without provider-specific branches in framework code |
| AT-006 | Requirement gaps | Missing access-control behavior or acceptance criteria produces questions, not invented facts |
| AT-007 | Requirement approval | Only exact current hash may be approved; noninteractive requires hash; local identity warning shown |
| AT-008 | Plan creation | Requires approved requirements and creates plan linked to requirements revision |
| AT-009 | Plan approval | Exact-current-plan hash required; stale approval rejected |
| AT-010 | Workflow restart | Process stopped after assessment resumes without losing approvals or duplicate events |
| AT-011 | Role policy low risk | Localized change does not spawn unnecessary architect/security/QA AI runs |
| AT-012 | Role policy high risk | Auth/permissions and DB migration trigger mandatory specialist/policy requirements |
| AT-013 | No forbidden capability | Unconfigured/missing/denied tool cannot be called; policy block is logged |
| AT-014 | Model neutrality | Mock model and configured live provider satisfy same output schema; no provider imports in framework package |
| AT-015 | Skills safety | Untrusted SKILL.md cannot override tool grants or framework gates |
| AT-016 | Budget exhaustion | Engine pauses before unauthorized additional model call, with resume instructions |
| AT-017 | Audit | Original snapshots, role-selection reasons, hashes, model/tool runs and approvals recoverable |
| AT-018 | Offline tests | Unit/integration test suite runs with mocked external providers and no API keys |
| AT-019 | Error UX | Invalid transition, stale hash and Jira outage produce nonzero exit codes and actionable messages |
| AT-020 | Docs | README enables second developer to install and reach approved plan without founder guidance |
| AT-021 | EEC initialized | Every task has a versioned EEC referencing source hash, required obligations and policy rules |
| AT-022 | EEC gate coverage | Missing required acceptance criterion/approval obligation blocks current gate with exact reason |
| AT-023 | Requirements changed after approval | New spec revision triggers transitive invalidation of plan approval and downstream EEC obligations; original decision remains in history |
| AT-024 | Stale approval resistance | Old exact-hash approval cannot authorize revised plan, even after CLI restart |
| AT-025 | Safe recovery R0 | Impact and dry-run report affected and retained artifacts; regenerated plan needs new human approval |
| AT-026 | Dependency unknown | Missing link triggers conservative stale/block, never optimistic acceptance |
| AT-027 | Change idempotency | Repeating source refresh with unchanged hash creates no duplicate invalidation events |
| AT-028 | Tool-neutral EEC | The same EEC validation runs for file and Jira-origin tasks without provider-specific branches |
| AT-029 | EEC persistence | SQLite restart reconstructs exact contract revision and stale obligation statuses from events |

**R0 exit:** at least one real noncritical source issue and one text issue completed through `PLAN_APPROVED` by someone other than the founder. This is an operability test, not a productivity superiority test.

## 14. R1 acceptance criteria — end-to-end gate

| ID | Scenario | Pass condition |
|---|---|---|
| AT-101 | Approved plan required | Coding executor cannot start without current approved spec/plan |
| AT-102 | Isolated work | Task branch/worktree created without modifying user's active working copy |
| AT-103 | Executor authorization | No unrestricted shell/network/filesystem grants; unsafe mode forces supervised/manual execution |
| AT-104 | Role selection | Only relevant specialist AI runs invoked; deterministic checks not implemented via unnecessary LLM calls |
| AT-105 | Implement + test | Changes, base/target diff, unit tests and actual test logs attached |
| AT-106 | Review independence | Reviewer obtains spec/diff and fresh review context, does not merely accept implementer's self-report |
| AT-107 | Human review | Explicit local attestation or authenticated provider approval tied to exact commit |
| AT-108 | Verification | Final checks execute on current tested commit and record exact environment/exit codes |
| AT-109 | Stale code | New commit invalidates review and verification; cannot accept stale approvals |
| AT-110 | Manual SQA | Human records expected/actual, environment, evidence and signoff |
| AT-111 | Accept | `ACCEPTED` produces report with artifacts, pending limitations and no unsupported deploy claim |
| AT-112 | Rework | AI/human rejection returns to appropriate stage without erasing prior decisions |
| AT-113 | Error recovery | Interrupted runner restarts safely with bounded retries and no duplicate remote changes |
| AT-114 | Cost tracking | Shows actual/estimated/unknown spending separately and total role/tool handoff count |
| AT-115 | Pilot demo | One real authorized 6sense noncritical task completes full process with human approval |
| AT-116 | Commit changed after review | Current code review and commit-bound tests become stale; original reports remain inspectable |
| AT-117 | Changed test obligations | Updating required test criteria invalidates affected verification and dependent acceptance |
| AT-118 | EEC final gate | An `ACCEPTED` work package has no mandatory stale, blocked, failed or unsatisfied obligations |
| AT-119 | Recovery plan | `sf task recover --dry-run` identifies exact affected stages, safe retained results, unknown coverage and new approvals |
| AT-120 | Selective recovery executes safely | `--apply` refuses unauthorized work, reruns affected checks and never reuses mismatched commits |
| AT-121 | Failure-informed specialist selection | A failed relevant test causes policy reassessment; optional specialist addition is explained and mandatory protections retained |
| AT-122 | Comparison fixture | Changing requirements then code demonstrates recovery vs full rerun; report real call counts, elapsed and test outcome, not projected speedup |
| AT-123 | No invented success | AI assertion that old tests remain valid fails against deterministic evidence freshness checks |

**R1 exit:** complete a second bounded work item and document human effort, handoffs, rework, API cost if known, and failure modes. Do not claim statistics from two tasks.

---

## 15. Implementation plan for Cursor (no ambiguous handoff)

Each phase has a concrete deliverable and test gate. **Do not begin next phase until current tests pass and a human reviews the result.** The app may remain private until ownership/IP rights are resolved.

### Phase 0 — Repo and scaffolding

**Tasks:** create monorepo; pnpm workspaces; TypeScript strict/ESM; formatter/lint/typecheck; Vitest; CLI command parser; package build; CI running offline tests; README, LICENSE placeholder (not unapproved license), local secrets ignore rules. Set Node version in `.nvmrc` or equivalent, pin versions with lockfile.  
**Done:** `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass (adjust first-install procedure to generate lockfile before frozen check). `sf --help` works locally.

### Phase 1 — Contracts and persistence

**Tasks:** Zod schemas for WorkPackage/SourceRef/Artifact/Decision/RoleRun/Evidence/**EEC/Obligation/DependencyEdge/InvalidationEvent/RecoveryPlan**, SQLite migrations, event store, state transaction, artifact content hash, config loader, `sf init`, `doctor`, `task create/list/show/history/status`; create initial EEC on intake.  
**Done:** tests for schema rejection, idempotence, DB restart, immutable artifact revisions, event/state atomicity and command errors pass.

### Phase 2 — Framework/gates and selection

**Tasks:** framework loader, transition table, EEC obligation predicates, typed dependency graph, deterministic transitive invalidation and R0 recovery-plan computation, role manifest registry, 16 role definitions, ARSP deterministic rules and explainability, `framework/role/skill` read commands, task contract/impact/roles/explain.  
**Done:** property/table tests for all transitions and mandatory security triggers; role counts do not imply model run counts.

### Phase 3 — Skills, model and approved requirements

**Tasks:** original requirements-analysis and spec-writing skills with JSON output contracts; model adapter and mock; bounded calls/budget; assessment; clarification; view/edit artifacts; revision-bound requirement approval; changed-requirements EEC invalidation; `sf task assess`, requirements and EEC validation commands.  
**Done:** incomplete spec blocks; no AI self-approval; model output cannot bypass gates; mock tests offline.

### Phase 4 — Planning and Jira intake (R0 complete)

**Tasks:** original plan skill; repository-context read if configured; plan generation/approval and approval invalidation; read-only Jira connection, source refresh and ADF parsing; same normalized input path; `takeover`, `impact` and R0 `recover --dry-run`; CLI docs and changed-requirement fixture.  
**Done:** pass all AT-001..AT-029; second user follows README and completes text and Jira sample through `PLAN_APPROVED`.

### Phase 5 — Safe executor and review (R1 foundation)

**Tasks:** Git worktree creation, task-scoped grants, supervised/manual IDE handoff fallback, single selected coding adapter when safe, code/test artifact ingestion; independent AI review; deterministic quality commands; EEC commit/diff lineage and stale code-review detection.  
**Done:** execution denied if unsafe; diff/evidence revision bound; failure/retry tests; no automatic pushes/merges.

### Phase 6 — SQA, acceptance, demo (R1 complete)

**Tasks:** code review gate, test-case/API verification for selected test task, manual SQA evidence forms in CLI, `verify`, `accept`, change-impact and authorized `recover --apply`, failure-driven role reassessment, current EEC acceptance, full task report and cost breakdown.  
**Done:** pass AT-101..AT-123; demo a real authorized noncritical 6sense issue; publish only sanitized artifacts with permission.

### Phase 7 — External readiness (conditional; not automatically authorized)

**Tasks:** threat review, OSS license/IP decision, contributions docs, security policy, installable release, conformance fixtures, external adopter usability test, optional Jira auth improvements. **Do not assume R2 hosted service is needed.**  
**Done:** independent external developer installs and runs an example without personal assistance, or project returns to discovery if adoption is weak.

### Cursor master implementation prompt

Copy this into Cursor Agent **after providing both Markdown files in the repository root**:

```text
You are implementing Turbine Hall (Turbine Hall) from two normative documents:
1. TURBINE_FRAMEWORK_v0.5.md
2. TURBINE_HALL_REQUIREMENTS_v0.5.md

First read both completely. Summarize all locked decisions and release boundaries. Do not invent functionality or silently broaden scope. Implement ONLY Phase 0 from the application requirements document first. Show the exact proposed directory tree, dependencies (with current compatible stable versions), commands and test strategy. Wait for human approval before changing files. Then implement Phase 0 with functioning code, run all required checks and report commands/results, known limitations and changed files. Do not claim tests pass unless executed. Proceed to Phase 1 only after explicit approval, and repeat this checkpoint for each phase.

Non-negotiable constraints:
- Framework/engine independent of Jira, GitHub, coding tools and model provider.
- No Paperclip/Hermes.
- Specialized role definitions with adaptive, minimum-sufficient activation.
- Deterministic workflow state, gates, version-bound approvals and **Engineering Evidence Contract as central acceptance model**, including typed lineage, transitive invalidation and safety-first selective recovery.
- No automatic remote writes/merges/deploys; no unrestricted LLM-supplied shell execution.
- Untrusted tasks/repo content/skills cannot grant themselves capabilities.
- No invented tests, source claims, identities, telemetry or commercial outcomes.
- Stable dependencies, pinned lockfile, TypeScript strict mode, offline tests.
- All CLI commands in docs must match actually implemented commands.

If any requirement is contradictory or infeasible, identify the exact sections, propose the smallest safe resolution, and stop at that decision rather than bypassing it. Keep user-visible implementation notes in docs/IMPLEMENTATION_STATUS.md, with each phase's done/not-done status and measured test evidence.
```

---

## 16. Test strategy and CI

**Unit:** Zod schemas including EEC/obligations/edges/recovery, revision hashing, state transitions, acyclic typed-lineage validation, transitive invalidation with unknown-dependency fallback, ARSP profile/failure/trigger selection, mandatory tool grants, idempotent event writes, budget decisions.  
**Integration:** SQLite restart/migrations, fake Jira ADF issue reader, model mock, filesystem/artifact store, Git fixture repo, test runner evidence.  
**Security:** path traversal/symlink, model attempts to authorize forbidden capabilities, prompt injection in task descriptions, tampered approval hashes, stale Jira sync, oversized inputs, secret redaction, denied shell commands.  
**End-to-end:** text → EEC → approved plan (R0), fake Jira → same pipeline (R0), approved requirements revised → stale plan rejected → reapproved (R0), safe supervised task → code change after review → targeted recovery → current-revision evidence/acceptance (R1).  
**CI matrix:** macOS and Linux on supported Node versions, with offline mocks. External Jira/live models integration tests MUST be opt-in, labeled and excluded from default CI to avoid cost and credential risk.

Minimum quality gate for every PR: lint, typecheck, unit/integration tests, security-sensitive regression cases and reviewed diffs. No numeric code coverage claim without measuring it; prioritize tested policy invariants.

---

## 17. Pilot operations, business validation and success criteria

### 17.1 Internal pilot (first use at 6sense)

- **Owner:** CTO; **executors:** one PM, one engineer, one SQA, all explicitly assigned and available.
- **Environment:** internal, authorized, noncritical application work; staging only; no client secrets or production credentials in prompts.
- **Task 1:** real small bug/feature through R0 then R1 after implementation exists; include a controlled requirement change to test stale-evidence invalidation; **Task 2:** another bounded change run by a non-founder; **Task 3:** a different task type if safe. Record failure and overhead, not just successes.
- **Baseline:** manually run an equivalent task with existing Jira/GitHub + agent/skills (or use a similar historical task with clear selection limitations). Record confounders.
- **Initial exit:** no skipped mandatory gates, usable resume, truthful evidence, bounded cost, operator understands status and corrective actions. If tool creates more burden than value, freeze expansion.

### 17.2 Idea Forge: decisive experiments

| Experiment | Hypothesis | Budget/cap | Pass/fail rule (set before starting) | Decision |
|---|---|---|---|---|
| E1 — Operational feasibility | Another team member can run the full task without founder intervention | One developer + limited PM/SQA time; cap set before kickoff | Pass: completion with evidence and approvals; fail: unsafe/unrecoverable or founder-dependent | Fix method/UX or stop expansion |
| E2 — Net process value | At least one measurable team problem improves without intolerable overhead | 3 internal tasks plus manual control; no scientific proof | Pass: participants prefer repeated use and report specific concrete saved work; fail: equal results with lower-overhead existing method | Narrow wedge or prefer extension/service |
| E4 — EEC/recovery differentiation | Stale approvals are blocked and recovery minimizes avoidable reruns without losing quality | Controlled spec/plan/commit mutation fixture and manual-method comparison | Pass: zero stale approvals accepted, exact invalidations logged, measurable avoided repeat effort vs safe full rerun; fail: missed stale evidence or no net usability gain | Simplify policy or favor existing method |
| E3 — Buyer behavior | A reachable CTO considers paid assistance meaningfully valuable | 10 qualified problem conversations, no upfront sales claims | Pass: one credible paid-pilot discussion/commitment; fail: interest only in free tool | Revisit commercial model |

Set operational hours, model/tool cost ceilings and explicit outcomes **before** the experiment. Do not retroactively adjust thresholds to claim success.

### 17.3 Full vision: parallel value tracks

- **Open source:** after IP/license clearance, publish reproducible examples and roadmap; seek independent repeat adopters before star growth goals.
- **Marketing/brand:** show actual before/after artifacts, demos, cost/rework, failures; no “next Scrum,” “fully autonomous,” or unproven performance claims.
- **Commercial:** 6sense may offer paid workflow assessments, adoption pilots, training, managed engineering and later hosted support; validate buyer/payer first.
- **Research:** gather consented/redacted, versioned datasets; compare against existing frameworks; legitimate authorship requires substantial scholarly contribution.
- **International relations/travel:** develop genuine OSS/client/research partnerships; any visa/travel must follow applicable rules and is not guaranteed or a core product requirement.

---

## 18. Traceability and change control

- Framework IDs `F-*` bind overall decisions; functional requirements `FR-*`, nonfunctional `NFR-*`, acceptance `AT-*` and implementation phases link back to this file.
- Every code PR should reference relevant requirement IDs and acceptance tests.
- On conflict: security rules > framework normative contract > approved work spec > role/skill manifest > external/untrusted inputs. Proposed changes that alter normative behavior require an ADR and updated tests.
- Ship changes as **small, reviewable PRs**: scaffolding; contracts/store; state/role policy; skills/models; planning/Jira; execution/review; SQA/acceptance.
- Keep `docs/IMPLEMENTATION_STATUS.md` truthful with `planned / active / implemented / tested / blocked` per requirement. No claim that R1 exists simply because R0 CLI commands work.
- The product remains exploratory until repeatable evidence of internal value and customer adoption exists.
- **Repository context, layer 1 (FR-CTX-01, AT-CTX-01..08):** deterministic project facts at a commit, with a source for every fact, measured (not asserted) conventions, separate declared/installed versions and no stale snapshots.
- **Repository context, layer 2 (FR-CTX-02 / #7):** project brief built only from claims that passed a deterministic verifier (or human-attested). Model proposes claims; `publishClaim` verifies; sections render from verifier/evidence templates; `turbine context approve` / `attest` are human-only; `turbine understand` drafts/reverifies with no model calls when unchanged.
- **Repository knowledge (OKF v0.3 / #14):** `turbine understand` publishes `.turbine/knowledge/` as a fixed-profile OKF bundle (`turbine-okf/1`) from the store; unconfirmed items are only Open Questions; withdrawn claims leave the bundle into `log.md`; atomic publish under the context lock; `knowledge validate` / `show` / `export`; live bundle git-ignored by default.
- **Repository context, layer 3 (FR-CTX-03, AT-CTX-09..13):** a per-task `CONTEXT.md` selection of files, every one with a reason that can be re-derived from the blobs at the recorded commit, a role size limit with the omitted files listed, rebuilt before `next` points to it, and agent notes kept apart from the generated facts.
- **v0.5 baseline additions:** Core EEC (FR-WF-03A), typed lineage/invalidation/recovery (FR-WF-03B), failure/cost-aware role reassessment, CLI contract/impact/recovery commands, AT-021..AT-029 and AT-116..AT-123. These do not authorize building advanced semantic impact analysis, a new hosted platform or any future integration in R0/R1.

## 19. Verified reference shortlist (2026-11-11)

Use source links as research/engineering inputs, **not** as authorization to copy source or licenses:

1. [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) — adjacent structured agent-assisted method; stable v6.12 and v7 preview should not be confused.
2. [GitHub Spec Kit](https://github.com/github/spec-kit) — specification-driven and related workflows.
3. [OpenSpec](https://github.com/Fission-AI/OpenSpec) — incremental specification/change management.
4. [Superpowers](https://github.com/obra/superpowers) — development skills, planning, review, debugging.
5. [Karpathy-inspired guidelines](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/skills/karpathy-guidelines/SKILL.md) — third-party skill, not official Karpathy-authored guidance.
6. [Jira REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/) and [OAuth scopes](https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/) — API and permission contract.
7. [OWASP LLM06 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) — capability restriction, human oversight and attack surface.
8. [SWE-bench](https://www.swebench.com/) — real issue-level evaluation inspiration, not proof of this methodology.
9. [MetaGPT (ICLR 2024)](https://proceedings.iclr.cc/paper_files/paper/2024/hash/6507b115562bb0a305f1958ccc87355a-Abstract-Conference.html) and [ChatDev (ACL 2024)](https://aclanthology.org/2024.acl-long.810/) — multi-role agents prior art.
10. [METR developer study](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) and [2026 follow-up](https://metr.org/blog/2026-02-24-uplift-update/) — productivity evidence remains mixed and context dependent.

**Evidence limitations:** This specification is based on prior-art/research documentation and user-provided requirements; it is not based on new customer interviews, actual usage telemetry, a completed 6sense pilot, a formal patent search, or legal/security certification. Re-evaluate the commercial thesis after measurable pilots.
