import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type BoardRecord = {
  pid: number;
  port: number;
  projectRoot: string;
  url: string;
};

export function boardRecordPath(projectRoot: string): string {
  return join(projectRoot, '.turbine', 'state', 'board.json');
}

export function readBoardRecord(projectRoot: string): BoardRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(boardRecordPath(projectRoot), 'utf8')) as Partial<BoardRecord>;
    if (!parsed || typeof parsed.port !== 'number' || typeof parsed.url !== 'string' || parsed.projectRoot !== projectRoot) {
      return undefined;
    }
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      port: parsed.port,
      projectRoot,
      url: parsed.url,
    };
  } catch {
    return undefined;
  }
}

export function writeBoardRecord(projectRoot: string, record: BoardRecord): void {
  const path = boardRecordPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}
