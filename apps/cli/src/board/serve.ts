import { createServer, type Server } from 'node:http';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { BOARD_PAGE } from './page.js';
import { loadTasks } from './tasks.js';

export const BOARD_HEADER = 'x-turbine-board';
const CANDIDATE_PORTS = [3000, 3010, 3011, 3012, 3013, 3014, 3015];

function boardServer(projectRoot: string): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const headers = { 'Cache-Control': 'no-store', 'X-Turbine-Board': '1' };
    if (url.pathname === '/') {
      res.writeHead(302, { ...headers, Location: '/turbine' });
      res.end();
      return;
    }
    if (url.pathname === '/turbine/api/health') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, projectRoot }));
      return;
    }
    if (url.pathname === '/turbine/api/tasks') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ project: basename(projectRoot), projectRoot, tasks: loadTasks(projectRoot) }));
      return;
    }
    if (url.pathname === '/turbine' || url.pathname === '/turbine/') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(BOARD_PAGE);
      return;
    }
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
  });
}

async function localhostServesThisBoard(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/turbine/api/health`);
    return response.headers.get(BOARD_HEADER) === '1';
  } catch {
    return false;
  }
}

export type ListeningBoard = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

/** Listen on the first free port. Port 3000 is skipped when localhost already belongs to another app. */
export async function startBoardServer(projectRoot: string, ports = CANDIDATE_PORTS): Promise<ListeningBoard> {
  let lastError: Error | undefined;
  for (const port of ports) {
    let server = boardServer(projectRoot);
    try {
      await listen(server, port, '::');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EAFNOSUPPORT' && code !== 'EINVAL') throw error;
      server = boardServer(projectRoot);
      try {
        await listen(server, port, '127.0.0.1');
      } catch (ipv4) {
        lastError = ipv4 as Error;
        if ((ipv4 as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
        throw ipv4;
      }
    }
    const address = server.address();
    const bound = typeof address === 'object' && address ? address.port : port;
    if (bound === 3000 && !(await localhostServesThisBoard(bound))) {
      await closeServer(server);
      continue;
    }
    return {
      port: bound,
      url: `http://localhost:${bound}/turbine`,
      close: () => closeServer(server),
    };
  }
  throw lastError ?? new Error('No free port for the Turbine board');
}

const invoked = process.argv.map((arg) => {
  try {
    return resolve(arg);
  } catch {
    return arg;
  }
});
const self = resolve(fileURLToPath(import.meta.url));

if (invoked.includes(self)) {
  const projectFlag = process.argv.indexOf('--project');
  const projectRoot = projectFlag >= 0 ? process.argv[projectFlag + 1] : '';
  if (!projectRoot) {
    process.stderr.write('Missing --project <path>\n');
    process.exit(1);
  }
  const board = await startBoardServer(projectRoot);
  const { writeBoardRecord } = await import('./record.js');
  writeBoardRecord(projectRoot, { pid: process.pid, port: board.port, projectRoot, url: board.url });
  process.stdout.write(`${board.url}\n`);
}
