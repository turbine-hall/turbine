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
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, input, maxBuffer });
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
  return r.status === 0 ? r.stdout.toString('utf8').trim() : null;
}

/** Full commit id for a revision (default HEAD), or null when it does not resolve (e.g. no commits yet). */
export function resolveCommit(repoRoot: string, rev = 'HEAD'): string | null {
  const r = run(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return r.status === 0 ? r.stdout.toString('utf8').trim() : null;
}

export function treeIdOf(repoRoot: string, commit: string): string {
  return must(repoRoot, ['rev-parse', '--verify', `${commit}^{tree}`]).toString('utf8').trim();
}

function parseTree(out: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const rec of out.toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, id, size] = rec.slice(0, tab).split(/\s+/);
    const path = rec.slice(tab + 1);
    const known = /^\d+$/.test(size ?? '');
    // `git ls-tree -l` prints "-" for trees and submodules and "BAD" for a blob it cannot find.
    if (type === 'blob' && !known) throw new Error(`git object ${id} (${path}) is missing from the repository`);
    entries.push({ mode: mode!, type: type!, id: id!, size: known ? Number(size) : 0, path });
  }
  return entries;
}

/** Every tracked file at the commit (recursive). Sorted by path so results are deterministic. */
export function listTree(repoRoot: string, commit: string): TreeEntry[] {
  const out = must(repoRoot, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit]);
  return parseTree(out).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Entries directly under the repository root (directories carry their tree id). */
export function listTopLevel(repoRoot: string, commit: string): TreeEntry[] {
  const out = must(repoRoot, ['ls-tree', '-l', '-z', '--full-tree', commit]);
  return parseTree(out).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
  const r = run(repoRoot, ['status', '--porcelain', '-z', '--', '.', ':(exclude).turbine']);
  return r.status === 0 && r.stdout.length > 0;
}
