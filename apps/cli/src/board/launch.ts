import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { factoryRoot } from '../paths.js';
import { BOARD_HEADER } from './serve.js';
import { readBoardRecord, type BoardRecord } from './record.js';

export type BoardLaunch = {
  url: string;
  started: boolean;
};

async function boardForProject(record: BoardRecord | undefined, projectRoot: string): Promise<BoardRecord | undefined> {
  if (!record) return undefined;
  try {
    const response = await fetch(record.url.replace(/\/turbine$/, '/turbine/api/health'));
    if (response.headers.get(BOARD_HEADER) !== '1') return undefined;
    const body = (await response.json()) as { projectRoot?: string };
    if (body.projectRoot !== projectRoot) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

function serveCommand(): { command: string; args: string[] } {
  const serveTs = fileURLToPath(new URL('./serve.ts', import.meta.url));
  const serveJs = fileURLToPath(new URL('./serve.js', import.meta.url));
  // Published installs always run compiled .js (no tsx). Dev runs .ts via tsx.
  if (!import.meta.url.endsWith('.ts')) {
    return { command: process.execPath, args: [serveJs] };
  }
  // board/ → package root (apps/cli or installed package)
  const cliRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const tsx = [
    join(cliRoot, 'node_modules/tsx/dist/cli.mjs'),
    join(factoryRoot(), 'node_modules/tsx/dist/cli.mjs'),
  ].find((p) => existsSync(p));
  if (!tsx) {
    throw new Error('tsx is required to launch the board from TypeScript sources; build the CLI or install tsx');
  }
  return { command: process.execPath, args: [tsx, serveTs] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start the task board for a project unless one is already serving it.
 * The first `turbine init` calls this. A later init reuses the running board.
 */
export async function ensureBoard(projectRoot: string): Promise<BoardLaunch> {
  const existing = await boardForProject(readBoardRecord(projectRoot), projectRoot);
  if (existing) return { url: existing.url, started: false };

  const { command, args } = serveCommand();
  const logPath = join(projectRoot, '.turbine', 'state', 'board.log');
  mkdirSync(join(projectRoot, '.turbine', 'state'), { recursive: true });
  const logFd = openSync(logPath, 'a');
  const child = spawn(command, [...args, '--project', projectRoot], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(100);
    const record = await boardForProject(readBoardRecord(projectRoot), projectRoot);
    if (record) return { url: record.url, started: true };
  }
  throw new Error(`Task board did not start. See ${logPath}`);
}
