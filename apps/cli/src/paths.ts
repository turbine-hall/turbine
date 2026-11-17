import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Directory the user ran the command from.
 * When launched via `pnpm --dir <factory> turbine`, process.cwd() is the factory
 * package; pnpm sets INIT_CWD to the original shell cwd.
 */
export function callerCwd(): string {
  const initCwd = process.env.INIT_CWD?.trim();
  if (initCwd) return resolve(initCwd);
  const pwd = process.env.PWD?.trim();
  if (pwd) return resolve(pwd);
  return process.cwd();
}

export function resolveProjectPath(projectPath?: string): string {
  if (!projectPath) return callerCwd();
  if (isAbsolute(projectPath)) return resolve(projectPath);
  return resolve(callerCwd(), projectPath);
}

/** Monorepo root containing frameworks/, roles/, skills/, packages/ */
export function factoryRoot(): string {
  const candidates = [
    resolve(here, '../../..'),
    resolve(here, '../../../..'),
    process.cwd(),
    callerCwd(),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'frameworks', 'turbine', '0.5.0', 'framework.json'))) return c;
  }
  return resolve(here, '../../..');
}

export function projectPaths(projectRoot: string) {
  const sf = join(projectRoot, '.turbine');
  return {
    root: projectRoot,
    sfDir: sf,
    configPath: join(sf, 'project.yaml'),
    lockPath: join(sf, 'frameworks.lock.json'),
    gitignorePath: join(sf, '.gitignore'),
    stateDir: join(sf, 'state'),
    dbPath: join(sf, 'state', 'engine.db'),
    artifactsDir: join(sf, 'state', 'artifacts'),
  };
}

export function findProjectRoot(start = callerCwd()): string | null {
  let cur = resolve(start);
  for (;;) {
    if (existsSync(join(cur, '.turbine', 'project.yaml'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
