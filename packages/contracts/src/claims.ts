import { z } from 'zod';
import { DependencySectionSchema, GitObjectIdSchema, assertNoUnsafeKeys } from './context.js';

/**
 * Repository context, layer 2: claims.
 *
 * The project brief is made of CLAIMS, not prose. A claim is one statement plus the evidence and the
 * deterministic verifier that can prove it at ONE commit. These schemas enforce what can be enforced
 * without reading the repository:
 *   - a claim of an unknown kind does not parse, and neither does a claim with no evidence;
 *   - the words all / only / never / always / every / none are refused in a statement unless the claim's kind is
 *     exhaustive (an exhaustive kind is one whose verifier searches EVERYTHING, so it can prove a universal);
 *   - every evidence item names the claim's single commit, and the verifier's own inputs are all cited as evidence,
 *     so everything the verifier reads is pinned to a blob.
 * Whether a claim is TRUE is decided only by the verifiers (apps/cli/src/engine/context/verify.ts).
 * The verifier proves what the verifier says; the free-text `statement` is only a label, so the brief must be
 * rendered from the verifier and evidence, never from the statement.
 */

/** What one claim may occupy, as JSON. */
export const MAX_CLAIM_BYTES = 128 * 1024;
/** What the reason stored with a claim may occupy, in UTF-8 bytes. The engine clips far below this. */
export const MAX_CLAIM_REASON_BYTES = 64 * 1024;
/** How deep, and how many values, a claim may have: checked before any recursive validation runs. */
const MAX_CLAIM_DEPTH = 64;
const MAX_CLAIM_NODES = 20_000;

/**
 * A bounded walk over an untrusted claim, run before the schema (which recurses and serialises). It refuses a claim that is
 * too deep, has too many values, or holds more text than a stored claim may (a string's length in UTF-16 units never exceeds
 * its UTF-8 byte length, so a claim that fits is never refused here). The exact serialised-size check stays in the schema.
 */
export function assertClaimBudget(raw: unknown): void {
  let nodes = 0;
  let text = 0;
  // Every value is counted as it is QUEUED, so a very wide array or object is refused after MAX_CLAIM_NODES children, not after all of them.
  const visit = (v: unknown, depth: number, containers: Array<{ v: object; depth: number }>): void => {
    if (++nodes > MAX_CLAIM_NODES) throw new Error(`the claim has more than ${MAX_CLAIM_NODES} values`);
    if (typeof v === 'string') {
      text += v.length;
      if (text > MAX_CLAIM_BYTES) throw new Error(`the claim holds more than ${MAX_CLAIM_BYTES} characters of text`);
    } else if (typeof v === 'object' && v !== null) {
      if (depth >= MAX_CLAIM_DEPTH) throw new Error(`the claim is nested deeper than ${MAX_CLAIM_DEPTH} levels`);
      containers.push({ v, depth });
    }
  };
  const containers: Array<{ v: object; depth: number }> = [];
  visit(raw, 0, containers);
  while (containers.length) {
    const { v, depth } = containers.pop()!;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) visit(v[i], depth + 1, containers);
    } else {
      // `for in` with an own-property test: no list of all the keys or entries is built first.
      for (const k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        text += k.length;
        if (text > MAX_CLAIM_BYTES) throw new Error(`the claim holds more than ${MAX_CLAIM_BYTES} characters of text`);
        visit((v as Record<string, unknown>)[k], depth + 1, containers);
      }
    }
  }
}

export const CLAIM_KINDS = ['exists', 'quote', 'imports', 'calls', 'config', 'dependency', 'command', 'absence'] as const;
export const ClaimKindSchema = z.enum(CLAIM_KINDS);
export type ClaimKind = z.infer<typeof ClaimKindSchema>;

/** Kinds whose verifier examines every tracked file, so they (and only they) can prove a universal statement. */
export const EXHAUSTIVE_CLAIM_KINDS: readonly ClaimKind[] = ['absence'];

export const UNIVERSAL_WORDS = ['all', 'only', 'never', 'always', 'every', 'none'] as const;
const UNIVERSAL = new RegExp(`(?<![\\p{L}\\p{N}_])(${UNIVERSAL_WORDS.join('|')})(?![\\p{L}\\p{N}_])`, 'iu');

/** The universal word in a statement, if any. Compatibility forms (full-width letters) are folded first. */
export function universalWordIn(statement: string): string | undefined {
  return UNIVERSAL.exec(statement.normalize('NFKC'))?.[1]?.toLowerCase();
}

/** A repository-relative path: no absolute path, no `..`, no empty or `.` segment, no backslash or NUL. */
export const SafeRepoPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.includes('\\') && !p.includes('\0') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..'),
    'expected a repository-relative path without "..", "." or empty segments, and without a leading "/", a drive letter or any backslash',
  );

const LinesSchema = z
  .object({ start: z.number().int().min(1), end: z.number().int().min(1) })
  .strict()
  .refine((l) => l.end >= l.start, 'line range end is before its start');

export const ClaimEvidenceSchema = z
  .object({
    path: SafeRepoPathSchema,
    commit: GitObjectIdSchema,
    blob: GitObjectIdSchema,
    lines: LinesSchema.optional(),
    /** Exact text (LF line ends) found on exactly `lines`. A quote needs its lines. */
    quote: z
      .string()
      .min(1)
      .max(2000)
      .refine((q) => !q.includes('\r') && !q.includes('\0'), 'a quote uses LF line ends and has no NUL')
      .refine((q) => q.trim().length > 0, 'a quote is not blank')
      .optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.quote === undefined) return;
    if (!e.lines) {
      ctx.addIssue({ code: 'custom', message: 'a quote must name the lines it is on', path: ['lines'] });
      return;
    }
    const span = e.lines.end - e.lines.start + 1;
    const quoted = e.quote.split('\n').length;
    if (span !== quoted) ctx.addIssue({ code: 'custom', message: `the quote has ${quoted} line(s) but the cited range is ${span}`, path: ['lines'] });
  });
export type ClaimEvidence = z.infer<typeof ClaimEvidenceSchema>;

const Identifier = z.string().max(256).regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, 'expected an identifier');
const Printable = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[\x20-\x7e]+$/, 'expected printable ASCII');

const WorkspaceSchema = z.union([z.literal('.'), SafeRepoPathSchema]).default('.');

export const AbsencePatternSchema = z.discriminatedUnion('type', [
  /** This exact text occurs in no tracked file (searched as UTF-8, UTF-16LE and UTF-16BE bytes). */
  z.object({ type: z.literal('literal'), text: Printable(3, 200).refine((t) => t.trim().length >= 3, 'not blank') }).strict(),
  /** This exact specifier, in quotes, occurs in no JavaScript / TypeScript source file. */
  z
    .object({
      type: z.literal('import-specifier'),
      specifier: Printable(1, 214).regex(/^[^\s'"`]+$/, 'no whitespace or quote characters'),
    })
    .strict(),
]);
export type AbsencePattern = z.infer<typeof AbsencePatternSchema>;

const ExcludePrefixSchema = z
  .string()
  .refine((p) => SafeRepoPathSchema.safeParse(p.endsWith('/') ? p.slice(0, -1) : p).success, 'expected a repository-relative file path, or a directory path ending in "/"');

export const ClaimVerifierSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exists'), path: SafeRepoPathSchema, symbol: Identifier.optional() }).strict(),
  z.object({ kind: z.literal('quote') }).strict(),
  z.object({ kind: z.literal('imports'), from: SafeRepoPathSchema, specifier: z.string().min(1).max(1024) }).strict(),
  z
    .object({
      kind: z.literal('calls'),
      path: SafeRepoPathSchema,
      /** A name as written at the call: `foo` or `a.b.c`. Matched by name; no binding is resolved. */
      callee: z.string().max(512).regex(/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/, 'expected a dotted name'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('config'),
      path: SafeRepoPathSchema,
      key: z.array(z.union([z.string().max(256), z.number().int().min(0)])).min(1).max(32),
      value: z.json().refine((v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= 65536, 'the expected value is over 64 KiB'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dependency'),
      workspace: WorkspaceSchema,
      section: DependencySectionSchema,
      name: z.string().min(1).max(214),
      spec: z.string().min(1).max(512),
      /** A source file that must also import the package (`name` or `name/...`), at lines the evidence cites. */
      usedIn: SafeRepoPathSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('command'), workspace: WorkspaceSchema, script: z.string().min(1).max(214), command: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      kind: z.literal('absence'),
      pattern: AbsencePatternSchema,
      /** Path prefixes (a file, or a directory ending in "/") left out of the search. They are part of the claim. */
      exclude: z.array(ExcludePrefixSchema).max(50).default([]),
    })
    .strict(),
]);
export type ClaimVerifier = z.infer<typeof ClaimVerifierSchema>;

/** The manifest a `dependency` or `command` verifier reads. */
export function manifestPath(workspace: string): string {
  return workspace === '.' ? 'package.json' : `${workspace}/package.json`;
}

/** The file a verifier reads whose lines the evidence must cite (undefined: it reads the whole tree or only the evidence). */
export function verifierPrimaryPath(v: ClaimVerifier): string | undefined {
  switch (v.kind) {
    case 'exists':
      return v.path;
    case 'imports':
      return v.from;
    case 'calls':
    case 'config':
      return v.path;
    case 'dependency':
    case 'command':
      return manifestPath(v.workspace);
    default:
      return undefined;
  }
}

export const ClaimSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'expected 1-64 letters, digits, ".", "_" or "-"'),
    section: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'expected a lower-case section name'),
    statement: z
      .string()
      .min(1)
      .max(500)
      .refine((s) => s.trim().length > 0 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s), 'a statement is one printable line'),
    kind: ClaimKindSchema,
    evidence: z.array(ClaimEvidenceSchema).min(1, 'a claim needs evidence').max(20),
    verifier: ClaimVerifierSchema,
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (message: string, path: Array<string | number> = []) => ctx.addIssue({ code: 'custom', message, path });
    // Every field is bounded on its own; this is the budget for the claim as a whole, which is what is verified and stored.
    if (Buffer.byteLength(JSON.stringify(c), 'utf8') > MAX_CLAIM_BYTES) issue(`the claim is over ${MAX_CLAIM_BYTES} bytes`);
    if (c.verifier.kind !== c.kind) issue(`the verifier is for "${c.verifier.kind}" but the claim is "${c.kind}"`, ['verifier', 'kind']);
    if (!EXHAUSTIVE_CLAIM_KINDS.includes(c.kind)) {
      const word = universalWordIn(c.statement);
      if (word) issue(`the statement says "${word}", which only an exhaustive claim (${EXHAUSTIVE_CLAIM_KINDS.join(', ')}) can prove`, ['statement']);
    }
    // Zod still runs this check when the evidence list itself failed (empty or missing): there is nothing more to check.
    if (!Array.isArray(c.evidence) || !c.evidence.length) return;
    const commit = c.evidence[0]!.commit;
    c.evidence.forEach((e, i) => {
      if (e.commit !== commit) issue('every piece of evidence must name the same commit', ['evidence', i, 'commit']);
    });
    if (c.kind === 'quote') {
      c.evidence.forEach((e, i) => {
        if (e.quote === undefined) issue('a quote claim cites only quoted lines', ['evidence', i, 'quote']);
      });
    }
    if (c.verifier.kind === 'dependency' && c.verifier.usedIn !== undefined) {
      const used = c.verifier.usedIn;
      if (!c.evidence.some((e) => e.path === used && e.lines)) issue(`the verifier reads ${used}, so its lines must be cited as evidence`, ['evidence']);
    }
    const primary = verifierPrimaryPath(c.verifier);
    if (primary !== undefined) {
      const cited = c.evidence.filter((e) => e.path === primary);
      if (!cited.length) issue(`the verifier reads ${primary}, so it must be cited as evidence`, ['evidence']);
      // A symbol-less existence claim needs no lines; everything else points at the lines it is about.
      else if (!(c.verifier.kind === 'exists' && c.verifier.symbol === undefined) && !cited.some((e) => e.lines)) {
        issue(`the evidence for ${primary} must name the lines the claim is about`, ['evidence']);
      }
    }
  });
export type Claim = z.infer<typeof ClaimSchema>;

/** The commit a claim is pinned to (the schema guarantees every evidence item names the same one). */
export function claimCommit(claim: Claim): string {
  return claim.evidence[0]!.commit;
}

/** Parse untrusted claim JSON: a `__proto__` key is refused before the schema sees it. Throws on a bad claim. */
export function parseClaim(raw: unknown): Claim {
  assertClaimBudget(raw);
  assertNoUnsafeKeys(raw);
  return ClaimSchema.parse(raw);
}

export type ClaimParse = { ok: true; claim: Claim } | { ok: false; reason: string };

/**
 * Like `parseClaim`, but a bad claim is an answer, not an exception. A `__proto__` key anywhere in the raw input is
 * refused BEFORE the schema runs (zod would drop it, which would change what the claim says), and an input nested
 * so deeply that parsing it overflows the stack is a refused claim, not a crash.
 */
export function parseClaimSafe(raw: unknown): ClaimParse {
  try {
    assertClaimBudget(raw);
    assertNoUnsafeKeys(raw);
    const r = ClaimSchema.safeParse(raw);
    if (r.success) return { ok: true, claim: r.data };
    return { ok: false, reason: r.error.issues.map((i) => `${i.path.join('.') || 'claim'}: ${i.message}`).join('; ') };
  } catch (e) {
    if (e instanceof RangeError) return { ok: false, reason: 'the claim is nested too deeply to read' };
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export const CLAIM_STATUSES = ['verified', 'rejected', 'withdrawn', 'attested'] as const;
export const ClaimStatusSchema = z.enum(CLAIM_STATUSES);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

/** The statuses under which a claim may appear in the brief. */
export const PUBLISHED_CLAIM_STATUSES: readonly ClaimStatus[] = ['verified', 'attested'];

export const StoredClaimSchema = z
  .object({
    repoPath: z.string().min(1),
    claim: ClaimSchema,
    section: z.string(),
    commit: GitObjectIdSchema,
    status: ClaimStatusSchema,
    reason: z.string().optional(),
    createdAt: z.string(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.section !== s.claim.section) ctx.addIssue({ code: 'custom', message: 'the row section is not the claim section', path: ['section'] });
    if (s.commit !== s.claim.evidence?.[0]?.commit) ctx.addIssue({ code: 'custom', message: 'the row commit is not the claim commit', path: ['commit'] });
    if ((s.status === 'rejected' || s.status === 'withdrawn') && !s.reason?.trim()) {
      ctx.addIssue({ code: 'custom', message: `a ${s.status} claim records why`, path: ['reason'] });
    }
  });
export type StoredClaim = z.infer<typeof StoredClaimSchema>;
