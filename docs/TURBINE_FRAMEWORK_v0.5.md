# Turbine

**Version:** v0.5 implementation baseline (document revision 2; proposal, not empirically validated)  
**Date:** 2026-11-11  
**Status:** v0.5 design baseline; not implemented or experimentally validated. Effectiveness, differentiation, and pricing remain hypotheses  
**Intended readers:** CTOs, product managers, software engineers, SQA engineers, designers, open-source maintainers, researchers, and contributors  
**Companion document:** `TURBINE_HALL_REQUIREMENTS_v0.5.md`

> **Mission:** Establish a portable, evidence-driven operating method for teams of humans and AI agents to specify, implement, review, test, and evolve software safely, economically, and repeatably.

## 0. Executive decision and document contract

**Idea Forge verdict: TEST FIRST.** Authorize a time-boxed engineering pilot; do **not** claim an invented discipline, proven improvement over existing methods, or commercial product-market fit. This document finalizes the *working design* sufficiently for implementation, not empirical truth.

**What the user originally proposed:** A Scrum-like software-engineering philosophy and open-source factory platform; real use at 6sense Technologies; specialist agent roles with assigned skills; vendor/tool independence; international developer contributors, research collaboration, public technical content, an eventual business for 6sense, and professional travel opportunities.

**Agreed evolutions:** (1) Jira and repositories are tools rather than foundations; (2) framework and software engine are independent; (3) deterministic governance controls agent execution; (4) specialist roles are capabilities invoked adaptively; (5) skills from established methods are optional sources, never silently copied into the product; (6) project implementation starts with a bounded end-to-end vertical slice, not a full multi-agent factory.

**Core thesis, falsifiable:** For small and midsize professional software teams that already use AI coding tools, a portable role-and-policy-governed workflow will improve task readiness, traceability, independent verification, or rework burden versus their existing process, without unacceptable coordination cost or quality degradation. The magnitude and even direction of the effect are currently unknown.

**Language:** MUST = mandatory for conformance; SHOULD = preferred unless a documented exception applies; MAY = optional. The framework's normative requirements are separate from particular software implementations.

### 0.1 Design decisions (locked for pilot)

| ID | Decision | Rationale |
|---|---|---|
| F-01 | Framework is a documented, versioned method independent from a CLI or SaaS | Prevent vendor lock-in and enable learning, independent adoption, research |
| F-02 | Separate `Framework → Engine → Roles/Skills/Tools/Models → Work outputs` | Clear responsibility boundaries |
| F-03 | Jira, Git, GitHub, IDEs and CI are **tools/adapters** | Replaceable sources and destinations |
| F-04 | Humans and AI agents both act as workers under the same work contract | Consistent responsibility/evidence |
| F-05 | Roles are **responsibility contracts**, not permanently running personas | Avoid needless agent calls and handoffs |
| F-06 | Adaptive Role Selection chooses minimum sufficient capabilities by scope/risk | Control cost without dropping quality |
| F-07 | Workflow transitions, approvals and evidence requirements are deterministic rules | LLM output cannot approve itself |
| F-08 | Requirements and plans are revisioned, and approval is bound to exact content hash | Prevent stale approvals |
| F-09 | AI can draft/execute within authorized scope but not merge, deploy, expand scope or approve itself | Safety and accountability |
| F-10 | One full task workflow is piloted before autonomous multi-task orchestration | Test value quickly |
| F-11 | First use case is an existing, noncritical 6sense application task | Realistic and bounded learning |
| F-12 | No Paperclip/Hermes dependencies | Explicit user decision |
| F-13 | **Engineering Evidence Contract (EEC)** is the canonical unit of outcome governance, bound to each Work Package | Connect obligation → artifact → evidence → approval, not merely a task status |
| F-14 | Artifact revisions and typed dependency edges are immutable, hash-bound and provenance-preserving | Make change impact and audit reproducible |
| F-15 | Invalidation is transitive, deterministic and conservative when dependencies are incomplete | Prevent stale approvals/reviews/tests from satisfying current gates |
| F-16 | Selective recovery reuses only demonstrably valid results; otherwise re-execute affected gates | Control rework without false assurance |
| F-17 | Adaptive role selection reassesses observed failure, actual cost and residual risk | Avoid indiscriminate specialist invocation |
| F-18 | Originality is a **comparative hypothesis**, not a feature checklist | Validate EEC integrity, recovery and overhead against simpler approaches |
| F-19 | R0 provides basic EEC, requirements/plan change impact and recovery; R1 extends to code/review/test | Fast delivery without pretending full dependency intelligence exists |

### 0.2 Not claims of originality

Agile, Scrum, specification-driven development, defined AI roles, prompt/skill libraries, human approvals and multi-agent pipelines all predate Turbine. The possible defensible contribution is **portable, enforceable human–AI execution governance** coupled with **adaptive specialization and evidence provenance** across engineering tools, if it outperforms simpler alternatives in practice. Avoid calling Turbine an industry standard or research-backed before independent evidence exists.

---

## 1. Philosophy and principles

1. **Value over activity.** Accepted, maintainable behavior matters more than code volume, tasks completed or agents spawned.
2. **Humans remain accountable.** Every accepted work item has an identifiable human accountable owner and reviewer; an agent never becomes the final business authority.
3. **Requirements before irreversible actions.** AI may explore ambiguity but MUST distinguish confirmed decisions from its own proposals.
4. **Revisions are immutable evidence.** Each approved artifact is identified by hash, author/source, time and scope. Change invalidates dependent approvals as specified below. The active Engineering Evidence Contract is the authoritative evaluation record for whether obligations are satisfied.
5. **Capabilities over personalities.** Role definitions describe permissions, skill capabilities, inputs and outputs—not fictional employees or endless chat personas.
6. **Right-sized specialization.** Use the smallest sufficient role set; prefer one run with multiple skills when independence is unnecessary.
7. **Independent verification when risk warrants it.** A reviewer SHOULD receive fresh context and objective evidence, not the implementer's self-attestation.
8. **Deterministic where possible.** Tests, schema validation, linting, permission checks, state transitions and budgets are code, not discretionary prompts.
9. **External systems stay external.** The method operates on normalized work packages and tools; a Jira ticket or GitHub PR is neither a workflow engine nor the single source of all truth.
10. **Trust is bounded and observable.** Tool capability grants, cost ceilings, runtime restrictions, logs and human escalation are mandatory.
11. **Failure is an output.** A blocked, refused, unsafe, or inconclusive run is properly completed as an incident/result, not silently marked successful.
12. **Empiricism over mythology.** Publish failures, comparisons, overhead and changed hypotheses; don't optimize for stars or content views as outcome measures.

### 1.1 Relationship to Scrum and other methods

Turbine is **not initially a replacement for Scrum**. Scrum or Kanban can still handle prioritization and iteration cadence. Turbine governs execution and evidence of a *work item* by human and AI workers. A team MAY use Turbine within Scrum, Kanban, an internal SDLC, or no named agile method. The initial framework intentionally does not prescribe sprint length, story points, standups or reporting hierarchy.

---

## 2. Framework ontology and ownership

| Term | Definition | Example |
|---|---|---|
| **Intent** | User or system's requested outcome | “Managers can approve leave” |
| **Input Source** | Origin of intent, not authoritative for all later artifacts | Jira issue, GitHub issue, Markdown, typed request |
| **Work Package** | Normalized, versioned description with goals, constraints, acceptance criteria and source references | `work_id=wf_01...` |
| **Engineering Evidence Contract (EEC)** | Version-bound collection of work obligations, lineage, artifacts, evidence, approvals and gate decisions | EEC revision 4 for a feature |
| **Artifact Dependency Edge** | Typed, explicitly recorded upstream → dependent relationship | approved spec → plan → implementation |
| **Invalidation Event** | Append-only record marking a formerly valid obligation, decision or evidence stale against the active revision | changed commit invalidates review |
| **Recovery Plan** | Validated subset of stages to rerun and evidence that may safely be retained | rerun plan + code review + API checks |
| **Artifact** | Revisioned output, content-hashed and typed | specification, plan, diff, test report |
| **Role** | Contract for a category of responsibility | backend-developer |
| **Skill** | Reusable procedure that consumes context and returns structured outcomes | requirements-analysis |
| **Tool** | Scoped capability for an external operation | `issue.read`, `workspace.diff`, `tests.run` |
| **Model** | Configurable reasoning/generation runtime | provider/model identifier |
| **Agent Run** | One bounded invocation of a role, skills, model and tools against a work package | one code review |
| **Execution Profile** | Policy-selected resource and review pattern | lightweight / standard / comprehensive |
| **Gate** | Deterministic predicate that permits or blocks progress | approved hash + passing checks |
| **Human Decision** | Authenticated (in shared deployments) approval, rejection or exception | PM accepts requirements |
| **Evidence** | Verifiable execution output, with provenance and binding | CI test run tied to commit SHA |
| **Output** | Approved or blocked state and linked artifacts; not necessarily deployment | accepted PR + report |

### 2.1 Separation of authority

- **Source tool** is authoritative for its native records (e.g., Jira issue ID/status), subject to access permissions.
- **Turbine engine** is authoritative for framework-run states, revision chains, role decisions, gate outcomes and execution history.
- **Repository and CI** are authoritative for Git object IDs, diffs, build logs, check runs, and source code.
- **Human approver** authorizes scope decisions and accepted business behavior.
- **Model output** is a proposal or generated work, never authoritative proof of success.
- No external system is automatically overwritten to keep copies “in sync.” Explicit sync policy and human authorization apply.

---

## 3. Canonical work contract

Every work package MUST include the fields below before implementation (some may begin empty during intake).

| Field | Meaning / validation |
|---|---|
| `id`, `source_ref`, `source_snapshot` | Engine ID, original URI/ID, source update/version/hash |
| `type` | `bug`, `feature`, `refactor`, `migration`, `maintenance`, `investigation` |
| `title`, `objective`, `why` | Human-readable intent and business context |
| `acceptance_criteria[]` | Testable observable conditions; each has stable ID |
| `constraints[]`, `non_goals[]` | Scope boundaries, forbidden modifications |
| `unknowns[]`, `assumptions[]` | Questions and proposed answers explicitly classified |
| `dependencies[]` | Other work IDs or technical dependencies |
| `risk` | Assessed risk with triggers/explanations and human override |
| `accountable_human_id` | Responsible human; identity resolution depends on deployment |
| `repository_refs[]` | Optional Git repository + base revision references |
| `artifacts[]` | Revisioned outputs and provenance |
| `approvals[]` | Exact artifact hash, approver, decision, timestamp, scope |
| `runs[]`, `evidence[]` | Agent/tool runs, costs, review, tests and checks |
| `state`, `blockers[]` | Current engine state and why it can/cannot advance |

**Readiness conditions:** The requirements analyst MUST distinguish actionable information from missing decisions. It MAY propose acceptance criteria, but MUST NOT invent user/business answers. A task with material unresolved scope, access-control or acceptance questions must become `NEEDS_CLARIFICATION` and be routed to a human. A human's approval does not automatically waive missing required fields; documented exceptions are controlled by policy.

**Revision rules:** Requirements are versioned; plan references an approved requirements hash; implementation references approved plan and source commit; review evidence references resulting commit/diff; tests reference exact revision/environment. Changing a bound input creates a new contract revision and invokes deterministic change-impact evaluation. An AI-generated statement that previous tests or approvals are still valid cannot satisfy revalidation. Full rules follow.

### 3.1 Engineering Evidence Contract (EEC) — normative center of the method

**Definition:** An EEC is the **versioned, machine-checkable acceptance contract attached to a Work Package**. It is neither a promise that AI work is correct nor a separate project-management tool. It specifies what must be true for the current engineering change to be accepted, and which trustworthy evidence demonstrates those conditions. Its validity is always evaluated **against the current revision**.

Each active EEC MUST identify:

| Field | Minimum requirement |
|---|---|
| Identity and source | `contract_id`, `contract_revision`, `work_id`, `framework_id/version`, source snapshot hashes, creation event |
| Intent | Requirement/acceptance criterion IDs and their approved revision hashes; explicit scope and unknowns |
| Accountability | Accountable human; current policy profile; required human gates and authorized exceptions |
| Obligations | Explicit `obligation_id`, type, acceptance criterion IDs, required evidence kinds, pass rule, dependency references |
| Artifact lineage | Immutable artifact IDs, revision/hash, provenance, and typed dependency edges |
| Results and provenance | Evidence IDs with result, source tool/actor, execution context, timestamp, commit/environment, and logs when applicable |
| Decisions | Human approvals bound to exact artifact revision, obligations, relevant commit, and authenticated/local-attestation status |
| Validity and disposition | Derived `satisfied | unsatisfied | stale | blocked | waived-with-authority` per obligation; **no silent success** |
| Usage and exceptions | Role-selection rationale, retries/handoffs, budget/cost observations, known limits, exception record |

The canonical data model is **Work Package (intent and lifecycle)** + **EEC (obligations, provenance, decision validity)** + immutable **Artifacts/Evidence/Events**. Changes to requirements or code do not mutate historical approvals into an apparently new approval. Approval history is append-only, and current validity is calculated from the latest revision and invalidation events. A contract cannot be `ACCEPTED` while a mandatory obligation is stale, failed, blocked or unresolved.

**Evidence acceptance rule:** Every satisfied obligation MUST have independent, relevant, valid evidence where required by policy. Tests require actual execution/check identifiers, exit status, relevant source revision and environment, not model narration. Human decisions require the exact approved artifact/commit and appropriate identity assurance. Linking a test to an acceptance criterion does not by itself prove that the test establishes the business outcome; the accountable reviewer verifies relevance.

### 3.2 Typed lineage, changes and deterministic invalidation

A dependency edge is recorded as `upstream_id + upstream_revision_hash → dependent_id + reason + affected_obligation_ids`. All edge endpoints must exist, and cycle prevention applies to the directed dependency graph (a cycle is a validation error, not an arbitrary execution order). Initially the mandatory minimum lineage is:

```text
source snapshot → approved requirements/acceptance criteria
requirements revision → plan + test intent
plan revision + repository base → implementation authorization / code change
code commit/diff → code review + automated checks + manual verification
requirements + code/test evidence + human approvals → final acceptance gate
```

The engine MUST track explicit lineage rather than relying on a model to guess changes. If a dependency is missing or impact cannot be established, use the **conservative fallback**: invalidate all downstream obligations that could be affected, and ask an authorized human to resolve ambiguity. Never accept an old check merely because its text still says “passed.”

| Event | Mandatory action (baseline) |
|---|---|
| Original source changed | Capture new immutable snapshot; **do not** silently rewrite approved spec; human decides whether to adopt changes |
| Approved requirement or acceptance criterion changed | New spec/EEC revision; invalidate bound plan approval, execution authorization and downstream acceptance until re-established |
| Approved plan changed | Invalidate plan approval and implementation authorization; reassess affected execution and downstream evidence |
| Code/diff/commit changed after review or tests | Invalidate review and commit-bound test results; rerun relevant checks on new commit |
| Test plan or required check changed | Invalidate affected verification obligations and dependent acceptance, even if code did not change |
| Risk classification changed upward | Rerun role-selection policy, add mandatory review/test obligations, block acceptance pending evidence |
| Tool/model or external dependency changed | Revalidate obligations only if their declared execution context or safety/quality policy depends on that change; otherwise preserve history |

**Technical invariants:** Artifact revisions and evidence events are immutable. Record old and new hashes, triggering event, transitive affected IDs, reason and actor. Invalidation and current-state changes are atomic. An approval may be superseded or made inapplicable, **never copied forward** to a new hash. Gate evaluation must compute current EEC validity after every relevant change and restart.

### 3.3 Selective recovery with safety-first fallback

**Objective:** Re-run the **minimum justified subset**, not necessarily the minimum number of AI calls. First compute transitive impact through explicit dependency edges and current policy obligations. Then produce a human-inspectable recovery plan: changed inputs, affected obligations/artifacts/stages, retained valid artifacts (with proof), required new evidence, proposed role runs, estimated cost ceiling, and blockers. Recovery may require `ASSESSING`, `PLANNING`, `IMPLEMENTING`, `AI_REVIEW`, `VERIFYING`, or human reapproval as appropriate.

1. Detect content/revision change; append event.
2. Compute conservative dependency closure; mark affected approvals/evidence stale in derived current view.
3. Re-run hard-risk triggers and adaptive role selection against new facts and prior failure evidence.
4. Draft recovery plan with `required`, `retained`, and `unknown` branches. Unknown is **never** treated as valid.
5. Require explicit authorization for new scope, costly runs, unsafe operations and sensitive workflow changes.
6. Re-execute only eligible stages; re-bind all new evidence to the latest EEC revision and exact source/commit/context.
7. Re-evaluate every mandatory gate. If any still fail or are stale, return blocked/changes-requested rather than `ACCEPTED`.

**R0 scope:** selective re-evaluation for source → requirements → plan using *explicit dependencies* and deterministic rules; conservative regeneration/reapproval is acceptable. **R1 scope:** change-impact and recovery for code → review → tests → human acceptance, with commit-bound checks. **R2+ research:** finer-grained, evidence-backed component/criterion impact analysis, never unrestricted AI-only invalidation. The initial engine MUST NOT claim automatic semantic understanding of arbitrary repositories.

### 3.4 Differentiation hypothesis and falsification

Candidate differentiator: an **EEC-centered, portable method** that detects stale evidence and performs **policy-safe selective recovery**, coupled with **observed-outcome-based adaptive specialization**. Each element has adjacent prior art; the claim is that their integrated, verifiable operation produces measurable value.

Compare the same representative change/revision scenarios against (a) existing manual Jira/GitHub + AI tools, and (b) one well-matched established spec/agent workflow (BMad, Spec Kit/OpenSpec, or another direct comparison). Metrics: stale-evidence escape rate, missing acceptance coverage, false-positive invalidations, rework effort, human supervision time, number/cost of agent calls, and task completion quality. Do **not** claim novelty or product advantage from a feature checklist. A result where the simpler alternative is equally reliable at lower total cost is a signal to narrow the project or pivot to an extension/service.

---

## 4. Standard engineering lifecycle

### 4.1 Stages and accountable outputs

| Stage | What happens | Typical capabilities | Mandatory gate / output |
|---|---|---|---|
| `INTAKE` | Normalize source input; preserve original snapshot; create initial EEC obligations | input adapter | Work ID, provenance and draft EEC |
| `ASSESS` | Check clarity, uncertainty, risk and readiness | requirements analyst; spec writer | Assessment, unanswered questions |
| `REQUIREMENTS_REVIEW` | Human edits/accepts precise requirements revision | human PM/owner | Requirements approval or clarification |
| `PLAN` | Inspect repo; decompose work; assess dependencies, architecture, tests and costs | architect, PM, relevant dev/test roles | Plan and test intent linked to approved requirements |
| `PLAN_REVIEW` | Human reviews plan and scope | human technical owner | Plan approval or rework |
| `IMPLEMENT` | Execute authorized work in isolated workspace | relevant developer role(s) | Diff, changed files, unit test evidence and notes |
| `AI_REVIEW` | Independent AI assessment and deterministic quality checks | reviewer + static tools | Findings, required fixes and evidence |
| `HUMAN_CODE_REVIEW` | Human code/architecture/security review appropriate to risk | developer/architect | Authenticated decision or pilot-local attestation |
| `VERIFY` | Test required acceptance cases; rerun after changes | API/E2E/test-case SQA and deterministic tools | Commit-bound tests and human SQA evidence |
| `HUMAN_ACCEPTANCE` | Human decides whether the **active EEC** has satisfied obligations with current evidence | product owner / QA | Current-revision acceptance or changes requested |
| `ACCEPTED` | Final artifact bundle, reports, optional authorized external sync | engine and adapters | Signed-off completion; deployment remains separate |

**Important:** Test development and local execution happen during `IMPLEMENT`; final verification still occurs *after* review and any rework. This is not “write no tests until the end.”

### 4.2 State machine and errors

Main path:

```text
IMPORTED → ASSESSING → REQUIREMENTS_REVIEW → REQUIREMENTS_APPROVED
 → PLANNING → PLAN_REVIEW → PLAN_APPROVED
 → IMPLEMENTING → AI_REVIEW → HUMAN_CODE_REVIEW
 → VERIFYING → HUMAN_ACCEPTANCE → ACCEPTED
```

Interruptions: `NEEDS_CLARIFICATION`, `BLOCKED`, `CHANGES_REQUESTED`, `CANCELLED`, `FAILED`, `PAUSED_BUDGET`, `PAUSED_POLICY`. Each includes a reason, resume target and owner. Retries MUST be bounded and idempotent where possible; no attempt may silently erase earlier runs. State transitions are checked in code; agent proposals do not directly mutate approved state.

**Change loops:** Requirement rejection → `ASSESSING`; plan rejection → `PLANNING`; review/test rejection → `IMPLEMENTING` or `PLANNING` if architecture/scope changed. Budget exhaustion pauses before further model/tool calls. New input material triggers change-impact assessment.

### 4.3 Human roles and accountable decisions

- PM/product owner: validates business requirements and prioritization; may reject invented scope.
- Technical reviewer: signs off plan/implementation and architecture where needed.
- SQA/test approver: signs off observable acceptance behavior on the approved commit.
- Accountable owner: resolves exceptions and authorizes final acceptance. A person MAY hold several roles in a small pilot, subject to project rules; high-risk projects SHOULD separate implementer and approver.
- Humans can replace an AI specialist and still produce the same artifact/evidence contract.

**Pilot caveat:** On a local single-user CLI, an entered name is **not** cryptographically authenticated identity. Treat such approval as a pilot attestation. Team-grade approval requires authenticated identity from an approved service and authorization checks; do not label local approval audit trails tamper-proof.

---

## 5. Granular role catalog

Roles are contracts, not permanent processes. Use minimal roles necessary for the work. Each role defines input types, required skills/capabilities, allowed tools, forbidden actions, output schema, and escalation conditions. The catalog is extensible with semantic versions.

| Role ID | Responsibility | Primary output | When selected |
|---|---|---|---|
| `requirements-analyst` | Identify missing or conflicting user intent | readiness assessment and clarification questions | intake requires analysis |
| `spec-writer` | Produce verifiable specification and acceptance scenarios | specification draft | new or changed functionality |
| `project-manager` | Decompose and sequence dependent work | work plan/dependencies | multi-part or coordinated work |
| `architect` | Analyze boundaries, interfaces and architecture decisions | architecture impact / ADR | cross-module, nontrivial or sensitive designs |
| `ux-designer` | Specify relevant interactions and states | UX artifact | user interaction/design changed |
| `frontend-developer` | Implement UI behavior | code, tests, implementation report | frontend change |
| `backend-developer` | Implement API/domain/backend behavior | code, tests, implementation report | backend change |
| `database-engineer` | Design/verify schema and data migration | migration + rollback/verification plan | data model/integrity changes |
| `unit-tester` | Independently add targeted unit evidence where warranted | unit tests/report | complex logic or coverage gaps |
| `code-quality-checker` | Run deterministic lint/type/static checks | tool reports | almost all code-changing tasks; no LLM by default |
| `code-reviewer` | Review diff vs spec, security/logic impacts and maintainability | findings and disposition | code changes; independent context when justified |
| `test-case-sqa` | Derive positive/negative/boundary test scenarios | test case matrix | standard/comprehensive scope |
| `api-sqa` | Verify API contracts/auth/negative cases | API verification | API change |
| `e2e-sqa` | Verify end-to-end journeys | E2E evidence | user journey integration |
| `security-reviewer` | Assess security-sensitive changes | security findings and mitigations | auth, secrets, payments, privacy, access control, risky deps |
| `release-engineer` | Verify release readiness without auto-deploy authority | release readiness record | release workflow (later phase) |

**No mandatory role proliferation:** A `frontend-developer` MAY execute unit-testing skills in the same run; `code-quality-checker` is usually just tools; `requirements-analyst` and `spec-writer` can share one context where cheap and safe. Independent `code-reviewer` must not receive authority to rubber-stamp or approve itself.

### 5.1 Role contract (normative fields)

```yaml
id: backend-developer
version: 0.1.0
responsibility: Implement approved backend behavior
inputs: [approved-specification, approved-plan, repository-context]
skills:
  required: [core/surgical-changes, core/test-driven-development]
  optional: [core/systematic-debugging]
capabilities:
  required: [repo.read, workspace.write, tests.run, git.diff]
  prohibited: [requirements.approve, plan.approve, git.merge, production.deploy]
outputs: [implementation-report, code-diff, test-evidence]
model_policy: coding-capable
max_attempts: 2
escalates_on: [ambiguous-requirement, scope-expansion, destructive-change, repeated-test-failure]
```

The engine MUST validate each manifest; failing capability resolution MUST stop/ask, not silently select a privileged tool. `role`/`skill` IDs and schemas are **proposed** Turbine definitions, not upstream BMad or Superpowers APIs.

---

## 6. Adaptive Role Selection Policy (ARSP) v0.1

### 6.1 Selection factors

1. Type: bug, feature, integration, refactor, migration, security change.
2. Scope: number of affected subsystems, known dependencies, interface changes.
3. Risk: authentication/authorization, payments, sensitive data, destructive changes, migrations, public exposure.
4. Required work surfaces: frontend/backend/API/DB/UX/infrastructure.
5. Evidence need: regression, unit, API, E2E, security, performance.
6. **Observed execution evidence:** previous failed checks, unresolved review findings, repeated rework, known context-loss/handoff problems and actual role performance in the same task.
7. **Economics:** observed model/tool spend, retry count and handoff latency; use advisory cost optimization **only after** meeting mandatory safety and coverage obligations. Absence of reliable cost data is marked unknown, not zero.

An LLM MAY recommend a profile and roles, but deterministic classification MUST enforce hard-risk triggers, capability requirements and minimum gates. The engine MUST produce a selection explanation and record rejected roles or reasons for omission.

### 6.2 Profiles (select roles; **do not** remove required lifecycle gates in v0.1)

| Profile | Trigger examples | Role execution | Mandatory protection |
|---|---|---|---|
| **Lightweight** | Small localized low-risk change | One implementer with appropriate skills; deterministic checks; optional separate review agent | Requirements and plan approval, human code review and human acceptance remain required in pilot; later lighter gates require evidence |
| **Standard** | Normal functional/API work, moderate dependencies | Requirements/spec, relevant developer, independent reviewer, specific QA; architect/PM conditional | Approved revisions and targeted tests/reviews |
| **Comprehensive** | Security/auth/payment/privacy/data migration or broad coupled change | Dedicated architecture, relevant specialists, security review, independent verification | Enhanced human approvals, explicit escalation and protected execution |

### 6.3 Mandatory overrides

- Auth/authz/session/roles/permissions → `security-reviewer`, appropriate API tests, human technical signoff.
- Data deletion/migration/schema changes → `database-engineer`, backup/rollback plan, explicit human approval.
- Billing/payments/financial integrity → comprehensive profile, independent verification.
- Secrets or sensitive personal/client data → restricted tool/model data policy and security review.
- Deployment/release → no agent-initiated deployment; separate authorized release process.
- Failure to classify risk → default to Standard or Comprehensive depending on uncertainty; human can raise profile; downgrade requires privileged, logged exception and is disabled in v0.1 pilot.

### 6.4 Selection algorithm

```text
normalize task → extract facts and uncertainties
→ detect deterministic hard-risk triggers
→ LLM recommends complexity, surfaces, roles, questions
→ policy computes max(hard-risk minimum, recommended tier)
→ map required capabilities to minimum sufficient roles/skills
→ group compatible skills in one run; preserve independent review where required
→ show selection and estimate of model/tool costs
→ human approves/overrides scope where needed
→ reassess after requirements approval, repository inspection, failed verification, budget pressure, source/plan/code changes and new risk evidence
```

The selection policy MUST optimize **outcomes subject to quality gates**, not minimize cost blindly. Record calls, model usage, latency, handoffs, failures and review outcomes. A role may be introduced mid-run when justified by new evidence. Role removal after a failure MUST NOT suppress a mandatory test/review obligation; selection changes are versioned decisions with reasons, observed evidence, budget implications and any human override. Avoid training a role selector on misleading success claims from AI self-reports.

### 6.5 Example

For a normal leave-approval API change: combine requirements-analysis/spec-writing; select backend-developer with unit tests; run deterministic quality checks; independent code reviewer; API SQA; include architect/security reviewer if scope touches permissions, as leave approvals usually do. No frontend/UX/E2E by default without affected user journeys. Human requirements, plan, code and acceptance reviewers remain.

---

## 7. Skill system and external inspiration

A skill is a versioned procedure with an identifier, publisher/source, license metadata, compatible runner, inputs/outputs, allowed capabilities, resource limits, validation tests and content hash. It is **not** automatically executable just because a repo contains `SKILL.md`.

### 7.1 Starting internal skills

- `core/assess-requirements` — parse intent; classify verified facts, assumptions and unanswered questions.
- `core/write-specification` — testable behaviors, edge cases, non-goals, acceptance criteria.
- `core/plan-change` — repo impact, ADR needs, decomposition, dependency and test plan.
- `core/execute-code-change` — surgical changes to agreed plan, initial tests, report.
- `core/review-change` — independent review vs approved spec and diff.
- `core/verify-acceptance` — run test matrix, aggregate evidence, identify gaps.
- `core/systematic-debugging` — evidence-driven root cause analysis.
- `core/surgical-changes` — minimal changes and assumption surfacing.

### 7.2 Prior-art incorporation policy

| Reference | What to learn | What NOT to do |
|---|---|---|
| [BMad](https://github.com/bmad-code-org/BMAD-METHOD) | Role specialization, right-sized processes, project context, workflows | Copy text/brand or promise BMad compatibility without adapter tests |
| [GitHub Spec Kit](https://github.com/github/spec-kit) | Structured specification/plan/tasks and verification | Run duplicate spec structures by default |
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) | Incremental change proposals and specification evolution | Make OpenSpec folder structure Turbine's only storage format |
| [Superpowers](https://github.com/obra/superpowers) | Composable skills, TDD/debugging/review, working-tree practice | Assume its full workflow can be blindly composed with others |
| [Karpathy-inspired Guidelines](https://github.com/multica-ai/andrej-karpathy-skills) | Avoid unjustified complexity, guesswork and unrelated edits | Claim official authorship/endorsement by Andrej Karpathy |

**Licensing:** Repository licensing and **individual skill/file licensing must be verified at the pinned revision before redistribution**. At review time BMad/Spec Kit/OpenSpec/Superpowers display MIT licensing, and the referenced Karpathy `SKILL.md` contains MIT metadata; preserve notices, inspect trademarks, check each repository's full license, and do not assume everything in an entire repo has identical rights. Prefer independently authored Turbine skills based on ideas over bundling upstream content. Never download/execute arbitrary skills from the internet by default.

### 7.3 Conflict precedence

Engine policy and security > approved framework version > approved work specification/plan > validated role contract > approved skill > untrusted Jira/repository/tool outputs. A skill cannot grant its own tools or override safety settings. If instructions conflict, fail closed and request a human ruling, preserving the conflict as evidence.

---

## 8. Tool and model independence

Tools expose specific capabilities rather than provider-specific verbs, for example: `issue.read`, `issue.comment`, `repo.inspect`, `workspace.write`, `git.diff`, `tests.run`, `ci.read`, `pr.create`, `pr.review.read`. The provider adapter maps to Jira, GitHub, local Git, CI, or future equivalents; a required capability may be unavailable and must trigger a meaningful block.

Models are selected via policy: `analysis-capable`, `coding-capable`, `review-capable`, with separate provider configuration and cost limits. Provider names must never appear in workflow specification. Model substitution does not imply equivalent quality; maintain regression tests and usage records.

**Trust boundary:** Issue descriptions, docs, source comments, model outputs and imported skills are untrusted instructions. Tools execute only engine-authorized operations with least privilege; prompt text is never authorization. High-impact external writes require explicitly approved target and diff. See [OWASP Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/).

---

## 9. Independent framework conformance

A team may adopt Turbine without installing its CLI. To claim conformance for a work item, the team must be able to produce:

1. Original input/provenance and a normalized work package.
2. Approved, testable requirements and version-bound plan.
3. A recorded role selection/risk rationale and accountable human.
4. Bounded implementation work with changed artifacts.
5. Evidence of applicable independent review, automated checks and human acceptance.
6. Change/rework history and explicit final state; no false claims of deployment.
7. Active EEC with mapped obligations, artifact lineage and traceable current evidence; demonstrate how a changed requirement or commit makes affected approvals/checks stale.
8. A recovery decision that explicitly explains retained versus rerun steps; teams may conservatively redo everything if finer-grained impact is unknown.

The future engine can automate this, but the framework remains usable with paper templates, GitHub Issues, Jira, or local Markdown. Manual adoption is also the **no-build control** against which a custom CLI must show incremental value.

---

## 10. Quality, economics and evaluation

### 10.1 Required engineering evidence

- Implementation: changed files, base commit, resulting commit/diff, objective/spec hash.
- Automated verification: command/check name, exit status, timestamp, environment, revision, complete log reference.
- Review: reviewer identity/source, findings, approvals, relevant commit hash.
- Manual SQA: steps, actual vs expected, environment, person, result, limitations.
- Model/tool usage: provider/model or tool, role, tokens where provided, explicit rate assumptions for estimated cost, actual billed cost if accessible, elapsed time and retry count.
- Exceptions: reason, authority, expiry, affected gates and residual risk.

No test count, coverage statistic, LLM confidence or green summary can replace evidence of actual execution against the relevant revision.

### 10.2 Trial metrics and baseline

Measure end-to-end cycle time, human touch-time, AI/tool spending, accepted requirements revisions, rework loops, escaped defects when observable, percentage of tasks completed without founder supervision, user-perceived burden, and number of agent handoffs. **Also record** obligation coverage, stale-evidence acceptance attempts blocked, false-positive invalidations, reusable evidence percentage, selective-recovery cost versus full rerun, and role-selection escalation/de-escalation rationale. Select comparable work items and record task difficulty. A two-task feasibility pilot can test operability but **cannot** prove productivity superiority.

**Predeclared initial feasibility gates (proposals, not findings):**

- A non-founder PM/developer can independently complete a task through the process.
- The engine preserves state and approval integrity across interruption/restart.
- One tool can be replaced without rewriting role/framework definitions.
- No unauthorized Jira, Git, deployment, or secret-reading action occurs in tests.
- Actual successful tests/review evidence is linked to the accepted revision.
- Team members report that any added overhead is tolerable for the tested task class; capture exact objections.

**Post-pilot comparison:** At least 10–20 additional comparable work items (or a better pre-registered design) before drawing directional conclusions about cycle time. For scientific claims, use an independently designed, sufficiently powered study and report limitations.

### 10.3 Explicit stop/revise triggers

Stop expanding platform scope if simple existing BMad/Spec Kit/Superpowers + Jira/manual workflows achieve comparable outcomes with less overhead; if agents routinely misclassify scope; if independent users cannot operate it; if token/tool cost exceeds approved budget; or if safe execution cannot be delivered for target repositories. Continue only after diagnosing why and selecting a revised wedge.

---

## 11. Open-source governance and research ethics

- Decide 6sense vs individual ownership, assignment, public license, trademarks, code/data release permissions and commercial arrangements **before** publishing company-derived code. Obtain cofounder/company agreement.
- Public code SHOULD use an OSI-recognized license chosen after legal/strategic review; MIT or Apache-2.0 are candidates, **not chosen yet**. Documentation and trademarks need separate decisions.
- Provide CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, SUPPORT, governance roles, issue templates and roadmap before contributor recruitment.
- Community principle: invite users to solve problems, not to work free for a founder's star goal. Track active adopters, returning contributors, issue resolution and maintenance sustainability; stars remain a secondary reach indicator.
- For academic projects: obtain client/company data permissions, redact sensitive records, document sampling and confounders, secure required research ethics review, and use actual scholarly contributions for authorship. Papers do not automatically create customers.

---

## 12. Venture strategy connected to the founder's original vision

### 12.1 Stakeholders and value

| Stakeholder | Value hypothesis | What must be demonstrated |
|---|---|---|
| 6sense PM/developer/SQA | Less ambiguous work and rework, consistent handoffs | Repeat usage and measured burden/quality |
| CTO / engineering manager (buyer) | Predictable delivery, auditability, reduced integration risk | Budget owner agrees to pilot or pays |
| Open-source developer | Reusable workflow and adapters; credible contribution | Installs without founder help, returns |
| Researcher | Methodologically usable data and testable questions | Research interest and compliant dataset |
| 6sense business | Implementation services, training, support, managed delivery, later software | Paid pilot and contribution margin |
| Founder personally | Thought leadership, network and legitimate professional opportunities | Public proof, trusted collaborators, sustained value |

### 12.2 Initial ideal customer and positioning

**ICP hypothesis:** 10–100 developer software services firms already using Jira/GitHub and multiple AI coding tools, with visible inconsistency between prompt-driven coding and team approvals. The first user is a PM/dev/SQA group, the champion is an engineering manager/CTO, and the budget owner is CTO/founder. This is a target to validate, not evidence of market size or willingness to pay.

**Positioning hypothesis:** “An open execution control layer for human–AI software teams: keep your tools, standardize work, measure evidence.” Do not promise autonomous delivery or productivity percentages until proven.

### 12.3 Parallel tracks and owner actions

1. **Internal usefulness:** One noncritical 6sense repository, 2–3 real changes and one non-founder operator; keep spend and time capped.
2. **Framework/IP:** Publish a concise versioned method *after* identifying company/private information and trademark/license implications.
3. **Open source:** Local alpha → external install instructions → public bug reports → meaningful contributor onboarding; no 10k-star deadline as viability gate.
4. **Personal technical brand:** Record an honest demo, failure analysis and comparisons in English; share publicly only with clearance. A regular series beats hype claims.
5. **Business:** Run 10 problem interviews with qualified CTOs (do not pitch a solution first); offer a paid, limited “Human–AI Delivery Workflow Pilot” only after credible internal evidence. Price from real delivery effort and feedback, not an invented demand estimate.
6. **Academic:** Build an evidence-quality protocol while using the tool; contact researchers with a precise study question and consented data, not a request to put the founder's name on a paper.
7. **International network:** Collaborate via documentation, issues, workshops, conferences and genuine client work. Business travel/visa is a contingent result, not a technical requirement or guaranteed outcome.

### 12.4 Illustrative economics, not forecasts

For a paid onboarding pilot, compute `contribution = pilot fee – engineer hours × fully loaded hourly cost – API/tool costs – support/onboarding hours × loaded cost – travel/vendor expenses`. Record the actual time to deliver each pilot. The fee and first three customer conversion assumptions must come from interviews and proposals; **no market pricing or revenue forecast is asserted here**.

### 12.5 First 10 conversations / first three customers

- Select ten reachable engineering leaders with explicit AI adoption activity; separate current contacts from cold targets and avoid conflating friendly feedback with demand.
- Use a 20-minute problem interview: last recent issue, coordination workaround, approval burden, cost/time lost, procurement obstacles. Ask permission for a follow-up demo only after listening.
- Invite three qualified teams with the problem to a bounded assessment, then propose a paid pilot if they see value; the first three paying customers are a hypothesis, not a target guaranteed by outreach.
- Track who attended, actual pain evidence, accepted next step, willingness to share repo/data securely, and willingness to pay.

---

## 13. Idea Forge adversarial review and decision ledger

### 13.1 Best case vs strongest countercase

**Best case:** A clean, portable work/approval contract lets teams use their preferred tools and models while obtaining predictable audit and review evidence. Granular roles improve traceability while selection policy keeps costs manageable. OSS integrations and public evidence build adoption and a services channel.

**Strongest countercase:** This is yet another orchestration/process layer in a crowded category. BMad, Spec Kit, OpenSpec, Superpowers, modern coding agents and the team's existing PM/review process already do much of the work. Requiring multiple approvals, agent handoffs and operational maintenance may be *slower* and *more expensive* than the status quo. Tool independence creates compatibility burden rather than a moat. No verified buyers or paid commitments exist yet.

| Lens | Criticism | Response/test |
|---|---|---|
| Customer | Teams may not pay for process overhead | Interview last 3 recent difficult tasks; timed pilot |
| Competitor | Incumbents bundle workflows directly into coding/issue tools | Compare with no-build BMad + Jira setup |
| Engineering | Cross-tool adapters, auth and safe agent execution are hard | Single vertical slice; read-only Jira; isolated workspace; security gate |
| Research | Role-based multi-agent engineering is not novel | Narrow measured contribution; no novelty claim |
| Sales | CTO procurement often requires privacy/security confidence | Service-first pilot, no unrestricted repo access |
| Finance | Founder time and API spend may outweigh value | Strict caps and contribution accounting |
| Brand | “New Scrum” and “fully autonomous” overstate proof | Show reproducible demos and failures |
| Devil's advocate | User could build endlessly rather than proving value | Weekly pass/fail review; explicit exclusions |

### 13.2 Material assumptions and falsifiers

| ID | Claim | Grade now | Decisive test |
|---|---|---|---|
| A-01 | 6sense has enough coordination pain to justify a formal layer | D (experience, not measured) | Non-founder team trial + baseline |
| A-02 | CLI overhead is acceptable for real tasks | U | Repeat three tasks, record touch-time |
| A-03 | Portable adapters can preserve semantics across tools | C (technically plausible) | Same work via text and Jira without core changes |
| A-04 | Specialist role selection improves net outcomes | U | Compare consolidated vs specialist runs on matched tasks |
| A-05 | External teams will adopt | U | Independent installs and returning use |
| A-06 | CTOs will pay for assistance/platform | U | Qualified paid pilot, not likes/stars |
| A-07 | Skills can be redistributed legally and safely | Mixed | Per-dependency legal/security audit |
| A-08 | This method is academically original | U | Focused literature review and research collaborator feedback |
| A-09 | EEC and transitive invalidation prevent acceptance of stale evidence | U | Mutation test: change approved spec, plan, code, test; assert every affected gate blocks |
| A-10 | Selective recovery cuts rework without losing correctness | U | Compare deterministic closure with safe full rerun; measure missed dependencies and overhead |
| A-11 | Failure-informed role selection outperforms fixed role rosters | U | Matched tasks: baseline profiles vs escalated adaptive profiles; quality and true cost |

### 13.3 Alternatives considered

1. **Original: full factory framework + platform immediately:** highest ambition, highest build/maintenance risk — **reject as first investment**.
2. **Recommended: standard method + slim execution engine + adapters:** controls core lifecycle, permits independent adoption and bounded experiments — **test first**.
3. **No-build/manual baseline:** use existing Jira/PR controls, BMad/Spec Kit skills and templates — **must be tested as control**.
4. **Services-only adjacent offer:** help companies configure existing methods/tools, no standalone engine — **retain as commercial fallback** if differentiation is weak.

### 13.4 Decision gate

**Verdict: TEST FIRST. Confidence: medium for basic feasibility, low for distinctiveness and buyer economics.** Pilot approved only for noncritical, authorized use. Reassess after 2–3 completed tasks and at least one non-founder operator. What reverses the go-for-pilot: inaccessible tool permissions, unsafe code execution without mitigation, unexpected data exposure, or inability to deliver a coherent end-to-end workflow within the preset capacity cap.

**Do not build yet:** hosted multi-tenant SaaS, marketplace, dozens of model adapters, self-managed browser, custom IDE, autonomous production deployment, self-modifying policies, automatic merging, certifications, billing, extensive dashboards, training data collection or “10k stars” growth machinery.

---

## 14. Evidence and prior-art ledger (verified 2026-11-11)

Source links are given so that claims are inspectable. Availability and upstream behavior can change; recheck during implementation.

| Evidence | Type and date | What it supports / limit |
|---|---|---|
| [BMad Method repository](https://github.com/bmad-code-org/BMAD-METHOD) and [skills reference](https://github.com/bmad-code-org/BMAD-METHOD/blob/main/docs/reference/skills-and-agents.md) | Active OSS documentation, checked 2026-11-11 | Direct methodological/agent prior art; not evidence of Turbine demand |
| [GitHub Spec Kit](https://github.com/github/spec-kit) | Active OSS documentation, checked 2026-11-11 | Specs, planning, verification workflows already implemented |
| [Fission AI OpenSpec](https://github.com/Fission-AI/OpenSpec) | Active OSS documentation, checked 2026-11-11 | Existing incremental specs and flexible workflow prior art |
| [Superpowers](https://github.com/obra/superpowers) | Active OSS documentation, checked 2026-11-11 | Composable skills and software workflow prior art |
| [Karpathy-inspired guidelines skill](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/skills/karpathy-guidelines/SKILL.md) | Third-party skill, checked 2026-11-11 | Useful coding guidance, not official Karpathy endorsement |
| [MetaGPT, Hong et al., ICLR 2024](https://proceedings.iclr.cc/paper_files/paper/2024/hash/6507b115562bb0a305f1958ccc87355a-Abstract-Conference.html) | Peer-reviewed conference paper | Specialized role/assembly-line agent prior art; different benchmark and organizational context |
| [ChatDev, Qian et al., ACL 2024, DOI:10.18653/v1/2024.acl-long.810](https://aclanthology.org/2024.acl-long.810/) | Peer-reviewed conference paper | Multi-role communication prior art; does not prove field effectiveness in 6sense |
| [SWE-bench, Jimenez et al., ICLR 2024](https://proceedings.iclr.cc/paper_files/paper/2024/hash/edac78c3e300629acfe6cbe9ca88fb84-Abstract-Conference.html) | Peer-reviewed benchmark paper | Real issue-level evaluation importance; historical model numbers become stale |
| [METR developer trial, Becker et al. (2025)](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) and [Feb 2026 follow-up](https://metr.org/blog/2026-02-24-uplift-update/) | RCT + later research update | Contradictory productivity outcomes; selection bias limits newer estimates |
| [Google DORA AI Capabilities Model (2025)](https://research.google/pubs/dora-ai-capabilities-model/) | Research/practitioner report | Organization and AI adoption practices matter; not proof of this product |
| [OWASP LLM06 Excessive Agency (2025)](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) | Security guidance | Least privilege, permission checks, human approvals; not a guarantee of safety |
| [Atlassian Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/) and [OAuth scopes](https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/) | Official technical docs, checked 2026-11-11 | Integration mechanisms and scope constraints |
| [Cursor CLI headless documentation](https://docs.cursor.com/en/cli/headless) | Vendor technical docs, checked 2026-11-11 | Noninteractive agent integration possible; trust and permissions need independent validation |

**Research gaps:** No real 6sense outcome measurements, no qualified buyer interviews, no actual pilot costs, no independent adoption, no patent freedom-to-operate review, no systematic thesis/dissertation inventory, and no formal commercial legal opinion. Do not fill these unknowns with invented numbers.

---

## 15. Revision and publication policy

Framework semantic versions: patch = editorial/clarification; minor = compatible extension; major = change to required lifecycle/governance contracts. Each change needs an ADR, examples, migration notes and conformance tests. Approved historical runs retain the exact framework and role/skill hashes they used. Public naming is provisional until brand/trademark clearance.

**v0.5 revision summary (2026-11-11):** Added F-13..F-19, formal EEC governance, typed lineage, deterministic invalidation, safe selective recovery, outcome-informed role selection, originality falsification criteria and release-specific scope. Prior philosophy, specialized role catalog, tool/skill/model independence, human gates, security, venture strategy and Idea Forge decision are preserved.

**Next concrete action:** Read `TURBINE_HALL_REQUIREMENTS_v0.5.md`, implement Phase 0 only, then test the EEC-focused vertical slice against one representative, authorized issue and its changed-requirement variant. Within the same pilot, reproduce the task manually with existing tools to establish whether the new engine creates incremental value.
