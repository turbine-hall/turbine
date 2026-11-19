import type * as TS from 'typescript';
import { ClaimSchema, manifestPath } from '@turbine-hall/turbine-contracts';
import type { AbsencePattern, Claim, ClaimEvidence, ClaimVerifier } from '@turbine-hall/turbine-contracts';
import { listTreeDetailed, readBlobs, resolveCommit } from './git-read.js';
import type { TreeEntry, TreeListing } from './git-read.js';
import { jsxFile, parseSource, scanModule } from './js-scan.js';
import { parseJsonc } from './jsonc.js';
import type { LineRange } from './jsonc.js';

/**
 * Layer 2 verifiers: the ONLY code that decides whether a claim is true.
 *
 * A verifier reads from one commit's git objects (ls-tree and one `git cat-file --batch` per read), never from the
 * working tree and never from the index, so a file that exists only in an uncommitted change cannot prove a claim.
 * Every verifier returns `{ ok, reason }`; `reason` says what was found (or what was not). A verifier is built to be
 * sure rather than complete: whenever it cannot examine something it needs, the answer is `ok: false`
 * (with `unconfirmed: true` when the reason is "could not look", not "looked and it is false").
 *
 * What a verifier proves is what the verifier says, not what the claim's free-text statement says:
 *   - `calls` matches the callee NAME as written at a call site (`foo(...)`, `a.b.c(...)`); no binding is resolved,
 *     so an alias or a shadowing local with the same name still matches;
 *   - `absence` supports exactly two patterns, `literal` and `import-specifier`, which are byte searches over every
 *     tracked file (or every JavaScript / TypeScript source file). It refuses, and proves nothing, when any file in
 *     scope cannot be examined. An escaped, computed or encoded occurrence is not a literal occurrence.
 */

export type VerifyResult = { ok: true; reason: string } | { ok: false; reason: string; /** The verifier could not look, as opposed to having looked and found the claim false. */ unconfirmed?: true };

/**
 * `pinned`: the claim's recorded blobs and commit must equal what this commit holds (initial publication).
 * `rebind`: the claim is being carried from an earlier commit to this one: the recorded blobs may differ, but every
 * line, quote, name and value must still be proven here.
 */
export type VerifyMode = 'pinned' | 'rebind';

/** One text file read for evidence, quote or parsing. */
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
/** One file in an exhaustive search. A larger file cannot be examined, so the search refuses. */
const MAX_SEARCH_FILE_BYTES = 32 * 1024 * 1024;
/** The whole tree in an exhaustive search. */
const MAX_SEARCH_TOTAL_BYTES = 512 * 1024 * 1024;
const SEARCH_BATCH_BYTES = 48 * 1024 * 1024;
const MAX_REPORTED_MATCHES = 5;

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const fail = (reason: string): VerifyResult => ({ ok: false, reason });
const unconfirmed = (reason: string): VerifyResult => ({ ok: false, reason, unconfirmed: true });
const pass = (reason: string): VerifyResult => ({ ok: true, reason });

/** Lines as the parsers here count them: LF, CRLF and a bare CR each end a line. A leading byte order mark is not text. */
export function splitLines(text: string): string[] {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\r|\n/);
}

type Text = { ok: true; text: string } | { ok: false; reason: string };

/** One commit, read through git only. Trees and blobs are cached for the life of the reader. */
export class CommitReader {
  readonly commit: string;
  private listing: TreeListing | undefined;
  private byPath: Map<string, TreeEntry> | undefined;
  private readonly blobs = new Map<string, Buffer>();

  constructor(
    readonly repoRoot: string,
    commit: string,
  ) {
    // A branch name or an abbreviated id would move or be ambiguous: only the full id of a commit is a pin.
    if (resolveCommit(repoRoot, commit) !== commit) throw new Error(`${commit} is not a commit of this repository (a full commit id is required)`);
    this.commit = commit;
  }

  tree(): TreeListing {
    return (this.listing ??= listTreeDetailed(this.repoRoot, this.commit));
  }

  entry(path: string): TreeEntry | undefined {
    if (!this.byPath) this.byPath = new Map(this.tree().entries.map((e) => [e.path, e]));
    return this.byPath.get(path);
  }

  /** The bytes of a tracked file at this commit, or why they cannot be used. */
  bytes(path: string, maxBytes = MAX_TEXT_BYTES): { ok: true; entry: TreeEntry; buf: Buffer } | { ok: false; reason: string } {
    const entry = this.entry(path);
    if (!entry) return { ok: false, reason: `${path} is not tracked at commit ${this.commit.slice(0, 12)}` };
    if (entry.type !== 'blob') return { ok: false, reason: `${path} is a ${entry.type}, not a file` };
    if (entry.size > maxBytes) return { ok: false, reason: `${path} is ${entry.size} bytes, over the ${maxBytes}-byte limit for reading it` };
    let buf = this.blobs.get(entry.id);
    if (!buf) {
      buf = readBlobs(this.repoRoot, [entry.id], entry.size).get(entry.id);
      if (!buf) return { ok: false, reason: `${path} could not be read from git` };
      this.blobs.set(entry.id, buf);
    }
    return { ok: true, entry, buf };
  }

  /** The file as UTF-8 text. A file that is not valid UTF-8, or has a NUL byte, is not text. */
  text(path: string): Text {
    const b = this.bytes(path);
    if (!b.ok) return b;
    if (b.buf.includes(0)) return { ok: false, reason: `${path} is not a text file (it contains a NUL byte)` };
    try {
      return { ok: true, text: UTF8.decode(b.buf) };
    } catch {
      return { ok: false, reason: `${path} is not valid UTF-8` };
    }
  }
}

const inLines = (lines: Array<{ start: number; end: number }>, from: number, to = from): boolean => lines.some((l) => from >= l.start && to <= l.end);

/** The cited line ranges of every evidence item for a path. */
const citedLines = (claim: Claim, path: string): Array<{ start: number; end: number }> =>
  claim.evidence.filter((e) => e.path === path && e.lines).map((e) => e.lines!);

/** Evidence, checked against the commit: it exists, is pinned (initial publication), and its lines and quote are right. */
function verifyEvidence(reader: CommitReader, e: ClaimEvidence, mode: VerifyMode): VerifyResult | undefined {
  const at = e.lines ? `${e.path}:${e.lines.start}-${e.lines.end}` : e.path;
  const entry = reader.entry(e.path);
  if (!entry) return fail(`${e.path} is not tracked at commit ${reader.commit.slice(0, 12)}`);
  if (entry.type !== 'blob') return fail(`${e.path} is a ${entry.type}, not a file`);
  if (mode === 'pinned' && e.commit !== reader.commit) return fail(`the evidence for ${e.path} names commit ${e.commit.slice(0, 12)}, not ${reader.commit.slice(0, 12)}`);
  if (mode === 'pinned' && e.blob !== entry.id) return fail(`the evidence blob ${e.blob.slice(0, 12)} for ${e.path} is stale: the file at this commit is ${entry.id.slice(0, 12)}`);
  if (!e.lines) return undefined;
  const t = reader.text(e.path);
  if (!t.ok) return unconfirmed(t.reason);
  const lines = splitLines(t.text);
  if (e.lines.end > lines.length) return fail(`${at} is past the end of the file (${lines.length} line(s))`);
  if (e.quote === undefined) return undefined;
  const found = lines.slice(e.lines.start - 1, e.lines.end).join('\n');
  if (!found.includes(e.quote)) return fail(`the quote is not on ${at}`);
  return undefined;
}

type Parsed = { ok: true; value: unknown; lines: (path: Array<string | number>) => LineRange | undefined } | { ok: false; result: VerifyResult };

function readJson(reader: CommitReader, path: string): Parsed {
  if (!/\.jsonc?$/.test(path)) return { ok: false, result: unconfirmed(`${path} is not a .json or .jsonc file, so its values cannot be read exactly`) };
  const t = reader.text(path);
  if (!t.ok) return { ok: false, result: unconfirmed(t.reason) };
  try {
    const j = parseJsonc(t.text);
    return { ok: true, value: j.value, lines: (p) => j.lines(p) };
  } catch (e) {
    return { ok: false, result: fail(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`) };
  }
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** The value at a key path, following own properties only. */
function valueAt(root: unknown, key: ReadonlyArray<string | number>): { found: true; value: unknown } | { found: false } {
  let cur = root;
  for (const k of key) {
    if (typeof k === 'number') {
      if (!Array.isArray(cur) || k >= cur.length) return { found: false };
      cur = cur[k];
    } else {
      if (typeof cur !== 'object' || cur === null || Array.isArray(cur) || !own(cur, k)) return { found: false };
      cur = (cur as Record<string, unknown>)[k];
    }
  }
  return { found: true, value: cur };
}

/** Deep equality of two JSON values. Object key order does not matter; only own keys count (a "__proto__" key is data). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => own(b, k) && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const keyText = (key: ReadonlyArray<string | number>) => key.map((k) => (typeof k === 'number' ? `[${k}]` : `.${k}`)).join('').replace(/^\./, '');

function verifyExists(reader: CommitReader, claim: Claim, v: Extract<ClaimVerifier, { kind: 'exists' }>): VerifyResult {
  const entry = reader.entry(v.path);
  if (!entry || entry.type !== 'blob') return fail(`${v.path} is not a tracked file at commit ${reader.commit.slice(0, 12)}`);
  if (v.symbol === undefined) return pass(`${v.path} is tracked at commit ${reader.commit.slice(0, 12)} (blob ${entry.id.slice(0, 12)})`);
  const t = reader.text(v.path);
  if (!t.ok) return unconfirmed(t.reason);
  const scan = scanModule(t.text, { jsx: jsxFile(v.path) });
  if (!scan.ok) return unconfirmed(`${v.path} cannot be parsed: ${scan.reason}`);
  const cited = citedLines(claim, v.path);
  const hit = scan.exports.find((x) => x.name === v.symbol && inLines(cited, x.line));
  if (hit) return pass(`${v.path} exports "${v.symbol}" at line ${hit.line}`);
  const elsewhere = scan.exports.find((x) => x.name === v.symbol);
  return fail(elsewhere ? `${v.path} exports "${v.symbol}" at line ${elsewhere.line}, outside the cited lines` : `${v.path} has no top-level export named "${v.symbol}"`);
}

function verifyImports(reader: CommitReader, claim: Claim, v: Extract<ClaimVerifier, { kind: 'imports' }>): VerifyResult {
  const t = reader.text(v.from);
  if (!t.ok) return unconfirmed(t.reason);
  const scan = scanModule(t.text, { jsx: jsxFile(v.from) });
  // The compiler API decides what is an import. A file that does not parse proves nothing.
  if (!scan.ok) return unconfirmed(`${v.from} cannot be parsed: ${scan.reason}`);
  const cited = citedLines(claim, v.from);
  const matches = scan.imports.filter((i) => i.specifier === v.specifier);
  const hit = matches.find((i) => inLines(cited, i.line));
  if (hit) return pass(`${v.from} imports "${v.specifier}" (${hit.kind}) at line ${hit.line}`);
  return fail(matches.length ? `${v.from} imports "${v.specifier}" at line ${matches.map((m) => m.line).join(', ')}, outside the cited lines` : `${v.from} does not import "${v.specifier}"`);
}

/** The file imports the package: its name exactly, or a path inside it. */
function verifyUse(reader: CommitReader, claim: Claim, path: string, name: string): VerifyResult {
  const t = reader.text(path);
  if (!t.ok) return unconfirmed(t.reason);
  const scan = scanModule(t.text, { jsx: jsxFile(path) });
  if (!scan.ok) return unconfirmed(`${path} cannot be parsed: ${scan.reason}`);
  const cited = citedLines(claim, path);
  const uses = scan.imports.filter((i) => i.specifier === name || i.specifier.startsWith(`${name}/`));
  const hit = uses.find((i) => inLines(cited, i.line));
  if (hit) return pass(`${path} imports "${hit.specifier}" at line ${hit.line}`);
  return fail(uses.length ? `${path} imports ${name} at line ${uses.map((m) => m.line).join(', ')}, outside the cited lines` : `${path} does not import ${name}`);
}

function verifyCalls(reader: CommitReader, claim: Claim, v: Extract<ClaimVerifier, { kind: 'calls' }>): VerifyResult {
  const t = reader.text(v.path);
  if (!t.ok) return unconfirmed(t.reason);
  const parsed = parseSource(t.text, { jsx: jsxFile(v.path) });
  if (!parsed.ok) return unconfirmed(`${v.path} cannot be parsed: ${parsed.reason}`);
  const { ts, sf, lineAt } = parsed;
  /** `a`, `a.b.c`, `this.x`: the dotted name written at the call. Anything computed has no name. */
  const nameOf = (n: TS.Expression): string | undefined => {
    if (ts.isIdentifier(n)) return n.text;
    if (n.kind === ts.SyntaxKind.ThisKeyword) return 'this';
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name)) {
      const base = nameOf(n.expression);
      return base === undefined ? undefined : `${base}.${n.name.text}`;
    }
    return undefined;
  };
  const cited = citedLines(claim, v.path);
  const lines: number[] = [];
  // An explicit stack, so the walk itself cannot overflow however deep the (already parsed) tree is.
  const stack: TS.Node[] = [sf];
  while (stack.length) {
    const n = stack.pop()!;
    if (ts.isCallExpression(n) && nameOf(n.expression) === v.callee) lines.push(lineAt(n.getStart(sf)));
    ts.forEachChild(n, (c) => {
      stack.push(c);
    });
  }
  lines.sort((a, b) => a - b);
  const hit = lines.find((l) => inLines(cited, l));
  if (hit !== undefined) return pass(`${v.path} calls ${v.callee}(...) at line ${hit} (matched by name; no binding is resolved)`);
  return fail(lines.length ? `${v.path} calls ${v.callee}(...) at line ${lines.join(', ')}, outside the cited lines` : `${v.path} has no call written as ${v.callee}(...)`);
}

/** A manifest or config member must hold the expected value, and sit inside the lines the evidence cites. */
function verifyMember(reader: CommitReader, claim: Claim, path: string, key: ReadonlyArray<string | number>, expected: unknown, what: string): VerifyResult {
  const json = readJson(reader, path);
  if (!json.ok) return json.result;
  const at = valueAt(json.value, key);
  if (!at.found) return fail(`${path} has no ${what} at ${keyText(key)}`);
  if (!jsonEqual(at.value, expected)) return fail(`${path} ${keyText(key)} is ${JSON.stringify(at.value)}, not ${JSON.stringify(expected)}`);
  const range = json.lines([...key]);
  if (!range) return unconfirmed(`the lines of ${keyText(key)} in ${path} are unknown`);
  if (!inLines(citedLines(claim, path), range.start, range.end)) return fail(`${keyText(key)} in ${path} is on lines ${range.start}-${range.end}, outside the cited lines`);
  return pass(`${path} ${keyText(key)} is ${JSON.stringify(expected)} (lines ${range.start}-${range.end})`);
}

/** The bytes of the quoted forms a specifier can take in source. */
function needlesFor(pattern: AbsencePattern): Buffer[] {
  const texts = pattern.type === 'literal' ? [pattern.text] : ["'", '"', '`'].map((q) => `${q}${pattern.specifier}${q}`);
  return texts.flatMap((t) => {
    const utf8 = Buffer.from(t, 'latin1'); // printable ASCII only, so latin1 bytes are its UTF-8 bytes
    const le = Buffer.alloc(utf8.length * 2);
    const be = Buffer.alloc(utf8.length * 2);
    utf8.forEach((b, i) => {
      le[i * 2] = b;
      be[i * 2 + 1] = b;
    });
    return [utf8, le, be];
  });
}

const excluded = (path: string, prefixes: readonly string[]): boolean => prefixes.some((p) => (p.endsWith('/') ? path.startsWith(p) || path === p.slice(0, -1) : path === p));

function verifyAbsence(reader: CommitReader, v: Extract<ClaimVerifier, { kind: 'absence' }>): VerifyResult {
  const listing = reader.tree();
  if (listing.undecodable > 0) return unconfirmed(`${listing.undecodable} tracked path(s) are not valid UTF-8 and cannot be searched, so absence cannot be shown`);
  const scope: TreeEntry[] = [];
  for (const e of listing.entries) {
    if (excluded(e.path, v.exclude)) continue;
    if (v.pattern.type === 'import-specifier' && !SOURCE_EXTENSION.test(e.path)) continue;
    if (e.type !== 'blob') return unconfirmed(`${e.path} is a ${e.type} (a submodule), whose files are not in this commit, so absence cannot be shown`);
    if (e.size > MAX_SEARCH_FILE_BYTES) return unconfirmed(`${e.path} is ${e.size} bytes, over the ${MAX_SEARCH_FILE_BYTES}-byte search limit, so absence cannot be shown`);
    scope.push(e);
  }
  if (!scope.length) return unconfirmed('no file is in the scope of this search, so absence would be vacuous');
  const total = scope.reduce((n, e) => n + e.size, 0);
  if (total > MAX_SEARCH_TOTAL_BYTES) return unconfirmed(`the files in scope are ${total} bytes, over the ${MAX_SEARCH_TOTAL_BYTES}-byte search limit, so absence cannot be shown`);

  const needles = needlesFor(v.pattern);
  const pathsOf = new Map<string, string[]>();
  for (const e of scope) pathsOf.set(e.id, [...(pathsOf.get(e.id) ?? []), e.path]);
  const sizeOf = new Map(scope.map((e) => [e.id, e.size]));
  const ids = [...pathsOf.keys()];
  const matches: string[] = [];
  for (let i = 0; i < ids.length; ) {
    const batch: string[] = [];
    let bytes = 0;
    while (i < ids.length && (!batch.length || bytes + sizeOf.get(ids[i]!)! <= SEARCH_BATCH_BYTES)) {
      bytes += sizeOf.get(ids[i]!)!;
      batch.push(ids[i++]!);
    }
    const blobs = readBlobs(reader.repoRoot, batch, bytes);
    for (const id of batch) {
      const buf = blobs.get(id);
      const paths = pathsOf.get(id)!;
      if (!buf || buf.length !== sizeOf.get(id)) return unconfirmed(`${paths[0]} could not be read in full, so absence cannot be shown`);
      // UTF-32 is not searched, so a file in it cannot support "absent".
      if (buf.length >= 4 && ((buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0 && buf[3] === 0) || (buf[0] === 0 && buf[1] === 0 && buf[2] === 0xfe && buf[3] === 0xff))) {
        return unconfirmed(`${paths[0]} is UTF-32, which is not searched, so absence cannot be shown`);
      }
      if (needles.some((n) => buf.includes(n))) matches.push(...paths);
    }
  }
  const what = v.pattern.type === 'literal' ? `the text ${JSON.stringify(v.pattern.text)}` : `the specifier ${JSON.stringify(v.pattern.specifier)} in quotes`;
  if (matches.length) {
    matches.sort();
    return fail(`${what} occurs in ${matches.length} file(s): ${matches.slice(0, MAX_REPORTED_MATCHES).join(', ')}${matches.length > MAX_REPORTED_MATCHES ? ', ...' : ''}`);
  }
  const where = v.pattern.type === 'literal' ? 'tracked files' : 'JavaScript / TypeScript source files';
  return pass(`${what} occurs in none of the ${scope.length} ${where} searched (${total} bytes, as UTF-8, UTF-16LE and UTF-16BE)`);
}

/**
 * Decide whether a claim is true at the reader's commit. Never throws for a bad claim or an unreadable file:
 * those are `ok: false`. Only a broken repository (git failing) throws.
 */
export function verifyClaim(reader: CommitReader, input: unknown, mode: VerifyMode = 'pinned'): VerifyResult {
  const parsed = ClaimSchema.safeParse(input);
  if (!parsed.success) return fail(`the claim is not valid: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'claim'}: ${i.message}`).join('; ')}`);
  const claim = parsed.data;
  for (const e of claim.evidence) {
    const bad = verifyEvidence(reader, e, mode);
    if (bad) return bad;
  }
  const v = claim.verifier;
  switch (v.kind) {
    case 'exists':
      return verifyExists(reader, claim, v);
    case 'quote':
      // The evidence check above IS the proof: every cited quote is on exactly its cited lines of its blob.
      return pass(`${claim.evidence.length} quote(s) found on the cited lines`);
    case 'imports':
      return verifyImports(reader, claim, v);
    case 'calls':
      return verifyCalls(reader, claim, v);
    case 'config':
      return verifyMember(reader, claim, v.path, v.key, v.value, 'member');
    case 'dependency': {
      const declared = verifyMember(reader, claim, manifestPath(v.workspace), [v.section, v.name], v.spec, 'dependency');
      if (!declared.ok || v.usedIn === undefined) return declared;
      const used = verifyUse(reader, claim, v.usedIn, v.name);
      return used.ok ? pass(`${declared.reason}; ${used.reason}`) : used;
    }
    case 'command':
      return verifyMember(reader, claim, manifestPath(v.workspace), ['scripts', v.script], v.command, 'script');
    case 'absence':
      return verifyAbsence(reader, v);
  }
}
