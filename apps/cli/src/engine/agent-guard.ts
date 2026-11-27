import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Commands only a human may run. Kept in one place so the Cursor hook script and the tests
 * use the same patterns. Each pattern stops at a shell separator so "turbine task next x && ls"
 * is not confused with an approval.
 */
export const HUMAN_ONLY_PATTERNS: string[] = [
  // turbine task approve|reject|waive|cancel|changes-requested (any launcher: turbine, pnpm turbine, npx turbine, tsx …/index.ts)
  String.raw`\btask\s+(approve|reject|waive|cancel|changes-requested)\b`,
  // legacy approval commands (removed, but block anyway)
  String.raw`\btask\s+(requirements|plan)\s+(approve|reject)\b`,
  String.raw`\btask\s+accept\b`,
  // layer 2 brief human gates
  String.raw`\bcontext\s+(approve|attest)\b`,
  // lane policies: approving or resuming widens autonomy (suspend stays open to agents)
  String.raw`\bpolicy\s+(approve|resume)\b`,
  // recording audit outcomes is a human attestation
  String.raw`\baudit\s+record\b`,
  // putting a task back in the autonomous lane
  String.raw`\btask\s+lane\b[^|;&]*--retry\b`,
  // writing the engine state directly
  String.raw`\b(sqlite3|rm|mv|cp|truncate|dd)\b[^|;&]*\.turbine/state\b`,
  String.raw`>\s*[^|;&]*\.turbine/state\b`,
];

/**
 * Bare approve/reject stay human-only. With `--confirm <token> --by <name>`, the human already
 * reviewed the revision in chat and asked the agent to record it — allow that mediated form.
 * `task approve|reject` must appear as a shell word (not only inside `"…"`), and the exemption
 * applies only to that verb — not to state-file redirects or other human-only patterns.
 */
export function isMediatedApproveOrReject(command: string): boolean {
  // `(^|[\s;&|])task` rejects `echo "task approve …"` (quote before task) while allowing
  // `turbine task approve …` / `pnpm … turbine task approve …`.
  return (
    /(^|[\s;&|])task\s+(approve|reject)\b/i.test(command) &&
    /--confirm\s+\S+/.test(command) &&
    /--by\s+\S+/.test(command)
  );
}

/** Patterns that mediated approve/reject may bypass. Everything else (state writes, waive, …) still denies. */
const MEDIATED_EXEMPT_PATTERN = String.raw`\btask\s+(approve|reject|waive|cancel|changes-requested)\b`;

export function isHumanOnlyCommand(command: string): boolean {
  const segments = command.split(/&&|\|\||;|\|/);
  return segments.some((seg) => {
    const mediated = isMediatedApproveOrReject(seg);
    return HUMAN_ONLY_PATTERNS.some((p) => {
      if (!new RegExp(p, 'i').test(seg)) return false;
      // Mediated form only skips the approve/reject task verb — not redirects or other gates.
      if (mediated && p === MEDIATED_EXEMPT_PATTERN) {
        const verb = seg.match(/\btask\s+(approve|reject|waive|cancel|changes-requested)\b/i)?.[1]?.toLowerCase();
        if (verb === 'approve' || verb === 'reject') return false;
      }
      return true;
    });
  });
}

export const GUARD_SCRIPT_PATH = '.cursor/hooks/turbine-guard.mjs';

/** Standalone Node script installed into the user's project; no dependency on the factory repo. */
export function guardScriptSource(): string {
  return `#!/usr/bin/env node
// Installed by \`turbine init\`. Blocks AI agents from running human-only Turbine Hall
// commands (approvals, waivers, cancel) or editing engine state. Humans run these in
// their own terminal, where Cursor hooks do not apply.
const PATTERN_SOURCES = ${JSON.stringify(HUMAN_ONLY_PATTERNS, null, 2)};
const EXEMPT = ${JSON.stringify(MEDIATED_EXEMPT_PATTERN)};
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let command = '';
  try {
    command = String(JSON.parse(input || '{}').command || '');
  } catch {
    command = '';
  }
  const mediated = (seg) =>
    /(^|[\\s;&|])task\\s+(approve|reject)\\b/i.test(seg) &&
    /--confirm\\s+\\S+/.test(seg) &&
    /--by\\s+\\S+/.test(seg);
  const hit = command.split(/&&|\\|\\||;|\\|/).some((seg) => {
    const allowApproveReject = mediated(seg);
    return PATTERN_SOURCES.some((p) => {
      if (!new RegExp(p, 'i').test(seg)) return false;
      if (allowApproveReject && p === EXEMPT) {
        const verb = seg.match(/\\btask\\s+(approve|reject|waive|cancel|changes-requested)\\b/i)?.[1]?.toLowerCase();
        if (verb === 'approve' || verb === 'reject') return false;
      }
      return true;
    });
  });
  if (hit) {
    process.stdout.write(
      JSON.stringify({
        continue: true,
        permission: 'deny',
        user_message:
          'Blocked: this Turbine Hall command is a human decision. Either run it in your terminal, or tell the agent to use: turbine task approve <id> --confirm <token> --by <your-name>.',
        agent_message:
          'Do not run bare approve/reject/waive/cancel. After the human explicitly approves in chat, you may run: turbine task approve <id> --confirm <token> --by <their-name> (token from turbine task next <id> --json). Still never waive, cancel, policy approve/resume, audit record, lane retry, or modify .turbine/state.',
      }),
    );
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ continue: true, permission: 'allow' }));
});
`;
}

/**
 * Install (or merge into) <project>/.cursor/hooks.json so the guard runs before every
 * agent shell command. Existing hooks are preserved.
 */
export function installCursorGuard(projectRoot: string): string[] {
  const written: string[] = [];
  const cursorDir = join(projectRoot, '.cursor');
  mkdirSync(join(cursorDir, 'hooks'), { recursive: true });
  const scriptPath = join(projectRoot, GUARD_SCRIPT_PATH);
  writeFileSync(scriptPath, guardScriptSource(), { encoding: 'utf8', mode: 0o755 });
  written.push(scriptPath);

  const hooksPath = join(cursorDir, 'hooks.json');
  let config: { version?: number; hooks?: Record<string, Array<{ command: string }>> } = {};
  if (existsSync(hooksPath)) {
    try {
      config = JSON.parse(readFileSync(hooksPath, 'utf8'));
    } catch {
      // Do not clobber a file we cannot parse; tell the caller instead.
      throw new Error(`${hooksPath} is not valid JSON; add the turbine guard manually: node ${GUARD_SCRIPT_PATH}`);
    }
  }
  config.version ??= 1;
  config.hooks ??= {};
  const entry = { command: `node ${GUARD_SCRIPT_PATH}` };
  const list = (config.hooks.beforeShellExecution ??= []);
  if (!list.some((h) => h.command === entry.command)) list.push(entry);
  writeFileSync(hooksPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  written.push(hooksPath);
  return written;
}
