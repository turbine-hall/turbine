import { z } from 'zod';

/**
 * Repository context, layer 3: task context (the files relevant to ONE task).
 *
 * A selection is a ranked, size-limited list of files. It is never a complete list. Every file carries
 * at least one reason, and every reason is structured evidence that can be re-checked against the commit
 * it was built at:
 *   - an import edge  → {file, line, statement, specifier, resolved target, resolution rule};
 *   - a request quote → {quote, offset} where request.slice(offset, offset + quote.length) === quote;
 *   - a stated rule   → the rule's name and the facts it was applied to.
 * The text shown to people is rendered FROM this evidence (never stored), so the two cannot drift.
 */

/** Size limit for one selection. A role may declare its own; DEFAULT_CONTEXT_BUDGET applies otherwise. */
export const ContextBudgetSchema = z
  .object({
    /** Most files listed. */
    maxFiles: z.number().int().min(1).max(200),
    /** Most characters the rendered file list may take (what an agent has to read). */
    maxChars: z.number().int().min(500).max(100_000),
  })
  .strict();
export type ContextBudget = z.infer<typeof ContextBudgetSchema>;

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = { maxFiles: 20, maxChars: 8000 };

export const ImportKindSchema = z.enum(['import', 'import-type', 'side-effect', 're-export', 'dynamic', 'require']);
export type ImportKind = z.infer<typeof ImportKindSchema>;

/** A resolved import edge read from a blob at the commit. `statement` is the exact source text (LF line ends). */
export const ImportEdgeSchema = z
  .object({
    from: z.string().min(1),
    line: z.number().int().min(1),
    statement: z.string().min(1),
    specifier: z.string(),
    kind: ImportKindSchema,
    to: z.string().min(1),
    /** How the specifier was resolved to `to` (the rule, stated). */
    resolution: z.string().min(1),
  })
  .strict();
export type ImportEdge = z.infer<typeof ImportEdgeSchema>;

const PackageRefSchema = z.object({ dir: z.string().min(1), name: z.string().optional() }).strict();

export const ReasonSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('named-in-request'),
      points: z.number().min(0),
      rule: z.enum(['exact-path', 'path-suffix', 'unique-basename', 'shared-basename']),
      quote: z.string().min(1),
      offset: z.number().int().min(0),
      /** How many tracked files this text could mean (1 unless it is a shared basename). */
      sharedBy: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('exports-symbol'),
      points: z.number().min(0),
      symbol: z.string().min(1),
      rule: z.enum(['distinctive-name', 'code-span']),
      /** Where the file exports it. */
      line: z.number().int().min(1),
      statement: z.string().min(1),
      /** Where the request mentions it. */
      quote: z.string().min(1),
      offset: z.number().int().min(0),
    })
    .strict(),
  /** This file imports `seed`. */
  z.object({ kind: z.literal('imports'), points: z.number().min(0), seed: z.string().min(1), edge: ImportEdgeSchema }).strict(),
  /** `seed` imports this file. */
  z.object({ kind: z.literal('imported-by'), points: z.number().min(0), seed: z.string().min(1), edge: ImportEdgeSchema }).strict(),
  z
    .object({
      kind: z.literal('test-for'),
      points: z.number().min(0),
      subject: z.string().min(1),
      rule: z.enum(['imports', 'naming']),
      edge: ImportEdgeSchema.optional(),
      /** The naming rule applied (stated), for rule "naming". */
      naming: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('owner'),
      points: z.number().min(0),
      package: PackageRefSchema,
      /** A file named in the request that lives in the same package. */
      sharesWith: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('codeowners'),
      points: z.number().min(0),
      file: z.string().min(1),
      line: z.number().int().min(1),
      rule: z.string().min(1),
      owners: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('owner-manifest'),
      points: z.number().min(0),
      package: PackageRefSchema,
      ownerOf: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('path-words'),
      points: z.number().min(0),
      words: z.array(z.object({ word: z.string().min(1), files: z.number().int().min(1), of: z.number().int().min(1) }).strict()).min(1),
      weight: z.number().min(0),
    })
    .strict(),
]);
export type Reason = z.infer<typeof ReasonSchema>;
export type ReasonKind = Reason['kind'];

/** A file in the selection. At least one reason: a file without one is not listed. */
export const RelevantFileSchema = z
  .object({
    path: z.string().min(1),
    score: z.number().min(0),
    reasons: z.array(ReasonSchema).min(1),
  })
  .strict();
export type RelevantFile = z.infer<typeof RelevantFileSchema>;

export const OmittedFileSchema = RelevantFileSchema.extend({ why: z.enum(['maxFiles', 'maxChars']) }).strict();
export type OmittedFile = z.infer<typeof OmittedFileSchema>;

export const SelectionTriggerSchema = z.enum([
  'initial',
  'base-commit-changed',
  'snapshot-changed',
  'changes-requested',
  'budget-changed',
  'request-changed',
  'method-changed',
]);
export type SelectionTrigger = z.infer<typeof SelectionTriggerSchema>;

export const SelectionLimitsSchema = z
  .object({
    sourceFiles: z.number().int().min(0),
    sourceFilesScanned: z.number().int().min(0),
    notScannedTooLarge: z.number().int().min(0),
    notScannedOverCap: z.number().int().min(0),
    /** Source files that could not be parsed exactly (a syntax error, or nested too deeply): no import or export is stated for them. */
    unreadable: z.array(z.string()).max(50),
    unreadableTotal: z.number().int().min(0),
    /** Manifests, tsconfig files and CODEOWNERS that were not read (over the size limit or the metadata budget). */
    metadataNotRead: z.number().int().min(0).default(0),
    /** `require()` calls found but not stated, because `require` is bound in the file and may not be the loader. */
    statementsUnconfirmed: z.number().int().min(0).default(0),
    unresolvedRelative: z.number().int().min(0),
    unresolvedPackage: z.number().int().min(0),
    seeds: z.number().int().min(0),
    seedsUsedForHops: z.number().int().min(0),
    hopsTruncated: z.number().int().min(0),
    testsTruncated: z.number().int().min(0),
    codeowners: z.string().optional(),
    codeownersRulesSkipped: z.number().int().min(0),
  })
  .strict();
export type SelectionLimits = z.infer<typeof SelectionLimitsSchema>;

export const SelectionChangesSchema = z
  .object({
    fromCommit: z.string(),
    toCommit: z.string(),
    added: z.array(z.object({ path: z.string(), score: z.number() }).strict()),
    removed: z.array(z.object({ path: z.string(), score: z.number() }).strict()),
    rescored: z.array(z.object({ path: z.string(), from: z.number(), to: z.number() }).strict()),
    /** Files of the previous selection that git reports as changed between the two commits. */
    gitChanged: z.array(z.object({ path: z.string(), status: z.string() }).strict()).optional(),
    /** Why `gitChanged` is missing (for example the old commit is no longer in the repository). */
    gitUnavailable: z.string().optional(),
  })
  .strict();
export type SelectionChanges = z.infer<typeof SelectionChangesSchema>;

export const TASK_CONTEXT_SCHEMA_VERSION = 1;

export const TaskContextSchema = z
  .object({
    schemaVersion: z.literal(TASK_CONTEXT_SCHEMA_VERSION),
    /** Version of the ranking rules; a different version rebuilds the selection. */
    methodVersion: z.number().int().min(1),
    workId: z.string().min(1),
    /** The Layer 1 snapshot this selection is bound to. */
    snapshot: z.object({ hash: z.string().regex(/^sha256:[0-9a-f]{64}$/), commit: z.string().min(7) }).strict(),
    request: z.object({ hash: z.string().min(1), chars: z.number().int().min(0) }).strict(),
    budget: ContextBudgetSchema.extend({
      source: z.enum(['default', 'roles']),
      roles: z.array(z.string()),
    }).strict(),
    trigger: SelectionTriggerSchema,
    /** How many times the task has entered CHANGES_REQUESTED when this was built. */
    changesCycle: z.number().int().min(0),
    files: z.array(RelevantFileSchema),
    /** Candidates the size limit left out, best first. `omittedTotal` counts all of them. */
    omitted: z.array(OmittedFileSchema),
    omittedTotal: z.number().int().min(0),
    /** Files that had at least one reason, before the size limit. */
    candidates: z.number().int().min(0),
    limits: SelectionLimitsSchema,
    changes: SelectionChangesSchema.optional(),
  })
  .strict();
export type TaskContext = z.infer<typeof TaskContextSchema>;

/** Stored artifacts are plain JSON, so a stored selection is re-validated when read. */
export function parseTaskContext(raw: string): TaskContext | undefined {
  try {
    const parsed = TaskContextSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
