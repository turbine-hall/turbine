import { posix } from 'node:path';
import type { ContextBudget, ImportEdge, OmittedFile, Reason, RelevantFile, SelectionLimits } from '@turbine-hall/turbine-contracts';
import { buildGraph, makeResolver, SOURCE_EXT, type Graph, type WorkspacePackage } from './import-graph.js';
import { jsxFile, scanModule } from './js-scan.js';
import { pathWordMatches } from './path-words.js';

/**
 * Which files matter to ONE task, and why.
 *
 * Ranking signals, strongest first (the points are what a reason adds to a file's score):
 *   1. a path or basename named in the request                      100 / 90 / 70 (shared basename: 70 ÷ files, min 15)
 *   2. an exported symbol the request mentions                      60 (+15 for each further symbol, up to 3)
 *   3. one hop on the import graph from a file of 1 or 2            30
 *   4. a test of a file of 1 or 2 (it imports it, or a naming rule) 25 / 20
 *   5. the package that owns the file; CODEOWNERS when present      5 for a same-package file, a package.json 10, else 0
 *   6. the path-keyword (IDF) match                                 at most 4
 *
 * The output is a SELECTION, never a complete list. Every file has at least one reason and every reason is
 * structured evidence (an import edge, a request quote, or a named rule) that `verifyRelevantFiles` can
 * re-derive from the blobs at the commit. A file with no reason is not listed.
 */

/**
 * Bump when the ranking rules change: stored selections of another version are rebuilt.
 * 2: imports are read with the TypeScript parser; `exports` follows Node's selection; build output needs tsconfig proof.
 */
export const METHOD_VERSION = 2;

const NAMED_EXACT = 100;
const NAMED_SUFFIX = 90;
const NAMED_UNIQUE = 70;
const NAMED_SHARED_MIN = 15;
/** A basename shared by more than this many files says nothing about which one is meant. */
const MAX_SHARED_BASENAME = 10;
const SYMBOL_FIRST = 60;
const SYMBOL_MORE = 15;
const MAX_SYMBOLS = 3;
const HOP = 30;
const TEST_IMPORTS = 25;
const TEST_NAMING = 20;
const OWNER_SAME_PACKAGE = 5;
const OWNER_MANIFEST = 10;
const PATH_WORDS_MAX = 4;
const MAX_HOP_SEEDS = 25;
const MAX_HOPS_PER_SEED = 30;
const MAX_TESTS_PER_SUBJECT = 10;
const MIN_SYMBOL_LENGTH = 4;
const LONG_SYMBOL = 8;
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

export type RankInput = {
  request: string;
  /** Tracked regular files at the commit (no symlinks, no submodules). */
  files: Array<{ path: string; size: number }>;
  /** Text of a file that was read at the commit (sources, manifests, tsconfig, CODEOWNERS); undefined if not read. */
  text: (path: string) => string | undefined;
  workspaces: WorkspacePackage[];
  /** How many source files were not read, and why. */
  notScanned: { tooLarge: number; overCap: number; metadataSkipped?: number };
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const stripDotSlash = (p: string) => (p.startsWith('./') ? p.slice(2) : p);

// ------------------------------------------------------------ request reading

/** Path-like and file-name-like texts in the request, each with where it starts. Matched against tracked files later. */
function pathTokens(request: string): Array<{ text: string; offset: number }> {
  const seen = new Set<string>();
  const out: Array<{ text: string; offset: number }> = [];
  const re = /(?<![\w@./-])(?:\.\/)?(?:[\w@.-]+\/)*[\w@.-]*\w\.[A-Za-z][A-Za-z0-9]{0,7}(?![\w])/g;
  for (const m of request.matchAll(re)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push({ text: m[0], offset: m.index! });
  }
  // File names without an extension (Dockerfile, Makefile): a capitalised word of 4+ letters.
  for (const m of request.matchAll(/(?<![\w@./-])[A-Z][A-Za-z]{3,}(?![\w.-])/g)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push({ text: m[0], offset: m.index! });
  }
  return out;
}

type Word = { offset: number; codeSpan: boolean; codeOffset?: number };

/** Identifier-like words of the request with their first occurrence and whether one is written as code. */
function requestWords(request: string): Map<string, Word> {
  const words = new Map<string, Word>();
  for (const m of request.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const w = m[0];
    const at = m.index!;
    const end = at + w.length;
    const code = (request[at - 1] === '`' && request[end] === '`') || request[end] === '(';
    const known = words.get(w);
    if (!known) words.set(w, { offset: at, codeSpan: code, ...(code ? { codeOffset: at } : {}) });
    else if (code && !known.codeSpan) {
      known.codeSpan = true;
      known.codeOffset = at;
    }
  }
  return words;
}

/** A name that is unlikely to be an ordinary word: an inner capital, an underscore or digit, or long. */
function isDistinctive(name: string): boolean {
  return /[A-Z_0-9]/.test(name.slice(1)) || name.length >= LONG_SYMBOL;
}

// ------------------------------------------------------------ tests

/** The rule that decides a path is a test, stated wherever a test is shown. */
export const TEST_PATH_RULE = 'a path is a test if its file name is *.test.* or *.spec.*, or it is under a __tests__, test or tests directory';

export function isTestPath(path: string): boolean {
  return /\.(test|spec)\.[^/]+$/.test(baseName(path)) || /(^|\/)(__tests__|test|tests)\//.test(path);
}

const sourceStem = (path: string) => baseName(path).replace(/\.[^.]+$/, '');
const testStem = (path: string) => sourceStem(path).replace(/\.(test|spec)$/, '');

export const TEST_NAMING_RULE = 'same name before .test/.spec, in the same directory or in a __tests__, test or tests directory directly inside it';

function testNamesMatch(testPath: string, subject: string): boolean {
  if (testStem(testPath) !== sourceStem(subject)) return false;
  if (!/\.(test|spec)\.[^/]+$/.test(baseName(testPath))) return false;
  const dir = posix.dirname(subject);
  const tdir = posix.dirname(testPath);
  return tdir === dir || ['__tests__', 'test', 'tests'].some((d) => tdir === posix.join(dir, d));
}

// ------------------------------------------------------------ packages and CODEOWNERS

function packageOf(path: string, packages: WorkspacePackage[], rootHasManifest: boolean): WorkspacePackage | undefined {
  let best: WorkspacePackage | undefined;
  for (const p of packages) {
    if (p.dir === '.') continue;
    if (path.startsWith(`${p.dir}/`) && (!best || p.dir.length > best.dir.length)) best = p;
  }
  if (best) return best;
  return rootHasManifest ? packages.find((p) => p.dir === '.') ?? { dir: '.' } : undefined;
}

const manifestPath = (dir: string) => (dir === '.' ? 'package.json' : `${dir}/package.json`);

export type CodeownersRule = { line: number; pattern: string; owners: string[]; re: RegExp };

/**
 * GitHub's CODEOWNERS rules for the subset that is matched exactly: `*`, `**`, `?`, a leading `/`, a trailing `/`.
 * A pattern using anything else (character classes, `!`, escapes) is skipped and counted; skipping a rule is the
 * safe direction, because a skipped rule can only mean an owner is not stated.
 */
export function parseCodeowners(textValue: string): { rules: CodeownersRule[]; skipped: number } {
  const rules: CodeownersRule[] = [];
  let skipped = 0;
  textValue.split(/\r\n|\r|\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern) return;
    if (/[[\]!\\]/.test(pattern) || pattern.startsWith('#')) {
      skipped++;
      return;
    }
    const dirOnly = pattern.endsWith('/');
    let body = pattern.replace(/\/+$/, '');
    const anchored = body.startsWith('/') || body.includes('/');
    body = body.replace(/^\//, '');
    const last = body.slice(body.lastIndexOf('/') + 1);
    // Segment by segment: a `**` segment between others matches ZERO or more directories (`docs/**/x` owns `docs/x`).
    const convert = (part: string) =>
      part
        .split('**')
        .map((p) => p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
        .join('.*');
    const segs = body.split('/');
    const re = segs
      .map((seg, k) => {
        const end = k === segs.length - 1;
        return seg === '**' ? (end ? '.*' : '(?:.*/)?') : `${convert(seg)}${end ? '' : '/'}`;
      })
      .join('');
    // A literal last segment may be a directory (its contents are owned too); a wildcard one is exact.
    const wildcardLast = /[*?]/.test(last);
    const tail = dirOnly || !wildcardLast ? '(?:/.*)?' : '';
    rules.push({ line: i + 1, pattern, owners, re: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}${dirOnly ? '/.*' : tail}$`) });
  });
  return { rules, skipped };
}

/** The last matching rule wins. */
export function codeownersFor(path: string, rules: CodeownersRule[]): CodeownersRule | undefined {
  let hit: CodeownersRule | undefined;
  for (const r of rules) if (r.re.test(path)) hit = r;
  return hit;
}

function codeownersFile(files: Set<string>): string | undefined {
  return CODEOWNERS_PATHS.find((p) => files.has(p));
}

// ------------------------------------------------------------ ranking

const KIND_ORDER: Reason['kind'][] = ['named-in-request', 'exports-symbol', 'imports', 'imported-by', 'test-for', 'owner-manifest', 'path-words', 'owner', 'codeowners'];

function emptyLimits(input: RankInput, graph: Graph): SelectionLimits {
  const sourceFiles = input.files.filter((f) => SOURCE_EXT.test(f.path)).length;
  return {
    sourceFiles,
    sourceFilesScanned: graph.modules.size + graph.unreadable.length,
    notScannedTooLarge: input.notScanned.tooLarge,
    notScannedOverCap: input.notScanned.overCap,
    unreadable: graph.unreadable.slice(0, 50),
    unreadableTotal: graph.unreadable.length,
    metadataNotRead: input.notScanned.metadataSkipped ?? 0,
    statementsUnconfirmed: graph.unconfirmed,
    unresolvedRelative: graph.unresolvedRelative,
    unresolvedPackage: graph.unresolvedPackage,
    seeds: 0,
    seedsUsedForHops: 0,
    hopsTruncated: 0,
    testsTruncated: 0,
    codeownersRulesSkipped: 0,
  };
}

type NamedReason = Extract<Reason, { kind: 'named-in-request' }>;

/**
 * The files the request names, each with the best reason. This is THE rule: ranking uses it to give reasons and
 * the verifier uses it to re-derive them, so token boundaries, which rule wins and how many files a name could
 * mean are the same in both. A file is named by (best first) its exact path, the end of its path, or its file name.
 */
function namedInRequest(request: string, pathSet: Set<string>, byBase: Map<string, string[]>): Map<string, NamedReason> {
  const named = new Map<string, NamedReason>();
  const keepBest = (path: string, r: NamedReason) => {
    const have = named.get(path);
    if (!have || r.points > have.points) named.set(path, r);
  };
  for (const tok of pathTokens(request)) {
    const norm = stripDotSlash(tok.text);
    if (pathSet.has(norm)) {
      keepBest(norm, { kind: 'named-in-request', points: NAMED_EXACT, rule: 'exact-path', quote: tok.text, offset: tok.offset, sharedBy: 1 });
    } else if (norm.includes('/')) {
      const hits = (byBase.get(baseName(norm)) ?? []).filter((f) => f.endsWith(`/${norm}`));
      for (const f of hits) keepBest(f, { kind: 'named-in-request', points: NAMED_SUFFIX, rule: 'path-suffix', quote: tok.text, offset: tok.offset, sharedBy: hits.length });
    } else {
      const usable = byBase.get(norm) ?? [];
      if (!usable.length || usable.length > MAX_SHARED_BASENAME) continue;
      for (const f of usable) {
        keepBest(f, {
          kind: 'named-in-request',
          points: usable.length === 1 ? NAMED_UNIQUE : Math.max(NAMED_SHARED_MIN, Math.round(NAMED_UNIQUE / usable.length)),
          rule: usable.length === 1 ? 'unique-basename' : 'shared-basename',
          quote: tok.text,
          offset: tok.offset,
          sharedBy: usable.length,
        });
      }
    }
  }
  return named;
}

export function rankFiles(input: RankInput): { ranked: RelevantFile[]; limits: SelectionLimits } {
  const paths = input.files.map((f) => f.path).sort(compare);
  const pathSet = new Set(paths);
  const resolver = makeResolver(pathSet, input.text, input.workspaces);
  const graph = buildGraph(
    paths.filter((p) => SOURCE_EXT.test(p)),
    input.text,
    resolver,
  );
  const limits = emptyLimits(input, graph);
  const reasons = new Map<string, Reason[]>();
  const add = (path: string, reason: Reason) => {
    if (!reasons.has(path)) reasons.set(path, []);
    reasons.get(path)!.push(reason);
  };

  const byBase = new Map<string, string[]>();
  for (const p of paths) {
    const b = baseName(p);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b)!.push(p);
  }

  // ---- 1. paths and basenames named in the request
  for (const [path, r] of namedInRequest(input.request, pathSet, byBase)) add(path, r);

  // ---- 2. exported symbols the request mentions
  const words = requestWords(input.request);
  for (const m of graph.modules.values()) {
    const found: Array<Extract<Reason, { kind: 'exports-symbol' }>> = [];
    for (const ex of m.exports) {
      if (ex.name.length < MIN_SYMBOL_LENGTH) continue;
      const w = words.get(ex.name);
      if (!w) continue;
      const rule = isDistinctive(ex.name) ? 'distinctive-name' : w.codeSpan ? 'code-span' : undefined;
      if (!rule) continue;
      if (found.some((f) => f.symbol === ex.name)) continue;
      found.push({
        kind: 'exports-symbol',
        points: found.length === 0 ? SYMBOL_FIRST : SYMBOL_MORE,
        symbol: ex.name,
        rule,
        line: ex.line,
        statement: ex.statement,
        quote: ex.name,
        offset: rule === 'code-span' ? (w.codeOffset ?? w.offset) : w.offset,
      });
      if (found.length === MAX_SYMBOLS) break;
    }
    for (const r of found) add(m.path, r);
  }

  const isSeed = (path: string) =>
    (reasons.get(path) ?? []).some((r) => (r.kind === 'named-in-request' && r.rule !== 'shared-basename') || r.kind === 'exports-symbol');
  const score = (path: string) => (reasons.get(path) ?? []).reduce((n, r) => n + r.points, 0);
  const seeds = [...reasons.keys()].filter(isSeed).sort((a, b) => score(b) - score(a) || compare(a, b));
  limits.seeds = seeds.length;

  // ---- 3. one hop on the import graph
  const hopSeeds = seeds.slice(0, MAX_HOP_SEEDS);
  limits.seedsUsedForHops = hopSeeds.length;
  const distinctBy = (edges: ImportEdge[], key: 'from' | 'to') => {
    const seen = new Set<string>();
    return edges.filter((e) => (seen.has(e[key]) ? false : (seen.add(e[key]), true))).sort((a, b) => compare(a[key], b[key]));
  };
  for (const seed of hopSeeds) {
    const out = distinctBy(graph.modules.get(seed)?.edges ?? [], 'to').filter((e) => e.to !== seed);
    // A test that imports the seed is reported by signal 4 (as a test), not twice.
    const inn = distinctBy(graph.incoming.get(seed) ?? [], 'from').filter((e) => e.from !== seed && !isTestPath(e.from));
    limits.hopsTruncated += Math.max(0, out.length - MAX_HOPS_PER_SEED) + Math.max(0, inn.length - MAX_HOPS_PER_SEED);
    for (const edge of out.slice(0, MAX_HOPS_PER_SEED)) add(edge.to, { kind: 'imported-by', points: HOP, seed, edge });
    for (const edge of inn.slice(0, MAX_HOPS_PER_SEED)) add(edge.from, { kind: 'imports', points: HOP, seed, edge });
  }

  // ---- 4. related tests of the files of 1 and 2
  const testFiles = paths.filter(isTestPath);
  const subjects = seeds.filter((s) => !isTestPath(s));
  for (const subject of subjects) {
    let count = 0;
    const emitted = new Set<string>();
    const tryAdd = (testPath: string, reason: Reason) => {
      const id = `${testPath}|${reason.kind === 'test-for' ? reason.rule : ''}`;
      if (emitted.has(id)) return;
      if (count >= MAX_TESTS_PER_SUBJECT) {
        limits.testsTruncated++;
        return;
      }
      emitted.add(id);
      count++;
      add(testPath, reason);
    };
    for (const edge of distinctBy(graph.incoming.get(subject) ?? [], 'from')) {
      if (isTestPath(edge.from)) tryAdd(edge.from, { kind: 'test-for', points: TEST_IMPORTS, subject, rule: 'imports', edge });
    }
    for (const t of testFiles) {
      if (testNamesMatch(t, subject)) tryAdd(t, { kind: 'test-for', points: TEST_NAMING, subject, rule: 'naming', naming: TEST_NAMING_RULE });
    }
  }

  // ---- 5a. the package.json of each package that owns a file of 1 or 2
  const rootHasManifest = pathSet.has('package.json');
  const packages = input.workspaces;
  const seedPackages = new Map<string, { pkg: WorkspacePackage; seeds: string[] }>();
  for (const s of seeds) {
    const pkg = packageOf(s, packages, rootHasManifest);
    if (!pkg) continue;
    if (!seedPackages.has(pkg.dir)) seedPackages.set(pkg.dir, { pkg, seeds: [] });
    seedPackages.get(pkg.dir)!.seeds.push(s);
  }
  for (const { pkg, seeds: owned } of seedPackages.values()) {
    const manifest = manifestPath(pkg.dir);
    if (pathSet.has(manifest)) add(manifest, { kind: 'owner-manifest', points: OWNER_MANIFEST, package: { dir: pkg.dir, ...(pkg.name ? { name: pkg.name } : {}) }, ownerOf: owned[0]! });
  }

  // ---- 6. the weakest signal: rare words in the path
  for (const m of pathWordMatches(paths, input.request).slice(0, 12)) {
    add(m.path, { kind: 'path-words', points: round1(Math.min(PATH_WORDS_MAX, m.weight)), words: m.words, weight: round1(m.weight) });
  }

  // ---- 5b. ownership is shown for every file that already has a reason
  const coPath = codeownersFile(pathSet);
  const owners = coPath && input.text(coPath) !== undefined ? parseCodeowners(input.text(coPath)!) : undefined;
  if (coPath && owners) {
    limits.codeowners = coPath;
    limits.codeownersRulesSkipped = owners.skipped;
  }
  for (const path of [...reasons.keys()]) {
    const pkg = packageOf(path, packages, rootHasManifest);
    if (pkg) {
      const sharing = seedPackages.get(pkg.dir)?.seeds.find((s) => s !== path);
      add(path, {
        kind: 'owner',
        points: sharing && !isSeed(path) ? OWNER_SAME_PACKAGE : 0,
        package: { dir: pkg.dir, ...(pkg.name ? { name: pkg.name } : {}) },
        ...(sharing ? { sharesWith: sharing } : {}),
      });
    }
    const rule = owners ? codeownersFor(path, owners.rules) : undefined;
    if (coPath && rule && rule.owners.length) {
      add(path, { kind: 'codeowners', points: 0, file: coPath, line: rule.line, rule: `${rule.pattern} ${rule.owners.join(' ')}`, owners: rule.owners });
    }
  }

  const ranked: RelevantFile[] = [...reasons.entries()]
    .map(([path, rs]) => ({
      path,
      score: round1(rs.reduce((n, r) => n + r.points, 0)),
      reasons: [...rs].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.points - a.points),
    }))
    .sort((a, b) => b.score - a.score || compare(a.path, b.path));
  return { ranked, limits };
}

// ------------------------------------------------------------ size limit

/**
 * Apply the size limit in rank order. A file is listed while there are fewer than `maxFiles` and its rendered
 * entry still fits in `maxChars`; the first file that does not fit ends the list, and it and everything after it
 * are recorded as omitted with their scores (never silently dropped). `measure` is the rendered size of one entry.
 */
export function applyBudget(
  ranked: RelevantFile[],
  budget: ContextBudget,
  measure: (f: RelevantFile) => number,
  omittedCap = 300,
): { files: RelevantFile[]; omitted: OmittedFile[]; omittedTotal: number } {
  const files: RelevantFile[] = [];
  const omitted: OmittedFile[] = [];
  let used = 0;
  let closed: 'maxFiles' | 'maxChars' | undefined;
  let omittedTotal = 0;
  for (const f of ranked) {
    if (!closed) {
      if (files.length >= budget.maxFiles) closed = 'maxFiles';
      else if (used + measure(f) > budget.maxChars) closed = 'maxChars';
      else {
        files.push(f);
        used += measure(f);
        continue;
      }
    }
    omittedTotal++;
    if (omitted.length < omittedCap) omitted.push({ ...f, why: closed! });
  }
  return { files, omitted, omittedTotal };
}

// ------------------------------------------------------------ verification

export type VerifyInput = {
  request: string;
  files: Array<{ path: string; size: number }>;
  text: (path: string) => string | undefined;
  workspaces: WorkspacePackage[];
};

/**
 * Re-derive every reason of the given files from the commit's own data and report each one that does not hold.
 * An empty result means every stated reason was found again, by the rules, in the blobs at the commit.
 */
export function verifyRelevantFiles(selected: RelevantFile[], input: VerifyInput): string[] {
  const problems: string[] = [];
  const paths = input.files.map((f) => f.path).sort(compare);
  const pathSet = new Set(paths);
  const resolver = makeResolver(pathSet, input.text, input.workspaces);
  const rootHasManifest = pathSet.has('package.json');
  const byBase = new Map<string, string[]>();
  for (const p of paths) {
    const b = baseName(p);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b)!.push(p);
  }
  const words = requestWords(input.request);
  let namedMap: Map<string, NamedReason> | undefined;
  const namedByRequest = () => (namedMap ??= namedInRequest(input.request, pathSet, byBase));

  const edgeHolds = (e: ImportEdge, where: string): boolean => {
    const t = input.text(e.from);
    if (t === undefined) return (problems.push(`${where}: ${e.from} was not read`), false);
    const scan = scanModule(t, { jsx: jsxFile(e.from) });
    if (!scan.ok) return (problems.push(`${where}: ${e.from} cannot be parsed (${scan.reason})`), false);
    const found = scan.imports.find((i) => i.line === e.line && i.specifier === e.specifier && i.kind === e.kind && i.statement === e.statement);
    if (!found) return (problems.push(`${where}: no such statement at ${e.from}:${e.line}`), false);
    const r = resolver.resolve(e.from, e.specifier, resolver.modeFor(e.from, e.kind));
    if ('unresolved' in r || r.to !== e.to || r.resolution !== e.resolution) {
      problems.push(`${where}: "${e.specifier}" in ${e.from} does not resolve to ${e.to} by the stated rule`);
      return false;
    }
    return true;
  };

  for (const f of selected) {
    if (!f.reasons.length) problems.push(`${f.path}: listed without a reason`);
    if (!pathSet.has(f.path)) problems.push(`${f.path}: not a tracked file at the commit`);
    if (round1(f.reasons.reduce((n, r) => n + r.points, 0)) !== f.score) problems.push(`${f.path}: score does not equal the sum of its reasons`);
    for (const r of f.reasons) {
      const where = `${f.path} (${r.kind})`;
      switch (r.kind) {
        case 'named-in-request': {
          if (input.request.slice(r.offset, r.offset + r.quote.length) !== r.quote) {
            problems.push(`${where}: the request does not contain "${r.quote}" at ${r.offset}`);
            break;
          }
          // The rule is the one ranking used: the same tokens, the same winner, the same count of files a name could mean.
          const expected = namedByRequest().get(f.path);
          const ok =
            !!expected &&
            expected.rule === r.rule &&
            expected.quote === r.quote &&
            expected.offset === r.offset &&
            expected.sharedBy === r.sharedBy &&
            expected.points === r.points;
          if (!ok) problems.push(`${where}: "${r.quote}" does not name this file by rule ${r.rule}`);
          break;
        }
        case 'exports-symbol': {
          const t = input.text(f.path);
          const scan = t === undefined ? undefined : scanModule(t, { jsx: jsxFile(f.path) });
          const ex = scan?.ok ? scan.exports.find((e) => e.name === r.symbol && e.line === r.line && e.statement === r.statement) : undefined;
          if (!ex) problems.push(`${where}: ${f.path} does not export ${r.symbol} at line ${r.line}`);
          if (input.request.slice(r.offset, r.offset + r.quote.length) !== r.quote || r.quote !== r.symbol) problems.push(`${where}: the request does not mention ${r.symbol} at ${r.offset}`);
          const w = words.get(r.symbol);
          if (!w || (r.rule === 'distinctive-name' ? !isDistinctive(r.symbol) : !w.codeSpan)) problems.push(`${where}: rule ${r.rule} does not hold for ${r.symbol}`);
          break;
        }
        case 'imports':
          if (edgeHolds(r.edge, where) && (r.edge.from !== f.path || r.edge.to !== r.seed)) problems.push(`${where}: the edge is not ${f.path} → ${r.seed}`);
          break;
        case 'imported-by':
          if (edgeHolds(r.edge, where) && (r.edge.to !== f.path || r.edge.from !== r.seed)) problems.push(`${where}: the edge is not ${r.seed} → ${f.path}`);
          break;
        case 'test-for':
          if (!isTestPath(f.path)) problems.push(`${where}: not a test by the stated rule`);
          if (r.rule === 'imports') {
            if (!r.edge) problems.push(`${where}: no edge recorded`);
            else if (edgeHolds(r.edge, where) && (r.edge.from !== f.path || r.edge.to !== r.subject)) problems.push(`${where}: the edge is not ${f.path} → ${r.subject}`);
          } else if (!testNamesMatch(f.path, r.subject)) problems.push(`${where}: the naming rule does not link ${f.path} to ${r.subject}`);
          break;
        case 'owner': {
          const pkg = packageOf(f.path, input.workspaces, rootHasManifest);
          if (!pkg || pkg.dir !== r.package.dir) problems.push(`${where}: the owning package is not ${r.package.dir}`);
          break;
        }
        case 'owner-manifest': {
          const owner = packageOf(r.ownerOf, input.workspaces, rootHasManifest);
          if (!owner || owner.dir !== r.package.dir || manifestPath(owner.dir) !== f.path) problems.push(`${where}: not the package.json of the package that owns ${r.ownerOf}`);
          break;
        }
        case 'codeowners': {
          const t = input.text(r.file);
          const rule = t === undefined ? undefined : codeownersFor(f.path, parseCodeowners(t).rules);
          if (!rule || rule.line !== r.line || `${rule.pattern} ${rule.owners.join(' ')}` !== r.rule) problems.push(`${where}: ${r.file} line ${r.line} is not the rule that matches this file`);
          break;
        }
        case 'path-words': {
          const m = pathWordMatches(paths, input.request).find((x) => x.path === f.path);
          if (!m || JSON.stringify(m.words) !== JSON.stringify(r.words)) problems.push(`${where}: the path-word match does not hold`);
          break;
        }
      }
    }
  }
  return problems;
}
