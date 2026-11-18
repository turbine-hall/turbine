import { posix } from 'node:path';
import type { ImportEdge } from '@turbine-hall/turbine-contracts';
import { parseJsonc } from './jsonc.js';
import { scanModule, type ScannedExport } from './js-scan.js';

/**
 * The import graph of the files at ONE commit. Every edge is a statement found in a blob at that commit,
 * resolved to a tracked file by a rule that is recorded on the edge:
 *   - a relative specifier is resolved against the importing file's directory, probing extensions the way
 *     TypeScript / Node do (`./x.js` finds `x.ts`; `./dir` finds `dir/index.*`);
 *   - a workspace package name (`@scope/pkg`) is resolved to that package's entry file, when the entry can be
 *     proven from the commit (see `workspaceEntry`).
 * Not resolved, and therefore never stated: tsconfig `paths` / `baseUrl` aliases, sub-path imports of workspace
 * packages, packages from node_modules, and anything computed at run time.
 */

export const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;

export type WorkspacePackage = { dir: string; name?: string };

export type Resolution = { to: string; resolution: string };
export type Unresolved = { unresolved: 'relative' | 'package' | 'external' };

export type Resolver = {
  resolve(from: string, specifier: string): Resolution | Unresolved;
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

function conditionTargets(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (!isObj(value) || depth > 4) return [];
  const out: string[] = [];
  for (const key of ['import', 'default', 'require', 'node', 'types']) if (key in value) out.push(...conditionTargets(value[key], depth + 1));
  return out;
}

export function makeResolver(files: Set<string>, text: (path: string) => string | undefined, workspaces: WorkspacePackage[]): Resolver {
  const byName = new Map<string, WorkspacePackage>();
  for (const w of workspaces) if (w.name) byName.set(w.name, w);
  const entries = new Map<string, Resolution | undefined>();

  /** The entry file of a workspace package, proven from its package.json (and tsconfig.json) at the commit. */
  const workspaceEntry = (pkg: WorkspacePackage): { to: string; how: string } | undefined => {
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
    if (typeof ex === 'string') targets.push(ex);
    else if (isObj(ex)) {
      const keys = Object.keys(ex);
      // "exports" is either a map of sub-paths or the conditions of "." directly.
      if (keys.some((k) => k.startsWith('.'))) targets.push(...conditionTargets(ex['.']));
      else targets.push(...conditionTargets(ex));
    }
    for (const f of ['module', 'main', 'types', 'typings'] as const) if (typeof data[f] === 'string') targets.push(data[f] as string);
    if (!targets.length) targets.push('index.js');

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
    resolve(from, specifier) {
      if (specifier.startsWith('.')) {
        const base = posix.join(posix.dirname(from), specifier);
        if (base === '..' || base.startsWith('../')) return { unresolved: 'relative' };
        const hit = probe(base === '.' ? '.' : base, files);
        return hit ? { to: hit.path, resolution: `relative specifier "${specifier}" from ${posix.dirname(from)}/ (${hit.how})` } : { unresolved: 'relative' };
      }
      const pkg = byName.get(specifier);
      if (!pkg) return { unresolved: 'external' };
      if (!entries.has(pkg.dir)) {
        const e = workspaceEntry(pkg);
        entries.set(pkg.dir, e ? { to: e.to, resolution: `workspace package "${specifier}" (${pkg.dir}): ${e.how}` } : undefined);
      }
      return entries.get(pkg.dir) ?? { unresolved: 'package' };
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
      const r = resolver.resolve(path, imp.specifier);
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
