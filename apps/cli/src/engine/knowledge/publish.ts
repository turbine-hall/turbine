import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  lstatSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PUBLISHED_CLAIM_STATUSES, err, type BriefState, type RepoSnapshot } from '@turbine-hall/turbine-contracts';
import type { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import { resolveCommit } from '../context/git-read.js';
import { HeadMovedError, ensureContextIgnored, withContextPublishLock } from '../context/render.js';
import { knowledgePaths, readBoundedUtf8, resolvePhysical, MAX_BUNDLE_FILE_BYTES, MAX_MARKER_BYTES } from './paths.js';
import { bundleContentHash, renderBundle, type BundleFiles } from './render.js';
import { validateBundle } from './validate.js';
import { splitFrontmatter } from './frontmatter.js';
import { isMap, parseDocument } from 'yaml';

export type PublishKnowledgeResult = {
  commit: string;
  written: string[];
  unchanged: boolean;
  hash: string;
};

/**
 * Build the knowledge bundle in a temp folder, validate it, recheck HEAD + snapshot, then swap
 * under the context publish lock. A failed validation or HEAD change publishes nothing.
 */
export function publishKnowledgeBundle(input: {
  store: WorkStore;
  projectRoot: string;
  repoRoot: string;
  repoPath: string;
  snapshot: RepoSnapshot;
  brief: BriefState | null;
  cliVersion: string;
  projectName: string;
  license?: string;
}): PublishKnowledgeResult {
  recoverInterruptedSwap(input.projectRoot);
  const head = resolveCommit(input.repoRoot, 'HEAD');
  if (!head) throw err('E_CONTEXT_UNAVAILABLE', 'HEAD does not resolve to a commit');
  if (head !== input.snapshot.commit) {
    throw new HeadMovedError('snapshot commit is not HEAD; rebuild before publishing the knowledge bundle');
  }

  const paths = knowledgePaths(input.projectRoot);
  const previousFiles = readExistingBundle(paths.dir);
  const previousLog = previousFiles.get('log.md');
  const previousLogBody = previousLog?.replace(/^# Directory Update Log\s*/i, '') ?? '';

  const marker = readBundleMarker(paths.dir);
  const claims = input.store.listClaims(input.repoPath, { statuses: [...PUBLISHED_CLAIM_STATUSES], commit: head });
  const withdrawn = listRecentWithdrawals(input.store, input.repoPath);

  const files = renderBundle({
    snapshot: input.snapshot,
    claims,
    brief: input.brief,
    withdrawn,
    previousLogBody,
    cliVersion: input.cliVersion,
    projectName: input.projectName,
    license: input.license,
    previousFiles,
  });

  // Merge unknown keys from disk concepts into the rendered frontmatter (Document API).
  mergeUnknownKeys(files, previousFiles);

  const hash = bundleContentHash(files);
  if (
    marker?.commit === head &&
    marker?.hash === hash &&
    marker?.snapshot === input.snapshot.hash &&
    bundleOnDiskMatches(paths.dir, files)
  ) {
    ensureContextIgnored(input.projectRoot);
    return { commit: head, written: [], unchanged: true, hash };
  }

  return withContextPublishLock(input.projectRoot, () => {
    const headNow = resolveCommit(input.repoRoot, 'HEAD');
    if (!headNow || headNow !== head) {
      throw new HeadMovedError('HEAD changed while the knowledge bundle was being built; nothing was published. Run again.');
    }

    const stagingParent = join(input.projectRoot, '.turbine');
    mkdirSync(stagingParent, { recursive: true });
    const staging = mkdtempSync(join(stagingParent, 'knowledge-staging-'));
    try {
      writeTree(staging, files);
      writeFileSync(
        join(staging, '.turbine-bundle.json'),
        `${JSON.stringify({ commit: head, hash, snapshot: input.snapshot.hash }, null, 2)}\n`,
        'utf8',
      );

      const issues = validateBundle(staging);
      const errors = issues.filter((i) => i.level === 'error');
      if (errors.length) {
        throw err(
          'E_CONTEXT_UNAVAILABLE',
          `knowledge bundle failed validation (${errors.length} error(s)); nothing was published: ${errors[0]!.file}: ${errors[0]!.message}`,
          { issues: errors.slice(0, 20) },
        );
      }

      const headFinal = resolveCommit(input.repoRoot, 'HEAD');
      if (!headFinal || headFinal !== head) {
        throw new HeadMovedError('HEAD changed before the knowledge bundle was published; nothing was published. Run again.');
      }

      // Swap with recoverable aside: persist swap state before moving the live tree.
      const aside = `${paths.dir}.aside.${process.pid}`;
      const swapFile = knowledgePaths(input.projectRoot).swapState;
      writeFileSync(swapFile, `${JSON.stringify({ aside, staging, dir: paths.dir }, null, 2)}\n`, 'utf8');
      if (existsSync(paths.dir)) renameSync(paths.dir, aside);
      try {
        renameSync(staging, paths.dir);
      } catch (e) {
        if (existsSync(aside)) renameSync(aside, paths.dir);
        rmSync(swapFile, { force: true });
        throw e;
      }
      rmSync(aside, { recursive: true, force: true });
      rmSync(swapFile, { force: true });
      ensureContextIgnored(input.projectRoot);
      return {
        commit: head,
        written: [...files.keys()].map((p) => join(paths.dir, p)),
        unchanged: false,
        hash,
      };
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
  });
}

function writeTree(root: string, files: BundleFiles): void {
  for (const [rel, body] of files) {
    if (rel.includes('..') || rel.startsWith('/') || rel.split('/').some((p) => p === '..' || p === '.')) {
      throw new Error(`refusing to write unsafe bundle path ${rel}`);
    }
    if (rel.split('/').some((p) => p.startsWith('.'))) {
      throw new Error(`refusing to write dot-path ${rel} inside the bundle`);
    }
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
  }
}

function readExistingBundle(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs)) {
      if (name.startsWith('.')) continue;
      const child = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(child);
      } catch (e) {
        throw err(
          'E_CONTEXT_UNAVAILABLE',
          `cannot read previous knowledge path ${childRel} (${(e as Error).message}); leaving the live bundle unchanged`,
        );
      }
      if (st.isDirectory()) walk(child, childRel);
      else if (st.isFile() && name.endsWith('.md')) {
        try {
          const text = readBoundedUtf8(child, MAX_BUNDLE_FILE_BYTES);
          if (text === undefined) {
            throw err('E_CONTEXT_UNAVAILABLE', `cannot read previous knowledge file ${childRel}; leaving the live bundle unchanged`);
          }
          out.set(childRel, text);
        } catch (e) {
          if (e instanceof Error && e.name === 'TurbineError') throw e;
          throw err(
            'E_CONTEXT_UNAVAILABLE',
            `cannot read previous knowledge file ${childRel} (${(e as Error).message}); leaving the live bundle unchanged`,
          );
        }
      }
    }
  };
  walk(dir, '');
  return out;
}

function readBundleMarker(dir: string): { commit: string; hash: string; snapshot: string } | undefined {
  const file = join(dir, '.turbine-bundle.json');
  try {
    const text = readBoundedUtf8(file, MAX_MARKER_BYTES);
    if (text === undefined) return undefined;
    const raw = JSON.parse(text) as { commit?: string; hash?: string; snapshot?: string };
    if (raw.commit && raw.hash && raw.snapshot) return { commit: raw.commit, hash: raw.hash, snapshot: raw.snapshot };
  } catch {
    return undefined;
  }
  return undefined;
}

function recoverInterruptedSwap(projectRoot: string): void {
  const paths = knowledgePaths(projectRoot);
  if (!existsSync(paths.swapState)) return;
  try {
    const raw = JSON.parse(readBoundedUtf8(paths.swapState, MAX_MARKER_BYTES) ?? '') as {
      aside?: string;
      dir?: string;
    };
    if (!raw.dir || !raw.aside) {
      rmSync(paths.swapState, { force: true });
      return;
    }
    const expectedDir = resolvePhysical(paths.dir);
    const dir = resolvePhysical(raw.dir);
    const aside = resolvePhysical(raw.aside);
    // Only recover records this publisher could have written: exact knowledge dir + sibling `.aside.<pid>`.
    if (dir !== expectedDir) {
      rmSync(paths.swapState, { force: true });
      return;
    }
    const parent = dirname(expectedDir);
    const expectedPrefix = `${basename(expectedDir)}.aside.`;
    if (dirname(aside) !== parent || !basename(aside).startsWith(expectedPrefix)) {
      rmSync(paths.swapState, { force: true });
      return;
    }
    if (!existsSync(dir) && existsSync(aside)) {
      renameSync(aside, dir);
    }
  } catch {
    // leave state for a human; do not delete blindly
    return;
  }
  rmSync(paths.swapState, { force: true });
}

function bundleOnDiskMatches(dir: string, files: BundleFiles): boolean {
  if (!existsSync(dir)) return false;
  for (const [rel, body] of files) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return false;
    try {
      const disk = readBoundedUtf8(abs, MAX_BUNDLE_FILE_BYTES);
      if (disk === undefined) return false;
      const want = body.endsWith('\n') ? body : `${body}\n`;
      if (disk !== want) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function listRecentWithdrawals(
  store: WorkStore,
  repoPath: string,
): Array<{ id: string; section: string; reason: string }> {
  const withdrawn = store.listClaims(repoPath, { statuses: ['withdrawn'] });
  return withdrawn.map((c) => ({
    id: c.claim.id,
    section: c.claim.section,
    reason: c.reason ?? 'withdrawn',
  }));
}

/**
 * Preserve unknown frontmatter keys from a previous on-disk concept by editing the YAML Document in place.
 */
const RENDERER_OWNED_KEYS = new Set([
  'type',
  'title',
  'description',
  'resource',
  'tags',
  'sources',
  'usage_window',
  'generated',
  'verified',
  'status',
  'superseded_by',
  'stale_after',
  'okf_version',
  'license',
  'x-turbine-commit',
  'x-turbine-blob',
  'x-turbine-profile',
]);

function mergeUnknownKeys(files: BundleFiles, previous: Map<string, string>): void {
  for (const [rel, body] of files) {
    const prev = previous.get(rel);
    if (!prev || !rel.endsWith('.md') || rel === 'log.md' || rel === 'README.md' || rel === 'index.md') continue;
    const prevSplit = splitFrontmatter(prev);
    const nextSplit = splitFrontmatter(body);
    if (!prevSplit.ok || !nextSplit.ok) continue;
    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(prevSplit.data)) {
      if (RENDERER_OWNED_KEYS.has(k)) continue; // never restore omitted generated/verified/etc.
      if (k in nextSplit.data) continue;
      extras[k] = v;
    }
    if (!Object.keys(extras).length) continue;
    try {
      const doc = parseDocument(nextSplit.raw, { uniqueKeys: true, schema: 'core', version: '1.2' });
      if (!isMap(doc.contents)) continue;
      for (const [k, v] of Object.entries(extras)) {
        doc.set(k, v);
      }
      const fm = `---\n${String(doc).replace(/\n$/, '')}\n---`;
      files.set(rel, `${fm}\n${nextSplit.body}`);
    } catch {
      // keep rendered body without merge
    }
  }
}

/** Copy a validated bundle to an external directory (export). */
export function exportKnowledgeBundle(input: {
  projectRoot: string;
  targetDir: string;
  force?: boolean;
}): { targetDir: string; files: number } {
  const source = knowledgePaths(input.projectRoot).dir;
  if (!existsSync(source)) throw err('E_NOT_FOUND', 'No knowledge bundle; run: turbine understand');
  assertSafeExportTarget(input.targetDir, input.projectRoot, source);

  return withContextPublishLock(input.projectRoot, () => {
    const issues = validateBundle(source);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) {
      throw err('E_CONTEXT_UNAVAILABLE', `source bundle is invalid; fix with turbine understand: ${errors[0]!.message}`);
    }

    const files = readExistingBundle(source);
    const absTarget = resolvePhysical(resolve(input.targetDir));
    // Re-check after physical resolution (symlink parents).
    assertSafeExportTarget(absTarget, input.projectRoot, source);

    const stagingParent = dirname(absTarget);
    mkdirSync(stagingParent, { recursive: true });
    const staging = mkdtempSync(join(stagingParent, '.turbine-knowledge-export-'));
    try {
      writeTree(staging, files);
      const stagedIssues = validateBundle(staging).filter((i) => i.level === 'error');
      if (stagedIssues.length) {
        throw err('E_CONTEXT_UNAVAILABLE', `staged export failed validation: ${stagedIssues[0]!.message}`);
      }
      if (existsSync(absTarget)) {
        const entries = readdirSync(absTarget);
        if (entries.length && !input.force) {
          throw err('E_INVALID_CONFIG', `export target ${input.targetDir} is not empty; pass --force to replace`);
        }
        if (input.force) {
          const aside = `${absTarget}.aside.${process.pid}`;
          renameSync(absTarget, aside);
          try {
            renameSync(staging, absTarget);
          } catch (e) {
            if (existsSync(aside)) renameSync(aside, absTarget);
            throw e;
          }
          rmSync(aside, { recursive: true, force: true });
          return { targetDir: absTarget, files: files.size };
        }
      }
      renameSync(staging, absTarget);
      return { targetDir: absTarget, files: files.size };
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
  });
}

function assertSafeExportTarget(target: string, projectRoot: string, sourceDir: string): void {
  if (!target || target === '.' || target === '..') throw err('E_INVALID_CONFIG', 'export target path is required');
  if (target.includes('\0')) throw err('E_INVALID_CONFIG', 'export target must not contain NUL');
  const parts = target.replace(/\\/g, '/').split('/');
  if (parts.some((p) => p === '..')) throw err('E_INVALID_CONFIG', 'export target must not contain ".."');

  const absTarget = resolvePhysical(resolve(target));
  const absSource = resolvePhysical(resolve(sourceDir));
  const absProject = resolvePhysical(resolve(projectRoot));
  const absTurbine = resolvePhysical(resolve(projectRoot, '.turbine'));
  const under = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
  // Reject: live bundle overlap, anything under .turbine/, the project root itself, and ancestors of the project.
  // Allow: other descendants of the project (so teams can export into a tracked folder to commit).
  if (
    absTarget === absSource ||
    under(absTarget, absSource) ||
    under(absSource, absTarget) ||
    absTarget === absProject ||
    under(absTarget, absProject) ||
    under(absTurbine, absTarget) ||
    under(absTarget, absTurbine)
  ) {
    throw err(
      'E_INVALID_CONFIG',
      'export target must not be the project root/an ancestor, or overlap .turbine/ / the live knowledge bundle',
    );
  }
}

/** Detect hand edits: generated content hash drift vs marker / concept regenerated values. */
export function lintKnowledgeHandEdits(projectRoot: string): Array<{ level: 'error' | 'warning'; file: string; message: string }> {
  const paths = knowledgePaths(projectRoot);
  if (!existsSync(paths.dir)) return [];
  const issues: Array<{ level: 'error' | 'warning'; file: string; message: string }> = [];
  const marker = readBundleMarker(paths.dir);
  if (!marker) {
    issues.push({ level: 'warning', file: 'knowledge/', message: 'knowledge bundle has no .turbine-bundle.json marker' });
    return issues;
  }
  const files = readExistingBundle(paths.dir);
  const hash = bundleContentHash(files);
  if (hash !== marker.hash) {
    issues.push({
      level: 'warning',
      file: 'knowledge/',
      message: 'knowledge bundle content does not match its marker (hand edit or stale); the next turbine understand will overwrite generated values',
    });
  }
  return issues;
}
