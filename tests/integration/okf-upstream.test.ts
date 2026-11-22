/**
 * Conformance: vendored OKF upstream validate.py against a Turbine-generated bundle.
 * Pinned SHA: 527e81aff55992be21507e97004286789126f88c (see tests/fixtures/okf-upstream/README.md).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WorkStore } from '../../packages/storage-sqlite/dist/index.js';
import { factoryRoot } from '../../apps/cli/src/paths.js';
import { understandProjectWithBrief } from '../../apps/cli/src/engine/context/understand.js';
import { defaultConfig } from '../../apps/cli/src/engine/project.js';
import { knowledgePaths } from '../../apps/cli/src/engine/knowledge/paths.js';

const dirs: string[] = [];
const stores: WorkStore[] = [];
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '../fixtures/okf-upstream');
const VALIDATOR = join(FIXTURE, 'validate.py');

function pythonBin(): string {
  const venv = join(FIXTURE, '.venv/bin/python');
  if (existsSync(venv)) return venv;
  return 'python3';
}

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-okf-up-'));
  dirs.push(dir);
  const emptyTemplate = mkdtempSync(join(tmpdir(), 'turbine-okf-up-tpl-'));
  dirs.push(emptyTemplate);
  git(dir, 'init', '-q', '-b', 'main', '--object-format=sha1', `--template=${emptyTemplate}`);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgSign', 'false');
  const noHooks = mkdtempSync(join(tmpdir(), 'turbine-okf-up-hooks-'));
  dirs.push(noHooks);
  git(dir, 'config', 'core.hooksPath', noHooks);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'echo' } }, null, 2) + '\n');
  writeFileSync(join(dir, 'README.md'), '# Demo\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/index.ts'), 'export const ok = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

function runUpstream(bundle: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(pythonBin(), [VALIDATOR, bundle], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('AC: upstream OKF validate.py conformance (pinned SHA)', () => {
  it('passes on a Turbine-generated bundle', async () => {
    expect(existsSync(VALIDATOR)).toBe(true);
    const dir = newRepo();
    const root = mkdtempSync(join(tmpdir(), 'turbine-okf-up-db-'));
    dirs.push(root);
    const store = new WorkStore(join(root, 'engine.db'));
    stores.push(store);
    await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultConfig(tmpdir(), 'demo') });
    const bundle = knowledgePaths(dir).dir;
    const result = runUpstream(bundle);
    if (result.status === 2) {
      // setup problem (missing PyYAML) — fail with a clear message
      expect(result.stderr + result.stdout).not.toMatch(/needs PyYAML|No module named/);
    }
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('fails on a deliberately broken bundle', () => {
    const broken = mkdtempSync(join(tmpdir(), 'turbine-okf-broken-'));
    dirs.push(broken);
    writeFileSync(
      join(broken, 'index.md'),
      `---\nokf_version: 0.3\ntitle: broken\n---\n\n# Broken\n`,
    );
    writeFileSync(
      join(broken, 'bad.md'),
      `---\ntype: Something\ntitle: !!python/object/apply:os.system ['echo pwn']\n---\n\nbody\n`,
    );
    const result = runUpstream(broken);
    expect(result.status).not.toBe(0);
  });
});
