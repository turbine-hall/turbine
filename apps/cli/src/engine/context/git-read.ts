import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Reading a repository AT A COMMIT. Nothing here touches the working tree: tracked paths and
 * object ids come from `git ls-tree` and file contents from one `git cat-file --batch` process.
 * (`git ls-files -s <commit>` does not read a commit — it lists the index — so `ls-tree -r -l`
 * is used; it returns the same mode / object id / path, plus the blob size.)
 */

export type TreeEntry = {
  mode: string;
  /** "blob" for files; "commit" for submodules. */
  type: string;
  /** Object id (blob id for files, tree id for directories, commit id for submodules). */
  id: string;
  size: number;
  path: string;
};

function run(cwd: string, args: string[], input?: string | Buffer, maxBuffer = 256 * 1024 * 1024) {
  // Only the repository at `cwd` may be read. An inherited GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
  // GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR, ... would point git at a different repository, so every
  // GIT_* variable is removed. Also never contact a remote: a missing object is an error to report,
  // not something to fetch lazily (partial clones), and never prompt.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  const r = spawnSync('git', ['--no-replace-objects', '-c', 'core.quotepath=off', ...args], { cwd, input, maxBuffer, env });
  if (r.error) throw new Error(`git ${args[0]} failed: ${r.error.message}`);
  return { status: r.status ?? 1, stdout: r.stdout as Buffer, stderr: (r.stderr as Buffer).toString('utf8').trim() };
}

function must(cwd: string, args: string[], input?: string | Buffer, maxBuffer?: number): Buffer {
  const r = run(cwd, args, input, maxBuffer);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || `exit ${r.status}`}`);
  return r.stdout;
}

/** Top level of the repository containing `dir`, or null if it is not a git repository. */
export function repoToplevel(dir: string): string | null {
  const r = run(dir, ['rev-parse', '--show-toplevel']);
  // git ends the path with ONE newline; on POSIX a carriage return can be part of the directory name.
  const eol = process.platform === 'win32' ? /\r?\n$/ : /\n$/;
  return r.status === 0 ? r.stdout.toString('utf8').replace(eol, '') : null;
}

/** Full commit id for a revision (default HEAD), or null when it does not resolve (e.g. no commits yet). */
export function resolveCommit(repoRoot: string, rev = 'HEAD'): string | null {
  const r = run(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return r.status === 0 ? r.stdout.toString('utf8').trim() : null;
}

export type HeadState =
  | { kind: 'commit'; commit: string }
  /** HEAD names a branch that has no commits yet (a fresh `git init`). */
  | { kind: 'unborn' }
  /** HEAD exists but cannot be read as a commit (missing object, corrupt ref, ...). */
  | { kind: 'broken'; reason: string };

/** Tell a repository with no commits yet apart from one whose HEAD cannot be read. */
export function headState(repoRoot: string): HeadState {
  const head = resolveCommit(repoRoot, 'HEAD');
  if (head) return { kind: 'commit', commit: head };
  // The IMMEDIATE target of HEAD only: following a chain could hide a dangling link as "unborn".
  const sym = run(repoRoot, ['symbolic-ref', '--no-recurse', '--quiet', 'HEAD']);
  if (sym.status === 0) {
    const ref = sym.stdout.toString('utf8').replace(/\n$/, '');
    // The target is itself a symbolic ref that does not lead to a commit: not a fresh branch.
    if (run(repoRoot, ['symbolic-ref', '--quiet', ref]).status === 0) {
      return { kind: 'broken', reason: `${ref} is a symbolic ref that does not lead to a readable commit` };
    }
    // A loose ref FILE that exists is a ref, even when its content is garbage: that is broken, not a fresh
    // branch. (git's own exit codes do not separate "absent" from "corrupt" reliably: a corrupt ref makes
    // show-ref exit 1, the same as an absent one.)
    const loose = run(repoRoot, ['rev-parse', '--git-path', ref]);
    const loosePath = loose.stdout.toString('utf8').trim();
    if (loose.status === 0 && loosePath && existsSync(resolve(repoRoot, loosePath))) {
      return { kind: 'broken', reason: `${ref} exists but is not a readable commit` };
    }
    // Otherwise a packed or missing ref: show-ref --verify exits 1 only when the ref is absent.
    if (run(repoRoot, ['show-ref', '--verify', '--quiet', ref]).status === 1) return { kind: 'unborn' };
    return { kind: 'broken', reason: `${ref} does not point at a readable commit` };
  }
  return { kind: 'broken', reason: 'HEAD does not point at a readable commit' };
}

/** Branch and commit as git reports them right now (undefined branch when HEAD is detached). */
function headPair(repoRoot: string): { commit: string; branch?: string } | null {
  const oid = run(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (oid.status !== 0) return null;
  const sym = run(repoRoot, ['symbolic-ref', '--quiet', 'HEAD']);
  const ref = sym.status === 0 ? sym.stdout.toString('utf8').replace(/\n$/, '') : '';
  return { commit: oid.stdout.toString('utf8').trim(), ...(ref.startsWith('refs/heads/') ? { branch: ref.slice('refs/heads/'.length) } : {}) };
}

/**
 * Branch name and commit, stated together only when they can be shown to belong together. git has no
 * single call that returns both atomically, so HEAD is read, then read again: if the two readings agree
 * the pair is returned; if anything moved in between, null is returned and the caller must not state
 * a branch. (branch is undefined for a detached HEAD.)
 */
export function observeBranch(repoRoot: string): { commit: string; branch?: string } | null {
  const first = headPair(repoRoot);
  if (!first) return null;
  const second = headPair(repoRoot);
  if (!second || second.commit !== first.commit || second.branch !== first.branch) return null;
  return first;
}

/** Paths in the index (what is tracked) under `pathspec`. Reads the index only, never the working tree. */
export function trackedPaths(repoRoot: string, pathspec: string): string[] {
  const r = run(repoRoot, ['ls-files', '-z', '--', pathspec]);
  if (r.status !== 0) return [];
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
}

/**
 * Git's own answer to "would this path be ignored?" (all ignore files, in precedence order, including
 * negations). undefined when the directory is not a repository, so the caller can fall back.
 */
export function isGitIgnored(repoRoot: string, path: string): boolean | undefined {
  const r = run(repoRoot, ['check-ignore', '-q', '--no-index', '--', path]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return undefined;
}

export function treeIdOf(repoRoot: string, commit: string): string {
  return must(repoRoot, ['rev-parse', '--verify', `${commit}^{tree}`]).toString('utf8').trim();
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Entries plus how many records had a path that is not valid UTF-8 (those are never emitted). */
export type TreeListing = { entries: TreeEntry[]; undecodable: number };

function parseTree(out: Buffer): TreeListing {
  const entries: TreeEntry[] = [];
  let undecodable = 0;
  let pos = 0;
  while (pos < out.length) {
    let end = out.indexOf(0, pos);
    if (end < 0) end = out.length;
    const raw = out.subarray(pos, end);
    pos = end + 1;
    if (!raw.length) continue;
    // git prints path bytes verbatim. Decoding invalid UTF-8 would turn two different paths into
    // the same string, so such a path is not described at all (it is counted and reported).
    let rec: string;
    try {
      rec = UTF8.decode(raw);
    } catch {
      undecodable++;
      continue;
    }
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, id, size] = rec.slice(0, tab).split(/\s+/);
    const path = rec.slice(tab + 1);
    const known = /^\d+$/.test(size ?? '');
    // `git ls-tree -l` prints "-" for trees and submodules and "BAD" for a blob it cannot find.
    // A missing blob is recorded with size -1 so a claim that needs THAT path can refuse, without aborting the whole tree.
    entries.push({
      mode: mode!,
      type: type!,
      id: id!,
      size: type === 'blob' && !known ? -1 : known ? Number(size) : 0,
      path,
    });
  }
  return { entries, undecodable };
}

const byPath = (a: TreeEntry, b: TreeEntry) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Every tracked file at the commit (recursive). Sorted by path so results are deterministic. */
export function listTreeDetailed(repoRoot: string, commit: string): TreeListing {
  const r = parseTree(must(repoRoot, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit]));
  return { entries: r.entries.sort(byPath), undecodable: r.undecodable };
}

export function listTree(repoRoot: string, commit: string): TreeEntry[] {
  return listTreeDetailed(repoRoot, commit).entries;
}

/** Entries directly under the repository root (directories carry their tree id). */
export function listTopLevel(repoRoot: string, commit: string): TreeEntry[] {
  const out = must(repoRoot, ['ls-tree', '-l', '-z', '--full-tree', commit]);
  return parseTree(out).entries.sort(byPath);
}

/**
 * Read many blobs with ONE `git cat-file --batch` process. Throws if any object is missing or
 * is not a blob: a snapshot must never be built from a partial read.
 */
export function readBlobs(repoRoot: string, blobIds: string[], expectedBytes = 0): Map<string, Buffer> {
  const ids = [...new Set(blobIds)];
  const result = new Map<string, Buffer>();
  if (!ids.length) return result;
  const out = must(repoRoot, ['cat-file', '--batch'], `${ids.join('\n')}\n`, expectedBytes + ids.length * 160 + 1024 * 1024);
  let pos = 0;
  for (const id of ids) {
    const eol = out.indexOf(0x0a, pos);
    if (eol < 0) throw new Error(`git cat-file output ended early before ${id}`);
    const header = out.subarray(pos, eol).toString('utf8');
    const parts = header.split(' ');
    if (parts[1] === 'missing') throw new Error(`git object ${id} is missing from the repository`);
    if (parts[0] !== id || parts[1] !== 'blob') throw new Error(`unexpected git cat-file header "${header}" for ${id}`);
    const size = Number(parts[2]);
    const start = eol + 1;
    result.set(id, Buffer.from(out.subarray(start, start + size)));
    pos = start + size + 1; // each object is followed by a newline
  }
  return result;
}

/**
 * Which of `paths` git reports as changed between two commits (A added, M modified, D deleted, T type change).
 * Renames are not followed, so a moved file shows as D and A. Throws when either commit cannot be read.
 */
/** Whether `ancestor` is `descendant` or one of its ancestors. Throws when either is not a commit of the repository. */
export function isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  // Grafts rewrite parent links without changing the stored commits: a comparison that used them would not be a fact of the repository.
  const grafts = run(repoRoot, ['rev-parse', '--git-path', 'info/grafts']);
  if (grafts.status === 0) {
    const path = String(grafts.stdout).trim();
    if (path && existsSync(resolve(repoRoot, path))) {
      throw new Error('this repository has info/grafts; ancestry cannot be settled from the stored parent links until the grafts are removed');
    }
  }
  // Shallow state is read before AND after: a "no" is settled only if the history was complete for the whole query.
  const full = (): boolean => {
    const shallow = run(repoRoot, ['rev-parse', '--is-shallow-repository']);
    return shallow.status === 0 && String(shallow.stdout).trim() === 'false';
  };
  const completeBefore = full();
  const r = run(repoRoot, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (r.status === 0) return true;
  if (r.status === 1) {
    // In a shallow repository git stops at the boundary and ignores the parent link behind it: "no" is then not a settled answer.
    if (!completeBefore || !full()) {
      throw new Error('the history of this repository is shallow (or could not be checked), so it is not known whether the commits are related; fetch the full history and try again');
    }
    return false;
  }
  throw new Error(`git merge-base --is-ancestor failed: ${r.stderr || `exit ${r.status}`}`);
}

export function changedBetween(repoRoot: string, from: string, to: string, paths: string[]): Array<{ path: string; status: string }> {
  if (!paths.length) return [];
  const out = must(repoRoot, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', from, to, '--', ...paths.map((p) => `:(literal)${p}`)]);
  const parts = out.toString('utf8').split('\0').filter(Boolean);
  const changed: Array<{ path: string; status: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) changed.push({ status: parts[i]!, path: parts[i + 1]! });
  return changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * True when the main checkout has uncommitted changes (staged, unstaged or untracked), ignoring
 * Turbine's own `.turbine/` directory. Only used to say "uncommitted changes exist (not included)".
 */
export function hasUncommittedChanges(repoRoot: string): boolean {
  const r = run(repoRoot, ['status', '--porcelain', '-z', '--untracked-files=normal', '--', '.', ':(exclude).turbine']);
  return r.status === 0 && r.stdout.length > 0;
}
