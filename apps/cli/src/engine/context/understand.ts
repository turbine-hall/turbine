import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { err, shortSnapshotId, type RepoSnapshot, type SnapshotDiff } from '@turbine-hall/turbine-contracts';
import type { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import { hasUncommittedChanges, headState, repoToplevel } from './git-read.js';
import { contextFilesCurrent, ensureContextIgnored, writeContextFiles } from './render.js';
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

export function repoHead(projectRoot: string): RepoHead | NoHead {
  const repoRoot = repoToplevel(projectRoot);
  if (!repoRoot) {
    // git could not find a repository. If a .git entry exists on the way up, the repository is
    // there but unreadable (corrupt, bad permissions, ...): a failure, not "not a repository".
    for (let dir = resolve(projectRoot); ; dir = dirname(dir)) {
      if (existsSync(join(dir, '.git'))) return { error: 'broken-head', reason: `${join(dir, '.git')} exists but git cannot open the repository` };
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
  store.saveSnapshot(snapshot, projectRoot);
  return previous
    ? { status: 'rebuilt', snapshot, previous, diff: diffSnapshots(previous, snapshot) }
    : { status: 'built', snapshot };
}

export type UnderstandOutcome = FreshSnapshot & {
  /** The main checkout has uncommitted changes. They are not part of any fact. */
  dirty: boolean;
  /** Generated files written by this run (empty when nothing changed). */
  written: string[];
  /** The snapshot was current but its generated files were missing or edited, so they were regenerated. */
  repaired: boolean;
};

/**
 * `turbine understand`: no snapshot → build; up to date → change nothing; stale → rebuild.
 * Then (re)render the generated files.
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
  if (fresh.status === 'current') {
    if (contextFilesCurrent(projectRoot, fresh.snapshot)) {
      // Nothing to regenerate, but an earlier run may have stopped before the ignore rule was added.
      return { ...fresh, dirty, written: ensureContextIgnored(projectRoot) ? [join(projectRoot, '.turbine', '.gitignore')] : [], repaired: false };
    }
    return { ...fresh, dirty, written: writeContextFiles(projectRoot, fresh.snapshot), repaired: true };
  }
  return { ...fresh, dirty, written: writeContextFiles(projectRoot, fresh.snapshot), repaired: false };
}

/** Keep the generated files in step with the store after a task command refreshed the snapshot. */
export function refreshContextFiles(projectRoot: string, fresh: FreshSnapshot): void {
  if (fresh.status !== 'current' || !contextFilesCurrent(projectRoot, fresh.snapshot)) writeContextFiles(projectRoot, fresh.snapshot);
  else ensureContextIgnored(projectRoot);
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
