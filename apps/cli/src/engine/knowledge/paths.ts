import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  };
}

/** Marker commit the live bundle was published for, if readable. */
export function knowledgeBundleCommit(projectRoot: string): string | undefined {
  const marker = knowledgePaths(projectRoot).marker;
  if (!existsSync(marker)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(marker, 'utf8')) as { commit?: unknown };
    return typeof raw.commit === 'string' ? raw.commit : undefined;
  } catch {
    return undefined;
  }
}

/** Byte budget for any single bundle file read back as untrusted input. */
export const MAX_BUNDLE_FILE_BYTES = 512 * 1024;
/** Max YAML nesting depth when parsing frontmatter from disk. */
export const MAX_BUNDLE_YAML_DEPTH = 32;
/** Max files walked under a bundle root during validation. */
export const MAX_BUNDLE_FILES = 2000;
