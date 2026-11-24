import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startBoardServer } from './serve.js';
import { loadTasks, stagesFor } from './tasks.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function taskFixture(state: string): string {
  const root = mkdtempSync(join(tmpdir(), 'turbine-board-'));
  dirs.push(root);
  const task = join(root, '.turbine', 'tasks', 'work_test');
  mkdirSync(join(task, 'evidence'), { recursive: true });
  writeFileSync(
    join(task, 'STATUS.md'),
    [
      '# Waiting',
      '',
      `**Add a refresh button** · feature · risk: standard · track: standard · state: \`${state}\``,
      '',
      '> **Next — you (human):** Read SPEC.md',
      '',
      '## What just happened',
      '',
      '- Requirements changed',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(task, 'SPEC.md'),
    ['## Requirements', '', '- **FR-001** (P0, behavioral): WHEN the page opens THE SYSTEM SHALL show refresh', '', '## Open questions', '', '- **Q1**: Who can refresh?', ''].join('\n'),
  );
  writeFileSync(
    join(task, 'evidence', 'spec.json'),
    JSON.stringify({
      requirements: [{ id: 'FR-001', priority: 'P0', statement: 'WHEN the page opens THE SYSTEM SHALL show refresh' }],
    }),
  );
  return root;
}

describe('task board packets', () => {
  it('marks requirements as the current stage and keeps request done', () => {
    const stages = stagesFor('REQUIREMENTS_REVIEW');
    expect(stages.find((stage) => stage.id === 'req')?.status).toBe('done');
    expect(stages.find((stage) => stage.id === 'spec')?.status).toBe('now');
    expect(stages.find((stage) => stage.id === 'plan')?.status).toBe('todo');
    expect(stagesFor('ACCEPTED').every((stage) => stage.status === 'done')).toBe(true);
  });

  it('reads a task packet from the project', () => {
    const root = taskFixture('NEEDS_CLARIFICATION');
    const tasks = loadTasks(root);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('Add a refresh button');
    expect(tasks[0]?.state).toBe('NEEDS_CLARIFICATION');
    expect(tasks[0]?.requirements[0]?.id).toBe('FR-001');
    expect(tasks[0]?.questions).toEqual(['Q1: Who can refresh?']);
    expect(tasks[0]?.stages.find((stage) => stage.name === 'Requirements')?.status).toBe('now');
  });

  it('serves the task list for that project', async () => {
    const root = taskFixture('REQUIREMENTS_REVIEW');
    const board = await startBoardServer(root, [0]);
    try {
      const response = await fetch(`${board.url}/api/tasks`);
      expect(response.headers.get('x-turbine-board')).toBe('1');
      const body = (await response.json()) as { tasks: Array<{ id: string; state: string }> };
      expect(body.tasks.map((task) => task.id)).toEqual(['work_test']);
      expect(body.tasks[0]?.state).toBe('REQUIREMENTS_REVIEW');
    } finally {
      await board.close();
    }
  });
});
