/**
 * Issue #6 — repository context, layer 1: project facts.
 * One describe block per acceptance criterion, plus planted traps (a dirty file that
 * contradicts the committed one, a partial convention, version drift, a stale snapshot and a
 * failed rebuild).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConventionSchema,
  ContextFactSchema,
  hasUnsafeKey,
  DependencyFactSchema,
  RepoSnapshotSchema,
  sealSnapshot,
  shortSnapshotId,
  type FactSource,
  type RepoSnapshot,
} from '../../packages/contracts/dist/index.js';
import { WorkStore } from '../../packages/storage-sqlite/dist/index.js';
import { DatabaseSync } from 'node:sqlite';
import { initProject, openContext } from '../../apps/cli/src/engine/project.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { collectProjectEvidence } from '../../apps/cli/src/engine/project-context.js';
import { buildSnapshot, diffSnapshots } from '../../apps/cli/src/engine/context/snapshot.js';
import {
  ensureFreshSnapshot,
  formatOutcome,
  repoHead,
  understandOnInit,
  understandProject,
} from '../../apps/cli/src/engine/context/understand.js';
import { contextFilesCurrent, contextPaths, lintProjectContext, writeContextFiles } from '../../apps/cli/src/engine/context/render.js';
import { parseJsonc } from '../../apps/cli/src/engine/context/jsonc.js';
import { satisfies } from '../../apps/cli/src/engine/context/semver-lite.js';
import { hasUncommittedChanges, headState, observeBranch, repoToplevel } from '../../apps/cli/src/engine/context/git-read.js';
import { cleanup, commitIn, git, tempProject } from './fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const factory = resolve(here, '../..');
const dirs: string[] = [];
const stores: WorkStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  cleanup(dirs);
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function head(dir: string): string {
  return git(dir, 'rev-parse', 'HEAD').stdout.trim();
}

/** Write/commit several files at once (null deletes a file). */
function commitFiles(dir: string, files: Record<string, string | null>, msg = 'change'): string {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) {
      git(dir, 'rm', '-q', '-f', file);
      continue;
    }
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
    git(dir, 'add', file);
  }
  git(dir, 'commit', '-qm', msg);
  return head(dir);
}

function newRepo(files: Record<string, string>): string {
  const dir = tmp('turbine-ctx-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  commitFiles(dir, files, 'init');
  return dir;
}

function openStore(): WorkStore {
  const store = new WorkStore(join(tmp('turbine-ctx-db-'), 'engine.db'));
  stores.push(store);
  return store;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

const PNPM_LOCK_DRIFT = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      left-pad:
        specifier: 1.3.0
        version: 1.2.0
      zod:
        specifier: ^4.1.12
        version: 4.1.13
    devDependencies:
      typescript:
        specifier: ^5.9.3
        version: 5.9.3
      vitest:
        specifier: ^3.0.0
        version: 3.2.7(@types/node@22.20.5)(tsx@4.23.15)
`;

const APP_PACKAGE = {
  name: 'app',
  version: '1.0.0',
  private: true,
  type: 'module',
  packageManager: 'pnpm@10.0.0',
  engines: { node: '>=22' },
  scripts: { build: 'tsc -p .', lint: 'eslint .', test: 'vitest run', typecheck: 'tsc --noEmit' },
  dependencies: { 'left-pad': '1.3.0', zod: '^4.1.12' },
  devDependencies: { typescript: '^5.9.3', vitest: '^3.0.0' },
};

function appFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'package.json': json(APP_PACKAGE),
    'pnpm-lock.yaml': PNPM_LOCK_DRIFT,
    'tsconfig.json': '{\n  // comments are allowed in tsconfig\n  "compilerOptions": {\n    "strict": true,\n    "target": "ES2022"\n  }\n}\n',
    '.editorconfig': 'root = true\n\n[*]\nindent_style = space\nindent_size = 2\n',
    '.nvmrc': '22\n',
    'src/index.ts': "import './a.js';\nexport const x = 1;\n",
    'tests/app.test.ts': "import { x } from '../src/index.js';\nvoid x;\n",
    ...extra,
  };
}

function sourcesOf(s: RepoSnapshot): FactSource[] {
  return [
    ...s.facts.map((f) => f.source),
    ...s.dependencies.flatMap((d) => [d.declared.source, ...(d.installed ? [d.installed.source] : [])]),
    ...s.conventions.flatMap((c) => [c.source, ...c.counterexamples]),
    ...s.unconfirmed.map((u) => u.source),
  ];
}

function expectSourcesTrue(dir: string, s: RepoSnapshot): void {
  const sources = sourcesOf(s);
  expect(sources.length).toBeGreaterThan(0);
  for (const src of sources) {
    expect(src.commit).toBe(s.commit);
    const expected =
      src.object === 'tree'
        ? git(dir, 'rev-parse', src.path === '.' ? `${src.commit}^{tree}` : `${src.commit}:${src.path}`).stdout.trim()
        : git(dir, 'rev-parse', `${src.commit}:${src.path}`).stdout.trim();
    expect(src.blob, `${src.path} blob id`).toBe(expected);
    if (src.lines && src.object === 'blob') {
      const text = git(dir, 'show', `${src.commit}:${src.path}`).stdout.split('\n');
      expect(src.lines.end).toBeLessThanOrEqual(text.length);
    }
  }
}

describe('criterion 1 — `turbine understand` on a fresh repo builds a snapshot; every fact carries {path, commit, blob}', () => {
  it('builds layout, workspaces, entry points, scripts, commands, versions, dependencies and conventions from the commit', () => {
    const dir = newRepo({
      ...appFiles(),
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - '!packages/ignored'\n",
      'packages/lib/package.json': json({ name: '@app/lib', version: '0.1.0', main: './dist/index.js', bin: { lib: './dist/cli.js' }, exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } }, dependencies: { zod: '^4.0.0' } }),
      'packages/ignored/package.json': json({ name: '@app/ignored' }),
    });
    const store = openStore();
    const out = understandProject(store, dir);
    expect(out.status).toBe('built');
    const s = out.snapshot;
    expect(s.commit).toBe(head(dir));
    expect(RepoSnapshotSchema.safeParse(s).success).toBe(true);

    const text = (key: string) => s.facts.find((f) => f.key === key)?.statement ?? '';
    expect(text('layout:src')).toContain('Top-level directory `src/`');
    expect(text('workspace:packages/lib')).toContain('@app/lib');
    expect(s.facts.some((f) => f.key === 'workspace:packages/ignored')).toBe(false); // excluded by !pattern
    expect(text('package-manager')).toContain('pnpm@10.0.0');
    expect(text('command:test')).toContain('vitest run');
    expect(text('command:test')).toContain('pnpm run test');
    expect(text('command:build')).toContain('tsc -p .');
    expect(text('script:.:lint')).toContain('eslint .');
    expect(text('version:.:engines.node')).toContain('>=22');
    expect(text('version:node:.nvmrc')).toContain('22');
    expect(text('language:tsconfig.json:target')).toContain('"ES2022"');
    expect(text('entry:packages/lib:main')).toContain('./dist/index.js');
    expect(text('entry:packages/lib:bin:lib')).toContain('./dist/cli.js');
    expect(text('entry:packages/lib:exports:.:import')).toContain('./dist/index.js');
    expect(s.dependencies.some((d) => d.workspace === 'packages/lib' && d.name === 'zod')).toBe(true);
    expect(s.conventions.some((c) => c.key === 'convention:tsconfig:tsconfig.json:strict' && c.status === 'confirmed')).toBe(true);
    expect(s.conventions.some((c) => c.key === 'convention:editorconfig:indent_style' && c.status === 'confirmed')).toBe(true);
  });

  it('every fact, dependency, convention and unconfirmed item carries a source that matches git exactly (blob id, commit, lines)', () => {
    const dir = newRepo(appFiles());
    const s = buildSnapshot(dir, head(dir));
    expectSourcesTrue(dir, s);
    const script = s.facts.find((f) => f.key === 'script:.:test')!;
    const lines = git(dir, 'show', `${s.commit}:package.json`).stdout.split('\n');
    expect(lines[script.source.lines!.start - 1]).toContain('"test"');
    const dep = s.dependencies.find((d) => d.name === 'left-pad')!;
    expect(lines[dep.declared.source.lines!.start - 1]).toContain('"left-pad"');
    const lock = git(dir, 'show', `${s.commit}:pnpm-lock.yaml`).stdout.split('\n');
    expect(lock.slice(dep.installed!.source.lines!.start - 1, dep.installed!.source.lines!.end).join('\n')).toContain('1.2.0');
  });

  it('the schema rejects a fact without a source, and anything not at the snapshot commit', () => {
    const sha = 'a'.repeat(40);
    const source = { path: 'package.json', commit: sha, blob: 'b'.repeat(40), object: 'blob' as const };
    expect(ContextFactSchema.safeParse({ key: 'k', category: 'script', statement: 's' }).success).toBe(false);
    expect(ContextFactSchema.safeParse({ key: 'k', category: 'script', statement: 's', source: { path: 'x', commit: sha } }).success).toBe(false);
    expect(ContextFactSchema.safeParse({ key: 'k', category: 'script', statement: 's', source: { ...source, blob: 'not-a-sha' } }).success).toBe(false);
    expect(ContextFactSchema.safeParse({ key: 'k', category: 'script', statement: 's', source }).success).toBe(true);
    const body = { schemaVersion: 1 as const, commit: sha, tree: 'c'.repeat(40), dependencies: [], conventions: [], unconfirmed: [] };
    expect(() => sealSnapshot({ ...body, facts: [{ key: 'k', category: 'script', statement: 's', source }] })).not.toThrow();
    expect(() => sealSnapshot({ ...body, facts: [{ key: 'k', category: 'script', statement: 's', source: { ...source, commit: 'd'.repeat(40) } }] })).toThrow(/not at the snapshot commit/);
  });

  it('reads only git objects: one `git cat-file --batch` process, no `ls-files`/`show`, and a deleted working tree changes nothing', () => {
    const dir = newRepo(appFiles());
    const real = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    const bin = tmp('turbine-ctx-bin-');
    const log = join(bin, 'calls.log');
    const envLog = join(bin, 'env.log');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\necho "$GIT_NO_LAZY_FETCH" >> "${envLog}"\nexec "${real}" "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const before = buildSnapshot(dir, head(dir));
    rmSync(join(dir, 'package.json')); // the working tree no longer has it
    rmSync(join(dir, 'src'), { recursive: true });
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    let after: RepoSnapshot;
    try {
      after = buildSnapshot(dir, head(dir));
    } finally {
      process.env.PATH = oldPath;
    }
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.filter((c) => c.includes('cat-file'))).toEqual(['--no-replace-objects -c core.quotepath=off cat-file --batch']);
    expect(calls.some((c) => /\b(ls-files|show|diff)\b/.test(c))).toBe(false);
    expect(after.hash).toBe(before.hash);
    // every git call forbids lazy fetching, so a missing object is reported and never fetched from a remote
    const envs = readFileSync(envLog, 'utf8').trim().split('\n');
    expect(envs.length).toBeGreaterThan(0);
    expect(new Set(envs)).toEqual(new Set(['1']));
  });
});

describe('criterion 2 — running it twice at the same commit makes no changes and yields the same hash', () => {
  it('the second run prints "Project understood (snapshot <sha8>)" and writes nothing', async () => {
    const dir = newRepo(appFiles());
    const store = openStore();
    const first = understandProject(store, dir);
    expect(first.status).toBe('built');
    expect(first.written.length).toBe(2);
    const p = contextPaths(dir);
    const mtimes = () => [statSync(p.snapshot).mtimeMs, statSync(p.project).mtimeMs];
    const before = mtimes();
    await new Promise((r) => setTimeout(r, 25));
    const second = understandProject(store, dir);
    expect(second.status).toBe('current');
    expect(second.written).toEqual([]);
    expect(second.snapshot.hash).toBe(first.snapshot.hash);
    expect(mtimes()).toEqual(before);
    expect(formatOutcome(second)).toEqual([`Project understood (snapshot ${shortSnapshotId(first.snapshot.hash)})`]);
    expect(shortSnapshotId(first.snapshot.hash)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('the same commit always gives the same hash, even in a clone at another path', () => {
    const dir = newRepo(appFiles());
    const clone = tmp('turbine-ctx-clone-');
    rmSync(clone, { recursive: true });
    git(dir, 'clone', '-q', dir, clone);
    const a = buildSnapshot(dir, head(dir));
    const b = buildSnapshot(dir, head(dir));
    const c = buildSnapshot(clone, head(clone));
    expect(head(clone)).toBe(head(dir));
    expect(b.hash).toBe(a.hash);
    expect(c.hash).toBe(a.hash);
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
    expect(JSON.stringify(a)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // no timestamps in the hashed data
  });

  it('storage: migration v2 creates repo_snapshots; save/get/latest round-trip and reject a tampered snapshot', () => {
    const dir = newRepo(appFiles());
    const store = openStore();
    const tables = store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='repo_snapshots'`).all();
    expect(tables).toHaveLength(1);
    const versions = (store.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version);
    expect(versions).toContain(2);
    const cols = (store.db.prepare(`PRAGMA table_info(repo_snapshots)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(['hash', 'repo_path', 'commit', 'data', 'created_at']);

    const c1 = head(dir);
    const s1 = buildSnapshot(dir, c1);
    const c2 = commitFiles(dir, { 'src/more.ts': 'export {};\n' });
    const s2 = buildSnapshot(dir, c2);
    store.saveSnapshot(s1, dir);
    store.saveSnapshot(s2, dir);
    expect(store.getSnapshot(s1.hash)).toEqual(s1);
    expect(store.getLatestSnapshotFor(dir)?.hash).toBe(s2.hash);
    store.saveSnapshot(s1, dir); // saving again makes it the latest
    expect(store.getLatestSnapshotFor(dir)?.hash).toBe(s1.hash);
    expect(store.getLatestSnapshotFor('/somewhere/else')).toBeNull();

    expect(() => store.saveSnapshot({ ...s1, facts: s1.facts.slice(1) }, dir)).toThrow(/hash/);
    store.db.prepare('UPDATE repo_snapshots SET data = replace(data, ?, ?) WHERE hash = ?').run('Top-level directory', 'Top-level folder', s1.hash);
    expect(() => store.getSnapshot(s1.hash)).toThrow(/hash/);
  });
});

describe('criterion 3 — after a new commit it rebuilds the snapshot and prints a correct diff', () => {
  it('reports added, removed and changed facts by key', () => {
    const dir = newRepo(appFiles());
    const store = openStore();
    const first = understandProject(store, dir);
    const pkg = { ...APP_PACKAGE, scripts: { build: 'tsc -p .', test: 'vitest', typecheck: 'tsc --noEmit' }, dependencies: { ...APP_PACKAGE.dependencies, express: '^5.0.0' } };
    commitFiles(dir, { 'package.json': json(pkg), 'docs/readme.md': '# docs\n' });
    const second = understandProject(store, dir);
    expect(second.status).toBe('rebuilt');
    expect(second.snapshot.commit).toBe(head(dir));
    expect(second.previous?.hash).toBe(first.snapshot.hash);
    const d = second.diff!;
    expect(d.added.map((x) => x.key)).toEqual(expect.arrayContaining(['dep:.:dependencies:express', 'layout:docs']));
    expect(d.removed.map((x) => x.key)).toEqual(['command:lint', 'script:.:lint']);
    expect(d.changed.map((x) => x.key)).toContain('script:.:test');
    const changed = d.changed.find((x) => x.key === 'script:.:test')!;
    expect(changed.before).toContain('vitest run');
    expect(changed.after).toContain('`vitest`');
    // a new commit alone is not a change: keys that did not change are absent
    expect(d.changed.map((x) => x.key)).not.toContain('script:.:build');
    expect(d.added.map((x) => x.key)).not.toContain('script:.:build');
    // the stored snapshot is now the new one, and the printed diff mentions it
    expect(store.getLatestSnapshotFor(dir)?.hash).toBe(second.snapshot.hash);
    const printed = formatOutcome(second).join('\n');
    expect(printed).toContain('Project facts were stale');
    expect(printed).toContain('+ dep:.:dependencies:express');
    expect(printed).toContain('- script:.:lint');
    expect(printed).toContain('~ script:.:test');
    // diffSnapshots can be used directly
    expect(diffSnapshots(first.snapshot, first.snapshot)).toEqual({ added: [], removed: [], changed: [] });
    // the generated files follow the new snapshot
    expect(readFileSync(contextPaths(dir).snapshot, 'utf8')).toContain(second.snapshot.hash);
  });
});

describe('criterion 4 — uncommitted changes never appear in any fact', () => {
  it('a dirty tree that contradicts the commit changes nothing; it only yields "uncommitted changes exist (not included)"', () => {
    const dir = newRepo(appFiles());
    const store = openStore();
    const clean = understandProject(store, dir);
    expect(clean.dirty).toBe(false);
    expect(formatOutcome(clean).join('\n')).not.toContain('uncommitted');

    // Plant traps: edit tracked files, stage another change, add untracked files.
    writeFileSync(join(dir, 'package.json'), json({ ...APP_PACKAGE, scripts: { test: 'jest --evil' }, dependencies: { 'evil-pkg': '9.9.9' }, engines: { node: '>=1' } }));
    writeFileSync(join(dir, 'tsconfig.json'), '{"compilerOptions":{"strict":false,"target":"ES5"}}');
    writeFileSync(join(dir, 'src/staged.ts'), "import './no-extension';\n");
    git(dir, 'add', 'src/staged.ts');
    writeFileSync(join(dir, 'src/untracked.ts'), "import './also-no-extension';\n");
    writeFileSync(join(dir, 'tsconfig.evil.json'), '{"compilerOptions":{"strict":false}}');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), PNPM_LOCK_DRIFT.replace('1.2.0', '1.3.0'));

    const again = understandProject(store, dir);
    expect(again.status).toBe('current');
    expect(again.dirty).toBe(true);
    expect(again.snapshot.hash).toBe(clean.snapshot.hash);
    const everything = JSON.stringify(buildSnapshot(dir, head(dir)));
    for (const forbidden of ['evil', 'jest', '9.9.9', 'no-extension', 'ES5', 'staged.ts', 'untracked.ts', '"strict: false']) {
      expect(everything).not.toContain(forbidden);
    }
    const lines = formatOutcome(again);
    expect(lines).toEqual([`Project understood (snapshot ${shortSnapshotId(clean.snapshot.hash)})`, 'Note: uncommitted changes exist (not included).']);
    // the generated files do not mention the dirty files either
    expect(readFileSync(contextPaths(dir).project, 'utf8')).not.toMatch(/evil|untracked\.ts|staged\.ts/);
  });

  it('the evidence wrapper states only the dirty-tree notice, never dirty content', () => {
    const dir = newRepo(appFiles());
    writeFileSync(join(dir, 'package.json'), json({ ...APP_PACKAGE, scripts: { test: 'jest' } }));
    const ev = collectProjectEvidence(dir, 'export report', { store: openStore() });
    const text = ev.facts.map((f) => f.text).join('\n');
    expect(text).toContain('Uncommitted changes exist in the main checkout (not included)');
    expect(text).not.toContain('jest');
    expect(text).toContain('vitest run');
  });
});

describe('criterion 5 — a convention without an enforcing config and under 100% is unconfirmed, with counts', () => {
  const relImports = (n: number, withExt: number) =>
    Array.from({ length: n }, (_, i) => (i < withExt ? `import './m${i}.js';` : `import './bare${i}';`)).join('\n') + '\n';

  it('47 of 50 relative imports use .js → unconfirmed, with counts and counterexamples; never confirmed', () => {
    const dir = newRepo({ 'package.json': json({ name: 'p' }), 'src/index.ts': relImports(50, 47) });
    const s = buildSnapshot(dir, head(dir));
    const c = s.conventions.find((x) => x.key === 'convention:imports:relative-js-extension')!;
    expect(c.status).toBe('unconfirmed');
    expect(c.basis).toBe('count');
    // A textual scan cannot prove every import was seen, so the count is never exhaustive.
    expect(c.measured).toEqual({ matched: 47, total: 50, exhaustive: false, scope: expect.stringContaining('textual scan') });
    expect(c.statement).toContain('47 of 50 relative import specifiers end in .js');
    expect(c.statement).toContain('not a confirmed convention');
    expect(c.counterexamples).toHaveLength(3);
    expect(c.counterexamples[0]).toMatchObject({ path: 'src/index.ts', commit: s.commit, lines: { start: 48, end: 48 } });
    expect(s.conventions.filter((x) => x.status === 'confirmed').some((x) => x.key.includes('relative-js-extension'))).toBe(false);
    expect(s.facts.some((f) => f.statement.includes('.js extension'))).toBe(false); // never stated as a fact

    const store = openStore();
    understandProject(store, dir);
    const md = readFileSync(contextPaths(dir).project, 'utf8');
    const [confirmed, unconfirmed] = md.split('### Conventions — unconfirmed');
    expect(confirmed).not.toContain('47 of 50');
    expect(unconfirmed).toContain('47 of 50 relative import specifiers end in .js');
  });

  it('even a 100% import count is unconfirmed: a textual scan cannot prove it saw every import', () => {
    const dir = newRepo({ 'package.json': json({ name: 'p' }), 'src/index.ts': relImports(10, 10) });
    const full = buildSnapshot(dir, head(dir)).conventions.find((x) => x.key === 'convention:imports:relative-js-extension')!;
    expect(full.status).toBe('unconfirmed');
    expect(full.measured).toMatchObject({ matched: 10, total: 10, exhaustive: false });
    expect(full.statement).toContain('not a confirmed convention');
    const next = commitFiles(dir, { 'src/other.ts': "import './stray';\n" });
    const partial = buildSnapshot(dir, next).conventions.find((x) => x.key === 'convention:imports:relative-js-extension')!;
    expect(partial.status).toBe('unconfirmed');
    expect(partial.measured).toMatchObject({ matched: 10, total: 11 });
  });

  it('config-enforced conventions are confirmed with the file and lines; JS configs are not evaluated', () => {
    const dir = newRepo({
      'package.json': json({ name: 'p', prettier: { singleQuote: true } }),
      'tsconfig.base.json': '{\n  "compilerOptions": {\n    "strict": true,\n    "noUncheckedIndexedAccess": true\n  }\n}\n',
      '.editorconfig': '[*]\nindent_style = tab\n\n[*.md]\ntrim_trailing_whitespace = false\n',
      'eslint.config.js': 'export default [];\n',
      'src/a.ts': 'export {};\n',
    });
    const s = buildSnapshot(dir, head(dir));
    const conv = (key: string) => s.conventions.find((c) => c.key === key);
    expect(conv('convention:tsconfig:tsconfig.base.json:strict')).toMatchObject({ status: 'confirmed', basis: 'config', source: { path: 'tsconfig.base.json', lines: { start: 3, end: 3 } } });
    expect(conv('convention:tsconfig:tsconfig.base.json:noUncheckedIndexedAccess')?.status).toBe('confirmed');
    expect(conv('convention:prettier:package.json:singleQuote')?.status).toBe('confirmed');
    expect(conv('convention:editorconfig:indent_style')?.statement).toContain('indent_style = tab');
    expect(conv('convention:editorconfig:trim_trailing_whitespace')).toBeUndefined(); // only the [*] section
    expect(s.unconfirmed.find((u) => u.key === 'unconfirmed:eslint:eslint.config.js')?.statement).toContain('not evaluated');
    expectSourcesTrue(dir, s);
  });

  it('the schema refuses a "confirmed" convention without proof', () => {
    const source = { path: '.', commit: 'a'.repeat(40), blob: 'b'.repeat(40), object: 'tree' as const };
    const base = { key: 'k', topic: 't', statement: 's', basis: 'count' as const, source, counterexamples: [] };
    const measured = (matched: number, total: number, exhaustive: boolean) => ({ matched, total, exhaustive, scope: 'x' });
    expect(ConventionSchema.safeParse({ ...base, status: 'confirmed', measured: measured(47, 50, true) }).success).toBe(false);
    expect(ConventionSchema.safeParse({ ...base, status: 'confirmed', measured: measured(50, 50, false) }).success).toBe(false);
    expect(ConventionSchema.safeParse({ ...base, status: 'confirmed' }).success).toBe(false);
    expect(ConventionSchema.safeParse({ ...base, status: 'confirmed', measured: measured(50, 50, true) }).success).toBe(true);
    expect(ConventionSchema.safeParse({ ...base, status: 'unconfirmed', measured: measured(47, 50, true) }).success).toBe(true);
    expect(ConventionSchema.safeParse({ ...base, status: 'unconfirmed', measured: measured(50, 50, true) }).success).toBe(false);
    expect(ConventionSchema.safeParse({ ...base, basis: 'config', status: 'unconfirmed' }).success).toBe(false);
  });
});

describe('criterion 6 — declared vs installed version drift is shown with both values', () => {
  it('pnpm-lock: exact pin that the lockfile does not honour is drift; ranges that hold are matches', () => {
    const dir = newRepo(appFiles());
    const s = buildSnapshot(dir, head(dir));
    const dep = (name: string) => s.dependencies.find((d) => d.workspace === '.' && d.name === name)!;
    const drift = dep('left-pad');
    expect(drift.declared.spec).toBe('1.3.0');
    expect(drift.installed?.version).toBe('1.2.0');
    expect(drift.installed?.lockfile).toBe('pnpm-lock.yaml');
    expect(drift.relation).toBe('mismatch');
    expect(drift.statement).toContain('declared `1.3.0`');
    expect(drift.statement).toContain('installed 1.2.0');
    expect(drift.statement).toContain('version drift');
    expect(drift.declared.source.path).toBe('package.json');
    expect(drift.installed?.source.path).toBe('pnpm-lock.yaml');
    expect(dep('zod')).toMatchObject({ relation: 'match', installed: { version: '4.1.13' } });
    expect(dep('vitest')).toMatchObject({ relation: 'match', installed: { version: '3.2.7' } }); // peer suffix stripped
    expect(dep('typescript').declared.spec).toBe('^5.9.3');

    const store = openStore();
    understandProject(store, dir);
    const md = readFileSync(contextPaths(dir).project, 'utf8');
    expect(md).toContain('**Version drift (installed does not satisfy declared):**');
    expect(md).toContain('left-pad: declared `1.3.0`');
    expect(md).toContain('installed 1.2.0');
    const evidence = collectProjectEvidence(dir, '', { store });
    expect(evidence.facts.map((f) => f.text)).toContain('Version drift: left-pad declared 1.3.0 but installed 1.2.0');
    expect(evidence.typescript).toBe('^5.9.3');
    expect(evidence.typescriptInstalled).toBe('5.9.3');
    expect(evidence.facts.find((f) => f.text.startsWith('TypeScript'))?.text).toBe('TypeScript declared ^5.9.3 in package.json, installed 5.9.3 per pnpm-lock.yaml');
  });

  it('package-lock.json workspaces: the nearest node_modules wins; declared and installed stay separate', () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'root' },
        'node_modules/left-pad': { version: '1.2.0' },
        'packages/a/node_modules/left-pad': { version: '1.0.0' },
        'node_modules/@root/a': { resolved: 'packages/a', link: true },
      },
    };
    const dir = newRepo({
      'package.json': json({ name: 'root', workspaces: ['packages/*'], dependencies: { 'left-pad': '^1.2.0', '@root/a': '*' } }),
      'package-lock.json': json(lock),
      'packages/a/package.json': json({ name: '@root/a', dependencies: { 'left-pad': '1.0.0' } }),
    });
    const s = buildSnapshot(dir, head(dir));
    const find = (w: string, n: string) => s.dependencies.find((d) => d.workspace === w && d.name === n)!;
    expect(find('.', 'left-pad')).toMatchObject({ relation: 'match', installed: { version: '1.2.0', lockfile: 'package-lock.json' } });
    expect(find('packages/a', 'left-pad')).toMatchObject({ relation: 'match', installed: { version: '1.0.0' } });
    expect(find('.', '@root/a')).toMatchObject({ installedStatus: 'workspace-link' });
    expect(s.facts.find((f) => f.key === 'workspace:declaration')?.statement).toContain('packages/*');
    expectSourcesTrue(dir, s);
  });

  it('yarn.lock is not parsed: installed versions are reported as unknown and the gap is listed as unconfirmed', () => {
    const dir = newRepo({ 'package.json': json({ name: 'y', dependencies: { chalk: '^5.0.0' } }), 'yarn.lock': '# yarn lockfile v1\n' });
    const s = buildSnapshot(dir, head(dir));
    expect(s.dependencies[0]).toMatchObject({ name: 'chalk', installedStatus: 'lockfile-not-parsed', relation: 'unchecked' });
    expect(s.dependencies[0]!.installed).toBeUndefined();
    expect(s.unconfirmed.find((u) => u.key === 'unparsed:yarn.lock')?.statement).toContain('does not parse it');
  });

  it('the schema keeps declared and installed apart and rejects a verdict without an installed version', () => {
    const source = { path: 'package.json', commit: 'a'.repeat(40), blob: 'b'.repeat(40) };
    const base = { key: 'k', name: 'x', workspace: '.', section: 'dependencies' as const, declared: { spec: '^1', source }, statement: 's' };
    expect(DependencyFactSchema.safeParse({ ...base, installedStatus: 'no-lockfile', relation: 'unchecked' }).success).toBe(true);
    expect(DependencyFactSchema.safeParse({ ...base, installedStatus: 'no-lockfile', relation: 'mismatch' }).success).toBe(false);
    expect(DependencyFactSchema.safeParse({ ...base, installedStatus: 'locked', relation: 'match' }).success).toBe(false);
    expect(DependencyFactSchema.safeParse({ ...base, installedStatus: 'locked', relation: 'match', installed: { version: '1.0.0', lockfile: 'pnpm-lock.yaml', source } }).success).toBe(true);
  });
});

describe('criterion 7 — a task never runs on a stale snapshot; a failed rebuild stops it with a clear error', () => {
  /** Remove a blob from the object store, so reading that commit fails. */
  function destroyBlob(dir: string, path: string): void {
    const id = git(dir, 'rev-parse', `HEAD:${path}`).stdout.trim();
    rmSync(join(dir, '.git', 'objects', id.slice(0, 2), id.slice(2)), { force: true });
  }

  it('HEAD != snapshot commit → the snapshot is rebuilt before it is used', () => {
    const dir = newRepo(appFiles());
    const store = openStore();
    const first = collectProjectEvidence(dir, '', { store });
    expect(first.snapshot?.commit).toBe(head(dir));
    const c2 = commitFiles(dir, { 'package.json': json({ ...APP_PACKAGE, scripts: { test: 'mocha' } }) });
    const second = collectProjectEvidence(dir, '', { store });
    expect(second.snapshot?.commit).toBe(c2);
    expect(second.snapshot?.hash).not.toBe(first.snapshot?.hash);
    expect(second.scripts).toEqual(['test']);
    expect(store.getLatestSnapshotFor(dir)?.commit).toBe(c2);
    expect(readFileSync(contextPaths(dir).snapshot, 'utf8')).toContain(c2);
    const at = repoHead(dir);
    if ('error' in at) throw new Error('expected a repo');
    expect(ensureFreshSnapshot(store, dir, at).status).toBe('current');
  });

  it('a failed rebuild throws and the old snapshot is not used', () => {
    const dir = newRepo(appFiles());
    const store = openStore();
    const old = collectProjectEvidence(dir, '', { store });
    commitFiles(dir, { 'src/new.ts': 'export const created = true;\n' });
    destroyBlob(dir, 'src/new.ts');
    let thrown: unknown;
    try {
      collectProjectEvidence(dir, '', { store });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ code: 'E_CONTEXT_UNAVAILABLE' });
    expect((thrown as Error).message).toMatch(/Project facts are stale \(snapshot [0-9a-f]{8} was taken at [0-9a-f]{8}, HEAD is [0-9a-f]{8}\) and rebuilding them failed/);
    expect((thrown as Error).message).toContain('is missing from the repository');
    expect((thrown as Error).message).toContain('The old snapshot is not used');
    expect((thrown as Error).message).toContain('turbine understand');
    // nothing fell back to, or replaced, the old snapshot
    expect(store.getLatestSnapshotFor(dir)?.commit).toBe(old.snapshot?.commit);
    expect(() => understandProject(store, dir)).toThrow(/rebuilding them failed/);
  });

  it('a first build that fails also throws instead of returning partial facts', () => {
    const dir = newRepo(appFiles());
    destroyBlob(dir, 'package.json');
    expect(() => collectProjectEvidence(dir, '', { store: openStore() })).toThrow(/could not be built at [0-9a-f]{8}: git object [0-9a-f]{40,64} \(package\.json\) is missing from the repository/);
  });

  it('assess stops with the error on a stale snapshot whose rebuild fails; a repaired repo works again', async () => {
    const dir = tempProject('turbine-ctx-engine-', dirs);
    const engine = new Engine(openContext(dir));
    stores.push(engine.ctx.store);
    const ok = engine.createTask({ title: 'Export CSV', text: '# Export\n\nManagers export leave requests as CSV.', type: 'feature' });
    await engine.syncFromMarkdown(ok.id); // assess: builds the snapshot at HEAD
    const first = engine.ctx.store.getLatestSnapshotFor(dir)!;
    expect(first.commit).toBe(head(dir));
    expect(existsSync(contextPaths(dir).project)).toBe(true);

    commitIn(dir, 'src/new.ts', 'export const created = true;\n');
    destroyBlob(dir, 'src/new.ts');
    const blocked = engine.createTask({ title: 'Second task', text: '# Another\n\nSomething else.', type: 'feature' });
    await expect(engine.syncFromMarkdown(blocked.id)).rejects.toMatchObject({ code: 'E_CONTEXT_UNAVAILABLE' });
    expect(engine.ctx.store.getLatestSnapshotFor(dir)?.hash).toBe(first.hash); // not replaced, not served
    // No assessment was produced; the task waits in ASSESSING and resumes once the facts can be rebuilt.
    expect(engine.ctx.store.getWork(blocked.id).currentState).toBe('ASSESSING');
    expect(engine.ctx.store.getLatestArtifact(blocked.id, 'specification')).toBeNull();
    await expect(engine.assess(blocked.id)).rejects.toMatchObject({ code: 'E_CONTEXT_UNAVAILABLE' });

    // Remove the broken file in a new commit: the snapshot rebuilds and the task proceeds.
    commitFiles(dir, { 'src/new.ts': null });
    await engine.assess(blocked.id);
    expect(engine.ctx.store.getLatestSnapshotFor(dir)?.commit).toBe(head(dir));
    expect(engine.ctx.store.getLatestArtifact(blocked.id, 'specification')).not.toBeNull();
  });
});

describe('generated files: .turbine/context/snapshot.json and PROJECT.md (header + content hash), flagged by `turbine lint` when edited', () => {
  it('renders a generated header and a content hash, and lint is clean until someone edits it', () => {
    const dir = newRepo(appFiles());
    initProject({ projectPath: dir, nonInteractive: true });
    const store = openStore();
    understandProject(store, dir);
    const p = contextPaths(dir);
    const md = readFileSync(p.project, 'utf8');
    const snap = JSON.parse(readFileSync(p.snapshot, 'utf8')) as RepoSnapshot;
    expect(md.startsWith('<!-- GENERATED by `turbine understand`.')).toBe(true);
    expect(md).toMatch(/<!-- turbine:facts begin snapshot=sha256:[0-9a-f]{64} commit=[0-9a-f]{40,64} content=sha256:[0-9a-f]{64} -->/);
    expect(md).toContain(`snapshot=${snap.hash}`);
    expect(md).toContain('## Facts');
    expect(md).toMatch(/_\(package\.json@[0-9a-f]{8}:L\d+/); // facts cite path@blob:lines
    expect(readFileSync(join(dir, '.turbine', '.gitignore'), 'utf8')).toContain('context/'); // committing it would make it stale
    expect(lintProjectContext(dir)).toEqual([]);

    // hand-edit the facts
    writeFileSync(p.project, md.replace('## Facts', '## Facts\n\n- I added this by hand'));
    expect(lintProjectContext(dir)).toEqual([expect.objectContaining({ level: 'error', file: 'PROJECT.md', message: expect.stringContaining('edited by hand') })]);
    // hand-edit the snapshot
    writeFileSync(p.project, md);
    writeFileSync(p.snapshot, readFileSync(p.snapshot, 'utf8').replace('strict: true', 'strict: false'));
    const issues = lintProjectContext(dir);
    expect(issues.some((i) => i.file === 'snapshot.json' && i.level === 'error')).toBe(true);
  });

  it('understand overwrites a hand edit and says so; text outside the Facts section survives', () => {
    const dir = newRepo(appFiles());
    initProject({ projectPath: dir, nonInteractive: true });
    const store = openStore();
    understandProject(store, dir);
    const p = contextPaths(dir);
    writeFileSync(p.project, `${readFileSync(p.project, 'utf8').replace('## Facts', '## Facts\n\nTAMPERED')}\n## Notes\n\nkept\n`);
    expect(lintProjectContext(dir).length).toBeGreaterThan(0);
    const out = understandProject(store, dir);
    expect(out.status).toBe('current');
    expect(out.repaired).toBe(true);
    expect(formatOutcome(out)[0]).toMatch(/^Project understood \(snapshot [0-9a-f]{8}\)$/);
    const md = readFileSync(p.project, 'utf8');
    expect(md).not.toContain('TAMPERED');
    expect(md).toContain('## Notes\n\nkept');
    expect(lintProjectContext(dir)).toEqual([]);
  });

  it('`turbine init` on a repo with commits runs understand; with no commits it does not', () => {
    const repo = newRepo(appFiles());
    const store = openStore();
    const message = understandOnInit(store, repo);
    expect(message).toMatch(/^Project understood \(snapshot [0-9a-f]{8}\): built from commit [0-9a-f]{8}/);
    expect(store.getLatestSnapshotFor(repo)?.commit).toBe(head(repo));

    const empty = tmp('turbine-ctx-empty-');
    git(empty, 'init', '-q');
    expect(understandOnInit(openStore(), empty)).toBeUndefined();
    expect(() => understandProject(openStore(), empty)).toThrow(/no commits yet/);
    const notRepo = tmp('turbine-ctx-norepo-');
    expect(() => understandProject(openStore(), notRepo)).toThrow(/not a git repository/);
  });
});

describe('the CLI end to end', () => {
  const tsx = join(factory, 'node_modules', '.bin', 'tsx');
  const cli = join(factory, 'apps', 'cli', 'src', 'index.ts');
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(tsx, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, INIT_CWD: cwd, PWD: cwd } });

  it('init → understand (up to date, writes nothing) → lint → hand edit flagged → understand repairs', async () => {
    const repo = newRepo(appFiles());
    const init = run(repo, 'init', '--non-interactive');
    expect(init.status, init.stderr).toBe(0);
    expect(init.stdout).toMatch(/"context": "Project understood \(snapshot [0-9a-f]{8}\): built from commit/);
    const p = contextPaths(repo);
    expect(existsSync(p.snapshot) && existsSync(p.project)).toBe(true);

    const mtimes = [statSync(p.snapshot).mtimeMs, statSync(p.project).mtimeMs];
    await new Promise((r) => setTimeout(r, 25));
    const again = run(repo, 'understand');
    expect(again.status, again.stderr).toBe(0);
    const [first, ...rest] = again.stdout.trim().split('\n');
    expect(first).toMatch(/^Project understood \(snapshot [0-9a-f]{8}\)$/);
    expect(rest).toEqual(['Note: uncommitted changes exist (not included).']); // init added .cursor/ files
    expect([statSync(p.snapshot).mtimeMs, statSync(p.project).mtimeMs]).toEqual(mtimes);

    const lint = run(repo, 'lint');
    expect(lint.status).toBe(0);
    expect(lint.stdout).toContain('Project context OK.');
    writeFileSync(p.project, readFileSync(p.project, 'utf8').replace('## Facts', '## Facts\n\nhand edit'));
    const bad = run(repo, 'lint');
    expect(bad.status).toBe(3);
    expect(bad.stdout).toContain('edited by hand');
    const fixed = run(repo, 'understand');
    expect(fixed.stdout).toContain('Regenerated .turbine/context/');
    expect(run(repo, 'lint').status).toBe(0);

    // stale after a new commit: rebuild + diff
    commitFiles(repo, { 'docs/new.md': '# new\n' });
    const stale = run(repo, 'understand');
    expect(stale.stdout).toContain('Project facts were stale');
    expect(stale.stdout).toContain('+ layout:docs');
  });

  it('`turbine init` in a repo with no commits does not fail and builds nothing', () => {
    const empty = tmp('turbine-ctx-cli-empty-');
    git(empty, 'init', '-q');
    const init = run(empty, 'init', '--non-interactive');
    expect(init.status, init.stderr).toBe(0);
    expect(init.stdout).not.toContain('Project understood');
    expect(existsSync(contextPaths(empty).snapshot)).toBe(false);
  });
});

describe('review follow-ups (PR #9): every hole a reviewer found stays closed', () => {
  const snap = (files: Record<string, string>) => {
    const dir = newRepo(files);
    return { dir, s: buildSnapshot(dir, head(dir)) };
  };
  const byKey = <T extends { key: string }>(xs: T[], key: string) => xs.find((x) => x.key === key);
  const destroyBlob = (dir: string, path: string) => {
    const id = git(dir, 'rev-parse', `HEAD:${path}`).stdout.trim();
    rmSync(join(dir, '.git', 'objects', id.slice(0, 2), id.slice(2)), { force: true });
  };

  describe('git reading', () => {
    it('replacement refs are ignored: the snapshot describes the real commit, not a `git replace` stand-in', () => {
      const dir = newRepo({ 'package.json': json({ name: 'one' }) });
      const real = commitFiles(dir, { 'package.json': json({ name: 'two' }) });
      git(dir, 'replace', real, git(dir, 'rev-parse', 'HEAD~1').stdout.trim());
      const realTree = spawnSync('git', ['--no-replace-objects', 'rev-parse', `${real}^{tree}`], { cwd: dir, encoding: 'utf8' }).stdout.trim();
      const s = buildSnapshot(dir, real);
      expect(s.tree).toBe(realTree);
      expect(byKey(s.facts, 'package:.')?.statement).toContain('`two`');
    });

    it('the repository path keeps trailing whitespace; the dirty notice sees untracked files even when git hides them', () => {
      const spaced = join(tmpdir(), `turbine-ctx-space-${process.pid} `);
      mkdirSync(spaced);
      dirs.push(spaced);
      git(spaced, 'init', '-q');
      expect(repoToplevel(spaced)).toBe(realpathSync(spaced));

      const dir = newRepo(appFiles());
      git(dir, 'config', 'status.showUntrackedFiles', 'no');
      expect(hasUncommittedChanges(dir)).toBe(false);
      writeFileSync(join(dir, 'src', 'new.ts'), 'export {};\n');
      expect(hasUncommittedChanges(dir)).toBe(true);
    });

    it('a path that is not valid UTF-8 is not described, and the gap is reported instead of colliding with another path', () => {
      const dir = newRepo(appFiles());
      const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'x\n', encoding: 'utf8' }).stdout.trim();
      const base = git(dir, 'rev-parse', 'HEAD^{tree}').stdout.trim();
      const entry = (name: number[]) => Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), Buffer.from(name), Buffer.from([0])]);
      const existing = spawnSync('git', ['ls-tree', '-z', base], { cwd: dir });
      const tree = spawnSync('git', ['mktree', '-z'], {
        cwd: dir,
        input: Buffer.concat([existing.stdout, entry([0x61, 0xff, 0x2e, 0x74, 0x73]), entry([0x61, 0xfe, 0x2e, 0x74, 0x73])]),
        encoding: 'utf8',
      }).stdout.trim();
      const commit = git(dir, 'commit-tree', tree, '-m', 'bad paths').stdout.trim();
      const s = buildSnapshot(dir, commit);
      expect(byKey(s.unconfirmed, 'paths:non-utf8')?.statement).toContain('2 tracked path(s) are not valid UTF-8');
      // the unreadable names also stop "kebab-case" from being claimed as an exhaustive count
      expect(byKey(s.conventions, 'convention:files:kebab-case')?.measured?.exhaustive).toBe(false);
    });

    it('HEAD of a repository with no commits is "unborn"; a HEAD that cannot be read is a failure, not "no facts"', () => {
      const empty = tmp('turbine-ctx-unborn-');
      git(empty, 'init', '-q');
      expect(headState(empty)).toEqual({ kind: 'unborn' });
      expect(repoHead(empty)).toEqual({ error: 'no-commits' });

      const dir = newRepo(appFiles());
      const branch = git(dir, 'symbolic-ref', '--short', 'HEAD').stdout.trim();
      writeFileSync(join(dir, '.git', 'refs', 'heads', branch), '0000000000000000000000000000000000000001\n');
      expect(headState(dir).kind).toBe('broken');
      expect(repoHead(dir)).toMatchObject({ error: 'broken-head' });
      expect(() => collectProjectEvidence(dir, '', { store: openStore() })).toThrow(/Project facts cannot be read/);
      expect(() => understandProject(openStore(), dir)).toThrow(/Project facts cannot be read/);
    });
  });

  describe('parsers', () => {
    it('jsonc: a long number does not truncate the manifest; distinct paths stay distinct; __proto__ is an ordinary member', () => {
      const long = '1'.repeat(41);
      const a = parseJsonc(`{"big": ${long}, "scripts": {"test": "vitest"}}`);
      expect((a.value as { scripts: { test: string } }).scripts.test).toBe('vitest');
      expect(a.lines(['scripts', 'test'])).toBeDefined();

      const b = parseJsonc('{\n"scripts\\u0000test": 1,\n"scripts": {\n"test": 2\n}\n}');
      expect(b.lines(['scripts', 'test'])).toEqual({ start: 4, end: 4 });
      expect(b.lines(['scripts\u0000test'])).toEqual({ start: 2, end: 2 });

      const c = parseJsonc('{"__proto__": {"compilerOptions": {"strict": true}}}').value as Record<string, unknown>;
      expect(Object.keys(c)).toContain('__proto__');
      expect(c.compilerOptions).toBeUndefined();
    });

    it('a tsconfig with a "__proto__" member does not confirm options it never set', () => {
      const { s } = snap({
        'package.json': json({ name: 'p' }),
        'tsconfig.json': '{"__proto__": {"compilerOptions": {"strict": true}}}\n',
      });
      expect(s.conventions.some((c) => c.key.startsWith('convention:tsconfig:'))).toBe(false);
    });

    it('semver-lite: a v prefix is understood and numbers that JavaScript would round are not judged', () => {
      expect(satisfies('1.3.0', '^v1.2.3')).toBe('match');
      expect(satisfies('1.3.0', '^1.2.3')).toBe('match');
      expect(satisfies('1.2.0', '1.3.0')).toBe('mismatch');
      expect(satisfies('9007199254740992.0.0', '^9007199254740993.0.0')).toBe('unchecked');
      expect(satisfies('1.0.0', 'latest')).toBe('unchecked');
    });

    it('an unreadable YAML file (unresolved alias) becomes an unconfirmed item instead of failing the snapshot', () => {
      const { s } = snap({ 'package.json': json({ name: 'p' }), 'pnpm-workspace.yaml': 'packages:\n  - *nowhere\n' });
      expect(byKey(s.unconfirmed, 'unparsed:pnpm-workspace.yaml')).toBeDefined();
    });
  });

  describe('workspaces', () => {
    const pkg = (name: string) => json({ name });

    it('brace patterns like {apps,packages}/* find their packages', () => {
      const { s } = snap({
        'package.json': json({ name: 'root' }),
        'pnpm-workspace.yaml': "packages:\n  - '{apps,packages}/*'\n  - '!packages/skip'\n",
        'apps/web/package.json': pkg('web'),
        'packages/ui/package.json': pkg('ui'),
        'packages/skip/package.json': pkg('skip'),
        'tools/x/package.json': pkg('x'),
      });
      const dirsFound = s.facts.filter((f) => f.category === 'workspace' && f.key !== 'workspace:declaration').map((f) => f.key);
      expect(dirsFound).toEqual(['workspace:apps/web', 'workspace:packages/ui']);
    });

    it('a pattern Turbine cannot evaluate is reported, not silently treated as a literal name', () => {
      const { s } = snap({
        'package.json': json({ name: 'root' }),
        'pnpm-workspace.yaml': "packages:\n  - 'packages/[ab]*'\n",
        'packages/a/package.json': pkg('a'),
      });
      expect(s.unconfirmed.find((u) => u.key.startsWith('workspace:unsupported-pattern:'))?.statement).toContain('packages/[ab]*');
    });

    it('a hostile pattern cannot cause catastrophic backtracking (matching runs in a child process with a hard timeout)', () => {
      const hostile = `${'*a'.repeat(30)}*b`;
      const deep = `${'a'.repeat(60)}/x`;
      // fixture creation is not part of what is timed
      const dir = newRepo({
        'package.json': json({ name: 'root' }),
        'pnpm-workspace.yaml': `packages:\n  - '${hostile}'\n`,
        [`${deep}/package.json`]: pkg('deep'),
      });
      const script = join(tmp('turbine-ctx-script-'), 'run.mts');
      const modulePath = join(factory, 'apps', 'cli', 'src', 'engine', 'context', 'snapshot.ts');
      writeFileSync(
        script,
        `import { buildSnapshot } from ${JSON.stringify(modulePath)};\nconst s = buildSnapshot(${JSON.stringify(dir)}, ${JSON.stringify(head(dir))});\nconsole.log(JSON.stringify(s.facts.some((f) => f.key === ${JSON.stringify(`workspace:${deep}`)})));\n`,
      );
      const started = Date.now();
      const r = spawnSync(join(factory, 'node_modules', '.bin', 'tsx'), [script], { encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL' });
      expect(r.error, 'the matcher must finish well inside the timeout').toBeUndefined();
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe('false');
      expect(Date.now() - started).toBeLessThan(20000);
    });

    it('a wildcard never matches a hidden directory, but an explicit pattern does', () => {
      const files = {
        'package.json': json({ name: 'root' }),
        'packages/ui/package.json': pkg('ui'),
        'packages/.cache/package.json': pkg('cache'),
      };
      const wild = snap({ ...files, 'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n" }).s;
      expect(wild.facts.map((f) => f.key)).toContain('workspace:packages/ui');
      expect(wild.facts.map((f) => f.key)).not.toContain('workspace:packages/.cache');
      const explicit = snap({ ...files, 'pnpm-workspace.yaml': "packages:\n  - 'packages/.cache'\n" }).s;
      expect(explicit.facts.map((f) => f.key)).toContain('workspace:packages/.cache');
    });

    it('an exclusion Turbine cannot evaluate withholds the packages it might affect instead of confirming them', () => {
      const { s } = snap({
        'package.json': json({ name: 'root' }),
        'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - '!packages/[ab]'\n",
        'packages/a/package.json': json({ name: 'a', dependencies: { foo: '1.0.0' } }),
      });
      expect(s.facts.map((f) => f.key)).not.toContain('workspace:packages/a');
      expect(s.dependencies.some((d) => d.workspace === 'packages/a')).toBe(false);
      expect(byKey(s.unconfirmed, 'workspace:undetermined:packages/a')?.statement).toContain('exclusion pattern was not evaluated');
      expect(s.unconfirmed.some((u) => u.key.startsWith('workspace:unsupported-pattern:'))).toBe(true);
    });
  });

  describe('size budgets', () => {
    const BIG = 'x'.repeat(33 * 1024 * 1024);

    it('an oversized lockfile is left out and reported; the rest of the snapshot is still built', () => {
      const { s } = snap({ 'package.json': json({ name: 'p', dependencies: { zod: '^4.0.0' } }), 'pnpm-lock.yaml': `# ${BIG}\n` });
      expect(byKey(s.unconfirmed, 'skipped:pnpm-lock.yaml')?.statement).toContain('over the read limit');
      expect(s.dependencies[0]).toMatchObject({ name: 'zod', installedStatus: 'lockfile-not-parsed' });
    });

    it('an oversized root package.json fails the build instead of being half-read', () => {
      const dir = newRepo({ 'package.json': json({ name: 'p', description: BIG }) });
      expect(() => buildSnapshot(dir, head(dir))).toThrow(/package\.json is \d+ bytes, over the read limit/);
    });
  });

  describe('import conventions', () => {
    const conv = (s: RepoSnapshot) => byKey(s.conventions, 'convention:imports:relative-js-extension')!;

    it('several imports on one line cannot be counted by the line scan, so the 100% is not called exhaustive', () => {
      const { s } = snap({ 'src/a.ts': "import './b.js'; import './c';\n", 'src/b.ts': 'export {};\n' });
      expect(conv(s).status).toBe('unconfirmed');
      expect(conv(s).measured?.exhaustive).toBe(false);
    });

    it('dynamic imports and require() are not counted, so the scan is not exhaustive either', () => {
      const { s } = snap({ 'src/a.ts': "import './b.js';\nconst c = await import('./c');\n", 'src/b.ts': 'export {};\n' });
      expect(conv(s).status).toBe('unconfirmed');
    });

    it('a clean file set is still unconfirmed: import counts are never confirmed', () => {
      const { s } = snap({ 'src/a.ts': "import './b.js';\nexport * from './c.js';\n", 'src/b.ts': 'export {};\n', 'src/c.ts': 'export {};\n' });
      expect(conv(s)).toMatchObject({ status: 'unconfirmed', measured: { matched: 2, total: 2, exhaustive: false } });
    });

    it('the schema refuses counterexamples on a confirmed convention (config-enforced ones)', () => {
      const { s } = snap({ 'src/a.ts': "import './b.js';\n", 'src/b.ts': 'export {};\n' });
      // an unconfirmed count may list counterexamples
      expect(ConventionSchema.safeParse({ ...conv(s), counterexamples: [conv(s).source] }).success).toBe(true);
      const config = byKey(snap({ 'package.json': json({ name: 'p' }), 'tsconfig.json': '{"compilerOptions":{"strict":true}}\n' }).s.conventions, 'convention:tsconfig:tsconfig.json:strict')!;
      expect(ConventionSchema.safeParse({ ...config, counterexamples: [config.source] }).success).toBe(false);
    });
  });

  describe('versions, package managers and lockfiles', () => {
    it('.nvmrc: an alias is a selector, only an exact version is a pin; a symlinked .nvmrc is never read as a version', () => {
      const lts = snap({ 'package.json': json({ name: 'p' }), '.nvmrc': 'lts/*\n' }).s;
      expect(byKey(lts.facts, 'version:node:.nvmrc')?.statement).toContain('selects Node `lts/*`');
      expect(byKey(lts.facts, 'version:node:.nvmrc')?.statement).not.toContain('pins');
      const exact = snap({ 'package.json': json({ name: 'p' }), '.nvmrc': '22.1.0\n' }).s;
      expect(byKey(exact.facts, 'version:node:.nvmrc')?.statement).toContain('pins Node `22.1.0`');

      // symlink whose target text ("22") is also the exact content of a source file that is read
      const dir = tmp('turbine-ctx-link-');
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 't@e.c');
      git(dir, 'config', 'user.name', 'T');
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'package.json'), json({ name: 'p' }));
      writeFileSync(join(dir, 'src', 'v.ts'), '22');
      symlinkSync('22', join(dir, '.nvmrc'));
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'link');
      expect(byKey(buildSnapshot(dir, head(dir)).facts, 'version:node:.nvmrc')).toBeUndefined();
    });

    it('npm-shrinkwrap.json wins over package-lock.json, as npm does', () => {
      const lock = (v: string) => json({ lockfileVersion: 3, packages: { '': {}, 'node_modules/foo': { version: v } } });
      const { s } = snap({
        'package.json': json({ name: 'p', dependencies: { foo: '2.0.0' } }),
        'package-lock.json': lock('1.0.0'),
        'npm-shrinkwrap.json': lock('2.0.0'),
      });
      expect(s.dependencies[0]).toMatchObject({ relation: 'match', installed: { version: '2.0.0', lockfile: 'npm-shrinkwrap.json' } });
    });

    it('an unknown package manager name ("constructor") does not break the build', () => {
      const { s } = snap({ 'package.json': json({ name: 'p', packageManager: 'constructor@1', dependencies: { foo: '1.0.0' } }) });
      expect(byKey(s.facts, 'package-manager')?.statement).toContain('constructor@1');
      expect(s.dependencies[0]?.installedStatus).toBe('no-lockfile');
    });

    it("another manager's leftover lockfile is not used for installed versions", () => {
      const { s } = snap({
        'package.json': json({ name: 'p', packageManager: 'npm@10.0.0', scripts: { test: 'vitest' }, dependencies: { 'left-pad': '1.3.0' } }),
        'pnpm-lock.yaml': PNPM_LOCK_DRIFT,
      });
      expect(s.dependencies[0]).toMatchObject({ installedStatus: 'no-lockfile', relation: 'unchecked' });
      expect(s.dependencies[0]!.installed).toBeUndefined();
      expect(byKey(s.unconfirmed, 'lockfile:other-manager')?.statement).toContain('belong to another manager');
      expect(byKey(s.facts, 'command:test')?.statement).toContain('npm run test');
    });

    it('npm lockfiles: every ancestor node_modules is searched, nearest first', () => {
      const { s } = snap({
        'package.json': json({ name: 'root', workspaces: ['packages/*/*'] }),
        'package-lock.json': json({
          lockfileVersion: 3,
          packages: {
            '': {},
            'node_modules/foo': { version: '1.0.0' },
            'packages/group/node_modules/foo': { version: '2.0.0' },
          },
        }),
        'packages/group/app/package.json': json({ name: 'app', dependencies: { foo: '2.0.0' } }),
      });
      expect(s.dependencies.find((d) => d.workspace === 'packages/group/app')).toMatchObject({ relation: 'match', installed: { version: '2.0.0' } });
    });

    it('a dependencies entry overridden by optionalDependencies is not reported as drift', () => {
      const { s } = snap({
        'package.json': json({ name: 'p', dependencies: { foo: '1.0.0' }, optionalDependencies: { foo: '2.0.0' } }),
        'package-lock.json': json({ lockfileVersion: 3, packages: { '': {}, 'node_modules/foo': { version: '2.0.0' } } }),
      });
      expect(byKey(s.dependencies, 'dep:.:dependencies:foo')).toMatchObject({ relation: 'unchecked' });
      expect(byKey(s.dependencies, 'dep:.:dependencies:foo')?.statement).toContain('overridden by optionalDependencies');
      expect(byKey(s.dependencies, 'dep:.:optionalDependencies:foo')).toMatchObject({ relation: 'match' });
    });

    it('Prettier: only the config Prettier would use is confirmed; a shadowed one is listed as not confirmed', () => {
      const { s } = snap({
        'package.json': json({ name: 'p', prettier: { semi: true } }),
        '.prettierrc.json': '{ "semi": false }\n',
      });
      expect(byKey(s.conventions, 'convention:prettier:package.json:semi')?.statement).toContain('semi: true');
      expect(byKey(s.conventions, 'convention:prettier:.prettierrc.json:semi')).toBeUndefined();
      expect(byKey(s.unconfirmed, 'shadowed:prettier:.prettierrc.json')?.statement).toContain('shadowed by `package.json`');
      const alone = snap({ 'package.json': json({ name: 'p' }), '.prettierrc.json': '{ "semi": false }\n' }).s;
      expect(byKey(alone.conventions, 'convention:prettier:.prettierrc.json:semi')?.status).toBe('confirmed');
    });
  });

  describe('storage', () => {
    it('two clones at the same commit keep their own rows; re-saving one makes it the latest for that path only', () => {
      const a = newRepo(appFiles());
      const b = tmp('turbine-ctx-clone-');
      git(b, 'clone', '-q', a, '.');
      const sa = buildSnapshot(a, head(a));
      const sb = buildSnapshot(b, head(b));
      expect(sb.hash).toBe(sa.hash);
      const store = openStore();
      store.saveSnapshot(sa, a);
      store.saveSnapshot(sb, b);
      store.saveSnapshot(sa, a);
      expect(store.getLatestSnapshotFor(a)?.hash).toBe(sa.hash);
      expect(store.getLatestSnapshotFor(b)?.hash).toBe(sb.hash);
    });
  });

  describe('generated files', () => {
    const setup = () => {
      const dir = newRepo(appFiles());
      initProject({ projectPath: dir, nonInteractive: true });
      const store = openStore();
      const outcome = understandProject(store, dir);
      return { dir, store, outcome, p: contextPaths(dir) };
    };

    it('writes never follow a symlink out of the project, and nothing outside is touched', () => {
      const { dir, store, p } = setup();
      const outside = join(tmp('turbine-ctx-outside-'), 'victim.txt');
      writeFileSync(outside, 'precious\n');
      rmSync(p.snapshot);
      symlinkSync(outside, p.snapshot);
      commitFiles(dir, { 'docs/n.md': '# n\n' });
      expect(() => understandProject(store, dir)).toThrow(/refusing to write generated context through it/);
      expect(readFileSync(outside, 'utf8')).toBe('precious\n');
      expect(contextFilesCurrent(dir, store.getLatestSnapshotFor(dir)!)).toBe(false);

      // a symlinked directory is refused too
      rmSync(p.snapshot);
      rmSync(p.dir, { recursive: true });
      const elsewhere = tmp('turbine-ctx-elsewhere-');
      symlinkSync(elsewhere, p.dir);
      expect(() => writeContextFiles(dir, store.getLatestSnapshotFor(dir)!)).toThrow(/not a real directory/);
      expect(existsSync(join(elsewhere, 'snapshot.json'))).toBe(false);
    });

    it('a marker whose commit was edited is flagged by lint and repaired by understand', () => {
      const { dir, store, p } = setup();
      const md = readFileSync(p.project, 'utf8');
      const commit = store.getLatestSnapshotFor(dir)!.commit;
      writeFileSync(p.project, md.replace(`commit=${commit}`, `commit=${'0'.repeat(commit.length)}`));
      expect(lintProjectContext(dir).map((i) => i.message).join('\n')).toContain('commit in the Facts marker was edited');
      expect(contextFilesCurrent(dir, store.getLatestSnapshotFor(dir)!)).toBe(false);
      const fixed = understandProject(store, dir);
      expect(fixed.repaired).toBe(true);
      expect(lintProjectContext(dir)).toEqual([]);
    });

    it('a deleted end marker is not guessed at: understand names the marker, lint reports it, and no second section is appended', () => {
      const { dir, store, p } = setup();
      const damaged = readFileSync(p.project, 'utf8').replace('<!-- turbine:facts end -->', '');
      writeFileSync(p.project, damaged);
      expect(lintProjectContext(dir).map((i) => i.message).join('\n')).toContain('turbine:facts end');
      expect(() => understandProject(store, dir)).toThrow(/damaged generated Facts section; restore the "<!-- turbine:facts end -->" line/);
      expect(readFileSync(p.project, 'utf8')).toBe(damaged); // untouched
    });

    it('an unreadable PROJECT.md (a directory) is a lint issue, not a crash', () => {
      const { dir, p } = setup();
      rmSync(p.project);
      mkdirSync(p.project);
      const issues = lintProjectContext(dir);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ level: 'error', file: 'PROJECT.md' });
      expect(issues[0]!.message).toContain('cannot be read');
    });

    it('the ignore rule is restored on a retry even when the generated files are already current', () => {
      const { dir, store } = setup();
      const ignore = join(dir, '.turbine', '.gitignore');
      writeFileSync(ignore, readFileSync(ignore, 'utf8').replace('context/\n', ''));
      expect(readFileSync(ignore, 'utf8')).not.toContain('context/');
      const again = understandProject(store, dir);
      expect(again.status).toBe('current');
      expect(readFileSync(ignore, 'utf8')).toContain('context/');
    });

    it('dependency rows cite the manifest and the lockfile, and the rendered text is stable', () => {
      const { p } = setup();
      const md = readFileSync(p.project, 'utf8');
      expect(md).toMatch(/`zod` declared `\^4\.1\.12` \(dependencies\) _\(package\.json@[0-9a-f]{8}:L\d+\)_; installed `4\.1\.13` _\(pnpm-lock\.yaml@[0-9a-f]{8}:L\d+/);
    });
  });

  describe('project evidence', () => {
    it('facts about a dependency declared only in a workspace package cite that package.json and the lockfile', () => {
      const dir = newRepo({
        'package.json': json({ name: 'root', workspaces: ['packages/*'] }),
        'package-lock.json': json({
          lockfileVersion: 3,
          packages: { '': {}, 'packages/web/node_modules/typescript': { version: '5.5.0' }, 'packages/web/node_modules/vitest': { version: '3.1.0' } },
        }),
        'packages/web/package.json': json({ name: 'web', devDependencies: { typescript: '^5.0.0', vitest: '^3.0.0' } }),
      });
      const ev = collectProjectEvidence(dir, '', { store: openStore() });
      const ts = ev.facts.find((f) => f.text.startsWith('TypeScript'))!;
      expect(ts.source).toBe('packages/web/package.json, package-lock.json');
      expect(ts.text).toBe('TypeScript declared ^5.0.0 in packages/web/package.json, installed 5.5.0 per package-lock.json');
      expect(ev.facts.find((f) => f.text.startsWith('Test runner'))?.source).toBe('packages/web/package.json, package-lock.json');
    });
  });

  describe('engine', () => {
    it('a task left in PLANNING by a failed refresh resumes planning on `sync` without new approvals', async () => {
      const dir = tempProject('turbine-ctx-resume-', dirs);
      const engine = new Engine(openContext(dir));
      stores.push(engine.ctx.store);
      const work = engine.createTask({ title: 'Upload sources', text: '# Upload\n\nUsers upload a spreadsheet.', type: 'feature' });
      await engine.assess(work.id);
      engine.editRequirements(work.id, {
        acceptanceCriteria: [{ id: 'ac_1', statement: 'User can upload a spreadsheet', kind: 'behavioral', status: 'confirmed' }],
        unknowns: [],
      });
      const spec = engine.ctx.store.getLatestArtifact(work.id, 'specification')!;
      engine.approveRequirements(work.id, spec.contentHash, 'pm');

      commitIn(dir, 'src/new.ts', 'export const created = true;\n');
      destroyBlob(dir, 'src/new.ts');
      await expect(engine.plan(work.id)).rejects.toMatchObject({ code: 'E_CONTEXT_UNAVAILABLE' });
      expect(engine.ctx.store.getWork(work.id).currentState).toBe('PLANNING');

      commitFiles(dir, { 'src/new.ts': null });
      const resumed = await engine.syncFromMarkdown(work.id);
      expect(resumed.action).toBe('plan');
      expect(engine.ctx.store.getWork(work.id).currentState).toBe('PLAN_REVIEW');
    });
  });

  describe('second review round', () => {
    it('HEAD: a symbolic-ref chain that leads nowhere is broken, not "unborn"; a .git that git cannot open is not "not a repo"', () => {
      const chain = tmp('turbine-ctx-chain-');
      git(chain, 'init', '-q', '-b', 'main');
      git(chain, 'symbolic-ref', 'refs/heads/main', 'refs/heads/gone');
      expect(headState(chain).kind).toBe('broken');

      const garbage = tmp('turbine-ctx-garbage-');
      mkdirSync(join(garbage, '.git'));
      expect(repoHead(garbage)).toMatchObject({ error: 'broken-head' });
      expect(() => understandProject(openStore(), garbage)).toThrow(/Project facts cannot be read/);
      const plain = tmp('turbine-ctx-plain-');
      expect(repoHead(plain)).toEqual({ error: 'not-a-repo' });
    });

    it('the repository path keeps a trailing carriage return', () => {
      const odd = join(tmpdir(), `turbine-ctx-cr-${process.pid}\r`);
      mkdirSync(odd);
      dirs.push(odd);
      git(odd, 'init', '-q');
      expect(repoToplevel(odd)).toBe(realpathSync(odd));
    });

    it('branch and commit come from one observation; a detached HEAD has no branch', () => {
      const dir = newRepo(appFiles());
      const branch = git(dir, 'symbolic-ref', '--short', 'HEAD').stdout.trim();
      expect(observeBranch(dir)).toEqual({ commit: head(dir), branch });
      git(dir, 'checkout', '-q', '--detach');
      expect(observeBranch(dir)).toEqual({ commit: head(dir) });
      const ev = collectProjectEvidence(dir, '', { store: openStore() });
      expect(ev.git).toBeUndefined();
      expect(ev.facts.map((f) => f.text).join('\n')).toContain('Project facts are read from commit');
    });

    it('jsonc refuses absurd nesting instead of building huge index structures', () => {
      expect(() => parseJsonc('['.repeat(300) + ']'.repeat(300))).toThrow(/Nested too deeply/);
      const ok = parseJsonc('{"a":{"b":[1,{"c":2}]}}');
      expect(ok.lines(['a', 'b', 1, 'c'])).toEqual({ start: 1, end: 1 });
      expect(ok.lines(['a', 'b', '1'])).toBeUndefined(); // "1" (a key) is not 1 (an index)
    });

    it('semver-lite: leading zeros are not valid SemVer and are not judged', () => {
      expect(satisfies('1.2.3', '^01.2.3')).toBe('unchecked');
      expect(satisfies('1.0.0', '^1.0.0')).toBe('match');
      expect(satisfies('0.2.0', '^0.2.0')).toBe('match');
    });

    it('.nvmrc: a trailing comment does not turn an exact pin into a selector', () => {
      const { s } = snap({ 'package.json': json({ name: 'p' }), '.nvmrc': '22.1.0 # keep CI on this patch\n' });
      const f = byKey(s.facts, 'version:node:.nvmrc')!;
      expect(f.statement).toContain('pins Node `22.1.0`');
      expect(f.source.lines).toEqual({ start: 1, end: 1 });
    });

    it('the import scan stays fast on a pathological line of whitespace', () => {
      const { s } = snap({ 'src/a.ts': `import${' '.repeat(200000)}x;\n` });
      expect(byKey(s.conventions, 'convention:imports:relative-js-extension')).toBeUndefined();
    });

    it('Prettier: a tracked config that cannot be read still wins; .prettierrc.json is JSON only', () => {
      const dir = tmp('turbine-ctx-prettier-');
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 't@e.c');
      git(dir, 'config', 'user.name', 'T');
      writeFileSync(join(dir, 'package.json'), json({ name: 'p' }));
      writeFileSync(join(dir, 'real.json'), '{ "semi": true }\n');
      symlinkSync('real.json', join(dir, '.prettierrc')); // tracked, but a symlink: not read
      writeFileSync(join(dir, '.prettierrc.json'), '{ "semi": false }\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'x');
      const s = buildSnapshot(dir, head(dir));
      expect(byKey(s.unconfirmed, 'unevaluated:prettier:.prettierrc')).toBeDefined();
      expect(byKey(s.unconfirmed, 'shadowed:prettier:.prettierrc.json')).toBeDefined();
      expect(s.conventions.some((c) => c.key.startsWith('convention:prettier:'))).toBe(false);

      const yamlInJson = snap({ 'package.json': json({ name: 'p' }), '.prettierrc.json': 'semi: false\n' }).s;
      expect(byKey(yamlInJson.unconfirmed, 'unparsed:.prettierrc.json')).toBeDefined();
      expect(yamlInJson.conventions.some((c) => c.key.startsWith('convention:prettier:'))).toBe(false);
      const yamlOk = snap({ 'package.json': json({ name: 'p' }), '.prettierrc': 'semi: false\n' }).s;
      expect(byKey(yamlOk.conventions, 'convention:prettier:.prettierrc:semi')?.status).toBe('confirmed');
    });

    it('storage: a valid snapshot filed under the wrong hash is rejected', () => {
      const dir = newRepo(appFiles());
      const store = openStore();
      const s1 = buildSnapshot(dir, head(dir));
      const s2 = buildSnapshot(dir, commitFiles(dir, { 'docs/x.md': '# x\n' }));
      store.saveSnapshot(s1, dir);
      store.saveSnapshot(s2, dir);
      store.db.prepare('UPDATE repo_snapshots SET data = (SELECT data FROM repo_snapshots WHERE hash = ?) WHERE hash = ?').run(s2.hash, s1.hash);
      expect(() => store.getSnapshot(s1.hash)).toThrow(/actually has hash/);
      expect(store.getSnapshot(s2.hash)).toEqual(s2);
      const indexes = (store.db.prepare(`PRAGMA index_list(repo_snapshots)`).all() as Array<{ name: string }>).map((i) => i.name);
      expect(indexes).toContain('idx_repo_snapshots_hash');
    });

    it('storage: only one claim on a work item at a time; a dead owner can be replaced; releasing frees it', () => {
      const store = openStore();
      const token = store.claimWork('w1', 'planning');
      expect(store.holdsClaim('w1', token)).toBe(true);
      expect(() => store.claimWork('w1', 'planning')).toThrowError(expect.objectContaining({ code: 'E_CONCURRENT' }));
      store.releaseClaim('w1', 'someone-else');
      expect(store.holdsClaim('w1', token)).toBe(true); // only the owner can release
      store.releaseClaim('w1', token);
      const again = store.claimWork('w1', 'planning');
      store.db.prepare(`UPDATE work_claims SET owner = '2147483646:ghost' WHERE work_id = 'w1'`).run(); // no such process
      const taken = store.claimWork('w1', 'planning');
      expect(store.holdsClaim('w1', taken)).toBe(true);
      expect(store.holdsClaim('w1', again)).toBe(false);
    });

    it('engine: planning is refused while another attempt owns the task, and the claim is released after a failure', async () => {
      const dir = tempProject('turbine-ctx-claim-', dirs);
      const engine = new Engine(openContext(dir));
      stores.push(engine.ctx.store);
      const work = engine.createTask({ title: 'Upload sources', text: '# Upload\n\nUsers upload a spreadsheet.', type: 'feature' });
      await engine.assess(work.id);
      engine.editRequirements(work.id, {
        acceptanceCriteria: [{ id: 'ac_1', statement: 'User can upload a spreadsheet', kind: 'behavioral', status: 'confirmed' }],
        unknowns: [],
      });
      const spec = engine.ctx.store.getLatestArtifact(work.id, 'specification')!;
      engine.approveRequirements(work.id, spec.contentHash, 'pm');

      const other = engine.ctx.store.claimWork(work.id, 'planning');
      await expect(engine.plan(work.id)).rejects.toMatchObject({ code: 'E_CONCURRENT' });
      expect(engine.ctx.store.getWork(work.id).currentState).toBe('REQUIREMENTS_APPROVED'); // untouched
      engine.ctx.store.releaseClaim(work.id, other);

      commitIn(dir, 'src/new.ts', 'export const created = true;\n');
      destroyBlob(dir, 'src/new.ts');
      await expect(engine.plan(work.id)).rejects.toMatchObject({ code: 'E_CONTEXT_UNAVAILABLE' });
      // the failed attempt gave the task back, so a retry is not blocked by a leftover claim
      const free = engine.ctx.store.claimWork(work.id, 'planning');
      engine.ctx.store.releaseClaim(work.id, free);
    });

    it('generated files: markers only count as whole lines; permissions of an existing file are kept; the ignore file is created and ordered rules are honoured', () => {
      const dir = newRepo(appFiles());
      initProject({ projectPath: dir, nonInteractive: true });
      const store = openStore();
      understandProject(store, dir);
      const p = contextPaths(dir);

      // a note that merely quotes the marker inside a sentence is not a marker
      const md = readFileSync(p.project, 'utf8');
      writeFileSync(p.project, `${md}\nNote: a line ending with <!-- turbine:facts end --> is how a section closes.\n`);
      expect(lintProjectContext(dir)).toEqual([]);
      commitFiles(dir, { 'docs/n.md': '# n\n' });
      understandProject(store, dir);
      expect(readFileSync(p.project, 'utf8')).toContain('Note: a line ending with');

      // private stays private
      chmodSync(p.project, 0o600);
      commitFiles(dir, { 'docs/m.md': '# m\n' });
      understandProject(store, dir);
      expect(statSync(p.project).mode & 0o777).toBe(0o600);
      expect(readdirSync(p.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]); // no temp file is left behind

      // a later rule that un-ignores the directory is repaired; a missing file is created
      const ignore = join(dir, '.turbine', '.gitignore');
      writeFileSync(ignore, `${readFileSync(ignore, 'utf8')}!context/\n`);
      expect(understandProject(store, dir).status).toBe('current');
      expect(git(dir, 'check-ignore', '-q', '.turbine/context/PROJECT.md').status).toBe(0);
      rmSync(ignore);
      understandProject(store, dir);
      expect(readFileSync(ignore, 'utf8')).toContain('context/');
    });
  });
});

describe('review round 3 (PR #9): the second batch of review items stays closed', () => {
  const snap = (files: Record<string, string>) => {
    const dir = newRepo(files);
    return { dir, s: buildSnapshot(dir, head(dir)) };
  };
  const byKey = <T extends { key: string }>(xs: T[], key: string) => xs.find((x) => x.key === key);

  describe('git environment', () => {
    it('a GIT_* variable inherited from the caller cannot redirect the read to another repository', () => {
      const { dir, s } = snap(appFiles());
      const commit = head(dir); // resolved before the environment is changed
      const other = newRepo({ 'package.json': json({ name: 'other' }) });
      const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
      process.env.GIT_DIR = join(other, '.git');
      process.env.GIT_INDEX_FILE = join(other, '.git', 'index');
      try {
        expect(buildSnapshot(dir, commit).hash).toBe(s.hash);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  });

  describe('HEAD', () => {
    it('a corrupt branch ref is broken, not an unborn branch; a branch with no commit yet is unborn', () => {
      const dir = newRepo(appFiles());
      writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), 'not-a-sha\n');
      expect(headState(dir)).toMatchObject({ kind: 'broken' });
      const fresh = tmp('turbine-unborn-');
      git(fresh, 'init', '-q', '-b', 'main');
      expect(headState(fresh)).toEqual({ kind: 'unborn' });
    });
  });

  describe('parsers', () => {
    it('CRLF and bare CR line endings give the same line numbers as LF', () => {
      const lf = '{\n"a": 1,\n"b": {\n"c": 2}}';
      for (const text of [lf, lf.replace(/\n/g, '\r\n'), lf.replace(/\n/g, '\r')]) {
        const jc = parseJsonc(text);
        expect(jc.lines(['a'])).toEqual({ start: 2, end: 2 });
        expect(jc.lines(['b', 'c'])).toEqual({ start: 4, end: 4 });
      }
    });

    it('a comment ends at a bare CR too, so the line after it is read', () => {
      expect(parseJsonc('{\r// note\r"a": 1}').value).toEqual({ a: 1 });
    });

    it('a duplicate member replaces the earlier one, including the positions of its children', () => {
      const jc = parseJsonc('{"a": {"x": 1},\n"a": 2}');
      expect(jc.value).toEqual({ a: 2 });
      expect(jc.lines(['a', 'x'])).toBeUndefined();
      expect(jc.lines(['a'])).toEqual({ start: 2, end: 2 });
    });

    it('a number that overflows to Infinity is refused, not stated', () => {
      expect(() => parseJsonc('{"a": 1e400}')).toThrow();
    });

    it('a version range with one arm the reader does not understand is unchecked, even when another arm matches', () => {
      expect(satisfies('1.2.3', '^1.0.0 || 1.2.x')).toBe('unchecked');
      expect(satisfies('1.2.3', '^1.0.0 || ^2.0.0')).toBe('match');
      expect(satisfies('3.0.0', '^1.0.0 || ^2.0.0')).toBe('mismatch');
    });
  });

  describe('contracts', () => {
    it('a __proto__ own key is detected before parsing, so it can never be silently dropped or reinterpreted', () => {
      expect(hasUnsafeKey(JSON.parse('{"__proto__": {"x": 1}}'))).toBe(true);
      expect(hasUnsafeKey(JSON.parse('{"a": [{"__proto__": 1}]}'))).toBe(true);
      expect(hasUnsafeKey(JSON.parse('{"a": {"b": 1}}'))).toBe(false);
    });
  });

  describe('project files read at the commit', () => {
    it('.nvmrc with two selectors does not state a version; the ambiguity is listed as not confirmed', () => {
      const { s } = snap({ 'package.json': json({ name: 'p' }), '.nvmrc': '20\n22\n' });
      expect(byKey(s.facts, 'version:node:.nvmrc')).toBeUndefined();
      expect(byKey(s.unconfirmed, 'unconfirmed:node:.nvmrc')).toBeDefined();
    });

    it('.nvmrc comments are stripped, so "22 # lts" pins 22', () => {
      const { s } = snap({ 'package.json': json({ name: 'p' }), '.nvmrc': '22.1.0 # lts\n' });
      expect(byKey(s.facts, 'version:node:.nvmrc')?.statement).toContain('pins Node `22.1.0`');
    });

    it('an EditorConfig key overridden in a more specific section is not stated for every file', () => {
      const { s } = snap({ '.editorconfig': 'root = true\n[*]\nindent_style = space\n[*.md]\nindent_style = tab\n', 'package.json': json({ name: 'p' }) });
      expect(byKey(s.conventions, 'convention:editorconfig:indent_style')).toBeUndefined();
      expect(byKey(s.unconfirmed, 'unconfirmed:editorconfig:indent_style')).toBeDefined();
    });

    it('an EditorConfig key set only under [*] is stated with its effective (last) value', () => {
      const { s } = snap({ '.editorconfig': '[*]\nindent_style = space\nindent_style = tab\n', 'package.json': json({ name: 'p' }) });
      expect(byKey(s.conventions, 'convention:editorconfig:indent_style')).toMatchObject({ status: 'confirmed', statement: expect.stringContaining('indent_style = tab') });
    });

    it('package.yaml is read before .prettierrc: its Prettier setting wins and the .prettierrc one is shadowed', () => {
      const { s } = snap({ 'package.yaml': 'prettier:\n  semi: false\n', '.prettierrc': '{"semi": true}\n' });
      expect(byKey(s.conventions, 'convention:prettier:package.yaml:semi')).toMatchObject({ status: 'confirmed' });
      expect(byKey(s.unconfirmed, 'shadowed:prettier:.prettierrc')).toBeDefined();
    });

    it('a .prettierrc.json with a comment is refused (strict JSON, as Prettier reads it), not read leniently', () => {
      const { s } = snap({ '.prettierrc.json': '{ // c\n"semi": false }\n', 'package.json': json({ name: 'p' }) });
      expect(s.conventions.some((c) => c.key.startsWith('convention:prettier:.prettierrc.json'))).toBe(false);
      expect(byKey(s.unconfirmed, 'unparsed:.prettierrc.json')).toBeDefined();
    });

    it('npm workspaces with exclusion patterns: membership is unknown, since the order is not evaluated', () => {
      const { s } = snap({
        'package.json': json({ name: 'root', workspaces: ['packages/*', '!packages/b'] }),
        'packages/a/package.json': json({ name: 'a' }),
        'packages/b/package.json': json({ name: 'b' }),
      });
      expect(s.facts.filter((f) => f.category === 'workspace' && f.key !== 'workspace:declaration')).toHaveLength(0);
      expect(byKey(s.unconfirmed, 'workspace:negation-order')).toBeDefined();
    });

    it('a tracked pnpm-workspace.yaml that is a symlink is unknown; package.json workspaces are not used in its place', () => {
      const dir = newRepo({
        'package.json': json({ name: 'root', workspaces: ['packages/*'] }),
        'packages/a/package.json': json({ name: 'a' }),
      });
      symlinkSync('package.json', join(dir, 'pnpm-workspace.yaml'));
      git(dir, 'add', 'pnpm-workspace.yaml');
      git(dir, 'commit', '-q', '-m', 'link');
      const s = buildSnapshot(dir, head(dir));
      expect(s.facts.some((f) => f.key === 'workspace:packages/a' || (f.category === 'workspace' && f.key !== 'workspace:declaration'))).toBe(false);
      expect(byKey(s.unconfirmed, 'workspace:unreadable')).toBeDefined();
    });

    it('package.yaml is admitted as a config file, so its Prettier setting can be read', () => {
      const { s } = snap({ 'package.yaml': 'name: x\nprettier:\n  printWidth: 100\n' });
      expect(byKey(s.conventions, 'convention:prettier:package.yaml:printWidth')).toMatchObject({ status: 'confirmed' });
    });
  });

  describe('publication and the generated files', () => {
    it('a HEAD that moved before publication publishes nothing', () => {
      const dir = newRepo(appFiles());
      const s = buildSnapshot(dir, head(dir));
      expect(() => writeContextFiles(dir, s, () => false)).toThrow(/nothing was published/);
      expect(existsSync(contextPaths(dir).snapshot)).toBe(false);
      expect(existsSync(contextPaths(dir).project)).toBe(false);
    });

    it('a live publisher holds the lock (the second is refused); a dead publisher\'s lock is taken over', () => {
      const dir = newRepo(appFiles());
      const s = buildSnapshot(dir, head(dir));
      const lock = join(contextPaths(dir).dir, '.publish.lock');
      mkdirSync(contextPaths(dir).dir, { recursive: true });
      writeFileSync(lock, String(process.pid));
      expect(() => writeContextFiles(dir, s)).toThrow(/another `turbine understand` is writing/);
      writeFileSync(lock, '999999999'); // no such process
      expect(() => writeContextFiles(dir, s)).not.toThrow();
      expect(existsSync(lock)).toBe(false);
    });

    it('a new generated file follows the umask, not a fixed 0644', () => {
      const dir = newRepo(appFiles());
      const s = buildSnapshot(dir, head(dir));
      writeContextFiles(dir, s);
      const umask = process.umask();
      expect(statSync(contextPaths(dir).snapshot).mode & 0o777).toBe(0o666 & ~umask);
    });

    it('CRLF PROJECT.md (written on Windows) is recognised: no false "edited by hand" error', () => {
      const dir = newRepo(appFiles());
      understandProject(openStore(), dir);
      const file = contextPaths(dir).project;
      writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
      expect(lintProjectContext(dir).filter((i) => i.level === 'error')).toEqual([]);
    });

    it('generated files that git tracks are a lint warning', () => {
      const dir = newRepo(appFiles());
      understandProject(openStore(), dir);
      git(dir, 'add', '-f', '.turbine/context/snapshot.json');
      git(dir, 'commit', '-q', '-m', 'oops');
      expect(lintProjectContext(dir)).toContainEqual(expect.objectContaining({ level: 'warning', file: '.turbine/context/snapshot.json' }));
    });

    it('a generated directory that is a file (not a directory) is an error, not followed', () => {
      const dir = newRepo(appFiles());
      mkdirSync(join(dir, '.turbine'), { recursive: true });
      writeFileSync(join(dir, '.turbine', 'context'), 'not a directory');
      expect(lintProjectContext(dir)).toContainEqual(expect.objectContaining({ level: 'error', file: '.turbine/context' }));
    });

    it('git decides the ignore: a later rule that un-ignores the generated files is an error from lint', () => {
      const dir = newRepo(appFiles());
      understandProject(openStore(), dir);
      writeFileSync(join(dir, '.turbine', '.gitignore'), `${readFileSync(join(dir, '.turbine', '.gitignore'), 'utf8')}!context/\n`);
      expect(lintProjectContext(dir)).toContainEqual(expect.objectContaining({ level: 'error', file: '.turbine/.gitignore' }));
    });
  });

  describe('storage', () => {
    it('a claim held by a live process is never taken over, however old it is', () => {
      const file = join(tmp('turbine-claim-'), 'engine.db');
      const store = new WorkStore(file);
      stores.push(store);
      const db = new DatabaseSync(file);
      db.prepare('INSERT INTO work_claims(work_id, owner, purpose, claimed_at) VALUES (?, ?, ?, ?)').run('w1', `${process.pid}:old`, 'planning', '1970-01-01T00:00:00.000Z');
      db.close();
      expect(() => store.claimWork('w1', 'planning')).toThrow(/already in progress/);
    });

    it('a claim whose process is gone is taken over', () => {
      const file = join(tmp('turbine-claim-'), 'engine.db');
      const store = new WorkStore(file);
      stores.push(store);
      const db = new DatabaseSync(file);
      db.prepare('INSERT INTO work_claims(work_id, owner, purpose, claimed_at) VALUES (?, ?, ?, ?)').run('w1', '999999999:dead', 'planning', new Date().toISOString());
      db.close();
      expect(() => store.claimWork('w1', 'planning')).not.toThrow();
    });
  });
});
