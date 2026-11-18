import { posix } from 'node:path';
import type { ImportEdge, ImportKind } from '@turbine-hall/turbine-contracts';
import { parseJsonc } from './jsonc.js';
import { scanModule, type ScannedExport } from './js-scan.js';

/**
 * The import graph of the files at ONE commit. Every edge is a statement found in a blob at that commit,
 * resolved to a tracked file by a rule that is recorded on the edge:
 *   - a relative specifier is resolved against the importing file's directory, probing extensions the way
 *     TypeScript / Node do (`./x.js` finds `x.ts`; `./dir` finds `dir/index.*`);
 *   - a workspace package name (`@scope/pkg`) is resolved to that package's entry file, when the entry can be
 *     proven from the commit (see `workspaceEntry`). A package with `exports` is resolved by its conditions, in
 *     manifest order, for the way the file imports it (`import` or `require`); where that way is not known
 *     (a type-only import) and the targets differ, no edge is stated.
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

/**
 * The targets of an `exports` value for one mode. Conditions are tried in the order the manifest writes them and
 * the first one that applies decides (Node's rule), even when its value is `null`: that blocks the package.
 * Applicable here: the mode itself, `default` and `node`. Others (`types`, `browser`, ...) are not claimed.
 */
function conditionTargets(value: unknown, mode: 'import' | 'require', depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((v) => conditionTargets(v, mode, depth + 1));
  if (!isObj(value) || depth > 4) return [];
  for (const [key, v] of Object.entries(value)) {
    if (key === mode || key === 'default' || key === 'node') return conditionTargets(v, mode, depth + 1);
  }
  return [];
}

export function makeResolver(files: Set<string>, text: (path: string) => string | undefined, workspaces: WorkspacePackage[]): Resolver {
  const byName = new Map<string, WorkspacePackage>();
  for (const w of workspaces) if (w.name) byName.set(w.name, w);
  /** By package and mode: the same package can have one entry for `import` and another for `require`. */
  const entries = new Map<string, Resolution | undefined>();

  /** The entry file of a workspace package, proven from its package.json (and tsconfig.json) at the commit. */
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
    const targets: string[] = [];
    const ex = data.exports;
    if (ex !== undefined && ex !== null) {
      // "exports" encapsulates the package: main/module are not consulted when it is present.
      if (typeof ex === 'string' || Array.isArray(ex)) targets.push(...conditionTargets(ex, mode));
      else if (isObj(ex)) {
        const keys = Object.keys(ex);
        // "exports" is either a map of sub-paths or the conditions of "." directly.
        if (keys.some((k) => k.startsWith('.'))) targets.push(...conditionTargets(ex['.'], mode));
        else targets.push(...conditionTargets(ex, mode));
      }
      if (!targets.length) return undefined;
    } else {
      for (const f of ['module', 'main', 'types', 'typings'] as const) if (typeof data[f] === 'string') targets.push(data[f] as string);
      if (!targets.length) targets.push('index.js');
    }

    const tsconfig = `${pkg.dir === '.' ? '' : `${pkg.dir}/`}tsconfig.json`;
    let outDir: string | undefined;
    let rootDir: string | undefined;
    const tsRaw = text(tsconfig);
    if (tsRaw !== undefined) {
      try {
        const co = (parseJsonc(tsRaw).value as { compilerOptions?: Record<string, unknown> } | null)?.compilerOptions;
        if (typeof co?.outDir === 'string') outDir = co.outDir;
        if (typeof co?.rootDir === 'string') rootDir = co.rootDir;
      } catch {
        /* an unreadable tsconfig proves nothing */
      }
    }

    for (const target of [...new Set(targets)]) {
      const path = posix.join(pkg.dir, target);
      if (path === '..' || path.startsWith('../')) continue;
      const direct = probe(path, files);
      if (direct) return { to: direct.path, how: `entry "${target}" of ${manifest} (${direct.how})` };
      if (outDir && rootDir) {
        const outAbs = posix.join(pkg.dir, outDir);
        const rootAbs = posix.join(pkg.dir, rootDir);
        if (path.startsWith(`${outAbs}/`)) {
          let rel = path.slice(outAbs.length + 1);
          const ext = posix.extname(rel);
          rel = rel.endsWith('.d.ts') ? rel.slice(0, -5) : rel.slice(0, rel.length - ext.length);
          const order = ext === '.mjs' ? ['.mts', '.ts'] : ext === '.cjs' ? ['.cts', '.ts'] : ['.ts', '.tsx'];
          for (const e of order) {
            const src = posix.join(rootAbs, `${rel}${e}`);
            if (files.has(src)) {
              return { to: src, how: `entry "${target}" of ${manifest} is build output: ${tsconfig} compiles rootDir "${rootDir}" into outDir "${outDir}", so its source is ${src}` };
            }
          }
        }
      }
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
  unresolvedRelative: number;
  unresolvedPackage: number;
};

/** Scan every source file whose text was read and resolve its imports. */
export function buildGraph(sourcePaths: string[], text: (path: string) => string | undefined, resolver: Resolver): Graph {
  const modules = new Map<string, ModuleInfo>();
  const incoming = new Map<string, ImportEdge[]>();
  const unreadable: string[] = [];
  let unresolvedRelative = 0;
  let unresolvedPackage = 0;
  for (const path of sourcePaths) {
    const t = text(path);
    if (t === undefined) continue;
    const scan = scanModule(t);
    if (!scan.ok) {
      unreadable.push(path);
      continue;
    }
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
  return { modules, incoming, unreadable, unresolvedRelative, unresolvedPackage };
}
