# AGENTS.md

Instructions for coding agents working in this repository. Read this before writing code. Repository-specific workflow rules are in `docs/AGENT_DRIVER.md` and `.cursor/rules/turbine-agent-driver.mdc`.

## Project

Turbine Hall: a pnpm monorepo of TypeScript packages and the `turbine` CLI (Node >= 22).

- `apps/cli`: the CLI and the engine (`apps/cli/src/engine`, including `context/` for repository context).
- `packages/*`: contracts, core, storage, adapters, executor.
- `tests/integration`: vitest integration tests. They import from `dist`, so build first.
- `docs/IMPLEMENTATION_STATUS.md`: what each layer does and its known limitations. Keep it accurate.

## Commands

Run these from the repository root, in this order:

1. `pnpm install --frozen-lockfile`
2. `pnpm build` (required before typecheck and test: workspace packages resolve types and runtime code from `dist`)
3. `pnpm lint`
4. `pnpm typecheck`
5. `pnpm test`

CI runs these on Node 22 and 24. A change is not done until all four pass locally.

## Before writing code

- Find an existing implementation of the same kind of thing and follow its naming, error handling, and test style.
- For Turbine task work, follow `.cursor/rules/turbine-agent-driver.mdc`: code changes go only in the task worktree on the task branch. Never commit task work to `main` or `staging`. Never approve, reject, or waive a human gate.
- Check the current state of the code before trusting a description of it, including any description in an issue, a PR, or this file.

## Correctness rules

These come from review findings on PR #9 (about 80 findings) and PR #11 (about 20). Most were functional correctness (44), data integrity (27), stability (17), and security (7).

1. **Validate paths** that come from input or config before using them. Reject absolute paths and `..` traversal.
2. **Bound every read of untrusted input.** Apply byte or size budgets. Limit the depth of recursive parsing. Turn a parser failure (including a stack overflow) into a per-file failure, not a crash and not a silent pass.
3. **Do not claim exhaustiveness from a heuristic.** If a scan cannot prove a result, report it as unconfirmed. Agreement between two regex scans is not proof.
4. **Validate the whole input before reporting a match.** Do not return early from a partial parse.
5. **Pin reads to one commit.** Read every fact from the same snapshot. Recheck HEAD and state before publishing. If they changed, retry or fail in a way that can be retried. Do not reuse a value computed before a state change.
6. **Git reads for snapshots:** disable replacement refs and lazy fetch. Distinguish an unborn branch from an unreadable HEAD.
7. **Publish atomically.** Write to a temporary file and rename it. Save store records inside the same critical section as the publish. Clean up on failure.
8. **Locks:** remove a lock only if you still own it. Re-read the owner immediately before removing it. Clean up if writing the owner fails.
9. **Never drop data silently.** If something is skipped, record why.
10. **Implement the standard the spec states, not a convenient subset.** Examples: Node `exports` selection (first valid array target, no fallback on a missing file, nested conditions fall through to `default`, a direct `null` target blocks but inside an array it is passed over (`[null, "./index.js"]` selects `./index.js`), targets start with `./`); JSON/JSONC edge cases (CR-only line endings, duplicate keys, non-finite numbers).
11. **Verify runtime behaviour when a rule depends on it.** Run the runtime (for example Node) on a small fixture instead of relying on memory.

## Testing

- Every bug fix and every review fix gets a regression test that fails before the fix and passes after it.
- Cover the edge cases in the correctness rules above, not only the happy path.
- Each acceptance criterion in a task needs a named test that checks it.

## Review findings (CodeRabbit or human)

- Check each finding against the current code before changing anything. Fix the valid ones.
- If you disagree with a finding, reply with evidence (a test, a command, or a line reference). Do not skip it silently.
- After fixing, reply to the thread with the commit SHA and resolve it.
- Do not claim a finding is fixed without a test or a command that shows it.

## Do not

- Do not commit local-only tooling (`.cursor/prompts/`, `.cursor/scripts/`) unless asked.
- Do not change unrelated files in the same change.
- Do not change issue status or merge a PR unless asked.
