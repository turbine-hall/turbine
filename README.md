<p align="center">
  <a href="https://github.com/turbine-hall/turbine" target="_blank">
    <img src="docs/assets/turbine-logo.jpg" width="120" alt="Turbine — open-source governance framework for AI-assisted software development" />
  </a>
</p>

<h1 align="center">Turbine — Governed Workflow Engine for Human + AI Software Development</h1>

<p align="center">
  <strong>Ship AI-written code your team can actually trust.</strong><br />
  An open-source CLI that adds requirements, approvals, independent review, real test evidence and audit trails<br />
  to the work your developers already do with AI coding agents like Cursor, Claude Code and Copilot.
</p>

<p align="center">
  <a href="https://github.com/turbine-hall/turbine/actions/workflows/ci.yml"><img src="https://github.com/turbine-hall/turbine/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <img src="https://img.shields.io/badge/version-0.5.2-blue" alt="Version 0.5.2" />
  <img src="https://img.shields.io/badge/node-22.13%E2%80%9322%20%7C%2024.x%20%7C%20%E2%89%A526-brightgreen" alt="Node.js 22.13–22.x, 24.x, or ≥26 (not 23 or 25)" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6" alt="TypeScript" />
  <a href="https://github.com/turbine-hall/turbine/stargazers"><img src="https://img.shields.io/github/stars/turbine-hall/turbine?style=social" alt="GitHub stars" /></a>
</p>

<p align="center">
  <a href="#autonomous-lane-and-sandbox">Lane &amp; sandbox</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#who-is-turbine-for">Who it's for</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="docs/TURBINE_FRAMEWORK_v0.5.md">Framework spec</a>
</p>

---

## What is Turbine?

**Turbine** is an open-source **AI software development governance framework**, and **Turbine Hall** (`turbine`) is the command-line app that runs it. Together they give engineering teams a repeatable, auditable way to turn a feature request or Jira ticket into reviewed, tested, accepted code when humans and **AI coding agents** work on it together.

AI coding tools are great at writing code, but they don't give you *process*: unclear requirements turn into confident wrong code, nobody can say which requirement a change satisfies, and "the tests pass" often means "the agent said they pass." Turbine fixes that by putting a **deterministic, fail-closed workflow** around the agent:

- **Requirements before code.** Every task gets a spec with numbered requirements (FR-001, P0/P1/P2), open questions, and a plan that a human approves.
- **Humans approve, AI doesn't.** Requirements, plan, code review and final acceptance are human-only decisions. An AI agent cannot approve its own work.
- **Approvals are bound to content.** Approvals are tied to the exact hash of the spec, plan or commit. Change the code and the old approval goes stale on its own.
- **Real evidence, not self-reporting.** Turbine runs your lint, typecheck, test and build commands in an isolated git worktree and records the output. No configured checks means the task is blocked, not passed.
- **Traceability from requirement to commit.** Each requirement is traced through the plan, tests and checks to the diff: FULL, PARTIAL or NONE.
- **Right-sized AI roles.** 16 specialist roles (architect, security reviewer, API SQA, and so on) are picked per task based on risk, so a typo fix doesn't pay for a security audit and a file-upload feature doesn't skip one.

> Turbine is not a replacement for Scrum or Kanban. Those decide *what* to build next. Turbine governs *how* a single work item gets built, reviewed and verified by humans and AI.

---

## Autonomous lane and sandbox

Two optional capabilities — both fail-closed, both off by default:

| Feature | In plain terms |
|---|---|
| **Autonomous lane** | For *low-risk* work, a human-approved **policy** can pass gates without typing each approval. Two AI reviewers must agree, and the PR lands through GitHub’s merge queue. Anything unclear drops back to a human. |
| **Sandboxed execution** | Set `execution.mode: sandboxed-unattended` and Turbine can run Claude Code or Codex **inside Docker/Podman**, with tight mounts and separate networks for installs vs. the model proxy. No container runtime → it refuses to start (it will not fall back to an open host run). |

Default behaviour is unchanged: humans still approve requirements, plan, review and acceptance unless you opt into the lane, and `turbine task execute` stays manual-supervised unless you turn on the sandbox.

More detail, config pointers and known gaps: **[docs/autonomous-lane-and-sandbox.md](docs/autonomous-lane-and-sandbox.md)**.

---

## Who is Turbine for?

| You are… | What Turbine gives you |
|---|---|
| **CTO / VP of Engineering** | Predictable AI-assisted delivery, an audit trail for every change, and a clear point of human accountability per task |
| **Software development agency / IT services firm** | One consistent delivery standard across clients, projects and developers, whatever AI tools each engineer prefers |
| **Tech startup founder or tech lead** | The speed of AI coding agents without piling up unreviewed, untested code |
| **Software engineer** | A CLI that tells you (and your agent) exactly what to do next, and specs/reviews in plain Markdown inside your repo |
| **QA / SQA engineer** | Commit-bound test evidence, per-requirement acceptance checklists, and checks that re-run whenever code changes |
| **Engineering manager / PM** | Requirements in a format you can edit, open questions surfaced before coding starts, and status you can read at a glance |

---

## Key features

### 🧭 Governed software delivery lifecycle
A state machine that enforces the path from intake to acceptance:

```text
IMPORTED → ASSESSING → REQUIREMENTS_REVIEW → REQUIREMENTS_APPROVED
 → PLANNING → PLAN_REVIEW → PLAN_APPROVED
 → IMPLEMENTING → AI_REVIEW → HUMAN_CODE_REVIEW
 → VERIFYING → HUMAN_ACCEPTANCE → ACCEPTED
```

Transitions are checked in code. Gates fail closed and report `PASS`, `CONCERNS` or `FAIL`. Waivers need a named human, a reason and an expiry date.

### 📄 Markdown-first task packets
Every work item lives in your repo under `.turbine/tasks/<work-id>/`:

| File | Purpose |
|---|---|
| `STATUS.md` | Start here: current state, who acts next, gate progress diagram, blockers |
| `SPEC.md` | Requirements (FR-001, P0/P1/P2, EARS wording), open questions, verified context vs. assumptions, plan and test plan |
| `REVIEW.md` | What changed (from git), traceability per requirement, AI review, check results, acceptance checklist |
| `evidence/` | Raw JSON and logs behind the documents |

Docs are rendered from the engine's state, including Mermaid diagrams for gate progress, change maps and user flows. Packet size scales with the task: **trivial**, **standard** or **full** track.

### 🔍 Diff-grounded AI code review
AI review runs through lenses (spec, tests, security) and is triaged deterministically. A finding has to cite a changed file, quoted code has to exist in the diff, and claims about dependencies or tests are checked against git.

### 🧪 Real verification in isolated worktrees
Each task gets its own git worktree and branch (`turbine/<work-id>`). Your configured setup and check commands run there, one evidence record per check. New commits make earlier review and test results stale automatically.

### 🛡️ Risk-based role selection (ARSP)
The **Adaptive Role Selection Policy** picks the smallest set of roles that covers the task's risk. The profile is the maximum of rule triggers, model recommendation, the human-set minimum and observed evidence, and it is never lowered. Triggers such as `file-upload`, `untrusted-input`, `data-deletion` and `new-dependency` bring in the right reviewers. A new dependency in the diff triggers a dependency audit.

### 🔗 Lineage and change-impact tracking
Requirements, plans, commits, reviews and tests are linked by typed edges. When something upstream changes, everything that depended on it is invalidated. When a link is missing, Turbine invalidates conservatively instead of guessing.

### 🔌 Tool- and model-independent
Jira, Git, GitHub, IDEs and CI are **adapters**, not foundations. Use the built-in offline mock model or any **OpenAI-compatible API** (OpenAI, Azure-compatible gateways, proxies). It works alongside **Cursor** (with a built-in hook that blocks agents from running approval commands), **Claude Code**, **GitHub Copilot** or any agent that can run shell commands.

### 🗂️ Multi-repo tasks
Changes spanning several repositories (for example frontend + backend) are bound together by a single change-set id with `turbine task repo add`.

---

## How it works

```text
 Request / Jira ticket
        │
        ▼
 ┌──────────────┐   AI drafts, human approves   ┌──────────────┐
 │ Requirements │ ─────────────────────────────▶│     Plan     │
 └──────────────┘        (hash-bound)           └──────────────┘
                                                       │ human approves
                                                       ▼
 ┌──────────────┐    commits in worktree        ┌──────────────┐
 │  AI review + │ ◀──────────────────────────── │ Implement    │
 │ human review │                               │ (agent/dev)  │
 └──────────────┘                               └──────────────┘
        │ human approves
        ▼
 ┌──────────────┐  every P0 ticked by a human   ┌──────────────┐
 │ Verify: real │ ─────────────────────────────▶│   ACCEPTED   │──▶ PR / merge
 │ checks run   │                               └──────────────┘
 └──────────────┘
```

1. **Intake.** Create a task from plain text or a Jira issue. Turbine keeps the original and opens an **Engineering Evidence Contract (EEC)**, the list of obligations the task has to satisfy.
2. **Assess and specify.** The requirements-analyst and spec-writer roles draft requirements and questions. You edit `SPEC.md` and approve.
3. **Plan.** The engine inspects the repo and drafts a plan and test plan linked to the requirements. You approve.
4. **Implement.** Your developer or AI agent works in the task worktree and commits.
5. **Review.** Diff-grounded AI review runs, then a human code review.
6. **Verify and accept.** Your real checks run. A human ticks each P0 requirement with what they observed. Then you open the PR.

---

## Quick start

### Requirements

- Node.js `^22.13.0 || ^24.0.0 || >=26.0.0` (intersection of ESLint 10, Vitest 5, and Commander 15; uses built-in `node:sqlite`)
- pnpm 10+
- Git

### Install

**npm (recommended once published):**

```bash
npm install -g @turbine-hall/turbine-cli
# or without a global install:
npx @turbine-hall/turbine-cli --help
```

**From source (contributors):**

```bash
git clone https://github.com/turbine-hall/turbine.git
cd turbine
pnpm install
pnpm build
```

Optional alias so you can run `turbine` from any project directory while developing:

```bash
alias turbine='pnpm --dir /path/to/turbine turbine'
```

### Use it in an existing project

```bash
cd /path/to/your-app
turbine init --project .     # creates .turbine/ in this directory; runs `understand` when the repo has commits
turbine doctor               # projectRoot should be your app, not the turbine repo

# Create your first task
turbine task create --title "Add password reset endpoint" --file ./request.md
```

### `turbine understand` (project knowledge)

`turbine understand` snapshots the repository at HEAD, drafts a verified-claims brief, and publishes an [OKF](https://github.com/open-knowledge-format/open-knowledge-format) v0.3 knowledge bundle under `.turbine/knowledge/` (profile `turbine-okf/1`). The store is the source of truth; the markdown files are a deterministic render. The live bundle is git-ignored by default — use `turbine knowledge export <dir>` when you want a validated copy to commit or share. A second run at the same commit writes nothing. Agents should start from `.turbine/knowledge/index.md`.

### Configure quality checks (required)

Verification runs your own commands in the task worktree. With no checks configured, verification is blocked. Edit `.turbine/project.yaml`:

```yaml
quality:
  setup: [npm ci]
  checks: [npm run lint, npm run typecheck, npm test, npm run build]
```

`quality.dependencyAudit` (default `auto`) runs `npm`/`pnpm`/`yarn audit` at high severity, chosen from your lockfile, whenever a change adds or updates dependencies. Set it to `off` to disable.

### The daily loop

Let the CLI drive:

```bash
turbine task next <work-id>    # always start here: the exact next action and commands
# follow "Do now" (edit SPEC.md / REVIEW.md if asked)
turbine task sync <work-id>
turbine task next <work-id>    # repeat until ACCEPTED, then open a PR and merge
```

Human decisions happen only in your own terminal:

```bash
turbine task approve <work-id>   # asks you to type the short hash of what you approve
turbine task reject <work-id>
```

Useful extras: `turbine task analyze <id>` checks consistency between requirements, plan and code (CRITICAL findings block approval). `turbine task lint <id>` checks the documents. `turbine task gate <id>` shows gate status. Terms are explained in `.turbine/GLOSSARY.md`.

> **ACCEPTED is not merged.** After acceptance, merge `turbine/<work-id>` into `staging`/`main` and `git pull` in your main folder.

If `doctor` shows `projectRoot` pointing at the turbine repo, re-init with an absolute path:

```bash
turbine init --project /absolute/path/to/your-app
```

### Use a real LLM (OpenAI-compatible)

The default model is an offline mock. To use a live model:

```bash
export OPENAI_API_KEY='sk-...'
# optional, for proxies or Azure-compatible gateways:
# export OPENAI_BASE_URL='https://api.openai.com/v1'

cd /path/to/your-app
turbine model add --provider openai --id gpt-4.1-mini
turbine model test gpt-4.1-mini
turbine doctor   # should show provider openai-compatible
```

Then create a **new** task (older tasks already used mock drafts).

Live models power assess, plan, review and implementation notes. `turbine task execute` is **manual-supervised by design**: it prepares the worktree(s) and a brief but does not rewrite your app on its own. Work in the worktree, commit, then run `turbine task sync`. The task stays in `IMPLEMENTING` until a real commit exists.

### Driving Turbine with an AI agent

Point your agent (Cursor, Claude Code, etc.) at [docs/AGENT_DRIVER.md](docs/AGENT_DRIVER.md) and the `.turbine/HOW_TO_DRIVE.md` file that `turbine init` writes. The agent runs `next` and `sync`, writes code in the worktree, and stops whenever a human decision is needed.

---

## Turbine vs. other approaches

| | Prompting an AI agent directly | Spec-driven prompt kits | **Turbine** |
|---|---|---|---|
| Written requirements before code | Optional | ✅ | ✅ with FR IDs and priorities |
| Human approval enforced in code | ❌ | ❌ | ✅ hash-bound, human-only |
| Stale approvals detected | ❌ | ❌ | ✅ automatic on new commits or spec changes |
| Tests actually executed and recorded | Agent says so | Agent says so | ✅ in an isolated worktree, per-check evidence |
| Requirement → code → test traceability | ❌ | Partial | ✅ FULL / PARTIAL / NONE |
| Risk-based reviewer selection | ❌ | ❌ | ✅ ARSP |
| Vendor / model lock-in | Tool-specific | Often tool-specific | Tool- and model-independent |

---

## Built-in roles and skills

**17 roles:** requirements analyst, spec writer, project manager, architect, UX designer, frontend developer, backend developer, database engineer, code reviewer, code quality checker, security reviewer, unit tester, test-case SQA, API SQA, E2E SQA, release engineer, task decomposer. See [`roles/`](roles).

**Core skills:** assess requirements, write specification, plan change, execute code change, surgical changes, systematic debugging, review change, verify acceptance. See [`skills/core/`](skills/core).

Roles are **responsibility contracts, not chat personas**. Each model call runs *as* a role, with tool grants limited to that role's capabilities intersected with your project's tool policy.

---

## Project structure

```text
apps/cli/            Turbine Hall CLI (`turbine`)
packages/core        Workflow engine, state machine, gates
packages/contracts   Zod schemas for work packages and evidence
packages/evidence-contract  Engineering Evidence Contract (EEC)
packages/lineage-impact     Typed lineage, invalidation, recovery
packages/executor    Worktree execution and supervised handoff
packages/models      Mock + OpenAI-compatible model adapters
packages/adapter-*   Git, Jira, test-runner adapters
packages/storage-sqlite     Local store on node:sqlite
roles/  skills/      Role manifests and skill definitions
frameworks/turbine/  Versioned framework definition (0.5.0)
examples/            Plain-text, Jira and backend API sample tasks
```

### Development scripts

| Script | Purpose |
|---|---|
| `pnpm build` | Build all packages |
| `pnpm test` | Offline unit and integration tests (Vitest) |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript project checks |
| `pnpm turbine -- <cmd>` | Run the CLI via tsx |

---

## Project status and roadmap

Turbine is at **v0.5.2**, a working baseline for pilot use on real projects. Phases 0–6, hardening phases 1–4, repository context / OKF knowledge, and the autonomous lane (policies, dual review, PR landing, metrics, fleet scheduler, sandboxed unattended execution) are implemented and tested. Full details are in [Implementation status](docs/IMPLEMENTATION_STATUS.md); a shorter narrative is in [Autonomous lane and sandboxed execution](docs/autonomous-lane-and-sandbox.md).

**Known limitations, stated plainly:**

- Local approvals are local attestations, not authenticated identity. For code review and acceptance, `humanGates.requirePrApproval: true` adds a GitHub PR approval that an agent account cannot grant itself.
- A plain git worktree is isolation for changes, not a security sandbox. Use `sandboxed-unattended` (Docker/Podman) when you need container boundaries; that path is single-repo today and still needs your own model-proxy URL.
- Jira write-back, a web UI and a hosted multi-tenant service are not built yet. Lane PR landing covers create + merge-queue auto-merge for accepted single-repo tasks; `turbine fleet run` / `fleet status` cover concurrency + spend budget (file-set overlap scheduling and post-merge revert detection are not).
- Turbine makes no claims about productivity percentages. Its value is a hypothesis being tested in pilots, and results will be published as they come in.

The binary name (`turbine`) is provisional. The package scope is `@turbine-hall/*`.

---

## Documentation

- [Autonomous lane and sandboxed execution](docs/autonomous-lane-and-sandbox.md): policy lane, dual review, container sandbox — plain language
- [Turbine framework specification](docs/TURBINE_FRAMEWORK_v0.5.md): philosophy, lifecycle, EEC, ARSP, roles, governance
- [Turbine Hall app requirements](docs/TURBINE_HALL_REQUIREMENTS_v0.5.md)
- [Implementation status](docs/IMPLEMENTATION_STATUS.md)
- [Agent driver playbook](docs/AGENT_DRIVER.md): how to drive Turbine from Cursor, Claude Code or another agent

---

## FAQ

**What is Turbine in one sentence?**
Turbine is an open-source CLI and framework that puts human-approved requirements, independent AI and human code review, real test execution and audit trails around AI-assisted software development.

**Does Turbine replace Cursor, Claude Code or GitHub Copilot?**
No. Turbine sits on top of the AI coding tools you already use. It governs the workflow and evidence, and your agent still writes the code.

**Can the AI approve its own pull request or skip review?**
No. Requirements, plan, code review and acceptance approvals are human-only. They require an interactive terminal and a typed content hash, and they are refused in agent sessions. In Cursor, a hook installed by `turbine init` blocks those commands. For stronger guarantees, you can require a GitHub PR approval.

**Does it work with Jira?**
Yes, for intake: Turbine reads Jira issues and normalizes them into work packages. Writing back to Jira is on the roadmap.

**Which LLMs are supported?**
An offline mock model by default, plus any OpenAI-compatible API through `OPENAI_BASE_URL`, which covers OpenAI and Azure-compatible gateways.

**Does it replace Scrum or Kanban?**
No. Keep your sprint or Kanban process for prioritization. Turbine governs how each individual work item is built and verified.

**Is my code sent anywhere?**
Turbine runs locally and stores state in a local SQLite database. Code context is only sent to an LLM if you configure a real model provider.

**Is Turbine a good fit for a software agency?**
Yes, it was designed with them in mind. The first target users are 10–100 developer services firms that use Jira/GitHub and several AI coding tools and want one consistent, auditable delivery standard across teams and clients.

---

## Contributing

Feedback from engineering teams trying AI-assisted delivery is the most valuable contribution right now. Open an [issue](https://github.com/turbine-hall/turbine/issues) to report a bug, share pilot results, or propose a role, skill or adapter. Pull requests are welcome. Please run `pnpm lint && pnpm typecheck && pnpm test` before submitting.

If Turbine is useful to you, please ⭐ **star the repo**. It helps other teams find it.

---

## Attribution

- **Framework proposed by** [Ahsan Aasim](https://www.linkedin.com/in/ahsan-aasim/)
- **Open-source project maintained by** [6sense HQ Ltd.](https://6sensehq.com)

<sub>Keywords: AI software development framework, AI coding agent governance, human-in-the-loop AI development, AI code review, spec-driven development, requirements traceability, software delivery workflow, AI SDLC, Cursor workflow, Claude Code workflow, GitHub Copilot governance, engineering audit trail, open-source developer tools.</sub>
