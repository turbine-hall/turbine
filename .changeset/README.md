# Changesets

Version and publish Turbine packages with [Changesets](https://github.com/changesets/changesets).

## Release flow

1. After a user-facing change, run `pnpm changeset` and select the packages (or let the fixed group bump together).
2. Merge the PR with the new `.changeset/*.md` file.
3. On release: `pnpm changeset version` then `pnpm build` then `pnpm changeset publish`.

`changeset publish` rewrites `workspace:*` dependencies to real versions in the published tarballs.
