import { posix } from 'node:path';
import { parseJsonc } from './jsonc.js';

/**
 * What a package's tsconfig proves about build output. A workspace package usually names a built file
 * (`./dist/index.js`) that is not tracked; the source it was built from may be, but only when the config really
 * emits that file from that source:
 *   - the entry config and the configs it `extends` (relative paths only) are read at the commit;
 *   - `noEmit`, `emitDeclarationOnly`, `declaration` / `composite`, `jsx` and `allowJs` decide which output kinds exist;
 *   - the source must be a compilation input: listed in `files`, or matched by `include` and not by `exclude`.
 * Anything that cannot be proven (an unreadable or non-relative `extends`, a glob syntax this does not model, a
 * hidden directory) leaves the mapping unconfirmed: no edge is stated.
 */

export type BuildConfig = {
  /** The tsconfig that was asked about (repo-relative). */
  file: string;
  outDir?: string;
  rootDir?: string;
  noEmit: boolean;
  emitDeclarationOnly: boolean;
  declaration: boolean;
  composite: boolean;
  allowJs: boolean;
  jsx?: string;
  /** Repo-relative file paths and glob patterns, resolved against the config that wrote them. */
  files?: string[];
  include?: string[];
  exclude?: string[];
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const MAX_EXTENDS = 8;

/** The merged options of a tsconfig and its relative `extends` chain; undefined when it is missing or cannot be read exactly. */
export function loadBuildConfig(file: string, text: (path: string) => string | undefined): BuildConfig | undefined {
  const chain: Array<{ dir: string; data: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  let cur: string | undefined = file;
  while (cur !== undefined) {
    if (seen.has(cur) || chain.length >= MAX_EXTENDS) return undefined;
    seen.add(cur);
    const raw = text(cur);
    if (raw === undefined) return undefined;
    let data: unknown;
    try {
      data = parseJsonc(raw).value;
    } catch {
      return undefined;
    }
    if (!isObj(data)) return undefined;
    if (data.compilerOptions !== undefined && !isObj(data.compilerOptions)) return undefined;
    const dir = posix.dirname(cur);
    chain.unshift({ dir, data });
    const ext: unknown = data.extends;
    if (ext === undefined) break;
    if (typeof ext !== 'string' || !(ext.startsWith('./') || ext.startsWith('../'))) return undefined;
    const next = posix.join(dir, ext.endsWith('.json') ? ext : `${ext}.json`);
    if (next === '..' || next.startsWith('../')) return undefined;
    cur = next;
  }

  const cfg: BuildConfig = { file, noEmit: false, emitDeclarationOnly: false, declaration: false, composite: false, allowJs: false };
  const list = (v: unknown, dir: string): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]).map((x) => posix.join(dir, x)) : undefined);
  for (const { dir, data } of chain) {
    const co = (data.compilerOptions ?? {}) as Record<string, unknown>;
    if (typeof co.outDir === 'string') cfg.outDir = posix.join(dir, co.outDir);
    if (typeof co.rootDir === 'string') cfg.rootDir = posix.join(dir, co.rootDir);
    if (typeof co.noEmit === 'boolean') cfg.noEmit = co.noEmit;
    if (typeof co.emitDeclarationOnly === 'boolean') cfg.emitDeclarationOnly = co.emitDeclarationOnly;
    if (typeof co.declaration === 'boolean') cfg.declaration = co.declaration;
    if (typeof co.composite === 'boolean') cfg.composite = co.composite;
    if (typeof co.allowJs === 'boolean') cfg.allowJs = co.allowJs;
    if (typeof co.jsx === 'string') cfg.jsx = co.jsx.toLowerCase();
    const files = list(data.files, dir);
    const include = list(data.include, dir);
    const exclude = list(data.exclude, dir);
    if (files) cfg.files = files;
    if (include) cfg.include = include;
    if (exclude) cfg.exclude = exclude;
  }
  return cfg;
}

// ------------------------------------------------------------ globs (the syntax tsconfig documents)

type Tri = true | false | 'unknown';

const segmentRe = (seg: string): RegExp => new RegExp(`^${seg.replace(/[.+^$|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);

function segmentsMatch(pat: string[], path: string[]): boolean {
  if (!pat.length) return !path.length;
  if (pat[0] === '**') return segmentsMatch(pat.slice(1), path) || (path.length > 0 && segmentsMatch(pat, path.slice(1)));
  if (!path.length) return false;
  return segmentRe(pat[0]!).test(path[0]!) && segmentsMatch(pat.slice(1), path.slice(1));
}

/** A pattern this module models: `*`, `?` and `**` segments only. */
const modelled = (pattern: string): boolean => !/[[\]{}()!\\]/.test(pattern) && pattern.split('/').every((s) => s === '**' || !s.includes('**'));

function matchInclude(pattern: string, source: string): Tri {
  if (!modelled(pattern)) return 'unknown';
  const segs = pattern.split('/');
  const last = segs[segs.length - 1]!;
  // a last segment with no wildcard and no extension names a directory
  if (!/[*?]/.test(last) && !last.includes('.')) segs.push('**', '*');
  return segmentsMatch(segs, source.split('/'));
}

function matchExclude(pattern: string, source: string): Tri {
  if (!modelled(pattern)) return 'unknown';
  const segs = pattern.split('/');
  const path = source.split('/');
  for (let n = 1; n <= path.length; n++) if (segmentsMatch(segs, path.slice(0, n))) return true;
  return false;
}

/** Whether the config compiles this source file. `true` only when it is proven. */
function isInput(cfg: BuildConfig, source: string): Tri {
  if (source.split('/').some((s) => s.startsWith('.'))) return 'unknown'; // wildcards skip hidden names; not modelled
  if (cfg.files?.includes(source)) return true;
  const base = posix.dirname(cfg.file);
  const include = cfg.include ?? (cfg.files ? [] : [posix.join(base, '**/*')]);
  const exclude = cfg.exclude ?? ['node_modules', 'bower_components', 'jspm_packages', ...(cfg.outDir ? [cfg.outDir] : [])].map((p) => posix.join(base, p));
  const inc = include.map((p) => matchInclude(p, source));
  if (!inc.includes(true)) return inc.includes('unknown') ? 'unknown' : false;
  const exc = exclude.map((p) => matchExclude(p, source));
  if (exc.includes(true)) return false;
  return exc.includes('unknown') ? 'unknown' : true;
}

/** The source extensions whose compilation can write a file with this output extension, under this config. */
function sourcesFor(cfg: BuildConfig, outExt: string): string[] {
  const reactJsx = cfg.jsx === 'react' || cfg.jsx === 'react-jsx' || cfg.jsx === 'react-jsxdev' || cfg.jsx === 'react-native';
  switch (outExt) {
    case '.d.ts':
      return cfg.declaration || cfg.composite ? ['.ts', '.tsx'] : [];
    case '.d.mts':
      return cfg.declaration || cfg.composite ? ['.mts'] : [];
    case '.d.cts':
      return cfg.declaration || cfg.composite ? ['.cts'] : [];
    case '.js':
      return cfg.emitDeclarationOnly ? [] : ['.ts', ...(reactJsx ? ['.tsx'] : []), ...(cfg.allowJs ? ['.js', '.jsx'] : [])];
    case '.jsx':
      return cfg.emitDeclarationOnly || cfg.jsx !== 'preserve' ? [] : ['.tsx'];
    case '.mjs':
      return cfg.emitDeclarationOnly ? [] : ['.mts', ...(cfg.allowJs ? ['.mjs'] : [])];
    case '.cjs':
      return cfg.emitDeclarationOnly ? [] : ['.cts', ...(cfg.allowJs ? ['.cjs'] : [])];
    default:
      return [];
  }
}

const OUT_EXT = /(\.d\.[cm]?ts|\.[cm]?jsx?)$/;

/**
 * The tracked source a config compiles into `output`, with the proof, or undefined. Needs an explicit `outDir` and
 * `rootDir`, no `noEmit`, an output kind the options produce, and a source that is proven to be a compilation input.
 */
export function sourceOfBuildOutput(cfg: BuildConfig, output: string, tracked: Set<string>): { source: string; how: string } | undefined {
  const { outDir, rootDir } = cfg;
  if (!outDir || !rootDir || cfg.noEmit) return undefined;
  if (!output.startsWith(`${outDir}/`)) return undefined;
  const rel = output.slice(outDir.length + 1);
  const m = OUT_EXT.exec(rel);
  if (!m) return undefined;
  const stem = rel.slice(0, rel.length - m[0].length);
  for (const ext of sourcesFor(cfg, m[0])) {
    const source = posix.join(rootDir, `${stem}${ext}`);
    if (!tracked.has(source)) continue;
    if (isInput(cfg, source) !== true) continue;
    return { source, how: `${cfg.file} compiles rootDir "${rootDir}" into outDir "${outDir}" (noEmit is not set) and has ${source} as an input` };
  }
  return undefined;
}
