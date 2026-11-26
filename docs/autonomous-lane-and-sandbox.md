# Autonomous lane and sandboxed execution

Plain-language guide to two optional Turbine capabilities. For the full capability matrix see [Implementation status](IMPLEMENTATION_STATUS.md). For FR-level design notes see [specs/autonomous-lane.md](specs/autonomous-lane.md).

---

## At a glance

| Feature | What you get |
|---|---|
| **Autonomous lane** | Low-risk tasks can pass gates under a human-approved policy, with dual AI review and GitHub merge-queue landing |
| **Sandboxed unattended execution** | Agents can implement inside Docker/Podman with fail-closed mounts and network policy |
| **Claude Code & Codex adapters** | Live implementers for the sandboxed path (stdin CLIs in the container) |

Related (not covered in depth here): project knowledge via `turbine understand` / OKF under `.turbine/knowledge/`.

---

## Autonomous lane (parts A, B, C, G)

Turbine still defaults to human gates. The **autonomous lane** is optional and fail-closed: it only removes autonomy when something is wrong; it never silently adds risk.

1. **Policies (A).** Humans write `.turbine/policies/<name>.yaml` and approve it in a terminal (`turbine policy approve`). Until that approval, the file does nothing. Edits make the policy pending again.
2. **Dual AI review (B).** Code-review gates that a policy may pass need **two** different model profiles. Both must finish cleanly with no blocking findings at the same commit.
3. **PR landing (C).** After acceptance, Turbine opens or reuses the `turbine/<work-id>` PR and enables GitHub auto-merge / merge queue. Landing does not push the base branch or bypass protection.
4. **Metrics & auto-suspend (G).** `turbine metrics` and audit sampling watch outcomes. Thresholds can suspend a policy so later tasks fall back to humans.

If eligibility is unknown, checks fail, reviewers disagree, or HEAD moves, the task leaves the lane and a human continues from the current state.

---

## Sandboxed unattended execution (Part D)

Default execution is still **manual-supervised**: Turbine prepares a worktree and a brief; a person or agent commits there.

When you set `execution.mode: sandboxed-unattended` (and the rest of the knobs), Turbine can run the implement loop **inside a container**:

- **Runtime:** Docker or Podman required. No runtime → refuse start (no unsandboxed fallback).
- **Mounts:** task worktree plus selective linked-worktree Git paths (including `.git/config` read-only). Home, SSH keys, host credential files outside the worktree, and `.turbine/state` are never mounted. The whole task worktree is mounted read-write, so task commands can read any credential file in it (for example `.env`) — keep secrets out of the worktree. If a remote URL in the mounted Git config embeds a token, task commands can also read it; use a credential helper or env instead.
- **Networks:** separate Docker/Podman network *names* for package registries vs the model proxy; checks and commit use `--network none`. Turbine does not build the allow-list itself — operators must create and validate filtering on both networks. Incomplete config refuses start.
- **Egress probe:** an in-container probe to one destination must show isolation before the run continues. Passing that probe is not proof of the full allow-list policy.
- **Agents:** Claude Code and Codex adapters run non-interactively via stdin inside the container when configured.
- **Fix cap:** too many failed check rounds leave the lane; another sandboxed launch needs a human `lane.retry`.

Multi-repo tasks are refused on this path today (single primary worktree). Host `VERIFYING` runs your configured `quality.setup` and `quality.checks` outside the sandbox, in the task worktree, after approval. Commands such as `npm test` and `npm ci` execute scripts from the task's `package.json` and lockfile on the host — review changes to those files before approving.

Config knobs live under `execution` in `.turbine/project.yaml` (image, registries, model-proxy URL/network, allow-network, implementer id). The model-proxy **server** itself is operator-supplied.

Shipped in [PR #37](https://github.com/turbine-hall/turbine/pull/37).

---

## Limits

- Revert detection after a recorded merge and stacked PRs are not built. The fleet scheduler (`turbine fleet run` / `fleet status`) is shipped for concurrency + budget + suspend-aware handoff; predicted file-set overlap scheduling remains Part F.
- Hosted multi-tenant service / web UI are not built.
- Model-proxy server is out of scope (you bring your own URL).
- GitHub issue **label** intake for policy matching is incomplete (Jira labels and the createTask API already record labels).
- Sandboxed path does not support multi-repo tasks yet.

---

## Where to read next

| Doc | Use when |
|---|---|
| [README — Autonomous lane and sandbox](../README.md#autonomous-lane-and-sandbox) | Short overview |
| [Implementation status](IMPLEMENTATION_STATUS.md) | Exact tested scope and known limits |
| [Agent driver](AGENT_DRIVER.md) | Driving tasks from Cursor / Claude Code |
| [Autonomous lane spec](specs/autonomous-lane.md) | Design and FR-level detail |
| [Framework v0.5](TURBINE_FRAMEWORK_v0.5.md) | Product philosophy and lifecycle |
