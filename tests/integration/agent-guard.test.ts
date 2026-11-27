import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { GUARD_SCRIPT_PATH, installCursorGuard, isHumanOnlyCommand } from '../../apps/cli/src/engine/agent-guard.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const blocked = [
  'turbine task approve work_01ABC',
  'pnpm --dir /x/factory turbine task approve work_01ABC',
  'npx tsx apps/cli/src/index.ts task reject work_1 --reason no',
  'turbine task approve work_1 --confirm abcdef12',
  'turbine task approve work_1 --by Ada',
  'turbine task waive work_1 --obligation obl_manual_sqa --reason x --expires 2030-01-01',
  'turbine task cancel work_1 --reason x',
  'cd /repo && turbine task approve work_1',
  'turbine task requirements approve work_1 --revision sha256:x',
  'turbine task accept work_1',
  'sqlite3 .turbine/state/engine.db "update approvals set data=1"',
  'echo x > .turbine/state/engine.db',
  // Mediated approve must not exempt a redirect into protected state.
  'turbine task approve work_1 --confirm abcdef12 --by Ada > .turbine/state/engine.db',
  'turbine task approve work_1 --confirm abcdef12 --by Ada && echo x > .turbine/state/x',
  // Text that only mentions mediated flags inside an argument is not the decision operation.
  'echo "task approve --confirm abcdef12 --by Ada" > .turbine/state/engine.db',
];
const allowed = [
  'turbine task next work_1',
  'turbine task sync work_1',
  'turbine task gate work_1',
  'turbine task approve work_1 --confirm abcdef12 --by Ada',
  'turbine task reject work_1 --confirm abcdef12 --by Ada --reason no',
  'pnpm --dir /x/factory turbine task approve work_1 --confirm abcdef12 --by Ada',
  'git commit -m "approve the plan"',
  'cat .turbine/tasks/work_1/03-PLAN.md',
  'npm run build',
];

describe('agent guard', () => {
  it('classifies human-only commands', () => {
    for (const c of blocked) expect(isHumanOnlyCommand(c), c).toBe(true);
    for (const c of allowed) expect(isHumanOnlyCommand(c), c).toBe(false);
  });

  it('installed Cursor hook denies human-only commands and allows others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-guard-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.cursor'), { recursive: true });
    writeFileSync(
      join(dir, '.cursor', 'hooks.json'),
      JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: 'fmt.sh' }] } }),
    );
    installCursorGuard(dir);
    installCursorGuard(dir); // idempotent
    const cfg = JSON.parse(readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8'));
    expect(cfg.hooks.afterFileEdit).toHaveLength(1); // existing hooks preserved
    expect(cfg.hooks.beforeShellExecution).toEqual([{ command: `node ${GUARD_SCRIPT_PATH}` }]);

    const run = (command: string) =>
      JSON.parse(
        spawnSync('node', [GUARD_SCRIPT_PATH], {
          cwd: dir,
          input: JSON.stringify({ command, cwd: dir }),
          encoding: 'utf8',
        }).stdout,
      );
    for (const c of blocked) expect(run(c).permission, c).toBe('deny');
    for (const c of allowed) expect(run(c).permission, c).toBe('allow');
  });
});
