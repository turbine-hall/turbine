# Implementation Status

**Product:** Turbine Hall (`turbine`)  
**Framework pin:** `turbine@0.5.0`  
**Last updated:** 2026-11-18 (hardening phases 1–4; repository context layer 1)

| Area | Status | Notes |
|---|---|---|
| Phase 0 — Scaffold | tested | pnpm monorepo, CLI `turbine`, lint/typecheck/test/build, CI workflow |
| Phase 1 — Contracts + persistence | tested | Zod contracts, `node:sqlite` store, init/doctor/task create-list-show-status-history, draft EEC |
| Phase 2 — Workflow / EEC / ARSP | tested | State machine, gates, lineage invalidation/recovery, 16 roles, ARSP |
| Phase 3 — Skills + requirements | tested | assess/spec skills, mock model, budgets, hash-bound approvals |
| Phase 4 — Planning + Jira (R0) | tested | plan skill, git inspect, Jira read + fixtures, recover --dry-run |
| Phase 5 — Executor + review (R1) | tested | worktree + supervised handoff, AI/human review, commit-bound evidence |
| Phase 6 — Verify + accept (R1) | tested | verify/accept, mark-commit stale recovery path, failure-informed roles |
| MD-first task packets | implemented | Per-work `.turbine/tasks/<id>/` STATUS + stage MDs; `turbine task sync` applies Decisions |
| Hardening Phase 1 — Gate integrity | tested | Fail-closed gate rules; derived PASS/CONCERNS/FAIL with separate expiring waivers; approvals bound to current spec/plan hash and commit; markdown Decision blocks display-only; human-only `turbine task approve/reject/waive` (interactive terminal + typed short hash, refused in agent sessions); Cursor `beforeShellExecution` guard installed by `turbine init`; optional GitHub PR approval (`humanGates.requirePrApproval`); 14 mutation/guard tests |
| Hardening Phase 2 — Real evidence | tested | Task stays in IMPLEMENTING until worktree HEAD is past base with no uncommitted files; real head captured from git; new commits detected automatically on sync/approve (review/checks/SQA go stale); change report computed from git (files, +/-, dependency changes, test files); every configured setup + check runs in each worktree with per-check evidence, no synthetic passes, blocked when no checks configured; diff-grounded AI review with lenses (spec / tests / security) and deterministic triage (must cite a changed file, quotes must be in the diff, dependency/test claims checked against git); multi-repo tasks (`turbine task repo add`) bound by a change-set id over all repos; 6 new tests |
| Hardening Phase 3 — Packet doc standard | tested | Packet is STATUS.md / SPEC.md / REVIEW.md + evidence/ (legacy numbered files moved to legacy/); one deterministic renderer from store state; requirements with FR IDs, P0/P1/P2 and EARS wording, editable in SPEC.md (answers via "→ Answer:"); verified-vs-assumption labels; engine-generated Mermaid (gate progress, change map, user flow); requirement traceability FULL/PARTIAL/NONE from plan links + verified test links + checks, feeding a CONCERNS obligation; per-requirement acceptance checklist (every P0 must be ticked with an observation); `turbine task analyze` (deterministic, CRITICAL blocks approval) and `turbine task lint` (errors block approval); track-based size budgets; rewritten assess/spec/plan/review skills with examples and question checklists; task-relevant project evidence; GLOSSARY.md; 9 new tests |
| Hardening Phase 4 — Risk selection & lineage | tested | Profile = max(rules, model recommendation, human minimum, observed evidence) — never lowered; word-boundary triggers read from the request only; new hard trigger `file-upload`, soft triggers `untrusted-input`, `data-deletion`, `new-dependency`; `turbine task risk --raise`; every model call runs AS a role (manifest must list the skill, grants = role capabilities ∩ project tools policy, run recorded in role_runs; non-intake roles must be selected); security review lens only when security-reviewer is selected; dependencies added by the diff re-select roles and require a dependency audit (`quality.dependencyAudit`, auto from lockfile) — failing audit blocks acceptance (fix or waive) without bouncing the task; invalidation walks explicit edges (incl. change revisions → review/checks), missing link ⇒ unknown ⇒ conservative invalidation + blocked recovery plan; 11 new tests |
| Repository context — Layer 1: project facts (#6, part of #5) | tested | `turbine understand` builds a deterministic snapshot of the repo AT HEAD (git objects only, one `git cat-file --batch`; dirty tree never included): layout, workspaces, entry points, scripts, test/lint/typecheck/build commands, versions, declared vs installed dependencies (pnpm-lock / package-lock; yarn.lock reported as not parsed) and conventions. Every fact carries `{path, commit, blob}` (+ lines); the Zod schema rejects a fact without one. Conventions are `confirmed` only with an enforcing config or an exhaustive 100% count, otherwise `unconfirmed` with counts. Same commit ⇒ same hash (`repo_snapshots`, migration v2). Up to date ⇒ no writes; stale ⇒ rebuild + diff; `collectProjectEvidence` is a thin wrapper and a failed rebuild stops `assess`/`plan` (`E_CONTEXT_UNAVAILABLE`, no fallback to the old snapshot). Renders `.turbine/context/snapshot.json` + PROJECT.md Facts (generated header + content hash, flagged by `turbine lint`); `turbine init` runs it on repos with commits; 27 tests incl. planted traps. Layers 2 (#7) and 3 (#8) are not implemented |
| R2+ / OSS distribution | not planned | Out of scope |

## Measured checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Integration fixtures cover R0 text+Jira intake through `PLAN_APPROVED` with requirement-change invalidation, and R1 execute→review→verify→accept with stale-commit invalidation.

## Known limitations

- Local approvals are **local attestations**, not authenticated identity. The terminal + hash check and the Cursor hook are speed bumps: an agent with unrestricted shell access could still drive a pseudo-terminal. For code review and acceptance, `humanGates.requirePrApproval: true` adds a GitHub PR approval that an agent account cannot self-grant.
- Verification needs `quality.checks` (and usually `quality.setup`, e.g. `npm ci`) in `.turbine/project.yaml`; checks run without a shell (no pipes/globs).
- Repositories the task changes must be declared before plan approval; changes in undeclared repos are invisible to turbine.
- Execution defaults to **manual-supervised** handoff; worktree is not a security sandbox.
- Non-mock model providers are adapter-shaped; mock is the default offline provider.
- Jira write sync, GitHub PR automation, web UI, and multi-tenant service are not implemented.
- Storage uses Node built-in `node:sqlite` (requires Node 22+).
- Project facts (layer 1): convention counts are textual (comments and strings are not parsed); ESLint / `prettier.config.js` are not evaluated; `yarn.lock` and bun lockfiles are not parsed; the version-range check only decides forms it fully understands (otherwise `unchecked`); `.turbine/context/` is git-ignored because it cites the commit it was built from.

Statuses: `planned` | `active` | `implemented` | `tested` | `blocked`
