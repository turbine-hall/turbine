import { spawnSync } from 'node:child_process';

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
  const r = spawnSync('git', ['--no-replace-objects', '-c', 'core.quotepath=off', ...args], { cwd, input, maxBuffer });
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
  return r.status === 0 ? r.stdout.toString('utf8').replace(/\r?\n$/, '') : null;
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
  const sym = run(repoRoot, ['symbolic-ref', '--quiet', 'HEAD']);
  if (sym.status === 0) {
    const ref = sym.stdout.toString('utf8').replace(/\r?\n$/, '');
    // `show-ref --verify` exits 1 when the ref does not exist (nothing committed on this branch yet)
    // and 128 when it exists but points at a missing or invalid object (a broken HEAD).
    if (run(repoRoot, ['show-ref', '--verify', '--quiet', ref]).status === 1) return { kind: 'unborn' };
    return { kind: 'broken', reason: `${ref} does not point at a readable commit` };
  }
  return { kind: 'broken', reason: 'HEAD does not point at a readable commit' };
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
    if (type === 'blob' && !known) throw new Error(`git object ${id} (${path}) is missing from the repository`);
    entries.push({ mode: mode!, type: type!, id: id!, size: known ? Number(size) : 0, path });
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
 * True when the main checkout has uncommitted changes (staged, unstaged or untracked), ignoring
 * Turbine's own `.turbine/` directory. Only used to say "uncommitted changes exist (not included)".
 */
export function hasUncommittedChanges(repoRoot: string): boolean {
  const r = run(repoRoot, ['status', '--porcelain', '-z', '--untracked-files=normal', '--', '.', ':(exclude).turbine']);
  return r.status === 0 && r.stdout.length > 0;
}
