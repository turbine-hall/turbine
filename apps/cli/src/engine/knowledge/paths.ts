import { constants, existsSync, openSync, readSync, closeSync, fstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const KNOWLEDGE_DIR = 'knowledge';

/** Paths under `.turbine/knowledge/` for one project. */
export function knowledgePaths(projectRoot: string) {
  const dir = join(projectRoot, '.turbine', KNOWLEDGE_DIR);
  return {
    dir,
    index: join(dir, 'index.md'),
    log: join(dir, 'log.md'),
    readme: join(dir, 'README.md'),
    marker: join(dir, '.turbine-bundle.json'),
    swapState: join(projectRoot, '.turbine', 'knowledge-swap.json'),
  };
}

/** Byte budget for any single bundle file read back as untrusted input. */
export const MAX_BUNDLE_FILE_BYTES = 512 * 1024;
/** Max YAML nesting depth when parsing frontmatter from disk. */
export const MAX_BUNDLE_YAML_DEPTH = 32;
/** Max files/entries walked under a bundle root during validation. */
export const MAX_BUNDLE_FILES = 2000;
/** Marker JSON budget. */
export const MAX_MARKER_BYTES = 64 * 1024;
/** Keep rendered log.md under the per-file budget with headroom. */
export const MAX_LOG_BODY_BYTES = 400 * 1024;

/**
 * Read a regular file with a hard byte budget (open → size check → read at most budget+1).
 * Returns undefined when missing; throws Error with code in message for oversized/unreadable.
 */
export function readBoundedUtf8(abs: string, budget = MAX_BUNDLE_FILE_BYTES): string | undefined {
  if (!existsSync(abs)) return undefined;
  let fd: number | undefined;
  try {
    // O_NONBLOCK: a FIFO with no writer must not hang forever (POSIX). Fall back to plain 'r' where unsupported.
    const flags =
      typeof constants.O_RDONLY === 'number' && typeof constants.O_NONBLOCK === 'number'
        ? constants.O_RDONLY | constants.O_NONBLOCK
        : 'r';
    fd = openSync(abs, flags);
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`not a regular file: ${abs}`);
    if (st.size > budget) throw new Error(`file-too-large:${st.size}`);
    const buf = Buffer.alloc(Math.min(st.size + 1, budget + 1));
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > budget) throw new Error(`file-too-large:${n}`);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Marker commit the live bundle was published for, if readable. */
export function knowledgeBundleCommit(projectRoot: string): string | undefined {
  const marker = knowledgePaths(projectRoot).marker;
  try {
    const text = readBoundedUtf8(marker, MAX_MARKER_BYTES);
    if (text === undefined) return undefined;
    const raw = JSON.parse(text) as { commit?: unknown };
    return typeof raw.commit === 'string' ? raw.commit : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve through symlinks for existing ancestors so a not-yet-created
 * `project/subdir` still compares equal to a realpath'd project root.
 */
export function resolvePhysical(path: string): string {
  let cur = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return missing.length ? join(realpathSync(cur), ...missing) : realpathSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(path);
      missing.unshift(basename(cur));
      cur = parent;
    }
  }
}
