# Publishing Turbine to npm

Turbine is a pnpm monorepo. The installable CLI is `@turbine-hall/turbine-cli` (bin: `turbine`). Internal libraries are published as `@turbine-hall/turbine-*` so workspace dependencies resolve on the registry.

## Prerequisites

- Own the [`@turbine-hall`](https://www.npmjs.com/org/turbine-hall) npm org (or change the scope).
- `npm login` (local) or `NPM_TOKEN` secret (CI workflow `publish.yml`).
- Built packages: `pnpm build` (copies `frameworks/`, `roles/`, `skills/` into `apps/cli/`).

## First publish

```bash
pnpm build
pnpm pack:cli          # inspect the CLI tarball locally
pnpm release           # changeset publish (rewrites workspace:* → versions)
```

Or dry-run via GitHub Actions: **Actions → publish → Run workflow** with `dry_run: true`.

## Later releases

1. `pnpm changeset` — describe the change (packages are versioned together via the fixed group in `.changeset/config.json`).
2. Merge the changeset file.
3. `pnpm version-packages` then `pnpm release`.

## What the CLI tarball must contain

- `dist/` — compiled CLI
- `frameworks/`, `roles/`, `skills/` — factory assets (`factoryRoot()` resolves to the package root after install)
