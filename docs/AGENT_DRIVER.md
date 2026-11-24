# Turbine Agent Driver (Cursor / AI + Human)

Use this playbook when driving Turbine Hall (`turbine`) with a human in the loop.

## Core rules

1. **Always ask the CLI what to do next** — `turbine task next <work-id>`. Do not invent the workflow.
2. **The packet is STATUS.md, SPEC.md, PLAN.md, EXECUTIVE-SUMMARY.md, REVIEW.md** — `.turbine/tasks/<id>/`. Start with STATUS.md. You may edit requirements / open-question answers in SPEC.md (in the shown line format) and the acceptance observations in REVIEW.md only when a human asks; then run `sync`. PLAN.md and EXECUTIVE-SUMMARY.md are generated from the plan artifact — do not hand-edit them expecting persistence. Decision sections are display-only; editing them does nothing. Never paste raw JSON into these files. **Linked tracker issues:** when the task has a GitHub (`github:owner/repo#n` / issue URL) or Jira (`jira:KEY`) link, each packet render mirrors those docs onto a sticky issue comment — only if `tools.allow` includes `issue.comment`, the matching `inputs.adapters.*.enabled` is true, and (for GitHub) `owner/repo` is in `inputs.adapters.github.mirrorRepos`; otherwise STATUS/evidence records an explicit skip reason (never silent).
3. **Main project folder ≠ task worktree.** Code for a task goes in `.turbine/worktrees/<id>/` on branch `turbine/<id>` until a PR is merged.
4. **ACCEPTED ≠ merged.** After acceptance, open a PR into `staging`/`main`, merge, then `git pull` in the main folder.
5. **Never make a human decision.** Requirements, plan, code review and acceptance are approved only by a human running `turbine task approve <id>` in their own terminal (it asks them to type the short hash of what they approve). Agents must never run `approve`, `reject`, `waive`, `cancel` or `changes-requested`, and must never touch `.turbine/state/`. In Cursor, `.cursor/hooks.json` (installed by `turbine init`) blocks these commands.
6. **Read the knowledge bundle before you plan or implement.** In REQUIREMENTS_APPROVED, PLANNING, PLAN_APPROVED, IMPLEMENTING and CHANGES_REQUESTED, `turbine task next` lists `.turbine/knowledge/index.md` first (OKF v0.3 bundle of verified facts and claims), then the task's `CONTEXT.md`. Roles that declare `brief_sections` also get those concepts under `knowledge/brief/`. `PROJECT.md` is superseded by the knowledge bundle for one release. `CONTEXT.md` is **a selection, not a complete list**. Never treat CONTEXT.md as current if it says STALE: run `turbine task next <id>`. Write what you learn only under `## Agent notes`. Hand edits to generated knowledge concepts are overwritten by the next `turbine understand` and reported by `turbine lint` / `turbine knowledge validate`.
7. **Gates fail closed.** `turbine task gate <id>` shows PASS / CONCERNS / FAIL. ACCEPTED requires every required obligation to be satisfied at the current commit, or waived by a named human with a reason and expiry. Brief approval (`turbine context approve`) and attestation (`turbine context attest`) are the same class of human-only gate — never run them from an agent session.
8. **Lane policies are approved by humans; agents only read or suspend them.** A policy in `.turbine/policies/<name>.yaml` lets `sync` pass listed gates for eligible tasks. A policy listing `codeReview` must name two model profiles that resolve to different provider/model identities; both reviewers run every selected lens on the same current diff, and both must complete with parseable, clean results. Incomplete output, refusal, timeout, budget stop, blocking findings, disagreement or a new commit sends the task to a human; REVIEW.md shows both completed reviews side by side. The policy does nothing until a human runs `turbine policy approve <name>`, and any later edit makes it pending again. Agents may run `turbine policy list`, `turbine policy show <name>`, `turbine task lane <id>` and `turbine policy suspend <name> --reason "…"` (suspending only removes autonomy). Agents must never run `turbine policy approve`, `turbine policy resume` or `turbine task lane <id> --retry`; the Cursor hook blocks them. A gate passed by policy says "Passed by policy `<name>`" — report it that way, never as "approved". When STATUS.md shows "Autonomous lane: a human decides", tell the human the listed reasons; the task now follows the normal human flow.
8. **Brief is claims, not prose.** `turbine understand` drafts/re-verifies the brief and publishes `.turbine/knowledge/`; only verified or human-attested claims appear. Model proposals never skip `publishClaim`. Unapproved drafts are marked `draft` in the bundle. Export a shareable copy with `turbine knowledge export <dir>` (the live bundle is git-ignored by default).

## Loop

```text
turbine task next <id>
→ do the "Do now" / Commands
→ if a human decision is needed: summarise it, ask the human to run `turbine task approve <id>`, then stop
→ turbine task next <id> again
```

## State cheat sheet

| State | Who | Action |
|---|---|---|
| IMPORTED / ASSESSING | either | `sync` / assess |
| NEEDS_CLARIFICATION / REQUIREMENTS_REVIEW | human | edit requirements / answer questions in `SPEC.md` → `sync` → human runs `turbine task approve` |
| REQUIREMENTS_APPROVED | either | `sync` → plan |
| PLAN_REVIEW | human | read `PLAN.md` and `EXECUTIVE-SUMMARY.md` (fix CRITICAL items from `turbine task analyze`) → human runs `turbine task approve` |
| PLAN_APPROVED | either | `sync` → execute handoff |
| IMPLEMENTING / CHANGES_REQUESTED | agent | code **in the worktree(s)**, commit everything, `sync` (stays here until there is a commit and nothing uncommitted) |
| AI_REVIEW | either | `sync` |
| HUMAN_CODE_REVIEW | human | review the diff + `REVIEW.md` sections 1–3 → human runs `turbine task approve` |
| VERIFYING | either | `sync` runs every `quality.checks` command in the worktree(s); failures → CHANGES_REQUESTED |
| HUMAN_ACCEPTANCE | human | tick each P0 in `REVIEW.md` → 5. Acceptance with what they observed → human runs `turbine task approve` |
| ACCEPTED | human | `gh pr create` → merge → pull main folder |

## Evidence rules

- The engine reads commits from git; it does not trust what you say you changed. Commit everything before `sync`.
- Any new commit after review (in any task repo) makes the review, checks and acceptance stale — that is intended.
- If the work needs another repository (e.g. a backend), stop before coding and ask the human to run
  `turbine task repo add <id> --path <dir> --name backend --check "npm run build"` (only possible before the plan is approved).
- The AI review only keeps findings that cite changed files; do not argue with discarded findings, fix real ones.

## Risk

- Role selection only goes up. If the task is riskier than detected (e.g. it touches money, auth or customer data),
  anyone may run `turbine task risk <id> --raise comprehensive --reason "…"`; nobody can lower it.
- Adding a dependency in the diff automatically adds a security review and a dependency audit. A failing audit blocks
  acceptance until it is fixed or a human waives `obl_dependency_audit` with a reason and expiry.

## What to tell the human

- “Your main checkout is still old until the PR merges.”
- “Please run `turbine task approve <id>` in your own terminal — I’m not allowed to approve.”
- “I’m coding in the worktree path from `turbine task next`, not in staging.”
