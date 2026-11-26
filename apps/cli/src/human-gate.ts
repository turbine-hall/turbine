import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { err } from '@turbine-hall/turbine-contracts';

/**
 * Human-presence checks for decisions (approve / reject / waive / cancel).
 *
 * This is a speed bump, not cryptographic identity: on a single-user machine an agent with
 * full shell access could still drive a pseudo-terminal. The layers are:
 *  1. Interactive path: TTY required; known agent environments refused; human types the short hash.
 *  2. Mediated path: `--confirm <token> --by <name>` binds the same short hash without a TTY, so a
 *     human who reviewed in chat can tell Cursor/Claude to record the decision.
 *  3. Project hooks still block bare approve/reject (no --confirm/--by); mediated form is allowed.
 *  4. Optionally, code-review and acceptance also need a GitHub PR approval (humanGates.requirePrApproval).
 *  5. Waive / cancel / policy approve remain interactive-only.
 */
const AGENT_ENV_MARKERS = ['TURBINE_AGENT', 'CLAUDECODE', 'CURSOR_AGENT'];

export const HUMAN_PRESENCE = 'tty-hash-confirmation';
/** Non-interactive attestation: revision token + reviewer name supplied on the CLI. */
export const CONFIRM_PRESENCE = 'confirm-flag';

export function isAgentSession(): boolean {
  return AGENT_ENV_MARKERS.some((k) => process.env[k] && process.env[k] !== '0');
}

export function assertHumanTerminal(action: string): void {
  const marker = AGENT_ENV_MARKERS.find((k) => process.env[k] && process.env[k] !== '0');
  if (marker) {
    throw err(
      'E_UNTRUSTED_IDENTITY',
      `"${action}" interactive mode cannot run inside an AI agent session (${marker} is set). Use --confirm <token> --by <name> after the human approves in chat, or run it in a normal terminal.`,
    );
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw err(
      'E_UNTRUSTED_IDENTITY',
      `"${action}" interactive mode needs a TTY. Use --confirm <token> --by <name>, or run it in a normal terminal.`,
    );
  }
}

/** Non-interactive approve/reject: both the revision token and the human's name are required. */
export function assertMediatedConfirm(
  action: string,
  confirm: string | undefined,
  by: string | undefined,
): { confirmToken: string; reviewer: string } {
  const confirmToken = confirm?.trim() ?? '';
  const reviewer = by?.trim() ?? '';
  if (!confirmToken || !reviewer) {
    throw err(
      'E_UNTRUSTED_IDENTITY',
      `"${action}" non-interactive mode needs --confirm <token> and --by <name> (the human who reviewed). Get the token from: turbine task next <id> --json`,
    );
  }
  return { confirmToken, reviewer };
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
