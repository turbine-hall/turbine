import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  changedFiles,
  createWorktree,
  diffStat,
  diffWorktree,
  fileAt,
  headOf,
  inspectRepo,
  uncommittedPaths,
  type ChangedFile,
} from '@turbine-hall/turbine-adapter-git';
import { err, type RepoRef, type WorkPackage } from '@turbine-hall/turbine-contracts';

/**
 * A task's change set: one entry per repository the task changes. The project repo is
 * always first ("primary"); extra repos come from work.repositories.
 *
 * Everything that binds to "the commit under review" (approvals, evidence, waivers) uses
 * changeSetId(): the plain head sha for single-repo tasks, or a hash over every repo's
 * head for multi-repo tasks — so a new commit in ANY repo makes reviews and checks stale.
 */
export type RepoState = {
  name: string;
  root: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
  checks: string[];
  setup: string[];
  primary: boolean;
};

export function worktreePathFor(projectRoot: string, workId: string, repoName?: string): string {
  const dir = join(projectRoot, '.turbine', 'worktrees');
  return repoName ? join(dir, `${workId}--${repoName}`) : join(dir, workId);
}

export function primaryName(projectRoot: string): string {
  return basename(projectRoot).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'project';
}

export function changeSetId(repos: Array<Pick<RepoState, 'name' | 'headCommit'>>): string {
  if (repos.length === 1) return repos[0]!.headCommit;
  const material = [...repos]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => `${r.name}@${r.headCommit}`)
    .join('\n');
  return createHash('sha256').update(material).digest('hex').slice(0, 40);
}

export function baseSetId(repos: Array<Pick<RepoState, 'name' | 'baseCommit'>>): string {
  return changeSetId(repos.map((r) => ({ name: r.name, headCommit: r.baseCommit })));
}

/** Create (or reuse) a worktree on turbine/<workId> in every repo of the task. */
export function prepareWorktrees(input: {
  projectRoot: string;
  work: WorkPackage;
  primaryChecks: string[];
  primarySetup: string[];
}): RepoState[] {
  const { projectRoot, work } = input;
  const out: RepoState[] = [];
  const primary = createWorktree({ repoRoot: projectRoot, workId: work.id });
  out.push({
    name: primaryName(projectRoot),
    root: inspectRepo(projectRoot).root,
    worktreePath: primary.worktreePath,
    branch: primary.branch,
    baseCommit: primary.baseCommit,
    headCommit: headOf(primary.worktreePath),
    checks: input.primaryChecks,
    setup: input.primarySetup,
    primary: true,
  });
  for (const repo of work.repositories ?? []) {
    out.push(prepareExtra(projectRoot, work.id, repo));
  }
  return out;
}

function prepareExtra(projectRoot: string, workId: string, repo: RepoRef): RepoState {
  if (!existsSync(repo.path)) throw err('E_NOT_FOUND', `Repository ${repo.name} not found at ${repo.path}`);
  const wt = createWorktree({
    repoRoot: repo.path,
    workId,
    worktreePath: worktreePathFor(projectRoot, workId, repo.name),
  });
  return {
    name: repo.name,
    root: inspectRepo(repo.path).root,
    worktreePath: wt.worktreePath,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
    headCommit: headOf(wt.worktreePath),
    checks: repo.checks,
    setup: repo.setup,
    primary: false,
  };
}

/** Re-read every worktree's HEAD and uncommitted files. */
export function observe(repos: RepoState[]): {
  repos: RepoState[];
  uncommitted: Array<{ repo: string; paths: string[] }>;
} {
  const next = repos.map((r) => ({ ...r, headCommit: headOf(r.worktreePath) }));
  const uncommitted = repos
    .map((r) => ({ repo: r.name, paths: uncommittedPaths(r.worktreePath) }))
    .filter((u) => u.paths.length > 0);
  return { repos: next, uncommitted };
}

export type DependencyChange = { name: string; from?: string; to?: string; section: string };

export type RepoFacts = {
  repo: string;
  baseCommit: string;
  headCommit: string;
  files: ChangedFile[];
  insertions: number;
  deletions: number;
  testFilesChanged: string[];
  dependencies: { added: DependencyChange[]; removed: DependencyChange[]; changed: DependencyChange[] };
};

const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(__tests__\/)|(^|\/)(tests?|e2e)\//i;
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function readDeps(json: string | undefined): Map<string, { version: string; section: string }> {
  const map = new Map<string, { version: string; section: string }>();
  if (!json) return map;
  try {
    const pkg = JSON.parse(json) as Record<string, Record<string, string> | undefined>;
    for (const section of DEP_SECTIONS) {
      for (const [name, version] of Object.entries(pkg[section] ?? {})) {
        map.set(name, { version: String(version), section });
      }
    }
  } catch {
    /* unparsable package.json: report no dependency facts */
  }
  return map;
}

/** Deterministic facts about what changed — computed from git, never from a model. */
export function computeFacts(repos: RepoState[]): RepoFacts[] {
  return repos.map((r) => {
    const files = changedFiles(r.worktreePath, r.baseCommit, r.headCommit);
    const stat = diffStat(r.worktreePath, r.baseCommit, r.headCommit);
    const added: DependencyChange[] = [];
    const removed: DependencyChange[] = [];
    const changed: DependencyChange[] = [];
    for (const f of files.filter((x) => x.path === 'package.json' || x.path.endsWith('/package.json'))) {
      const before = readDeps(fileAt(r.worktreePath, r.baseCommit, f.path));
      const after = readDeps(fileAt(r.worktreePath, r.headCommit, f.path));
      for (const [name, a] of after) {
        const b = before.get(name);
        if (!b) added.push({ name, to: a.version, section: a.section });
        else if (b.version !== a.version) changed.push({ name, from: b.version, to: a.version, section: a.section });
      }
      for (const [name, b] of before) {
        if (!after.has(name)) removed.push({ name, from: b.version, section: b.section });
      }
    }
    return {
      repo: r.name,
      baseCommit: r.baseCommit,
      headCommit: r.headCommit,
      files,
      insertions: stat.insertions,
      deletions: stat.deletions,
      testFilesChanged: files.filter((f) => f.status !== 'D' && TEST_FILE.test(f.path)).map((f) => f.path),
      dependencies: { added, removed, changed },
    };
  });
}

/** Unified diffs for every repo, capped in size; reports which repos were truncated. */
export function collectDiffs(repos: RepoState[], maxChars = 60_000): { text: string; truncated: string[] } {
  const truncated: string[] = [];
  const perRepo = Math.floor(maxChars / Math.max(1, repos.length));
  const parts = repos.map((r) => {
    let d = diffWorktree(r.worktreePath, r.baseCommit);
    if (d.length > perRepo) {
      truncated.push(r.name);
      d = `${d.slice(0, perRepo)}\n[... diff truncated at ${perRepo} characters ...]`;
    }
    return `### repo: ${r.name}\n${d}`;
  });
  return { text: parts.join('\n\n'), truncated };
}
