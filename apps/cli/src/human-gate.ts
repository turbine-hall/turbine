import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { err } from '@turbine-hall/turbine-contracts';

/**
 * Human-presence checks for decisions (approve / reject / waive / cancel).
 *
 * This is a speed bump, not cryptographic identity: on a single-user machine an agent with
 * full shell access could still drive a pseudo-terminal. The layers are:
 *  1. An interactive terminal is required (piped / scripted input is refused).
 *  2. Known agent environments are refused.
 *  3. The human must type the short hash of exactly what they are approving.
 *  4. Project hooks (.cursor/hooks.json) block agents from running these commands at all.
 *  5. Optionally, code-review and acceptance also need a GitHub PR approval (humanGates.requirePrApproval).
 */
const AGENT_ENV_MARKERS = ['TURBINE_AGENT', 'CLAUDECODE', 'CURSOR_AGENT'];

export const HUMAN_PRESENCE = 'tty-hash-confirmation';

export function assertHumanTerminal(action: string): void {
  const marker = AGENT_ENV_MARKERS.find((k) => process.env[k] && process.env[k] !== '0');
  if (marker) {
    throw err(
      'E_UNTRUSTED_IDENTITY',
      `"${action}" is a human decision and cannot run inside an AI agent session (${marker} is set). Run it yourself in a normal terminal.`,
    );
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw err(
      'E_UNTRUSTED_IDENTITY',
      `"${action}" is a human decision and needs an interactive terminal (input was piped or scripted). Run it yourself in a normal terminal.`,
    );
  }
}

export function gitUserName(cwd: string): string {
  const r = spawnSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function askReviewer(cwd: string): Promise<string> {
  const suggested = gitUserName(cwd);
  const answer = await ask(`Your name${suggested ? ` [${suggested}]` : ''}: `);
  const name = answer || suggested;
  if (!name) throw err('E_UNTRUSTED_IDENTITY', 'Reviewer name is required');
  return name;
}
