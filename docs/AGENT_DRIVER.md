# Turbine Agent Driver (Cursor / AI + Human)

Use this playbook when driving Turbine Hall (`turbine`) with a human in the loop.

## Core rules

1. **Always ask the CLI what to do next** — `turbine task next <work-id>`. Do not invent the workflow.
2. **The packet is STATUS.md, SPEC.md, REVIEW.md** — `.turbine/tasks/<id>/`. Start with STATUS.md. You may edit requirements / open-question answers in SPEC.md (in the shown line format) and the acceptance observations in REVIEW.md only when a human asks; then run `sync`. Decision sections are display-only; editing them does nothing. Never paste raw JSON into these files.
3. **Main project folder ≠ task worktree.** Code for a task goes in `.turbine/worktrees/<id>/` on branch `turbine/<id>` until a PR is merged.
4. **ACCEPTED ≠ merged.** After acceptance, open a PR into `staging`/`main`, merge, then `git pull` in the main folder.
5. **Never make a human decision.** Requirements, plan, code review and acceptance are approved only by a human running `turbine task approve <id>` in their own terminal (it asks them to type the short hash of what they approve). Agents must never run `approve`, `reject`, `waive`, `cancel` or `changes-requested`, and must never touch `.turbine/state/`. In Cursor, `.cursor/hooks.json` (installed by `turbine init`) blocks these commands.
6. **Gates fail closed.** `turbine task gate <id>` shows PASS / CONCERNS / FAIL. ACCEPTED requires every required obligation to be satisfied at the current commit, or waived by a named human with a reason and expiry.

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
| PLAN_REVIEW | human | read the Plan in `SPEC.md` (fix CRITICAL items from `turbine task analyze`) → human runs `turbine task approve` |
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
