import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { err } from '@turbine-hall/turbine-contracts';
import type { Capability, ToolAdapter } from '@turbine-hall/turbine-tools';

function git(cwd: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
  return {
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
    status: result.status ?? 1,
  };
}

export type RepoInfo = {
  root: string;
  branch: string;
  head: string;
  dirty: boolean;
  remotes: string[];
};

export function inspectRepo(cwd: string): RepoInfo {
  const rootRes = git(cwd, ['rev-parse', '--show-toplevel']);
  if (rootRes.status !== 0) throw err('E_ADAPTER', `Not a git repository: ${cwd}`);
  const root = rootRes.stdout.trim();
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const dirty = git(root, ['status', '--porcelain']).stdout.trim().length > 0;
  const remotes = git(root, ['remote']).stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return { root, branch, head, dirty, remotes };
}

export function createWorktree(input: {
  repoRoot: string;
  workId: string;
  branchName?: string;
  /** Where to put the worktree; defaults to <repo>/.turbine/worktrees/<workId>. */
  worktreePath?: string;
}): { worktreePath: string; branch: string; baseCommit: string } {
  const info = inspectRepo(input.repoRoot);
  const branch = input.branchName ?? `turbine/${input.workId}`;
  const worktreePath =
    input.worktreePath ?? join(info.root, '.turbine', 'worktrees', input.workId);
  mkdirSync(join(worktreePath, '..'), { recursive: true });

  if (existsSync(worktreePath)) {
    const head = git(worktreePath, ['rev-parse', 'HEAD']).stdout.trim();
    return { worktreePath, branch, baseCommit: head };
  }

  const branchExists = git(info.root, ['rev-parse', '--verify', branch]).status === 0;
  if (!branchExists) {
    const created = git(info.root, ['branch', branch, info.head]);
    if (created.status !== 0) {
      throw err('E_ADAPTER', `Failed to create branch ${branch}: ${created.stderr}`);
    }
  }

  const added = git(info.root, ['worktree', 'add', worktreePath, branch]);
  if (added.status !== 0) {
    throw err('E_ADAPTER', `Failed to create worktree: ${added.stderr}`);
  }
  return { worktreePath, branch, baseCommit: info.head };
}

export function headOf(path: string): string {
  const r = git(path, ['rev-parse', 'HEAD']);
  if (r.status !== 0) throw err('E_ADAPTER', `Cannot read HEAD in ${path}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** Uncommitted (staged, unstaged or untracked) paths in a worktree. */
export function uncommittedPaths(path: string): string[] {
  return git(path, ['status', '--porcelain'])
    .stdout.split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

export type ChangedFile = { status: string; path: string };

export function changedFiles(path: string, base: string, head = 'HEAD'): ChangedFile[] {
  const r = git(path, ['diff', '--name-status', '--no-renames', `${base}...${head}`]);
  if (r.status !== 0) throw err('E_ADAPTER', r.stderr || 'git diff --name-status failed');
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status: status ?? '?', path: rest.join('\t') };
    });
}

export function diffStat(path: string, base: string, head = 'HEAD'): { insertions: number; deletions: number } {
  const r = git(path, ['diff', '--numstat', `${base}...${head}`]);
  let insertions = 0;
  let deletions = 0;
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [a, d] = line.split('\t');
    insertions += Number(a) || 0;
    deletions += Number(d) || 0;
  }
  return { insertions, deletions };
}

/** File content at a commit, or undefined if it does not exist there. */
export function fileAt(path: string, commit: string, file: string): string | undefined {
  const r = git(path, ['show', `${commit}:${file}`]);
  return r.status === 0 ? r.stdout : undefined;
}

export function diffWorktree(worktreePath: string, baseCommit: string, headCommit = 'HEAD'): string {
  const result = git(worktreePath, ['diff', `${baseCommit}...${headCommit}`]);
  if (result.status !== 0) throw err('E_ADAPTER', result.stderr || 'git diff failed');
  return result.stdout;
}

export function createGitAdapter(repoRoot: string): ToolAdapter {
  return {
    id: 'git',
    capabilities: ['repo.inspect', 'repo.read', 'git.diff', 'git.branch.create'] as Capability[],
    async healthCheck() {
      try {
        const info = inspectRepo(repoRoot);
        return { ok: true, details: `root=${info.root} head=${info.head.slice(0, 8)}` };
      } catch (e) {
        return { ok: false, details: e instanceof Error ? e.message : String(e) };
      }
    },
    async invoke({ capability, arguments: args }) {
      if (capability === 'repo.inspect' || capability === 'repo.read') {
        return { data: inspectRepo(String(args.cwd ?? repoRoot)) };
      }
      if (capability === 'git.diff') {
        return {
          data: {
            diff: diffWorktree(
              String(args.worktreePath),
              String(args.baseCommit),
              args.headCommit === undefined ? 'HEAD' : String(args.headCommit),
            ),
          },
        };
      }
      if (capability === 'git.branch.create') {
        return {
          data: createWorktree({
            repoRoot,
            workId: String(args.workId),
            branchName: args.branchName ? String(args.branchName) : undefined,
          }),
        };
      }
      throw err('E_MISSING_CAPABILITY', `Git adapter does not support ${capability}`);
    },
  };
}
