import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { err, shortSnapshotId, type RepoSnapshot, type SnapshotDiff } from '@turbine-hall/turbine-contracts';
import type { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import { hasUncommittedChanges, headState, repoToplevel } from './git-read.js';
import { HeadMovedError, contextFilesCurrent, ensureContextIgnored, writeContextFiles } from './render.js';
import { buildSnapshot, diffSnapshots } from './snapshot.js';

/**
 * Keeps the stored snapshot true to HEAD. A snapshot is only ever served if it was taken at
 * the current HEAD; otherwise it is rebuilt first, and if the rebuild fails the caller gets an
 * error instead of the old snapshot.
 */
export type FreshSnapshot = {
  status: 'built' | 'rebuilt' | 'current';
  snapshot: RepoSnapshot;
  previous?: RepoSnapshot;
  diff?: SnapshotDiff;
};

export type RepoHead = { repoRoot: string; head: string };

/** The repository root and HEAD commit of a project, or the reason there is none. */
export type NoHead = { error: 'not-a-repo' | 'no-commits' } | { error: 'broken-head'; reason: string };

/** True if a directory entry exists at `path`, including a dangling symlink (lstat, not stat). */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function repoHead(projectRoot: string): RepoHead | NoHead {
  const repoRoot = repoToplevel(projectRoot);
  if (!repoRoot) {
    // git could not find a repository. If a .git entry exists on the way up, the repository is
    // there but unreadable (corrupt, bad permissions, ...): a failure, not "not a repository".
    for (let dir = resolve(projectRoot); ; dir = dirname(dir)) {
      if (entryExists(join(dir, '.git'))) return { error: 'broken-head', reason: `${join(dir, '.git')} exists but git cannot open the repository` };
      if (dirname(dir) === dir) break;
    }
    return { error: 'not-a-repo' };
  }
  const state = headState(repoRoot);
  if (state.kind === 'commit') return { repoRoot, head: state.commit };
  return state.kind === 'unborn' ? { error: 'no-commits' } : { error: 'broken-head', reason: state.reason };
}

/** A HEAD that exists but cannot be read must stop the task: it is NOT the same as "no commits yet". */
export function brokenHeadError(at: { reason: string }, projectRoot: string) {
  return err('E_CONTEXT_UNAVAILABLE', `Project facts cannot be read in ${projectRoot}: ${at.reason}. Repair the repository (for example restore the missing git objects), then run: turbine understand`, {
    reason: at.reason,
  });
}

/** Build the snapshot at `at.head`, or throw a clear error. The previous snapshot is never a fallback. */
export function buildOrThrow(
  at: RepoHead,
  previous: RepoSnapshot | null,
  build: (repoRoot: string, commit: string) => RepoSnapshot = buildSnapshot,
): RepoSnapshot {
  try {
    return build(at.repoRoot, at.head);
  } catch (e) {
    const why = (e as Error).message;
    throw err(
      'E_CONTEXT_UNAVAILABLE',
      previous
        ? `Project facts are stale (snapshot ${shortSnapshotId(previous.hash)} was taken at ${previous.commit.slice(0, 8)}, HEAD is ${at.head.slice(0, 8)}) and rebuilding them failed: ${why}. The old snapshot is not used. Fix the problem, then run: turbine understand`
        : `Project facts could not be built at ${at.head.slice(0, 8)}: ${why}. Fix the problem, then run: turbine understand`,
      { head: at.head, staleSnapshot: previous?.hash },
    );
  }
}

/**
 * Build (or reuse) the snapshot for `at`. Nothing is stored here: a built snapshot is recorded only by
 * `publishFresh`, after its generated files have been written, so the store never claims a snapshot
 * whose files do not exist.
 */
export function ensureFreshSnapshot(
  store: WorkStore,
  projectRoot: string,
  at: RepoHead,
  build: (repoRoot: string, commit: string) => RepoSnapshot = buildSnapshot,
): FreshSnapshot {
  let previous: RepoSnapshot | null = null;
  try {
    previous = store.getLatestSnapshotFor(projectRoot);
  } catch {
    previous = null; // unreadable or edited in the store: it is derived data, so rebuild it
  }
  if (previous && previous.commit === at.head) return { status: 'current', snapshot: previous };

  const snapshot = buildOrThrow(at, previous, build);
  return previous
    ? { status: 'rebuilt', snapshot, previous, diff: diffSnapshots(previous, snapshot) }
    : { status: 'built', snapshot };
}

/**
 * Publish a snapshot: write the generated files, then record the snapshot in the store. Both happen under the
 * publish lock, and the store is written only after the files are in place. If HEAD moved before publication,
 * nothing is published and the error has reason 'head-moved' (the caller may rebuild once at the new HEAD).
 * Returns the files written.
 */
export function publishFresh(store: WorkStore, projectRoot: string, fresh: FreshSnapshot): string[] {
  const commit = fresh.snapshot.commit;
  const stillCurrent = () => {
    const h = repoHead(projectRoot);
    return !('error' in h) && h.head === commit;
  };
  // Recorded whenever files are written, under the same lock: a re-written snapshot becomes the latest row again.
  const record = () => store.saveSnapshot(fresh.snapshot, projectRoot);
  try {
    if (fresh.status === 'current' && contextFilesCurrent(projectRoot, fresh.snapshot)) {
      // Nothing to regenerate, but an earlier run may have stopped before the ignore rule was added.
      return ensureContextIgnored(projectRoot) ? [join(projectRoot, '.turbine', '.gitignore')] : [];
    }
    return writeContextFiles(projectRoot, fresh.snapshot, stillCurrent, record);
  } catch (e) {
    if (e instanceof HeadMovedError) {
      throw err('E_CONTEXT_UNAVAILABLE', e.message, { reason: 'head-moved', commit });
    }
    throw err('E_CONTEXT_UNAVAILABLE', `Project context could not be published for ${commit.slice(0, 8)}: ${(e as Error).message}`, { commit });
  }
}

export type UnderstandOutcome = FreshSnapshot & {
  /** The main checkout has uncommitted changes. They are not part of any fact. */
  dirty: boolean;
  /** Generated files written by this run (empty when nothing changed). */
  written: string[];
  /** The snapshot was current but its generated files were missing or edited, so they were regenerated. */
  repaired: boolean;
  /** Layer 2 brief outcome when drafting ran (or was skipped with zero model calls). */
  brief?: {
    modelCalls: number;
    sectionsDrafted: string[];
    approved: boolean;
    claimsHash: string;
    confirmToken: string;
    samplePaths: string[];
    sampleCap: number;
  };
};

export type UnderstandBriefOpts = {
  factoryRoot: string;
  config: import('@turbine-hall/turbine-contracts').ProjectConfig;
  model?: import('@turbine-hall/turbine-models').ModelAdapter;
};

/**
 * `turbine understand` Layer 1: no snapshot → build; up to date → change nothing; stale → rebuild.
 * Then (re)render the generated Facts files.
 */
export function understandProject(store: WorkStore, projectRoot: string): UnderstandOutcome {
  const at = repoHead(projectRoot);
  if ('error' in at) {
    if (at.error === 'broken-head') throw brokenHeadError(at, projectRoot);
    throw err(
      'E_CONTEXT_UNAVAILABLE',
      at.error === 'not-a-repo'
        ? `${projectRoot} is not a git repository; project facts are read from a commit`
        : 'This repository has no commits yet; project facts are read from a commit. Make a first commit, then run: turbine understand',
    );
  }
  const fresh = ensureFreshSnapshot(store, projectRoot, at);
  const dirty = hasUncommittedChanges(at.repoRoot);
  const repaired = fresh.status === 'current' && !contextFilesCurrent(projectRoot, fresh.snapshot);
  return { ...fresh, dirty, written: publishFresh(store, projectRoot, fresh), repaired };
}

/**
 * Layer 1 + Layer 2: after Facts are fresh, draft / reverify / render the brief (no model calls when unchanged).
 */
export async function understandProjectWithBrief(
  store: WorkStore,
  projectRoot: string,
  briefOpts: UnderstandBriefOpts,
): Promise<UnderstandOutcome> {
  const base = understandProject(store, projectRoot);
  const at = repoHead(projectRoot);
  if ('error' in at) {
    // understandProject already succeeded at this HEAD; a race that removes the repo is a hard failure.
    throw err('E_CONTEXT_UNAVAILABLE', `repository became unreadable while drafting the brief (${'reason' in at ? at.reason : at.error})`);
  }
  const { briefConfigOf, ensureBrief } = await import('./brief.js');
  const brief = await ensureBrief({
    store,
    projectRoot,
    repoRoot: at.repoRoot,
    repoPath: projectRoot,
    snapshot: base.snapshot,
    config: briefConfigOf(briefOpts.config),
    factoryRoot: briefOpts.factoryRoot,
    model: briefOpts.model,
  });
  return {
    ...base,
    written: [...base.written, ...brief.written],
    brief: {
      modelCalls: brief.modelCalls,
      sectionsDrafted: brief.sectionsDrafted,
      approved: brief.approved,
      claimsHash: brief.claimsHash,
      confirmToken: brief.confirmToken,
      samplePaths: brief.samplePaths,
      sampleCap: brief.sampleCap,
    },
  };
}

const MAX_DIFF_LINES = 80;

export function formatOutcome(o: UnderstandOutcome): string[] {
  const id = shortSnapshotId(o.snapshot.hash);
  const lines: string[] = [];
  const counts = `${o.snapshot.facts.length} facts, ${o.snapshot.dependencies.length} dependencies, ${o.snapshot.conventions.length} conventions (${o.snapshot.conventions.filter((c) => c.status === 'confirmed').length} confirmed), ${o.snapshot.unconfirmed.length} not confirmed`;
  if (o.status === 'current') {
    lines.push(`Project understood (snapshot ${id})`);
    if (o.repaired) lines.push('Regenerated .turbine/context/ (the generated files were missing or edited by hand).');
  } else if (o.status === 'built') {
    lines.push(`Project understood (snapshot ${id}): built from commit ${o.snapshot.commit.slice(0, 8)}: ${counts}.`);
  } else {
    const prev = o.previous!;
    lines.push(`Project facts were stale (snapshot ${shortSnapshotId(prev.hash)} at ${prev.commit.slice(0, 8)}; HEAD is ${o.snapshot.commit.slice(0, 8)}).`);
    lines.push(`Rebuilt: project understood (snapshot ${id}): ${counts}.`);
    const d = o.diff!;
    const diffLines = [
      ...d.added.map((x) => `  + ${x.key}: ${x.statement}`),
      ...d.removed.map((x) => `  - ${x.key}: ${x.statement}`),
      ...d.changed.map((x) => `  ~ ${x.key}: ${x.before}  →  ${x.after}`),
    ];
    lines.push(`Changes since the last snapshot: ${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed.`);
    lines.push(...diffLines.slice(0, MAX_DIFF_LINES));
    if (diffLines.length > MAX_DIFF_LINES) lines.push(`  … ${diffLines.length - MAX_DIFF_LINES} more`);
  }
  if (o.dirty) lines.push('Note: uncommitted changes exist (not included).');
  if (o.brief) {
    const b = o.brief;
    if (b.modelCalls === 0) lines.push('Project brief: unchanged (no model calls).');
    else lines.push(`Project brief: drafted ${b.sectionsDrafted.join(', ') || '(none)'} (${b.modelCalls} model call(s); sample ${b.samplePaths.length}/${b.sampleCap}).`);
    lines.push(
      b.approved
        ? `Brief approved — verified claims at ${o.snapshot.commit.slice(0, 8)}.`
        : `Brief draft, not approved — verified claims at ${o.snapshot.commit.slice(0, 8)}. Review with: turbine context show; approve with: turbine context approve (code ${b.confirmToken}).`,
    );
  }
  return lines;
}

/** `turbine init` on a repository that already has commits. Returns the message to show, or undefined. */
export function understandOnInit(store: WorkStore, projectRoot: string): string | undefined {
  const at = repoHead(projectRoot);
  if ('error' in at) {
    if (at.error === 'broken-head') throw brokenHeadError(at, projectRoot);
    return undefined;
  }
  return formatOutcome(understandProject(store, projectRoot)).join('\n');
}

/** Like understandOnInit, but also drafts the Layer 2 brief. */
export async function understandOnInitWithBrief(
  store: WorkStore,
  projectRoot: string,
  briefOpts: UnderstandBriefOpts,
): Promise<string | undefined> {
  const at = repoHead(projectRoot);
  if ('error' in at) {
    if (at.error === 'broken-head') throw brokenHeadError(at, projectRoot);
    return undefined;
  }
  return formatOutcome(await understandProjectWithBrief(store, projectRoot, briefOpts)).join('\n');
}
