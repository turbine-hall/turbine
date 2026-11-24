import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
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
  if (import.meta.url.endsWith('.ts')) {
    return {
      command: process.execPath,
      args: [join(factoryRoot(), 'node_modules/tsx/dist/cli.mjs'), serveTs],
    };
  }
  return { command: process.execPath, args: [serveJs] };
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
