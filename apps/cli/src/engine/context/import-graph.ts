import { posix } from 'node:path';
import type { ImportEdge, ImportKind } from '@turbine-hall/turbine-contracts';
import { parseJsonc } from './jsonc.js';
import { jsxFile, scanModule, type ScannedExport } from './js-scan.js';
import { loadBuildConfig, sourceOfBuildOutput } from './tsconfig-view.js';

/**
 * The import graph of the files at ONE commit. Every edge is a statement found in a blob at that commit,
 * resolved to a tracked file by a rule that is recorded on the edge:
 *   - a relative specifier is resolved against the importing file's directory, probing extensions the way
 *     TypeScript / Node do (`./x.js` finds `x.ts`; `./dir` finds `dir/index.*`);
 *   - a workspace package name (`@scope/pkg`) is resolved to that package's entry file, when the entry can be
 *     proven from the commit (see `workspaceEntry`). A package with `exports` is resolved the way Node selects a
 *     target, for the way the file imports it (`import` or `require`); where that way is not known (a type-only
 *     import) and the targets differ, no edge is stated.
 * Not resolved, and therefore never stated: tsconfig `paths` / `baseUrl` aliases, sub-path imports of workspace
 * packages, packages from node_modules, and anything computed at run time.
 */

export const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;

export type WorkspacePackage = { dir: string; name?: string };

export type Resolution = { to: string; resolution: string };
export type Unresolved = { unresolved: 'relative' | 'package' | 'external' };

/** How a file reaches a package: the `import` or the `require` condition of its `exports`, or not known. */
export type ResolveMode = 'import' | 'require' | 'unknown';

/** The resolution mode of a statement: `require()` is CommonJS, type-only imports follow TypeScript's own choice. */
export function modeOf(kind: ImportKind): ResolveMode {
  return kind === 'require' ? 'require' : kind === 'import-type' ? 'unknown' : 'import';
}

export type Resolver = {
  resolve(from: string, specifier: string, mode: ResolveMode): Resolution | Unresolved;
};

const PROBE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.js'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The tracked file a path stands for, probing extensions and directory indexes. */
function probe(base: string, files: Set<string>): { path: string; how: string } | undefined {
  const ext = posix.extname(base);
  const swap = JS_TO_TS[ext];
  if (swap) {
    for (const e of swap) {
      const cand = base.slice(0, base.length - ext.length) + e;
      if (files.has(cand)) return { path: cand, how: e === ext ? 'exact file' : `${ext} specifier resolved to its ${e} source (TypeScript rule)` };
    }
  }
  if (files.has(base)) return { path: base, how: 'exact file' };
  for (const e of PROBE_EXTS) if (files.has(`${base}${e}`)) return { path: `${base}${e}`, how: `extension ${e} added` };
  for (const e of PROBE_EXTS) {
    const cand = posix.join(base, `index${e}`);
    if (files.has(cand)) return { path: cand, how: `directory index (index${e})` };
  }
  return undefined;
}

/** What one `exports` value says for one mode. `ambiguous`: the answer depends on the Node version, so nothing is claimed. */
type Pick = { target: string } | 'blocked' | 'invalid' | 'unmatched' | 'ambiguous';

/** Node's own check (lib/internal/modules/esm/resolve.js): a `.` or `..` or `node_modules` segment, however it is escaped. */
const INVALID_SEGMENT = /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))(\\|\/|$)/i;

/**
 * Node's choice for one `exports` value and one mode (checked against Node's behaviour, see the tests):
 *   - `null` blocks; an empty array blocks;
 *   - a string must start with `./` and have no `.`, `..` or `node_modules` segment, however escaped;
 *   - an array: the first entry that gives a target wins. An entry that gives no answer is passed over, an entry
 *     that is `null` or invalid is passed over too, but if no entry gives a target the last such outcome stands.
 *     A target whose file is missing is NOT passed over: Node does not fall back, it reports the file missing;
 *   - conditions, in manifest order: `default`, `node`, `node-addons` and the mode itself apply. A nested object
 *     with no answer is passed over and the next key is tried; `null` blocks. `module-sync` applies on some Node
 *     versions only, so reaching it makes the answer ambiguous. Array-index keys are invalid.
 */
function pickExport(value: unknown, mode: 'import' | 'require', depth = 0): Pick {
  if (depth > 8) return 'invalid';
  if (value === null) return 'blocked';
  if (typeof value === 'string') return value.startsWith('./') && !INVALID_SEGMENT.test(value.slice(2)) ? { target: value } : 'invalid';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'blocked';
    let last: 'unmatched' | 'blocked' | 'invalid' = 'unmatched';
    for (const v of value) {
      const r = pickExport(v, mode, depth + 1);
      if (typeof r === 'object' || r === 'ambiguous') return r;
      if (r !== 'unmatched') last = r;
    }
    return last;
  }
  if (!isObj(value)) return 'invalid';
  const keys = Object.keys(value);
  if (keys.some((k) => /^\d+$/.test(k))) return 'invalid';
  for (const key of keys) {
    if (key === 'module-sync') return 'ambiguous';
    if (key !== mode && key !== 'default' && key !== 'node' && key !== 'node-addons') continue;
    const r = pickExport(value[key], mode, depth + 1);
    if (r !== 'unmatched') return r;
  }
  return 'unmatched';
}

/** The `exports` of a package for its entry (`.`): a string, an array or conditions are sugar for `.`; a map of sub-paths is looked up. */
function exportsEntry(ex: unknown, mode: 'import' | 'require'): Pick {
  if (typeof ex === 'string' || Array.isArray(ex)) return pickExport(ex, mode);
  if (!isObj(ex)) return 'invalid';
  const keys = Object.keys(ex);
  const sub = keys.map((k) => k.startsWith('.'));
  if (sub.some(Boolean) && !sub.every(Boolean)) return 'invalid'; // Node: a map that mixes sub-paths and conditions is invalid
  if (sub.length && sub[0]) return ex['.'] === undefined ? 'unmatched' : pickExport(ex['.'], mode);
  return keys.length ? pickExport(ex, mode) : 'unmatched';
}

/**
 * The tracked path an `exports` target names, resolved as a file URL under the package directory the way Node does:
 * percent-escapes are decoded, an escaped `/` or `\` is refused, and a query or fragment is not trusted.
 */
function targetPath(pkgDir: string, target: string): string | undefined {
  const root = new URL('file:///r/');
  const base = new URL(pkgDir === '.' ? '.' : `${pkgDir.split('/').map(encodeURIComponent).join('/')}/`, root);
  let url: URL;
  try {
    url = new URL(target, base);
  } catch {
    return undefined;
  }
  if (url.search || url.hash || !url.pathname.startsWith(base.pathname) || /%2f|%5c/i.test(url.pathname)) return undefined;
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname.slice(base.pathname.length));
  } catch {
    return undefined;
  }
  if (rel === '' || rel.endsWith('/')) return undefined;
  const path = posix.join(pkgDir, rel);
  return path === '..' || path.startsWith('../') ? undefined : path;
}

export function makeResolver(files: Set<string>, text: (path: string) => string | undefined, workspaces: WorkspacePackage[]): Resolver {
  const byName = new Map<string, WorkspacePackage>();
  for (const w of workspaces) if (w.name) byName.set(w.name, w);
  /** By package and mode: the same package can have one entry for `import` and another for `require`. */
  const entries = new Map<string, Resolution | undefined>();

  /** The entry file of a workspace package for one mode, proven from its manifest (and tsconfig) at the commit. */
  const workspaceEntry = (pkg: WorkspacePackage, mode: 'import' | 'require'): { to: string; how: string } | undefined => {
    const manifest = pkg.dir === '.' ? 'package.json' : `${pkg.dir}/package.json`;
    const raw = text(manifest);
    if (raw === undefined) return undefined;
    let data: Record<string, unknown>;
    try {
      const v = parseJsonc(raw).value;
      if (!isObj(v)) return undefined;
      data = v;
    } catch {
      return undefined;
    }

    // With "exports" (anything but absent or null), Node reads only that: `main` is not consulted and the target is
    // exactly one file. Without it, the legacy entry is `main`, then `index.js`; `module`, `types` and `typings`
    // are bundler and TypeScript conventions, not what Node loads, so they are not used.
    const candidates: Array<{ target: string; path: string; exact: boolean }> = [];
    const viaExports = data.exports !== undefined && data.exports !== null;
    if (viaExports) {
      const top = exportsEntry(data.exports, mode);
      if (typeof top !== 'object') return undefined; // blocked, invalid, ambiguous or not exported: nothing is claimed
      const path = targetPath(pkg.dir, top.target);
      if (!path) return undefined;
      candidates.push({ target: top.target, path, exact: true });
    } else {
      const legacy = [...(typeof data.main === 'string' && data.main !== '' && !data.main.startsWith('/') ? [data.main] : []), 'index.js'];
      for (const target of legacy) {
        const path = posix.join(pkg.dir, target);
        if (path !== '..' && !path.startsWith('../')) candidates.push({ target, path, exact: false });
      }
    }

    const tsconfig = `${pkg.dir === '.' ? '' : `${pkg.dir}/`}tsconfig.json`;
    const build = loadBuildConfig(tsconfig, text);

    for (const { target, path, exact } of candidates) {
      const direct = exact ? (files.has(path) ? { path, how: 'exact file' } : undefined) : probe(path, files);
      if (direct) return { to: direct.path, how: `entry "${target}" of ${manifest} (${viaExports ? 'exports' : 'main'}: ${direct.how})` };
      const built = build ? sourceOfBuildOutput(build, path, files) : undefined;
      if (built) return { to: built.source, how: `entry "${target}" of ${manifest} is build output: ${built.how}, so its source is ${built.source}` };
    }
    return undefined;
  };

  return {
    resolve(from, specifier, mode) {
      if (specifier.startsWith('.')) {
        const base = posix.join(posix.dirname(from), specifier);
        if (base === '..' || base.startsWith('../')) return { unresolved: 'relative' };
        const hit = probe(base === '.' ? '.' : base, files);
        return hit ? { to: hit.path, resolution: `relative specifier "${specifier}" from ${posix.dirname(from)}/ (${hit.how})` } : { unresolved: 'relative' };
      }
      const pkg = byName.get(specifier);
      if (!pkg) return { unresolved: 'external' };
      const entry = (m: 'import' | 'require'): Resolution | undefined => {
        const key = `${pkg.dir}\0${m}`;
        if (!entries.has(key)) {
          const e = workspaceEntry(pkg, m);
          entries.set(key, e ? { to: e.to, resolution: `workspace package "${specifier}" (${pkg.dir}), ${m} condition: ${e.how}` } : undefined);
        }
        return entries.get(key);
      };
      if (mode !== 'unknown') return entry(mode) ?? { unresolved: 'package' };
      // Mode not known: a target is claimed only when both modes agree on it.
      const viaImport = entry('import');
      const viaRequire = entry('require');
      return viaImport && viaRequire && viaImport.to === viaRequire.to ? viaImport : { unresolved: 'package' };
    },
  };
}

export type ModuleInfo = {
  path: string;
  exports: ScannedExport[];
  edges: ImportEdge[];
};

export type Graph = {
  modules: Map<string, ModuleInfo>;
  /** Edges by the file they point at. */
  incoming: Map<string, ImportEdge[]>;
  unreadable: string[];
  /** `require()` calls not stated because `require` is bound in the file. */
  unconfirmed: number;
  unresolvedRelative: number;
  unresolvedPackage: number;
};

/** Scan every source file whose text was read and resolve its imports. */
export function buildGraph(sourcePaths: string[], text: (path: string) => string | undefined, resolver: Resolver): Graph {
  const modules = new Map<string, ModuleInfo>();
  const incoming = new Map<string, ImportEdge[]>();
  const unreadable: string[] = [];
  let unconfirmed = 0;
  let unresolvedRelative = 0;
  let unresolvedPackage = 0;
  for (const path of sourcePaths) {
    const t = text(path);
    if (t === undefined) continue;
    const scan = scanModule(t, { jsx: jsxFile(path) });
    if (!scan.ok) {
      unreadable.push(path);
      continue;
    }
    unconfirmed += scan.unconfirmed;
    const edges: ImportEdge[] = [];
    for (const imp of scan.imports) {
      const r = resolver.resolve(path, imp.specifier, modeOf(imp.kind));
      if ('unresolved' in r) {
        if (r.unresolved === 'relative') unresolvedRelative++;
        else if (r.unresolved === 'package') unresolvedPackage++;
        continue;
      }
      const edge: ImportEdge = { from: path, line: imp.line, statement: imp.statement, specifier: imp.specifier, kind: imp.kind, to: r.to, resolution: r.resolution };
      edges.push(edge);
      if (!incoming.has(edge.to)) incoming.set(edge.to, []);
      incoming.get(edge.to)!.push(edge);
    }
    modules.set(path, { path, exports: scan.exports, edges });
  }
  return { modules, incoming, unreadable, unconfirmed, unresolvedRelative, unresolvedPackage };
}
