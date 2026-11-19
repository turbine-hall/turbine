import { posix } from 'node:path';
import { prefixMatches } from './glob.js';
import { parseJsonc } from './jsonc.js';

/**
 * What a package's tsconfig proves about build output. A workspace package usually names a built file
 * (`./dist/index.js`) that is not tracked; the source it was built from may be, but only when the config really
 * emits that file from that source:
 *   - the entry config and the configs it `extends` (relative paths only) are read at the commit;
 *   - `noEmit`, `emitDeclarationOnly`, `declaration` / `composite`, `declarationDir`, `jsx` and `allowJs` decide
 *     which output files exist and where;
 *   - the source must be a compilation input: listed in `files`, or matched by `include` and not by `exclude`.
 * Anything that cannot be proven (an unreadable or non-relative `extends`, an absolute path, a path that leaves the
 * repository, a glob syntax this does not model, a hidden directory) leaves the mapping unconfirmed: no edge is stated.
 */

export type BuildConfig = {
  /** The tsconfig that was asked about (repo-relative). */
  file: string;
  /** Repo-relative: already resolved against the config that wrote them. */
  outDir?: string;
  declarationDir?: string;
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
/** Work limits for glob matching: a pattern or a path beyond them is not matched, so the mapping is unconfirmed. */
const MAX_PATTERN_CHARS = 512;
const MAX_SEGMENTS = 64;

class Unproven extends Error {}

/** A path written in a config, resolved against that config's directory. Absolute paths and paths leaving the repository are refused. */
function resolveIn(dir: string, value: string): string {
  if (value === '' || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value) || value.includes('\\')) throw new Unproven();
  const joined = posix.join(dir, value);
  if (joined === '..' || joined.startsWith('../')) throw new Unproven();
  return joined;
}

const pathIn = (dir: string, v: unknown): string => {
  if (typeof v !== 'string') throw new Unproven();
  return resolveIn(dir, v);
};

/** The merged options of a tsconfig and its relative `extends` chain; undefined when it is missing or cannot be read exactly. */
export function loadBuildConfig(file: string, text: (path: string) => string | undefined): BuildConfig | undefined {
  try {
    return load(file, text);
  } catch (e) {
    if (e instanceof Unproven) return undefined;
    throw e;
  }
}

function load(file: string, text: (path: string) => string | undefined): BuildConfig {
  const chain: Array<{ dir: string; data: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  let cur: string | undefined = file;
  while (cur !== undefined) {
    if (seen.has(cur) || chain.length >= MAX_EXTENDS) throw new Unproven();
    seen.add(cur);
    const raw = text(cur);
    if (raw === undefined) throw new Unproven();
    let data: unknown;
    try {
      data = parseJsonc(raw).value;
    } catch {
      throw new Unproven();
    }
    if (!isObj(data)) throw new Unproven();
    if (data.compilerOptions !== undefined && !isObj(data.compilerOptions)) throw new Unproven();
    const dir = posix.dirname(cur);
    chain.unshift({ dir, data });
    const ext: unknown = data.extends;
    if (ext === undefined) break;
    if (typeof ext !== 'string' || !(ext.startsWith('./') || ext.startsWith('../'))) throw new Unproven();
    cur = resolveIn(dir, ext.endsWith('.json') ? ext : `${ext}.json`);
  }

  const cfg: BuildConfig = { file, noEmit: false, emitDeclarationOnly: false, declaration: false, composite: false, allowJs: false };
  const list = (v: unknown, dir: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Unproven();
    return (v as string[]).map((x) => resolveIn(dir, x));
  };
  for (const { dir, data } of chain) {
    const co = (data.compilerOptions ?? {}) as Record<string, unknown>;
    if (co.outDir !== undefined) cfg.outDir = pathIn(dir, co.outDir);
    if (co.declarationDir !== undefined) cfg.declarationDir = pathIn(dir, co.declarationDir);
    if (co.rootDir !== undefined) cfg.rootDir = pathIn(dir, co.rootDir);
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

/** A pattern this module models: within the work limits, `*`, `?` and `**` segments only. */
const modelled = (pattern: string): boolean =>
  pattern.length <= MAX_PATTERN_CHARS && pattern.split('/').length <= MAX_SEGMENTS && !/[[\]{}()!\\]/.test(pattern) && pattern.split('/').every((s) => s === '**' || !s.includes('**'));

function matchInclude(pattern: string, source: string): Tri {
  const path = source.split('/');
  if (!modelled(pattern) || path.length > MAX_SEGMENTS) return 'unknown';
  const segs = pattern.split('/');
  const last = segs[segs.length - 1]!;
  // a last segment with no wildcard and no extension names a directory
  if (!/[*?]/.test(last) && !last.includes('.')) segs.push('**', '*');
  return prefixMatches(segs, path)[path.length]!;
}

function matchExclude(pattern: string, source: string): Tri {
  const path = source.split('/');
  if (!modelled(pattern) || path.length > MAX_SEGMENTS) return 'unknown';
  return prefixMatches(pattern.split('/'), path).some((ok, n) => n >= 1 && ok);
}

/** Whether the config compiles this source file. `true` only when it is proven. */
function isInput(cfg: BuildConfig, source: string): Tri {
  if (source.split('/').some((s) => s.startsWith('.'))) return 'unknown'; // wildcards skip hidden names; not modelled
  if (cfg.files?.includes(source)) return true;
  const base = posix.dirname(cfg.file);
  const include = cfg.include ?? (cfg.files ? [] : [posix.join(base, '**/*')]);
  // `outDir` and `declarationDir` are already repo-relative; only the unresolved defaults are joined to the config directory
  const exclude = cfg.exclude ?? [...['node_modules', 'bower_components', 'jspm_packages'].map((p) => posix.join(base, p)), ...(cfg.outDir ? [cfg.outDir] : []), ...(cfg.declarationDir ? [cfg.declarationDir] : [])];
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
      // a .jsx input becomes .js only when JSX is compiled; with "preserve" it is written as .jsx
      return cfg.emitDeclarationOnly ? [] : ['.ts', ...(reactJsx ? ['.tsx'] : []), ...(cfg.allowJs ? ['.js', ...(reactJsx ? ['.jsx'] : [])] : [])];
    case '.jsx':
      return cfg.emitDeclarationOnly || cfg.jsx !== 'preserve' ? [] : ['.tsx', ...(cfg.allowJs ? ['.jsx'] : [])];
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
 * The tracked source a config compiles into `output`, with the proof, or undefined. Needs an explicit `rootDir` and an
 * output directory (`outDir`, or `declarationDir` for declaration files), no `noEmit`, an output kind the options
 * produce, and a source that is proven to be a compilation input.
 */
export function sourceOfBuildOutput(cfg: BuildConfig, output: string, tracked: Set<string>): { source: string; how: string } | undefined {
  const { rootDir } = cfg;
  if (!rootDir || cfg.noEmit) return undefined;
  const m = OUT_EXT.exec(output);
  if (!m) return undefined;
  const declaration = m[0].startsWith('.d.');
  // declaration files go to `declarationDir` when it is set; everything else goes to `outDir`
  const outDir = declaration ? cfg.declarationDir ?? cfg.outDir : cfg.outDir;
  if (!outDir || !output.startsWith(`${outDir}/`)) return undefined;
  const stem = output.slice(outDir.length + 1, output.length - m[0].length);
  for (const ext of sourcesFor(cfg, m[0])) {
    const source = posix.join(rootDir, `${stem}${ext}`);
    if (!tracked.has(source)) continue;
    if (/\.d\.[cm]?ts$/.test(source)) continue; // TypeScript emits nothing from a declaration file
    if (isInput(cfg, source) !== true) continue;
    return { source, how: `${cfg.file} compiles rootDir "${rootDir}" into ${declaration && cfg.declarationDir ? 'declarationDir' : 'outDir'} "${outDir}" (noEmit is not set) and has ${source} as an input` };
  }
  return undefined;
}
