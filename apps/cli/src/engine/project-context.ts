import { err, shortSnapshotId, type DependencyFact, type RepoSnapshot } from '@turbine-hall/turbine-contracts';
import type { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import type { Fact } from './docs/normalize.js';
import { hasUncommittedChanges, listTree, observeBranch } from './context/git-read.js';
import { pathWordMatches } from './context/path-words.js';
import { buildSnapshot } from './context/snapshot.js';
import { brokenHeadError, buildOrThrow, ensureFreshSnapshot, publishFresh, repoHead, type RepoHead } from './context/understand.js';

/**
 * Project facts for assess/plan. This is a thin wrapper over the commit snapshot
 * (`engine/context/snapshot.ts`): everything here was read from git objects at one commit, so
 * it is stated as verified. With a store the snapshot is kept in step with HEAD (a stale one is
 * rebuilt first; if that fails this throws and the task stops). Declared and installed versions
 * are reported separately.
 */
export type ProjectEvidence = {
  projectRoot: string;
  collectedAt: string;
  git?: { branch: string; head: string; dirty: boolean };
  snapshot?: { hash: string; commit: string };
  packageManager?: string;
  packageName?: string;
  scripts: string[];
  stack: Array<{ name: string; version: string; installed?: string; source: string; installedSource?: string }>;
  testRunner?: string;
  typescript?: string;
  typescriptInstalled?: string;
  relatedFiles: string[];
  facts: Fact[];
};

const STACK: Array<[string, string]> = [
  ['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['@angular/core', 'Angular'],
  ['express', 'Express'], ['@nestjs/core', 'NestJS'], ['fastify', 'Fastify'], ['hono', 'Hono'],
  ['prisma', 'Prisma'], ['@prisma/client', 'Prisma'], ['typeorm', 'TypeORM'], ['mongoose', 'Mongoose'], ['drizzle-orm', 'Drizzle'],
  ['tailwindcss', 'Tailwind CSS'], ['zod', 'Zod'], ['react-hook-form', 'React Hook Form'],
];
const TEST_RUNNERS = ['vitest', 'jest', 'mocha', '@playwright/test', 'cypress'];

/**
 * Tracked files at the commit whose path mentions DISTINCTIVE words from the request (cap 12). The rule is
 * `pathWordMatches` (IDF weighting), the same one the task context uses as its weakest signal.
 */
function relatedFiles(allFiles: string[], requestText: string): string[] {
  return pathWordMatches(allFiles, requestText).slice(0, 12).map((x) => x.path);
}

/** Where a dependency fact came from: the manifest that declares it, plus the lockfile when it states an installed version. */
function sourcesOf(d: DependencyFact): string {
  return d.installed ? `${d.declared.source.path}, ${d.installed.lockfile}` : d.declared.source.path;
}

function describe(d: DependencyFact): string {
  return `${d.declared.spec} in ${d.declared.source.path}${d.installed ? `, installed ${d.installed.version} per ${d.installed.lockfile}` : ''}`;
}

/** A snapshot with the commit and branch HEAD was observed at when it was read. */
export type PinnedSnapshot = {
  at: RepoHead;
  snapshot: RepoSnapshot;
  /** Where HEAD is now (branch undefined when detached or when branch and commit could not be observed together). */
  observed: { commit: string; branch?: string };
};

/**
 * The project snapshot, pinned to the commit HEAD is at. With a store the snapshot is kept in step with HEAD (a
 * stale one is rebuilt, and published to `.turbine/context/`). If HEAD moves while this runs it is rebuilt once at
 * the new HEAD; a second move, or any failure, throws `E_CONTEXT_UNAVAILABLE`: an old snapshot is never served.
 * Returns the reason there is no snapshot when the project has no readable commit yet.
 */
export function pinSnapshot(projectRoot: string, opts: { store?: WorkStore } = {}): PinnedSnapshot | { error: 'not-a-repo' | 'no-commits' } {
  const at = repoHead(projectRoot);
  if ('error' in at) {
    // A HEAD that exists but is unreadable is a failure, not "no facts yet": stop instead of continuing blind.
    if (at.error === 'broken-head') throw brokenHeadError(at, projectRoot);
    return { error: at.error };
  }

  // HEAD can move during this collection, and each move costs one rebuild. ONE budget covers the whole
  // collection (publication and pinning alike): a single move recovers, and a second move stops the task (the
  // old facts are never served).
  let retriesLeft = 1;
  const load = (head: RepoHead): RepoSnapshot => {
    if (opts.store) {
      const fresh = ensureFreshSnapshot(opts.store, projectRoot, head);
      try {
        publishFresh(opts.store, projectRoot, fresh);
      } catch (e) {
        const headMoved = (e as { details?: { reason?: unknown } }).details?.reason === 'head-moved';
        const now = headMoved && retriesLeft > 0 ? repoHead(projectRoot) : undefined;
        if (now && !('error' in now)) {
          retriesLeft -= 1;
          return load(now);
        }
        throw e;
      }
      return fresh.snapshot;
    }
    return buildOrThrow(head, null, buildSnapshot);
  };
  let snapshot = load(at);

  // Where HEAD is now. Branch and commit come from ONE git observation when that is consistent. When it is
  // not (HEAD moved during the read), HEAD is resolved on its own: the commit is still known, and the branch
  // is then not stated.
  const pin = (): { commit: string; branch?: string } | undefined => {
    const observed = observeBranch(at.repoRoot);
    if (observed) return observed;
    const h = repoHead(projectRoot);
    return 'error' in h ? undefined : { commit: h.head };
  };
  let observed = pin();
  if (!observed || observed.commit !== snapshot.commit) {
    // HEAD moved while the snapshot was read (or cannot be read now): rebuild at the commit it is at now.
    // If that cannot be done, or HEAD keeps moving, the task stops; the old facts are never served.
    if (!observed) throw err('E_CONTEXT_UNAVAILABLE', 'HEAD could not be read after project facts were read; retry when the repository is quiet', { snapshot: snapshot.commit });
    if (retriesLeft <= 0) {
      throw err('E_CONTEXT_UNAVAILABLE', `HEAD keeps moving (snapshot at ${snapshot.commit.slice(0, 8)}, HEAD is ${observed.commit.slice(0, 8)}); project facts cannot be pinned to one commit. Retry when the checkout is quiet.`, { snapshot: snapshot.commit, head: observed.commit });
    }
    retriesLeft -= 1;
    const moved: RepoHead = { repoRoot: at.repoRoot, head: observed.commit };
    try {
      snapshot = load(moved);
    } catch (e) {
      throw err(
        'E_CONTEXT_UNAVAILABLE',
        `HEAD moved from ${at.head.slice(0, 8)} to ${observed.commit.slice(0, 8)} while project facts were read, and rebuilding them failed: ${(e as Error).message}`,
        { from: at.head, to: observed.commit },
      );
    }
    observed = pin();
    if (!observed || observed.commit !== snapshot.commit) {
      throw err(
        'E_CONTEXT_UNAVAILABLE',
        `HEAD keeps moving (snapshot at ${snapshot.commit.slice(0, 8)}, HEAD is ${observed?.commit.slice(0, 8) ?? 'unreadable'}); project facts cannot be pinned to one commit. Retry when the checkout is quiet.`,
        { snapshot: snapshot.commit, head: observed?.commit },
      );
    }
  }
  return { at, snapshot, observed: observed! };
}

/** Evidence from the snapshot (and live git state). Throws if the project facts cannot be made current. */
export function collectProjectEvidence(projectRoot: string, requestText = '', opts: { store?: WorkStore } = {}): ProjectEvidence {
  const facts: Fact[] = [];
  const ev: ProjectEvidence = {
    projectRoot,
    collectedAt: new Date().toISOString(),
    scripts: [],
    stack: [],
    relatedFiles: [],
    facts,
  };
  const pinned = pinSnapshot(projectRoot, opts);
  if ('error' in pinned) {
    facts.push({
      text: pinned.error === 'not-a-repo' ? 'Project is not a git repository' : 'Repository has no commits yet, so no project facts can be stated',
      source: 'git',
    });
    return ev;
  }
  const { at, snapshot, observed } = pinned;
  ev.snapshot = { hash: snapshot.hash, commit: snapshot.commit };

  const dirty = hasUncommittedChanges(at.repoRoot);
  if (observed?.branch) {
    ev.git = { branch: observed.branch, head: snapshot.commit, dirty };
    facts.push({ text: `Base branch is ${observed.branch} at ${snapshot.commit.slice(0, 8)} (project snapshot ${shortSnapshotId(snapshot.hash)})`, source: 'git' });
  } else {
    // detached HEAD, or the branch could not be observed together with the commit: state the commit only
    facts.push({ text: `Project facts are read from commit ${snapshot.commit.slice(0, 8)} (snapshot ${shortSnapshotId(snapshot.hash)})`, source: 'git' });
  }
  if (dirty) facts.push({ text: 'Uncommitted changes exist in the main checkout (not included)', source: 'git status' });

  const fact = (key: string) => snapshot.facts.find((f) => f.key === key);
  const root = fact('package:.');
  ev.packageName = typeof root?.data?.name === 'string' ? root.data.name : undefined;
  ev.scripts = snapshot.facts.filter((f) => f.key.startsWith('script:.:')).map((f) => String(f.data?.name));

  // Root dependencies first, then workspace packages.
  const deps = [...snapshot.dependencies].sort((a, b) => Number(a.workspace !== '.') - Number(b.workspace !== '.'));
  const find = (name: string) => deps.find((d) => d.name === name && d.section !== 'peerDependencies');
  for (const [dep, name] of STACK) {
    const d = find(dep);
    if (d && !ev.stack.some((s) => s.name === name)) ev.stack.push({ name, version: d.declared.spec, installed: d.installed?.version, source: d.declared.source.path, installedSource: d.installed?.lockfile });
  }
  ev.testRunner = TEST_RUNNERS.find((t) => find(t));
  const ts = find('typescript');
  ev.typescript = ts?.declared.spec;
  ev.typescriptInstalled = ts?.installed?.version;

  if (ev.stack.length) {
    facts.push({
      text: `Built with ${ev.stack.map((s) => `${s.name} declared ${s.version}${s.installed ? ` (installed ${s.installed})` : ''}`).join(', ')}`,
      source: [...new Set(ev.stack.flatMap((s) => [s.source, ...(s.installedSource ? [s.installedSource] : [])]))].join(', '),
    });
  }
  const useful = ev.scripts.filter((s) => /^(lint|test|typecheck|type-check|build|e2e|check)/.test(s));
  if (useful.length) facts.push({ text: `Scripts available: ${useful.join(', ')}`, source: 'package.json' });
  for (const f of snapshot.facts.filter((x) => x.category === 'command')) facts.push({ text: f.statement, source: f.source.path });
  if (root) {
    if (ev.testRunner) {
      const runner = find(ev.testRunner)!;
      facts.push({ text: `Test runner: ${ev.testRunner} (${describe(runner)})`, source: sourcesOf(runner) });
    }
    else facts.push({ text: 'No JavaScript test runner dependency found', source: 'package.json' });
  }
  if (ts) facts.push({ text: `TypeScript declared ${describe(ts)}`, source: sourcesOf(ts) });
  const pm = fact('package-manager');
  const lock = snapshot.facts.find((f) => f.key.startsWith('lockfile:'));
  if (pm) ev.packageManager = String(pm.data?.name);
  else if (lock) ev.packageManager = ({ 'pnpm-lock.yaml': 'pnpm', 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun' } as Record<string, string>)[String(lock.data?.file)];
  if (ev.packageManager) facts.push({ text: `Package manager: ${ev.packageManager}`, source: pm ? 'package.json' : lock!.source.path });
  const workspaces = snapshot.facts.filter((f) => f.category === 'workspace' && f.key !== 'workspace:declaration');
  if (workspaces.length) {
    facts.push({
      text: `Workspace packages (${workspaces.length}): ${workspaces.slice(0, 8).map((w) => String(w.data?.dir)).join(', ')}${workspaces.length > 8 ? `, +${workspaces.length - 8} more` : ''}`,
      source: fact('workspace:declaration')?.source.path ?? 'package.json',
    });
  }
  for (const d of deps.filter((x) => x.relation === 'mismatch').slice(0, 5)) {
    facts.push({ text: `Version drift: ${d.name} declared ${d.declared.spec} but installed ${d.installed!.version}`, source: d.installed!.lockfile });
  }

  ev.relatedFiles = relatedFiles(
    listTree(at.repoRoot, snapshot.commit).map((e) => e.path),
    requestText,
  );
  if (ev.relatedFiles.length) {
    facts.push({ text: `Existing files that look related: ${ev.relatedFiles.slice(0, 6).join(', ')}${ev.relatedFiles.length > 6 ? ` (+${ev.relatedFiles.length - 6})` : ''}`, source: 'git ls-tree' });
  }
  return ev;
}

/** Bullet facts derived deterministically (kept for callers that want plain strings). */
export function projectEvidenceFacts(evidence: ProjectEvidence): string[] {
  return evidence.facts.map((f) => f.text);
}

/**
 * Unknowns that are engineering discovery work, not human requirement blockers.
 * These must not force NEEDS_CLARIFICATION.
 */
export function isDeferredEngineeringUnknown(text: string): boolean {
  return /(latest.*(npm|registry|version)|@types|compatib|refactor|typecheck|build scripts? will pass|will force|exact .*version available|whether the upgrade|whether any @types|whether the existing)/i.test(
    text,
  );
}
