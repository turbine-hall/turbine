import {
  contentHashText,
  type ContextBudget,
  type RelevantFile,
  type RepoSnapshot,
  type SelectionChanges,
  type SelectionTrigger,
  type TaskContext,
  TASK_CONTEXT_SCHEMA_VERSION,
} from '@turbine-hall/turbine-contracts';
import type { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import { brokenHeadError, repoHead } from './understand.js';
import { changedBetween, listTreeDetailed, readBlobs, type TreeEntry } from './git-read.js';
import { pinSnapshot } from '../project-context.js';
import { SOURCE_EXT, type WorkspacePackage } from './import-graph.js';
import { applyBudget, METHOD_VERSION, rankFiles } from './relevance.js';
import { renderFileEntry, type Staleness } from './task-render.js';

/**
 * Builds a task's file selection from a commit, and decides when a stored one is still true.
 *
 * Everything is read from the commit the project snapshot (layer 1) was taken at: the tree from `ls-tree`, the
 * file contents from one `git cat-file --batch`. The working tree is never read, so a file that exists only
 * uncommitted can never give a reason.
 */

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SCAN_FILES = 4000;
const MAX_SCAN_BYTES = 96 * 1024 * 1024;
const NODE_MODULES = /(^|\/)node_modules\//;
const CODEOWNERS_PATHS = new Set(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']);

export type BudgetChoice = ContextBudget & { source: 'default' | 'roles'; roles: string[] };

export type SelectionRequest = {
  workId: string;
  /** The request as the human wrote it (title and source text). The selection quotes from this text. */
  request: string;
  budget: BudgetChoice;
  /** How many times the task has entered CHANGES_REQUESTED. */
  changesCycle: number;
};

/** The facts about now that decide whether a stored selection is still current. */
export type Now = {
  commit: string;
  /** Hash of the project snapshot stored for this commit, when there is one. */
  snapshotHash?: string;
  budget: ContextBudget;
  requestHash: string;
  changesCycle: number;
};

/** Why a stored selection may not be served as current. Empty means it is. */
export function stalenessOf(sel: TaskContext, now: Now): Staleness[] {
  const out: Staleness[] = [];
  if (sel.changesCycle !== now.changesCycle) out.push('changes-requested');
  if (sel.snapshot.commit !== now.commit) out.push('base-commit-changed');
  else if (now.snapshotHash && sel.snapshot.hash !== now.snapshotHash) out.push('snapshot-changed');
  if (sel.budget.maxFiles !== now.budget.maxFiles || sel.budget.maxChars !== now.budget.maxChars) out.push('budget-changed');
  if (sel.request.hash !== now.requestHash) out.push('request-changed');
  if (sel.methodVersion !== METHOD_VERSION) out.push('method-changed');
  return out;
}

export const requestHash = (request: string) => contentHashText(request);

/** Workspace packages (and the root) with their names, as the snapshot states them. */
export function workspacesOf(snapshot: RepoSnapshot, hasRootManifest: boolean): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  const root = snapshot.facts.find((f) => f.key === 'package:.');
  if (hasRootManifest) out.push({ dir: '.', ...(typeof root?.data?.name === 'string' ? { name: root.data.name } : {}) });
  for (const f of snapshot.facts) {
    if (f.category !== 'workspace' || f.key === 'workspace:declaration' || typeof f.data?.dir !== 'string') continue;
    out.push({ dir: f.data.dir, ...(typeof f.data.name === 'string' ? { name: f.data.name } : {}) });
  }
  return out.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

/**
 * The files to read from a tree, and the text read. Sources come first (up to the caps; what is left out is
 * counted), then the manifests, tsconfig files and CODEOWNERS that resolution and ownership need.
 */
export function readTaskFiles(
  repoRoot: string,
  entries: TreeEntry[],
  workspaces: WorkspacePackage[],
): { files: Array<{ path: string; size: number }>; text: (path: string) => string | undefined; notScanned: { tooLarge: number; overCap: number } } {
  const regular = entries.filter((e) => e.type === 'blob' && e.mode !== '120000' && !NODE_MODULES.test(e.path));
  const notScanned = { tooLarge: 0, overCap: 0 };
  const toRead: TreeEntry[] = [];
  let bytes = 0;
  for (const e of regular.filter((x) => SOURCE_EXT.test(x.path))) {
    if (e.size > MAX_FILE_BYTES) notScanned.tooLarge++;
    else if (toRead.length >= MAX_SCAN_FILES || bytes + e.size > MAX_SCAN_BYTES) notScanned.overCap++;
    else {
      toRead.push(e);
      bytes += e.size;
    }
  }
  const wanted = new Set<string>(CODEOWNERS_PATHS);
  for (const w of workspaces) {
    const prefix = w.dir === '.' ? '' : `${w.dir}/`;
    wanted.add(`${prefix}package.json`);
    wanted.add(`${prefix}tsconfig.json`);
  }
  for (const e of regular) if (wanted.has(e.path) && e.size <= MAX_FILE_BYTES && !toRead.includes(e)) toRead.push(e);

  const blobs = readBlobs(repoRoot, toRead.map((e) => e.id), toRead.reduce((n, e) => n + e.size, 0));
  const texts = new Map<string, string>();
  for (const e of toRead) texts.set(e.path, blobs.get(e.id)!.toString('utf8'));
  return { files: regular.map((e) => ({ path: e.path, size: e.size })), text: (p) => texts.get(p), notScanned };
}

function changesBetween(prev: TaskContext, files: RelevantFile[], repoRoot: string, toCommit: string): SelectionChanges {
  const before = new Map(prev.files.map((f) => [f.path, f.score]));
  const after = new Map(files.map((f) => [f.path, f.score]));
  const changes: SelectionChanges = {
    fromCommit: prev.snapshot.commit,
    toCommit,
    added: files.filter((f) => !before.has(f.path)).map((f) => ({ path: f.path, score: f.score })),
    removed: prev.files.filter((f) => !after.has(f.path)).map((f) => ({ path: f.path, score: f.score })),
    rescored: files.filter((f) => before.has(f.path) && before.get(f.path) !== f.score).map((f) => ({ path: f.path, from: before.get(f.path)!, to: f.score })),
  };
  if (prev.snapshot.commit !== toCommit) {
    try {
      changes.gitChanged = changedBetween(repoRoot, prev.snapshot.commit, toCommit, prev.files.map((f) => f.path));
    } catch (e) {
      changes.gitUnavailable = (e as Error).message.split('\n')[0]!;
    }
  }
  return changes;
}

export type BuildResult = { selection: TaskContext } | { unavailable: string };

/**
 * Build the selection from the commit HEAD is at. The project snapshot is pinned first (rebuilt if stale, and a
 * failure stops here: an old snapshot is never used), then every file is read from that same commit.
 */
export function buildTaskContext(
  projectRoot: string,
  store: WorkStore | undefined,
  req: SelectionRequest,
  trigger: SelectionTrigger,
  previous?: TaskContext,
): BuildResult {
  const pinned = pinSnapshot(projectRoot, store ? { store } : {});
  if ('error' in pinned) {
    return { unavailable: pinned.error === 'not-a-repo' ? 'the project is not a git repository, so there is no commit to read files from' : 'the repository has no commits yet, so there is no commit to read files from' };
  }
  const { at, snapshot } = pinned;
  const listing = listTreeDetailed(at.repoRoot, snapshot.commit);
  const hasRoot = listing.entries.some((e) => e.type === 'blob' && e.path === 'package.json');
  const workspaces = workspacesOf(snapshot, hasRoot);
  const read = readTaskFiles(at.repoRoot, listing.entries, workspaces);
  const { ranked, limits } = rankFiles({ request: req.request, files: read.files, text: read.text, workspaces, notScanned: read.notScanned });
  const kept = applyBudget(ranked, req.budget, (f) => renderFileEntry(f).length);
  const selection: TaskContext = {
    schemaVersion: TASK_CONTEXT_SCHEMA_VERSION,
    methodVersion: METHOD_VERSION,
    workId: req.workId,
    snapshot: { hash: snapshot.hash, commit: snapshot.commit },
    request: { hash: requestHash(req.request), chars: req.request.length },
    budget: { maxFiles: req.budget.maxFiles, maxChars: req.budget.maxChars, source: req.budget.source, roles: req.budget.roles },
    trigger,
    changesCycle: req.changesCycle,
    files: kept.files,
    omitted: kept.omitted,
    omittedTotal: kept.omittedTotal,
    candidates: ranked.length,
    limits,
    ...(previous ? { changes: changesBetween(previous, kept.files, at.repoRoot, snapshot.commit) } : {}),
  };
  return { selection };
}

export type RefreshResult =
  | { status: 'unavailable'; reason: string }
  | { status: 'current' | 'rebuilt'; selection: TaskContext };

/**
 * Make the stored selection current. It is served unchanged only when nothing it depends on has moved (commit,
 * snapshot, size limit, request, CHANGES_REQUESTED re-entry, ranking rules); otherwise it is rebuilt, saved with
 * `save`, and the rebuilt one is returned. A rebuild that fails throws: the old selection is never a fallback.
 */
export function refreshTaskContext(args: {
  projectRoot: string;
  store: WorkStore;
  request: SelectionRequest;
  previous?: TaskContext;
  save: (selection: TaskContext) => void;
}): RefreshResult {
  const head = repoHead(args.projectRoot);
  if ('error' in head) {
    if (head.error === 'broken-head') throw brokenHeadError(head, args.projectRoot);
    return { status: 'unavailable', reason: head.error === 'not-a-repo' ? 'the project is not a git repository, so there is no commit to read files from' : 'the repository has no commits yet, so there is no commit to read files from' };
  }
  let reasons: Staleness[] = [];
  if (args.previous) {
    let stored: string | undefined;
    try {
      const s = args.store.getLatestSnapshotFor(args.projectRoot);
      if (s && s.commit === head.head) stored = s.hash;
    } catch {
      stored = undefined;
    }
    reasons = stalenessOf(args.previous, {
      commit: head.head,
      ...(stored ? { snapshotHash: stored } : {}),
      budget: args.request.budget,
      requestHash: requestHash(args.request.request),
      changesCycle: args.request.changesCycle,
    });
    if (!reasons.length) return { status: 'current', selection: args.previous };
  }
  const trigger: SelectionTrigger = reasons[0] ?? 'initial';
  const built = buildTaskContext(args.projectRoot, args.store, args.request, trigger, args.previous);
  if ('unavailable' in built) return { status: 'unavailable', reason: built.unavailable };
  args.save(built.selection);
  return { status: 'rebuilt', selection: built.selection };
}

