# Changesets

Version and publish Turbine packages with [Changesets](https://github.com/changesets/changesets).

All `@turbine-hall/*` packages are in one **fixed** group — they always share the same version.

## Release flow (newer version)

From `main`, after user-facing changes are merged:

```bash
# 1. Record what changed (creates .changeset/*.md)
pnpm changeset
# pick any package in the fixed group; all bump together

# 2. Apply version bumps + changelog
pnpm version-packages

# 3. Commit the version bump (include Jira key per repo rules)
git add -A && git commit -m "chore: release x.y.z ABC-123"

# 4. Build and publish to npm
pnpm release
# same as: pnpm build && pnpm changeset publish

# 5. Push commit + tags
git push && git push --tags
```

`changeset publish` rewrites `workspace:*` to real versions in the published tarballs.

Or use GitHub Actions: **Actions → publish → Run workflow** with `dry_run: false` (needs `NPM_TOKEN` secret).
