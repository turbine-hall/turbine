import { z } from 'zod';
import { contentHash } from './ids.js';

/**
 * Repository context, layer 1: project facts.
 *
 * A snapshot is a set of facts that are mechanically true at ONE commit. They are read from
 * git objects (never the working tree) and every fact points at the exact object it came from.
 * The schemas here enforce the rules the engine relies on:
 *   - a fact without a {path, commit, blob} source does not parse;
 *   - every source in a snapshot names the snapshot's own commit;
 *   - a convention is "confirmed" only if a config file enforces it or an exhaustive count is 100%;
 *   - declared and installed versions are separate fields, never merged;
 *   - the snapshot hash covers the whole body, so a hand-edited snapshot is rejected.
 */

export const GitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'expected a full git object id');

/** Where a fact was read: a git object at a commit, plus the lines it was read from if known. */
export const FactSourceSchema = z
  .object({
    path: z.string().min(1),
    commit: GitObjectIdSchema,
    /** Object id of the blob (the tree for "tree", the gitlinked commit for a submodule "commit"). */
    blob: GitObjectIdSchema,
    object: z.enum(['blob', 'tree', 'commit']).default('blob'),
    lines: z
      .object({ start: z.number().int().min(1), end: z.number().int().min(1) })
      .refine((l) => l.end >= l.start, 'line range end is before its start')
      .optional(),
  })
  .strict();
export type FactSource = z.infer<typeof FactSourceSchema>;

/**
 * True if any object in the value has an OWN key named __proto__. Zod and plain assignment would
 * silently drop or reinterpret such a key (it would set a prototype), so it is refused before parsing.
 */
export function hasUnsafeKey(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((v) => hasUnsafeKey(v, seen));
  if (Object.prototype.hasOwnProperty.call(value, '__proto__')) return true;
  return Object.values(value).some((v) => hasUnsafeKey(v, seen));
}

export function assertNoUnsafeKeys(value: unknown): void {
  if (hasUnsafeKey(value)) throw new Error('snapshot data contains a "__proto__" key, which is refused');
}

export const FactCategorySchema = z.enum([
  'layout',
  'workspace',
  'package',
  'entry-point',
  'script',
  'command',
  'language',
  'version',
]);
export type FactCategory = z.infer<typeof FactCategorySchema>;

export const ContextFactSchema = z
  .object({
    /** Stable identity, used to diff snapshots. */
    key: z.string().min(1),
    category: FactCategorySchema,
    statement: z.string().min(1),
    data: z.record(z.string(), z.json()).optional(),
    source: FactSourceSchema,
  })
  .strict();
export type ContextFact = z.infer<typeof ContextFactSchema>;

export const DependencySectionSchema = z.enum([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);

export const InstalledStatusSchema = z.enum([
  'locked',
  'workspace-link',
  'not-in-lockfile',
  'lockfile-not-parsed',
  'no-lockfile',
]);

/** Declared (manifest) and installed (lockfile) versions are reported separately; never merged. */
export const DependencyFactSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    /** Directory of the package that declares it ("." for the root). */
    workspace: z.string().min(1),
    section: DependencySectionSchema,
    declared: z.object({ spec: z.string(), source: FactSourceSchema }).strict(),
    installed: z
      .object({ version: z.string().min(1), lockfile: z.string().min(1), source: FactSourceSchema })
      .strict()
      .optional(),
    installedStatus: InstalledStatusSchema,
    /** Only "match" or "mismatch" when it could be decided; otherwise "unchecked". */
    relation: z.enum(['match', 'mismatch', 'unchecked']),
    statement: z.string().min(1),
  })
  .strict()
  .superRefine((d, ctx) => {
    const hasInstalled = d.installed !== undefined;
    if ((d.installedStatus === 'locked' || d.installedStatus === 'workspace-link') !== hasInstalled) {
      ctx.addIssue({ code: 'custom', message: 'installed version must be present exactly when the status is locked/workspace-link' });
    }
    if (d.relation !== 'unchecked' && d.installedStatus !== 'locked') {
      ctx.addIssue({ code: 'custom', message: 'relation can only be decided for a locked version' });
    }
  });
export type DependencyFact = z.infer<typeof DependencyFactSchema>;

export const ConventionSchema = z
  .object({
    key: z.string().min(1),
    topic: z.string().min(1),
    status: z.enum(['confirmed', 'unconfirmed']),
    statement: z.string().min(1),
    /** "config": a config file sets it. "count": measured over tracked files. */
    basis: z.enum(['config', 'count']),
    measured: z
      .object({
        matched: z.number().int().min(0),
        total: z.number().int().min(0),
        /** True only if every tracked file in scope was examined. */
        exhaustive: z.boolean(),
        scope: z.string().min(1),
      })
      .strict()
      .optional(),
    /** A few places that do not follow it (unconfirmed counts only). */
    counterexamples: z.array(FactSourceSchema).max(3).default([]),
    source: FactSourceSchema,
  })
  .strict()
  .superRefine((c, ctx) => {
    // Counterexamples only make sense for a measured convention that is NOT confirmed.
    if (c.counterexamples.length > 0 && !(c.basis === 'count' && c.status === 'unconfirmed')) {
      ctx.addIssue({ code: 'custom', message: 'only an unconfirmed counted convention can list counterexamples' });
    }
    if (c.basis === 'config') {
      if (c.status !== 'confirmed') ctx.addIssue({ code: 'custom', message: 'a config-enforced convention is confirmed' });
      return;
    }
    if (!c.measured) {
      ctx.addIssue({ code: 'custom', message: 'a counted convention must carry its counts' });
      return;
    }
    const { matched, total, exhaustive } = c.measured;
    if (matched > total) ctx.addIssue({ code: 'custom', message: 'matched is larger than total' });
    const full = exhaustive && total > 0 && matched === total;
    if (c.status === 'confirmed' && !full) {
      ctx.addIssue({ code: 'custom', message: 'confirmed needs an exhaustive count of 100%' });
    }
    if (c.status === 'unconfirmed' && full) {
      ctx.addIssue({ code: 'custom', message: 'an exhaustive 100% count must be confirmed' });
    }
  });
export type Convention = z.infer<typeof ConventionSchema>;

/** Something Turbine could not prove (e.g. a lockfile format it does not parse). Never a fact. */
export const UnconfirmedItemSchema = z
  .object({
    key: z.string().min(1),
    statement: z.string().min(1),
    reason: z.string().min(1),
    source: FactSourceSchema,
  })
  .strict();
export type UnconfirmedItem = z.infer<typeof UnconfirmedItemSchema>;

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** Everything in a snapshot except its own hash. No timestamps: the same commit gives the same body. */
export const RepoSnapshotBodySchema = z
  .object({
    schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
    commit: GitObjectIdSchema,
    tree: GitObjectIdSchema,
    facts: z.array(ContextFactSchema),
    dependencies: z.array(DependencyFactSchema),
    conventions: z.array(ConventionSchema),
    unconfirmed: z.array(UnconfirmedItemSchema),
  })
  .strict();
export type RepoSnapshotBody = z.infer<typeof RepoSnapshotBodySchema>;

export function snapshotHash(body: RepoSnapshotBody): string {
  return contentHash(body);
}

export const RepoSnapshotSchema = RepoSnapshotBodySchema.extend({
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).superRefine((s, ctx) => {
  const { hash, ...body } = s;
  if (snapshotHash(body) !== hash) {
    ctx.addIssue({ code: 'custom', message: 'snapshot hash does not match its content (edited or corrupt)' });
  }
  const seen = new Set<string>();
  const sources: Array<{ where: string; commit: string }> = [];
  for (const f of s.facts) sources.push({ where: f.key, commit: f.source.commit });
  for (const d of s.dependencies) {
    sources.push({ where: d.key, commit: d.declared.source.commit });
    if (d.installed) sources.push({ where: d.key, commit: d.installed.source.commit });
  }
  for (const c of s.conventions) {
    sources.push({ where: c.key, commit: c.source.commit });
    for (const e of c.counterexamples) sources.push({ where: c.key, commit: e.commit });
  }
  for (const u of s.unconfirmed) sources.push({ where: u.key, commit: u.source.commit });
  for (const { where, commit } of sources) {
    if (commit !== s.commit) ctx.addIssue({ code: 'custom', message: `${where} has a source at ${commit}, not at the snapshot commit ${s.commit}` });
  }
  for (const key of [...s.facts, ...s.dependencies, ...s.conventions, ...s.unconfirmed].map((x) => x.key)) {
    if (seen.has(key)) ctx.addIssue({ code: 'custom', message: `duplicate key ${key}` });
    seen.add(key);
  }
});
export type RepoSnapshot = z.infer<typeof RepoSnapshotSchema>;

/** Order every list by key so the same facts always serialise (and hash) the same way. */
export function sealSnapshot(body: RepoSnapshotBody): RepoSnapshot {
  assertNoUnsafeKeys(body);
  const byKey = <T extends { key: string }>(xs: T[]): T[] => [...xs].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const parsed = RepoSnapshotBodySchema.parse({
    ...body,
    facts: byKey(body.facts),
    dependencies: byKey(body.dependencies),
    conventions: byKey(body.conventions),
    unconfirmed: byKey(body.unconfirmed),
  });
  return RepoSnapshotSchema.parse({ ...parsed, hash: snapshotHash(parsed) });
}

export const SnapshotDiffSchema = z.object({
  added: z.array(z.object({ key: z.string(), statement: z.string() })),
  removed: z.array(z.object({ key: z.string(), statement: z.string() })),
  changed: z.array(z.object({ key: z.string(), before: z.string(), after: z.string() })),
});
export type SnapshotDiff = z.infer<typeof SnapshotDiffSchema>;

/** First 8 hex characters of a snapshot hash, for display. */
export function shortSnapshotId(hash: string): string {
  return hash.replace(/^sha256:/, '').slice(0, 8);
}
