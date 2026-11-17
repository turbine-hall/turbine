<p align="center">
  <a href="https://github.com/turbine-hall/turbine" target="_blank">
    <img src="docs/assets/turbine-logo.jpg" width="120" alt="Turbine Logo" />
  </a>
</p>

<p align="center">
  <strong>Turbine Hall</strong> (<code>turbine</code>)<br />
  A governed workflow engine for human + AI software work.
</p>

<p align="center">
  <a href="https://github.com/turbine-hall/turbine/actions/workflows/ci.yml"><img src="https://github.com/turbine-hall/turbine/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

**Turbine** is the framework (rules, gates, roles). **Turbine Hall** is the app — the CLI that runs it.

A turbine turns raw input into steady output; the turbine hall is where you watch it run.

## Requirements

- Node.js 22+
- pnpm 10+

## Install

```bash
pnpm install
pnpm build
```

Optional alias (run from any project directory; point `--dir` at your local clone):

```bash
alias turbine='pnpm --dir /path/to/turbine turbine'
```

## Use in an existing project

```bash
cd /path/to/your-app          # e.g. 6senseWeb or 6senseHQ-frontend-v3a
turbine init --project .          # creates .turbine/ in THIS directory
turbine doctor                    # projectRoot should be your app, not the factory repo

# Create a task
turbine task create --title "..." --file /tmp/request.md
```

### Configure checks (required)

Verification really runs your commands in the task worktree; with none configured it is blocked.
Edit `.turbine/project.yaml`:

```yaml
quality:
  setup: [npm ci]
  checks: [npm run lint, npm run typecheck, npm test, npm run build]
```

Optional: `quality.dependencyAudit` (default `auto`: `npm`/`pnpm`/`yarn audit` at high severity, chosen from the lockfile; `off` to disable) runs when a change adds or changes dependencies.

### Markdown-first workflow

Each work item gets three short documents (plus raw data) under:

`.turbine/tasks/<work-id>/`

| File | Purpose |
|---|---|
| `STATUS.md` | Start here: state, who acts next, gate progress diagram, blockers |
| `SPEC.md` | Requirements (FR-001, P0/P1/P2), open questions, verified context vs assumptions, plan + test plan |
| `REVIEW.md` | What changed (from git), traceability per requirement, AI review, check results, acceptance checklist |
| `evidence/` | Raw JSON and logs behind the documents |

Size scales with the task (trivial / standard / full track). `turbine task analyze <id>` checks requirements ↔ plan ↔ code consistency; `turbine task lint <id>` checks the documents. CRITICAL analysis findings and lint errors block approval. Terms are explained in `.turbine/GLOSSARY.md`.

Typical loop (let the CLI drive):

```bash
turbine task next <work-id>          # always start here — exact next action + commands
# follow Do now (edit MD Decision if asked)
turbine task sync <work-id>
turbine task next <work-id>          # repeat until ACCEPTED, then open PR / merge / pull
```

After **ACCEPTED**, your main project folder is still old until you merge `turbine/<work-id>` into `staging`/`main` and `git pull`.

Agents: see [docs/AGENT_DRIVER.md](docs/AGENT_DRIVER.md) and `.turbine/HOW_TO_DRIVE.md` (written on `turbine init`).

CLI approve commands (`requirements approve`, `plan approve`, …) still work; `sync` + `next` is the preferred path.

If `doctor` shows `projectRoot` pointing at the factory repo, re-init with an absolute path:

```bash
turbine init --project /absolute/path/to/your-app
```

### Real model mode (not mock)

Default is mock. To use a live OpenAI-compatible API:

```bash
export OPENAI_API_KEY='sk-...'
# optional for proxies / Azure-compatible gateways:
# export OPENAI_BASE_URL='https://api.openai.com/v1'

cd /path/to/your-app
turbine model add --provider openai --id gpt-4.1-mini
turbine model test gpt-4.1-mini
turbine doctor   # should show provider openai-compatible
```

Then create a **new** task (old tasks already used mock drafts).

**Note:** Real model mode makes assess/plan/review/implement-notes live.  
`turbine task execute` is still **manual-supervised** by design: it prepares worktree(s) + a brief and does not autonomously rewrite your app. Work in the worktree path from `04-EXECUTION_BRIEF.md`, commit there, then `turbine task sync` — the task stays in IMPLEMENTING until a real commit exists.

Human decisions are made only with `turbine task approve <id>` / `turbine task reject <id>` in your own terminal.

Binary name is provisional (`turbine`). Package scope is `@turbine-hall/*`.

## Scripts

| Script | Purpose |
|---|---|
| `pnpm build` | Build all packages |
| `pnpm test` | Offline unit/integration tests |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript project checks |
| `pnpm turbine -- <cmd>` | Run CLI via tsx |

## Docs

- [Turbine (framework)](docs/TURBINE_FRAMEWORK_v0.5.md)
- [Turbine Hall (app requirements)](docs/TURBINE_HALL_REQUIREMENTS_v0.5.md)
- [Implementation status](docs/IMPLEMENTATION_STATUS.md)
- [Agent driver](docs/AGENT_DRIVER.md)

## Attribution

- **Framework proposed by** [Ahsan Aasim](https://github.com/ahsanaasim)
- **Open-source project maintained by** [6sense HQ Ltd.](https://6sensehq.com)
