import { posix } from 'node:path';
import { LineCounter, parseDocument, isNode } from 'yaml';
import {
  canonicalJson,
  sealSnapshot,
  type ContextFact,
  type Convention,
  type DependencyFact,
  type FactSource,
  type RepoSnapshot,
  type SnapshotDiff,
  type UnconfirmedItem,
} from '@turbine-hall/turbine-contracts';
import { listTopLevel, listTreeDetailed, readBlobs, resolveCommit, treeIdOf, type TreeEntry } from './git-read.js';
import { parseJsonc, type Jsonc, type LineRange } from './jsonc.js';
import { satisfies } from './semver-lite.js';

/**
 * Layer 1 of the repository context: deterministic facts about the repository AT ONE COMMIT.
 *
 * Rules this file keeps:
 *  - Nothing is read from the working tree. Paths and object ids come from `git ls-tree` on the
 *    commit and contents from a single `git cat-file --batch` process.
 *  - Every fact carries {path, commit, blob} (and lines where they are known).
 *  - A convention is "confirmed" only if a config file sets it or an exhaustive count is 100%.
 *  - Declared (manifest) and installed (lockfile) versions are separate fields.
 *  - Anything it cannot prove becomes an `unconfirmed` item, never a fact.
 *  - No timestamps and sorted keys: the same commit always yields the same snapshot hash.
 */

const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 256 * 1024 * 1024;
/** Budget for manifests, lockfiles and other config blobs (these are read in addition to sources). */
const MAX_CONFIG_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CONFIG_TOTAL_BYTES = 128 * 1024 * 1024;
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const SOURCE_SCOPE = 'tracked source files (*.ts, *.tsx, *.js, *.jsx, *.mjs, *.cjs, *.mts, *.cts) outside node_modules';
const LOCKFILES = ['pnpm-lock.yaml', 'npm-shrinkwrap.json', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'] as const;
const ROOT_CONFIGS = new Set([
  'pnpm-workspace.yaml',
  'package.yaml',
  '.nvmrc',
  '.node-version',
  '.editorconfig',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
]);
const PRETTIER_JS = /^(?:\.prettierrc\.(?:c?js|mjs)|prettier\.config\.(?:c?js|mjs|ts|cts|mts))$/;
const ESLINT_CONFIG = /^(?:eslint\.config\.(?:c?js|mjs|ts|cts|mts)|\.eslintrc(?:\.(?:c?js|json|ya?ml))?)$/;
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
type Section = (typeof SECTIONS)[number];
const BARE_BUILTINS = new Set(
  (
    'assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs ' +
    'fs/promises http http2 https inspector module net os path path/posix path/win32 perf_hooks process punycode querystring ' +
    'readline readline/promises repl stream stream/promises stream/web string_decoder sys timers timers/promises tls trace_events ' +
    'tty url util util/types v8 vm wasi worker_threads zlib'
  ).split(' '),
);
const ASSET_EXT = /\.(?:json|css|scss|sass|less|svg|png|jpe?g|gif|webp|md|html|txt|ya?ml|wasm|node)$/;
const TSCONFIG_LANGUAGE_OPTIONS = ['target', 'module', 'moduleResolution', 'lib', 'jsx'] as const;
const TSCONFIG_CONVENTION_OPTIONS = ['strict', 'noUncheckedIndexedAccess'] as const;
const PRETTIER_OPTIONS = ['printWidth', 'tabWidth', 'useTabs', 'semi', 'singleQuote', 'trailingComma', 'endOfLine'] as const;
const EDITORCONFIG_KEYS = new Set(['indent_style', 'indent_size', 'tab_width', 'end_of_line', 'charset', 'insert_final_newline', 'trim_trailing_whitespace']);
const COMMAND_SCRIPTS: Record<string, string[]> = {
  test: ['test'],
  lint: ['lint'],
  typecheck: ['typecheck', 'type-check', 'check-types'],
  build: ['build'],
};

type Json = Record<string, any>;
type Pkg = { dir: string; path: string; data: Json; jc: Jsonc };
type PackageManager = { declared?: { name: string; version?: string }; lockfiles: string[]; selected?: string; installer?: string };

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const inNodeModules = (p: string) => /(^|\/)node_modules\//.test(p);
const baseName = (p: string) => posix.basename(p);
/** Drop undefined values so the object is valid JSON data. */
function clean(o: Record<string, unknown>): Record<string, any> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

type Yaml = { value: unknown; errors: string[]; lines(path: Array<string | number>): LineRange | undefined };
function parseYamlLines(text: string): Yaml {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  const errors = doc.errors.map((e) => e.message);
  let value: unknown;
  if (!errors.length) {
    try {
      value = doc.toJS(); // can throw, e.g. for an alias bomb or an unresolved alias
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return {
    value,
    errors,
    lines(path) {
      const node = doc.getIn(path, true);
      if (!isNode(node) || !node.range) return undefined;
      const start = lc.linePos(node.range[0]).line;
      const end = lc.linePos(Math.max(node.range[0], node.range[1] - 1)).line;
      return { start, end: Math.max(start, end) };
    },
  };
}

class Builder {
  readonly facts: ContextFact[] = [];
  readonly deps: DependencyFact[] = [];
  readonly conventions: Convention[] = [];
  readonly unconfirmed: UnconfirmedItem[] = [];
  private readonly keys = new Set<string>();
  readonly byPath = new Map<string, TreeEntry>();
  blobs = new Map<string, Buffer>();
  /** Paths whose content may be stated: the config files admitted within the byte budget. */
  admitted = new Set<string>();
  undecodable = 0;

  constructor(
    readonly repoRoot: string,
    readonly commit: string,
    readonly tree: string,
    readonly entries: TreeEntry[],
  ) {
    for (const e of entries) if (e.type === 'blob') this.byPath.set(e.path, e);
  }

  source(path: string, lines?: LineRange): FactSource {
    const e = this.byPath.get(path);
    if (!e) throw new Error(`internal: ${path} is not tracked at ${this.commit}`);
    return { path, commit: this.commit, blob: e.id, object: 'blob', ...(lines ? { lines } : {}) };
  }

  treeSource(): FactSource {
    return { path: '.', commit: this.commit, blob: this.tree, object: 'tree' };
  }

  text(path: string): string | undefined {
    const e = this.byPath.get(path);
    // A symlink's blob is its target path; it is not the file's content and may share a blob id
    // with a regular file, so it is never read as configuration. A file that the budget did not
    // admit is not read even when its blob is present because another path shares it.
    if (!e || e.mode === '120000' || !this.admitted.has(path)) return undefined;
    return this.blobs.get(e.id)?.toString('utf8');
  }

  private unique(key: string): string {
    let k = key;
    for (let n = 2; this.keys.has(k); n++) k = `${key}#${n}`;
    this.keys.add(k);
    return k;
  }

  fact(f: ContextFact): void {
    this.facts.push({ ...f, key: this.unique(f.key) });
  }

  unconfirm(key: string, statement: string, reason: string, source: FactSource): void {
    this.unconfirmed.push({ key: this.unique(key), statement, reason, source });
  }

  convention(c: Omit<Convention, 'counterexamples'> & { counterexamples?: FactSource[] }): void {
    this.conventions.push({ ...c, key: this.unique(c.key), counterexamples: c.counterexamples ?? [] });
  }

  dependency(d: DependencyFact): void {
    this.deps.push({ ...d, key: this.unique(d.key) });
  }
}

const MAX_GLOB_LENGTH = 256;
const MAX_BRACE_EXPANSIONS = 64;

/** Expand `{a,b}` groups into plain alternatives, or null if there are too many / it is malformed. */
function expandBraces(p: string, depth = 0): string[] | null {
  const open = p.indexOf('{');
  if (open < 0) return p.includes('}') ? null : [p];
  if (depth > 8) return null;
  let level = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < p.length; i++) {
    const ch = p[i];
    if (ch === '{') level++;
    else if (ch === '}') {
      level--;
      if (level === 0) {
        close = i;
        break;
      }
    } else if (ch === ',' && level === 1) commas.push(i);
  }
  if (close < 0 || commas.length === 0) return null;
  const alternatives: string[] = [];
  let from = open + 1;
  for (const c of [...commas, close]) {
    alternatives.push(p.slice(from, c));
    from = c + 1;
  }
  const out: string[] = [];
  for (const alt of alternatives) {
    const expanded = expandBraces(p.slice(0, open) + alt + p.slice(close + 1), depth + 1);
    if (!expanded) return null;
    out.push(...expanded);
    if (out.length > MAX_BRACE_EXPANSIONS) return null;
  }
  return out;
}

/** `*` and `?` inside one path segment. Single back-tracking point, so cost is O(pattern x segment). */
function segmentMatches(pat: string, text: string): boolean {
  // A wildcard never matches a leading dot (hidden directories); only a pattern that starts with the dot does.
  if (text.startsWith('.') && !pat.startsWith('.')) return false;
  let p = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < text.length) {
    if (p < pat.length && pat[p] === '*') {
      star = p++;
      mark = i;
    } else if (p < pat.length && (pat[p] === '?' || pat[p] === text[i])) {
      p++;
      i++;
    } else if (star >= 0) {
      p = star + 1;
      i = ++mark;
    } else return false;
  }
  while (p < pat.length && pat[p] === '*') p++;
  return p === pat.length;
}

/** Segment-wise match where a `**` segment is any number (including zero) of directories; memoised. */
function pathMatches(pat: string[], segs: string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (pi: number, si: number): boolean => {
    const k = pi * (segs.length + 1) + si;
    const known = memo.get(k);
    if (known !== undefined) return known;
    let r: boolean;
    if (pi === pat.length) r = si === segs.length;
    else if (pat[pi] === '**') r = go(pi + 1, si) || (si < segs.length && !segs[si]!.startsWith('.') && go(pi, si + 1));
    else r = si < segs.length && segmentMatches(pat[pi]!, segs[si]!) && go(pi + 1, si + 1);
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}

/**
 * Compile a workspace pattern (`*`, `?`, `**`, `{a,b}`) into a matcher with bounded cost, or null for
 * syntax that is not supported (character classes, extglobs, escapes, too many alternatives). There is
 * no regular expression here, so a repository-controlled pattern cannot cause catastrophic backtracking.
 */
function compileGlob(glob: string): ((dir: string) => boolean) | null {
  if (!glob || glob.length > MAX_GLOB_LENGTH || /[[\]()\\!]/.test(glob)) return null;
  const expanded = expandBraces(glob);
  if (!expanded) return null;
  const patterns = expanded.map((e) => e.split('/').filter((x) => x !== '' && x !== '.'));
  return (dir) => {
    const segs = dir.split('/');
    return patterns.some((pat) => pathMatches(pat, segs));
  };
}

const normalizeGlob = (g: string) => g.trim().replace(/^\.\//, '').replace(/\/package\.json$/, '').replace(/\/+$/, '');

/** Build the snapshot of `repoRoot` at `commit`. Throws if anything it needs cannot be read. */
export function buildSnapshot(repoRoot: string, commit: string): RepoSnapshot {
  const resolved = resolveCommit(repoRoot, commit);
  if (!resolved) throw new Error(`commit ${commit} does not exist in ${repoRoot}`);
  const tree = treeIdOf(repoRoot, resolved);
  const listing = listTreeDetailed(repoRoot, resolved);
  const entries = listing.entries;
  const b = new Builder(repoRoot, resolved, tree, entries);
  b.undecodable = listing.undecodable;
  if (listing.undecodable > 0) {
    b.unconfirm(
      'paths:non-utf8',
      `${listing.undecodable} tracked path(s) are not valid UTF-8 and are not described by this snapshot`,
      'path bytes cannot be represented exactly',
      b.treeSource(),
    );
  }

  // ---- choose the blobs to read, then read them all through ONE git process ----
  const regular = entries.filter((e) => e.type === 'blob' && e.mode !== '120000' && !inNodeModules(e.path));
  const configs: TreeEntry[] = [];
  let configBytes = 0;
  // The root manifest is admitted first, so optional files can never use up the budget it needs.
  const candidates = regular.filter(
    (e) => baseName(e.path) === 'package.json' || /^tsconfig(?:\..+)?\.json$/.test(baseName(e.path)) || ROOT_CONFIGS.has(e.path),
  );
  candidates.sort((x, y) => Number(y.path === 'package.json') - Number(x.path === 'package.json'));
  for (const e of candidates) {
    if (e.size > MAX_CONFIG_FILE_BYTES || configBytes + e.size > MAX_CONFIG_TOTAL_BYTES) {
      // The root manifest is required for any fact; every other config is optional.
      if (e.path === 'package.json') throw new Error(`package.json is ${e.size} bytes, over the read limit, so a snapshot cannot be built`);
      b.unconfirm(`skipped:${e.path}`, `\`${e.path}\` is ${e.size} bytes, over the read limit, so nothing is stated from it`, 'over the size limit', b.source(e.path));
      continue;
    }
    configBytes += e.size;
    configs.push(e);
  }
  const sources: TreeEntry[] = [];
  let sourceBytes = 0;
  let skippedSources = 0;
  for (const e of regular.filter((x) => SOURCE_EXT.test(x.path))) {
    if (e.size > MAX_SOURCE_FILE_BYTES || sourceBytes + e.size > MAX_SOURCE_TOTAL_BYTES) {
      skippedSources++;
      continue;
    }
    sourceBytes += e.size;
    sources.push(e);
  }
  b.admitted = new Set(configs.map((e) => e.path));
  const toRead = [...configs, ...sources];
  const sizes = new Map(toRead.map((e) => [e.id, e.size]));
  b.blobs = readBlobs(
    repoRoot,
    toRead.map((e) => e.id),
    [...sizes.values()].reduce((n, s) => n + s, 0),
  );

  layoutFacts(b, entries);
  const rootPkg = parseManifest(b, 'package.json');
  const packages: Pkg[] = [...(rootPkg ? [rootPkg] : []), ...findWorkspaces(b, rootPkg, regular)];
  const manager = packageManagerFacts(b, rootPkg);
  for (const pkg of packages) packageFacts(b, pkg, pkg === rootPkg ? manager : undefined);
  nodeVersionFacts(b);
  tsconfigFacts(b, regular);
  dependencyFacts(b, packages, manager);
  conventionFacts(b, regular, sources, skippedSources, rootPkg);

  return sealSnapshot({
    schemaVersion: 1,
    commit: resolved,
    tree,
    facts: b.facts,
    dependencies: b.deps,
    conventions: b.conventions,
    unconfirmed: b.unconfirmed,
  });
}

// ------------------------------------------------------------------ layout

function layoutFacts(b: Builder, entries: TreeEntry[]): void {
  const top = listTopLevel(b.repoRoot, b.commit);
  // Blob counts per top-level directory, computed in one pass over the tree.
  const filesUnder = new Map<string, number>();
  for (const e of entries) {
    if (e.type !== 'blob') continue;
    const first = e.path.split('/')[0]!;
    if (first !== e.path) filesUnder.set(first, (filesUnder.get(first) ?? 0) + 1);
  }
  const blobs = entries.filter((e) => e.type === 'blob').length;
  b.fact({
    key: 'layout:.',
    category: 'layout',
    statement: `${blobs} tracked files in ${top.length} top-level entries`,
    data: { files: blobs, topLevelEntries: top.length },
    source: b.treeSource(),
  });
  for (const e of top) {
    if (e.type === 'tree') {
      const files = filesUnder.get(e.path) ?? 0;
      b.fact({
        key: `layout:${e.path}`,
        category: 'layout',
        statement: `Top-level directory \`${e.path}/\` holds ${files} tracked files`,
        data: { kind: 'directory', files },
        source: { path: e.path, commit: b.commit, blob: e.id, object: 'tree' },
      });
    } else if (e.type === 'blob') {
      b.fact({
        key: `layout:${e.path}`,
        category: 'layout',
        statement: `Top-level file \`${e.path}\``,
        data: { kind: 'file' },
        source: { path: e.path, commit: b.commit, blob: e.id, object: 'blob' },
      });
    } else {
      b.unconfirm(
        `submodule:${e.path}`,
        `\`${e.path}\` is a git submodule; its contents are not part of this commit and were not read`,
        'submodule',
        { path: e.path, commit: b.commit, blob: e.id, object: 'commit' },
      );
    }
  }
}

// ------------------------------------------------------- manifests and workspaces

function parseManifest(b: Builder, path: string): Pkg | null {
  const text = b.text(path);
  if (text === undefined) return null;
  try {
    const jc = parseJsonc(text);
    if (!isObj(jc.value)) throw new SyntaxError('not a JSON object');
    return { dir: path === 'package.json' ? '.' : path.slice(0, -'/package.json'.length), path, data: jc.value, jc };
  } catch (e) {
    b.unconfirm(`unparsed:${path}`, `\`${path}\` could not be parsed, so nothing is stated from it`, (e as Error).message, b.source(path));
    return null;
  }
}

function findWorkspaces(b: Builder, root: Pkg | null, regular: TreeEntry[]): Pkg[] {
  let patterns: string[] = [];
  let declaredBy: string | undefined;
  let declarationSource: FactSource | undefined;

  const pnpmText = b.text('pnpm-workspace.yaml');
  if (b.byPath.has('pnpm-workspace.yaml') && pnpmText === undefined) {
    // The file exists but was not read (over the size limit, or a symlink). It may be the one that decides,
    // so membership is unknown; the manifest's workspaces field must not stand in for it.
    b.unconfirm('workspace:unreadable', '`pnpm-workspace.yaml` is tracked but was not read, so workspace membership is unknown', 'pnpm workspace file not read', b.source('pnpm-workspace.yaml'));
    return [];
  }
  if (pnpmText !== undefined) {
    const y = parseYamlLines(pnpmText);
    if (y.errors.length) {
      b.unconfirm('unparsed:pnpm-workspace.yaml', '`pnpm-workspace.yaml` could not be parsed, so workspace packages are unknown', y.errors[0]!, b.source('pnpm-workspace.yaml'));
    } else {
      const list = isObj(y.value) ? y.value.packages : undefined;
      if (Array.isArray(list)) {
        patterns = list.filter((x): x is string => typeof x === 'string');
        declaredBy = 'pnpm-workspace.yaml';
        declarationSource = b.source('pnpm-workspace.yaml', y.lines(['packages']));
      } else {
        b.unconfirm('workspace:no-packages', '`pnpm-workspace.yaml` has no `packages` list, so workspace packages are not determined', 'no packages key', b.source('pnpm-workspace.yaml'));
      }
    }
  } else if (root) {
    const ws = root.data.workspaces;
    const list = Array.isArray(ws) ? ws : isObj(ws) && Array.isArray(ws.packages) ? ws.packages : undefined;
    if (list) {
      patterns = list.filter((x: unknown): x is string => typeof x === 'string');
      declaredBy = 'package.json workspaces';
      declarationSource = b.source(root.path, root.jc.lines(['workspaces']));
    }
  }
  if (!declaredBy || !declarationSource) return [];
  if (declaredBy === 'package.json workspaces' && patterns.some((p) => p.startsWith('!'))) {
    // npm applies inclusions and exclusions in list order. That order is not evaluated here, so membership
    // is not stated for any package rather than risk confirming one an exclusion removes.
    b.unconfirm('workspace:negation-order', 'package.json workspaces uses exclusion patterns, whose order is not evaluated, so workspace membership is unknown', 'exclusion order not evaluated', declarationSource);
    return [];
  }

  b.fact({
    key: 'workspace:declaration',
    category: 'workspace',
    statement: `${declaredBy} declares workspace packages: ${patterns.join(', ') || '(none)'}`,
    data: { declaredBy, patterns },
    source: declarationSource,
  });

  const compile = (pattern: string, glob: string) => {
    const matcher = compileGlob(normalizeGlob(glob));
    if (!matcher) {
      b.unconfirm(
        `workspace:unsupported-pattern:${pattern}`,
        `Workspace pattern \`${pattern}\` uses glob syntax Turbine does not evaluate, so the packages it matches are not known`,
        'unsupported glob syntax',
        declarationSource!,
      );
    }
    return matcher;
  };
  const include = patterns.filter((p) => !p.startsWith('!')).map((p) => compile(p, p)).filter((m): m is (dir: string) => boolean => m !== null);
  const excludeCompiled = patterns.filter((p) => p.startsWith('!')).map((p) => compile(p, p.slice(1)));
  const exclude = excludeCompiled.filter((m): m is (dir: string) => boolean => m !== null);
  // An exclusion Turbine cannot evaluate might remove any package: membership is then not known.
  const unevaluatedExclusion = excludeCompiled.some((m) => m === null);
  const found: Pkg[] = [];
  for (const e of regular) {
    if (baseName(e.path) !== 'package.json' || e.path === 'package.json') continue;
    const dir = e.path.slice(0, -'/package.json'.length);
    if (!include.some((m) => m(dir)) || exclude.some((m) => m(dir))) continue;
    if (unevaluatedExclusion) {
      b.unconfirm(
        `workspace:undetermined:${dir}`,
        `\`${dir}\` matches a workspace pattern but an exclusion pattern was not evaluated, so it is not stated to be a workspace package and its dependencies are not read`,
        'unsupported exclusion pattern',
        b.source(e.path),
      );
      continue;
    }
    const pkg = parseManifest(b, e.path);
    if (!pkg) continue;
    found.push(pkg);
    b.fact({
      key: `workspace:${dir}`,
      category: 'workspace',
      statement: `Workspace package \`${dir}\` (${typeof pkg.data.name === 'string' ? pkg.data.name : 'unnamed'}) is matched by ${declaredBy}`,
      data: clean({ dir, name: typeof pkg.data.name === 'string' ? pkg.data.name : undefined, declaredBy }),
      source: b.source(e.path, pkg.jc.lines(['name'])),
    });
  }
  return found;
}

function packageManagerFacts(b: Builder, root: Pkg | null): PackageManager {
  const out: PackageManager = { lockfiles: LOCKFILES.filter((l) => b.byPath.has(l)) };
  const field = root?.data.packageManager;
  if (root && typeof field === 'string') {
    const m = /^([^@]+)(?:@(.+))?$/.exec(field);
    if (m) {
      out.declared = clean({ name: m[1]!, version: m[2] }) as { name: string; version?: string };
      b.fact({
        key: 'package-manager',
        category: 'version',
        statement: `package.json declares packageManager \`${field}\``,
        data: clean({ name: m[1]!, version: m[2] }),
        source: b.source(root.path, root.jc.lines(['packageManager'])),
      });
    }
  }
  for (const l of out.lockfiles) {
    b.fact({ key: `lockfile:${l}`, category: 'package', statement: `Lockfile \`${l}\` is tracked`, data: { file: l }, source: b.source(l) });
  }
  // A Map: a manifest saying `packageManager: "constructor"` must not find inherited object members.
  const forManager = new Map<string, string[]>([
    ['pnpm', ['pnpm-lock.yaml']],
    ['npm', ['npm-shrinkwrap.json', 'package-lock.json']], // npm reads the shrinkwrap first when both exist
    ['yarn', ['yarn.lock']],
    ['bun', ['bun.lock', 'bun.lockb']],
  ]);
  const installerOf = new Map<string, string>([
    ['pnpm-lock.yaml', 'pnpm'],
    ['npm-shrinkwrap.json', 'npm'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
  ]);
  const known = out.declared ? forManager.get(out.declared.name) : undefined;
  if (known && out.declared) {
    // A recognised package manager only reads its own lockfile. Another manager's leftover lockfile
    // is reported, never used to state installed versions.
    out.selected = known.find((l) => out.lockfiles.includes(l));
    if (!out.selected && out.lockfiles.length) {
      b.unconfirm(
        'lockfile:other-manager',
        `package.json declares package manager \`${out.declared.name}\` but the tracked lockfile(s) ${out.lockfiles.map((l) => `\`${l}\``).join(', ')} belong to another manager, so installed versions are not read from them`,
        'lockfile does not match the declared package manager',
        b.source(out.lockfiles[0]!),
      );
    }
    out.installer = out.declared.name;
  } else {
    out.selected = out.lockfiles[0];
    out.installer = out.selected ? installerOf.get(out.selected) : undefined;
  }
  if (out.lockfiles.length > 1 && out.selected) {
    b.unconfirm(
      'lockfile:multiple',
      `Several lockfiles are tracked (${out.lockfiles.join(', ')}); installed versions are read from \`${out.selected}\` only`,
      'more than one lockfile',
      b.source(out.selected),
    );
  }
  return out;
}

function packageFacts(b: Builder, pkg: Pkg, manager?: PackageManager): void {
  const { dir, data, jc, path } = pkg;
  const name = typeof data.name === 'string' ? data.name : undefined;
  const type = data.type === 'module' || data.type === 'commonjs' ? data.type : undefined;
  b.fact({
    key: `package:${dir}`,
    category: 'package',
    statement: `Package \`${dir}\` is ${name ? `\`${name}\`` : 'unnamed'}${typeof data.version === 'string' ? ` version ${data.version}` : ''}${type ? `, package type "${type}"` : ''}${data.private === true ? ', private' : ''}`,
    data: clean({ dir, name, version: typeof data.version === 'string' ? data.version : undefined, type, private: data.private === true ? true : undefined }),
    source: b.source(path, jc.lines(['name'])),
  });

  if (isObj(data.scripts)) {
    for (const [script, cmd] of Object.entries(data.scripts)) {
      if (typeof cmd !== 'string') continue;
      b.fact({
        key: `script:${dir}:${script}`,
        category: 'script',
        statement: `Script \`${script}\` in ${path} runs \`${cmd}\``,
        data: { dir, name: script, command: cmd },
        source: b.source(path, jc.lines(['scripts', script])),
      });
    }
    if (dir === '.') {
      for (const [command, names] of Object.entries(COMMAND_SCRIPTS)) {
        const script = names.find((n) => typeof data.scripts[n] === 'string');
        if (!script) continue;
        const invocation = manager?.installer ? `${manager.installer} run ${script}` : undefined;
        b.fact({
          key: `command:${command}`,
          category: 'command',
          statement: `${command[0]!.toUpperCase()}${command.slice(1)} command: root script \`${script}\` = \`${data.scripts[script]}\`${invocation ? ` (run with \`${invocation}\`)` : ''}`,
          data: clean({ script, command: data.scripts[script], invocation }),
          source: b.source(path, jc.lines(['scripts', script])),
        });
      }
    }
  }

  const entry = (kind: string, target: string, jpath: Array<string | number>, label: string) =>
    b.fact({
      key: `entry:${dir}:${kind}`,
      category: 'entry-point',
      statement: `Package \`${dir}\` ${label} \`${target}\``,
      data: { dir, kind, target },
      source: b.source(path, jc.lines(jpath)),
    });
  for (const field of ['main', 'module', 'types', 'typings', 'browser'] as const) {
    if (typeof data[field] === 'string') entry(field, data[field], [field], `${field} entry is`);
  }
  if (typeof data.bin === 'string') {
    entry(`bin:${(name ?? dir).replace(/^@[^/]+\//, '')}`, data.bin, ['bin'], `exposes executable \`${(name ?? dir).replace(/^@[^/]+\//, '')}\` →`);
  } else if (isObj(data.bin)) {
    for (const [cmd, target] of Object.entries(data.bin)) if (typeof target === 'string') entry(`bin:${cmd}`, target, ['bin', cmd], `exposes executable \`${cmd}\` →`);
  }
  const walk = (node: unknown, subpath: string, conditions: string[], jpath: Array<string | number>) => {
    if (typeof node === 'string') {
      entry(`exports:${subpath}:${conditions.join('+') || 'default'}`, node, jpath, `exports \`${subpath}\`${conditions.length ? ` (${conditions.join(', ')})` : ''} →`);
    } else if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, subpath, conditions, [...jpath, i]));
    } else if (isObj(node)) {
      const keys = Object.keys(node);
      if (keys.length && keys.every((k) => k.startsWith('.'))) for (const k of keys) walk(node[k], k, conditions, [...jpath, k]);
      else for (const k of keys) walk(node[k], subpath, [...conditions, k], [...jpath, k]);
    }
  };
  if (data.exports !== undefined) walk(data.exports, '.', [], ['exports']);

  if (isObj(data.engines)) {
    for (const [tool, range] of Object.entries(data.engines)) {
      if (typeof range !== 'string') continue;
      b.fact({
        key: `version:${dir}:engines.${tool}`,
        category: 'version',
        statement: `${path} declares engines.${tool} \`${range}\` (a requirement, not the installed version)`,
        data: { dir, tool, range },
        source: b.source(path, jc.lines(['engines', tool])),
      });
    }
  }
}

function nodeVersionFacts(b: Builder): void {
  for (const file of ['.nvmrc', '.node-version']) {
    const text = b.text(file);
    if (text === undefined) continue;
    // nvm reads the first word of a line and ignores anything after "#" (even when it touches the version).
    const selectors = text
      .split(/\r?\n/)
      .map((raw, i) => ({ value: raw.replace(/#.*$/, '').trim(), line: i + 1 }))
      .filter((x) => x.value !== '');
    if (!selectors.length) continue;
    if (selectors.length > 1) {
      b.unconfirm(
        `unconfirmed:node:${file}`,
        `\`${file}\` lists ${selectors.length} version selectors, so the Node version it selects is not stated`,
        'more than one selector',
        b.source(file, { start: selectors[0]!.line, end: selectors[selectors.length - 1]!.line }),
      );
      continue;
    }
    const { value, line } = selectors[0]!;
    b.fact({
      key: `version:node:${file}`,
      category: 'version',
      statement: /^v?\d+\.\d+\.\d+$/.test(value)
        ? `\`${file}\` pins Node \`${value}\``
        : `\`${file}\` selects Node \`${value}\` (a version selector, not an exact pin)`,
      data: { file, version: value },
      source: b.source(file, { start: line, end: line }),
    });
  }
}

function tsconfigFacts(b: Builder, regular: TreeEntry[]): void {
  for (const e of regular) {
    if (!/^tsconfig(?:\..+)?\.json$/.test(baseName(e.path))) continue;
    const text = b.text(e.path);
    if (text === undefined) continue;
    let jc: Jsonc;
    try {
      jc = parseJsonc(text);
    } catch (err) {
      b.unconfirm(`unparsed:${e.path}`, `\`${e.path}\` could not be parsed, so nothing is stated from it`, (err as Error).message, b.source(e.path));
      continue;
    }
    const options = isObj(jc.value) && isObj(jc.value.compilerOptions) ? jc.value.compilerOptions : {};
    for (const opt of TSCONFIG_LANGUAGE_OPTIONS) {
      if (options[opt] === undefined) continue;
      // Only plain values are copied into facts (a string, number, boolean, or an array of strings such as
      // "lib"). Anything else is reported as unconfirmed, so one odd setting cannot fail the whole snapshot.
      const value = options[opt];
      const plain = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
      const strings = Array.isArray(value) && value.every((x) => typeof x === 'string');
      if (!plain && !strings) {
        b.unconfirm(`unconfirmed:${e.path}:${opt}`, `\`${e.path}\` sets compilerOptions.${opt} to a value that is not a plain setting, so it is not stated`, 'non-plain tsconfig value', b.source(e.path, jc.lines(['compilerOptions', opt])));
        continue;
      }
      b.fact({
        key: `language:${e.path}:${opt}`,
        category: 'language',
        statement: `${e.path} sets compilerOptions.${opt} to ${JSON.stringify(options[opt])}`,
        data: { path: e.path, option: opt, value: options[opt] },
        source: b.source(e.path, jc.lines(['compilerOptions', opt])),
      });
    }
    for (const opt of TSCONFIG_CONVENTION_OPTIONS) {
      if (typeof options[opt] !== 'boolean') continue;
      b.convention({
        key: `convention:tsconfig:${e.path}:${opt}`,
        topic: `tsconfig ${opt}`,
        status: 'confirmed',
        basis: 'config',
        statement: `\`${opt}: ${options[opt]}\` in ${e.path}`,
        source: b.source(e.path, jc.lines(['compilerOptions', opt])),
      });
    }
  }
}

// ------------------------------------------------------------------ dependencies

type Lookup =
  | { kind: 'locked'; version: string; lines?: LineRange }
  | { kind: 'link'; version: string; lines?: LineRange }
  | { kind: 'missing' };
type LockReader = { file: string; lookup(dir: string, section: Section, dep: string): Lookup } | { file: string; notParsed: true } | null;

function classifyPnpmVersion(raw: unknown, lines?: LineRange): Lookup {
  if (typeof raw !== 'string' && typeof raw !== 'number') return { kind: 'missing' };
  const v = String(raw);
  if (v.startsWith('link:')) return { kind: 'link', version: v, lines };
  let core = v.split('(')[0]!.split('_')[0]!;
  const alias = /^\/?(?:@[^/]+\/)?[^@/]+@(.+)$/.exec(core);
  if (alias) core = alias[1]!;
  return { kind: 'locked', version: core, lines };
}

function makeLockReader(b: Builder, manager: PackageManager): LockReader {
  const file = manager.selected;
  if (!file) return null;
  if (file === 'yarn.lock' || file === 'bun.lock' || file === 'bun.lockb') {
    b.unconfirm(
      `unparsed:${file}`,
      `\`${file}\` is tracked but Turbine does not parse it, so installed versions are unknown (declared versions are still reported)`,
      'lockfile format not supported',
      b.source(file),
    );
    return { file, notParsed: true };
  }
  const text = b.text(file);
  if (text === undefined) return { file, notParsed: true };
  const fail = (reason: string): LockReader => {
    b.unconfirm(`unparsed:${file}`, `\`${file}\` could not be parsed, so installed versions are unknown`, reason, b.source(file));
    return { file, notParsed: true };
  };

  if (file === 'pnpm-lock.yaml') {
    const y = parseYamlLines(text);
    if (y.errors.length || !isObj(y.value)) return fail(y.errors[0] ?? 'not a YAML mapping');
    const doc = y.value;
    const hasImporters = isObj(doc.importers);
    const importers: Json = hasImporters ? doc.importers : { '.': doc };
    return {
      file,
      lookup(dir, section, dep) {
        const imp = importers[dir];
        if (!isObj(imp)) return { kind: 'missing' };
        for (const sec of section === 'peerDependencies' ? (['dependencies', 'devDependencies', 'optionalDependencies'] as const) : [section]) {
          const entry = isObj(imp[sec]) ? imp[sec][dep] : undefined;
          if (entry === undefined) continue;
          const base = hasImporters ? ['importers', dir, sec, dep] : [sec, dep];
          if (isObj(entry)) return classifyPnpmVersion(entry.version, y.lines([...base, 'version']) ?? y.lines(base));
          return classifyPnpmVersion(entry, y.lines(base));
        }
        return { kind: 'missing' };
      },
    };
  }

  // package-lock.json / npm-shrinkwrap.json
  let jc: Jsonc;
  try {
    jc = parseJsonc(text);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!isObj(jc.value)) return fail('not a JSON object');
  const lock = jc.value;
  return {
    file,
    lookup(dir, _section, dep) {
      if (isObj(lock.packages)) {
        // node resolution: the nearest node_modules wins, so try every ancestor directory up to the root
        const keys: string[] = [];
        for (let d = dir; ; d = posix.dirname(d)) {
          keys.push(d === '.' ? `node_modules/${dep}` : `${d}/node_modules/${dep}`);
          if (d === '.' || d === '/') break;
        }
        for (const key of keys) {
          const entry = lock.packages[key];
          if (!isObj(entry)) continue;
          if (entry.link === true) return { kind: 'link', version: `link:${typeof entry.resolved === 'string' ? entry.resolved : key}`, lines: jc.lines(['packages', key]) };
          if (typeof entry.version === 'string') return { kind: 'locked', version: entry.version, lines: jc.lines(['packages', key, 'version']) };
        }
        return { kind: 'missing' };
      }
      const v1 = isObj(lock.dependencies) ? lock.dependencies[dep] : undefined;
      if (dir === '.' && isObj(v1) && typeof v1.version === 'string') return { kind: 'locked', version: v1.version, lines: jc.lines(['dependencies', dep, 'version']) };
      return { kind: 'missing' };
    },
  };
}

function dependencyFacts(b: Builder, packages: Pkg[], manager: PackageManager): void {
  const reader = makeLockReader(b, manager);
  for (const pkg of packages) {
    for (const section of SECTIONS) {
      const declared = pkg.data[section];
      if (!isObj(declared)) continue;
      for (const [name, spec] of Object.entries(declared)) {
        if (typeof spec !== 'string') continue;
        const declaredSource = b.source(pkg.path, pkg.jc.lines([section, name]));
        const head = `${name}: declared \`${spec}\` in ${pkg.path} (${section})`;
        const base = { key: `dep:${pkg.dir}:${section}:${name}`, name, workspace: pkg.dir, section, declared: { spec, source: declaredSource } };
        if (!reader) {
          b.dependency({ ...base, installedStatus: 'no-lockfile', relation: 'unchecked', statement: `${head}; no lockfile for this package manager is tracked, so the installed version is unknown` });
          continue;
        }
        if ('notParsed' in reader) {
          b.dependency({ ...base, installedStatus: 'lockfile-not-parsed', relation: 'unchecked', statement: `${head}; installed version unknown (\`${reader.file}\` is not parsed)` });
          continue;
        }
        const found = reader.lookup(pkg.dir, section, name);
        if (found.kind === 'missing') {
          b.dependency({ ...base, installedStatus: 'not-in-lockfile', relation: 'unchecked', statement: `${head}; not found in \`${reader.file}\`` });
          continue;
        }
        if (found.kind === 'locked' && found.version.trim() === '') {
          b.dependency({ ...base, installedStatus: 'not-in-lockfile', relation: 'unchecked', statement: `${head}; the lockfile entry has no version, so the installed version is unknown` });
          continue;
        }
        const installed = { version: found.version, lockfile: reader.file, source: b.source(reader.file, found.lines) };
        if (found.kind === 'link') {
          b.dependency({ ...base, installed, installedStatus: 'workspace-link', relation: 'unchecked', statement: `${head}; resolved by \`${reader.file}\` to workspace ${found.version}` });
          continue;
        }
        // npm installs the optionalDependencies entry when a name is in both sections, so the
        // `dependencies` declaration is not what the lockfile was resolved against.
        const optional = pkg.data.optionalDependencies;
        const overridden = section === 'dependencies' && isObj(optional) && Object.hasOwn(optional, name);
        const relation = overridden ? 'unchecked' : satisfies(found.version, spec);
        const verdict = overridden
          ? 'range not checked (overridden by optionalDependencies)'
          : relation === 'match'
            ? 'satisfies the declared range'
            : relation === 'mismatch'
              ? 'does NOT satisfy the declared range (version drift)'
              : 'range not checked';
        b.dependency({ ...base, installed, installedStatus: 'locked', relation, statement: `${head}; installed ${found.version} per \`${reader.file}\` — ${verdict}` });
      }
    }
  }
}

// ------------------------------------------------------------------ conventions

type Counted = { ok: boolean; entry: TreeEntry; at?: { text: string; index: number; length: number } };

function countConvention(
  b: Builder,
  args: { key: string; topic: string; noun: string; predicate: string; items: Counted[]; exhaustive: boolean; scope: string; skipped?: number },
): void {
  const total = args.items.length;
  if (total === 0) return;
  const matched = args.items.filter((i) => i.ok).length;
  const full = args.exhaustive && matched === total;
  const counterexamples: FactSource[] = full
    ? []
    : args.items
        .filter((i) => !i.ok)
        .slice(0, 3)
        .map((i) => ({
          path: i.entry.path,
          commit: b.commit,
          blob: i.entry.id,
          object: 'blob' as const,
          ...(i.at ? { lines: { start: lineAt(i.at.text, i.at.index), end: lineAt(i.at.text, i.at.index + i.at.length - 1) } } : {}),
        }));
  const counts = `${matched} of ${total} ${args.noun} ${args.predicate}`;
  b.convention({
    key: args.key,
    topic: args.topic,
    status: full ? 'confirmed' : 'unconfirmed',
    basis: 'count',
    statement: full
      ? `All ${total} ${args.noun} ${args.predicate} (exhaustive count over tracked files)`
      : `${counts} (counted over tracked files${args.exhaustive ? '' : `; ${args.skipped ?? 0} files not fully scanned`}) — not a confirmed convention`,
    measured: { matched, total, exhaustive: args.exhaustive, scope: args.scope },
    counterexamples,
    source: b.treeSource(),
  });
}

const FROM_RE = /^[ \t]*(?:import|export)\s[^;'"`()=]*?\bfrom\s*(['"])([^'"\n]+)\1/gm;
const SIDE_EFFECT_RE = /^[ \t]*import\s*(['"])([^'"\n]+)\1/gm;

function conventionFacts(b: Builder, regular: TreeEntry[], sources: TreeEntry[], skipped: number, root: Pkg | null): void {
  // --- measured over the commit's tracked files ---
  // Import counts come from a TEXTUAL scan of import lines. A textual scan cannot prove it saw every import
  // (multi-line statements, import(), require()), so these counts are never confirmed. Confirming them needs
  // a syntax-aware scanner; until then they are reported as unconfirmed counts.
  const relative: Counted[] = [];
  const builtin: Counted[] = [];
  for (const entry of sources) {
    const text = b.blobs.get(entry.id)!.toString('utf8');
    for (const re of [FROM_RE, SIDE_EFFECT_RE]) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const spec = m[2]!;
        const at = { text, index: m.index, length: m[0].length };
        if ((spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') && !ASSET_EXT.test(spec)) {
          relative.push({ ok: /\.js$/.test(spec), entry, at });
        } else if (spec.startsWith('node:') || BARE_BUILTINS.has(spec)) {
          builtin.push({ ok: spec.startsWith('node:'), entry, at });
        }
      }
    }
  }
  const importScope = `${SOURCE_SCOPE}; textual scan of import lines, not a parser`;
  countConvention(b, { key: 'convention:imports:relative-js-extension', topic: 'relative imports carry a .js extension', noun: 'relative import specifiers', predicate: 'end in .js', items: relative, exhaustive: false, scope: importScope, skipped });
  countConvention(b, { key: 'convention:imports:node-prefix', topic: 'Node built-ins imported with the node: prefix', noun: 'Node built-in imports', predicate: 'use the node: prefix', items: builtin, exhaustive: false, scope: importScope, skipped });

  const sourceFiles = regular.filter((e) => SOURCE_EXT.test(e.path));
  countConvention(b, {
    key: 'convention:files:kebab-case',
    topic: 'source file names are kebab-case',
    noun: 'source file names',
    predicate: 'are kebab-case',
    items: sourceFiles
      .filter((e) => baseName(e.path).split('.')[0] !== '')
      .map((e) => ({ ok: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(baseName(e.path).split('.')[0]!), entry: e })),
    exhaustive: b.undecodable === 0,
    scope: SOURCE_SCOPE,
  });
  countConvention(b, {
    key: 'convention:tests:location',
    topic: 'tests live in a tests/, test/ or __tests__/ directory',
    noun: 'test files',
    predicate: 'live in a tests/, test/ or __tests__/ directory',
    items: sourceFiles
      .filter((e) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(e.path))
      .map((e) => ({ ok: e.path.split('/').slice(0, -1).some((s) => s === 'tests' || s === 'test' || s === '__tests__'), entry: e })),
    exhaustive: b.undecodable === 0,
    scope: SOURCE_SCOPE,
  });

  // --- set by config files ---
  prettierConventions(b, regular, root);
  editorconfigConventions(b);
  for (const e of regular) {
    if (e.path.includes('/') || !ESLINT_CONFIG.test(e.path)) continue;
    b.unconfirm(
      `unconfirmed:eslint:${e.path}`,
      `ESLint config \`${e.path}\` is tracked but its rules are not evaluated, so no lint-enforced convention is stated`,
      'ESLint configuration is code / not interpreted',
      b.source(e.path),
    );
  }
}

function prettierConventions(b: Builder, regular: TreeEntry[], root: Pkg | null): void {
  for (const e of regular) {
    if (!e.path.includes('/') && PRETTIER_JS.test(e.path)) {
      b.unconfirm(`unconfirmed:prettier:${e.path}`, `Prettier config \`${e.path}\` is code and is not evaluated, so no formatting convention is stated from it`, 'Prettier configuration is code', b.source(e.path));
    }
  }
  const report = (file: string, get: (opt: string) => unknown, lines: (opt: string) => LineRange | undefined) => {
    for (const opt of PRETTIER_OPTIONS) {
      const v = get(opt);
      if (v === undefined || typeof v === 'object') continue;
      b.convention({
        key: `convention:prettier:${file}:${opt}`,
        topic: `prettier ${opt}`,
        status: 'confirmed',
        basis: 'config',
        statement: `\`${opt}: ${JSON.stringify(v)}\` in ${file} (Prettier config)`,
        source: b.source(file, lines(opt)),
      });
    }
  };
  // Prettier's search order: the `prettier` key of package.json, then of package.yaml, then .prettierrc,
  // .prettierrc.json, .prettierrc.yaml, .prettierrc.yml. The first one found wins; the rest are shadowed.
  const RC = ['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml'];
  // package.yaml: 'unknown' when tracked but unreadable or unparseable (it may or may not set Prettier),
  // undefined when it does not set Prettier, otherwise its parsed prettier value.
  let yaml: 'unknown' | { value: Json; lines: (opt: string) => LineRange | undefined } | undefined;
  if (b.byPath.has('package.yaml')) {
    const text = b.text('package.yaml');
    const y = text === undefined ? undefined : parseYamlLines(text);
    if (!y || y.errors.length) yaml = 'unknown';
    // A falsy setting (for example "prettier: null") is not a configuration, so it does not shadow .prettierrc.
    else if (isObj(y.value) && y.value.prettier) yaml = { value: y.value.prettier as Json, lines: (o) => y.lines(['prettier', o]) };
  }
  const candidates: string[] = [];
  if (root && root.data.prettier !== undefined) candidates.push(root.path);
  if (yaml && yaml !== 'unknown') candidates.push('package.yaml');
  const rcTracked = RC.filter((f) => b.byPath.has(f));
  if (yaml === 'unknown') {
    if (!candidates.length && rcTracked.length) {
      // Whether package.yaml wins is unknown, so no .prettierrc file can be stated to be the one in use.
      for (const f of rcTracked) {
        b.unconfirm(`unknown-precedence:prettier:${f}`, `\`${f}\` may be shadowed by package.yaml, whose Prettier setting could not be read, so its values are not stated`, 'package.yaml not read', b.source(f));
      }
      return;
    }
    b.unconfirm('unparsed:package.yaml', '`package.yaml` is tracked but its Prettier setting could not be read', 'package.yaml not read', b.source('package.yaml'));
  }
  candidates.push(...rcTracked);
  const [winner, ...shadowed] = candidates;
  for (const file of shadowed) {
    b.unconfirm(
      `shadowed:prettier:${file}`,
      `\`${file}\` also sets Prettier options but is shadowed by \`${winner}\`, which Prettier uses first, so its values are not stated`,
      'shadowed Prettier configuration',
      b.source(file),
    );
  }
  if (!winner) return;
  if (root && winner === root.path) {
    const p = root.data.prettier;
    if (isObj(p)) report(root.path, (o) => p[o], (o) => root.jc.lines(['prettier', o]));
    else if (typeof p === 'string') {
      b.unconfirm('unconfirmed:prettier:package.json', `package.json uses shared Prettier config \`${p}\`, which is not resolved`, 'shared config not read', b.source(root.path, root.jc.lines(['prettier'])));
    }
    return;
  }
  if (winner === 'package.yaml' && yaml && yaml !== 'unknown') {
    const p = yaml.value;
    if (isObj(p)) report('package.yaml', (o) => p[o], yaml.lines);
    else if (typeof p === 'string') {
      b.unconfirm('unconfirmed:prettier:package.yaml', `package.yaml uses shared Prettier config \`${p}\`, which is not resolved`, 'shared config not read', b.source('package.yaml'));
    }
    return;
  }
  const text = b.text(winner);
  if (text === undefined) {
    // Tracked but not readable (over the size limit, or a symlink): it still wins, and it was not evaluated.
    b.unconfirm(`unevaluated:prettier:${winner}`, `\`${winner}\` is the Prettier config in use but could not be read, so no formatting convention is stated`, 'Prettier configuration not read', b.source(winner));
    return;
  }
  const unparsed = (message: string) => b.unconfirm(`unparsed:${winner}`, `\`${winner}\` could not be parsed, so nothing is stated from it`, message, b.source(winner));
  let value: unknown;
  let lines: (opt: string) => LineRange | undefined;
  if (winner === '.prettierrc.json') {
    // Strict JSON, as Prettier reads it: comments or trailing commas make the file invalid here too.
    try {
      JSON.parse(text);
      const jc = parseJsonc(text);
      value = jc.value;
      lines = (o) => jc.lines([o]);
    } catch (e) {
      return unparsed((e as Error).message);
    }
  } else {
    // .prettierrc, .prettierrc.yaml and .prettierrc.yml are YAML (JSON is a subset of YAML).
    const y = parseYamlLines(text);
    if (y.errors.length) return unparsed(y.errors[0]!);
    value = y.value;
    lines = (o) => y.lines([o]);
  }
  if (isObj(value)) report(winner, (o) => (value as Json)[o], lines);
}

function editorconfigConventions(b: Builder): void {
  const text = b.text('.editorconfig');
  if (text === undefined) return;
  // Settings in file order, with the section each one sits in. A later setting replaces an earlier one
  // for the same files, so only the effective value of [*] is stated, and only when no other section
  // sets the same key (that section would override it for some files).
  const entries: Array<{ key: string; value: string; section: string; line: number }> = [];
  let section = '';
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) return;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      return;
    }
    const m = /^([A-Za-z_]+)\s*[=:]\s*(.*)$/.exec(line);
    if (!m) return;
    const key = m[1]!.toLowerCase();
    if (EDITORCONFIG_KEYS.has(key)) entries.push({ key, value: m[2]!.trim(), section, line: i + 1 });
  });
  for (const key of [...new Set(entries.map((e) => e.key))].sort()) {
    const mine = entries.filter((e) => e.key === key);
    const global = mine.filter((e) => e.section === '*');
    if (mine.length !== global.length) {
      b.unconfirm(
        `unconfirmed:editorconfig:${key}`,
        `\`${key}\` is set in .editorconfig for some files but overridden in another section, so no single value is stated`,
        'overridden by a more specific section',
        b.source('.editorconfig', { start: mine[0]!.line, end: mine[mine.length - 1]!.line }),
      );
      continue;
    }
    const effective = global[global.length - 1]!;
    // "unset" removes the setting for matching files, so no value is in effect to state.
    if (effective.value.toLowerCase() === 'unset') continue;
    b.convention({
      key: `convention:editorconfig:${key}`,
      topic: `editorconfig ${key}`,
      status: 'confirmed',
      basis: 'config',
      statement: `\`${key} = ${effective.value}\` under [*] in .editorconfig`,
      source: b.source('.editorconfig', { start: effective.line, end: effective.line }),
    });
  }
}

// ------------------------------------------------------------------ diff

type Item = { statement: string; fingerprint: string };

function itemsOf(s: RepoSnapshot): Map<string, Item> {
  const out = new Map<string, Item>();
  for (const f of s.facts) out.set(f.key, { statement: f.statement, fingerprint: canonicalJson([f.statement, f.data ?? null]) });
  for (const d of s.dependencies) out.set(d.key, { statement: d.statement, fingerprint: canonicalJson([d.statement, d.declared.spec, d.installed?.version ?? null, d.relation]) });
  for (const c of s.conventions) out.set(c.key, { statement: c.statement, fingerprint: canonicalJson([c.statement, c.status, c.measured ?? null]) });
  for (const u of s.unconfirmed) out.set(u.key, { statement: u.statement, fingerprint: canonicalJson([u.statement]) });
  return out;
}

/**
 * Compare two snapshots by fact key. A fact counts as changed when what it states changed; a
 * new commit alone (the sources' commit id) is not a change.
 */
export function diffSnapshots(prev: RepoSnapshot, next: RepoSnapshot): SnapshotDiff {
  const a = itemsOf(prev);
  const n = itemsOf(next);
  const diff: SnapshotDiff = { added: [], removed: [], changed: [] };
  for (const [key, item] of n) {
    const before = a.get(key);
    if (!before) diff.added.push({ key, statement: item.statement });
    else if (before.fingerprint !== item.fingerprint) diff.changed.push({ key, before: before.statement, after: item.statement });
  }
  for (const [key, item] of a) if (!n.has(key)) diff.removed.push({ key, statement: item.statement });
  diff.added.sort(byKey);
  diff.removed.sort(byKey);
  diff.changed.sort(byKey);
  return diff;
}
