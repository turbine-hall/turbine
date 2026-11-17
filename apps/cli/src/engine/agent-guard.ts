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
  // writing the engine state directly
  String.raw`\b(sqlite3|rm|mv|cp|truncate|dd)\b[^|;&]*\.turbine/state\b`,
  String.raw`>\s*[^|;&]*\.turbine/state\b`,
];

export function isHumanOnlyCommand(command: string): boolean {
  const segments = command.split(/&&|\|\||;|\|/);
  return segments.some((seg) => HUMAN_ONLY_PATTERNS.some((p) => new RegExp(p, 'i').test(seg)));
}

export const GUARD_SCRIPT_PATH = '.cursor/hooks/turbine-guard.mjs';

/** Standalone Node script installed into the user's project; no dependency on the factory repo. */
export function guardScriptSource(): string {
  return `#!/usr/bin/env node
// Installed by \`turbine init\`. Blocks AI agents from running human-only Turbine Hall
// commands (approvals, waivers, cancel) or editing engine state. Humans run these in
// their own terminal, where Cursor hooks do not apply.
const PATTERNS = ${JSON.stringify(HUMAN_ONLY_PATTERNS, null, 2)}.map((p) => new RegExp(p, 'i'));
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let command = '';
  try {
    command = String(JSON.parse(input || '{}').command || '');
  } catch {
    command = '';
  }
  const hit = command.split(/&&|\\|\\||;|\\|/).some((seg) => PATTERNS.some((re) => re.test(seg)));
  if (hit) {
    process.stdout.write(
      JSON.stringify({
        continue: true,
        permission: 'deny',
        user_message: 'Blocked: this Turbine Hall command is a human decision. Run it yourself in your own terminal.',
        agent_message:
          'You must not run approval, rejection, waiver or cancel commands, or modify .turbine/state. Summarise what the human is approving and ask them to run it themselves.',
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
