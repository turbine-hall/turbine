import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initProject, loadConfig, saveConfig } from '../../apps/cli/src/engine/project.js';

export function git(cwd: string, ...args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * A git repo with a passing "lint" script and a passing node:test suite, so verification
 * has real checks to run (quality.checks = node lint.mjs, node --test).
 */
export function makeRepo(prefix: string, dirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  writeFileSync(join(dir, 'lint.mjs'), "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('LINT_FAIL') ? 1 : 0);\n");
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'test', 'ok.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

export function tempProject(prefix: string, dirs: string[], checks = ['node lint.mjs', 'node --test']): string {
  const dir = makeRepo(prefix, dirs);
  const { paths } = initProject({ projectPath: dir, nonInteractive: true });
  const cfg = loadConfig(paths.configPath);
  cfg.quality.checks = checks;
  // task-decomposer runs before execute and fail-closes without pr.create / git.branch.create.
  for (const cap of ['pr.create', 'git.branch.create'] as const) {
    if (!cfg.tools.allow.includes(cap)) cfg.tools.allow.push(cap);
  }
  saveConfig(paths.configPath, cfg);
  return dir;
}

export function commitIn(wt: string, file: string, content = `${file}\n`): string {
  mkdirSync(join(wt, file, '..'), { recursive: true });
  writeFileSync(join(wt, file), content);
  git(wt, 'add', file);
  git(wt, 'commit', '-qm', `change ${file}`);
  return git(wt, 'rev-parse', 'HEAD').stdout.trim();
}

export function cleanup(dirs: string[]) {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
