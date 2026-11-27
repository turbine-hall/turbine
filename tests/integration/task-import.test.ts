import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { openContext } from '../../apps/cli/src/engine/project.js';
import {
  importTasks,
  issuesFromGitHubFixture,
  issuesFromJiraFixture,
} from '../../apps/cli/src/engine/task-import.js';
import { cleanup, tempProject } from './fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

describe('task import (Part F / #50)', () => {
  it('FR-001: creates tasks for new GitHub issues and skips existing with a recorded reason', () => {
    const dir = tempProject('import-gh-', dirs);
    const engine = new Engine(openContext(dir));
    const fixture = {
      issues: [
        { number: 10, title: 'First', body: 'one', labels: ['bug'] },
        { number: 11, title: 'Second', body: 'two', labels: ['bug'] },
        { number: 12, title: 'No label', body: 'skip by label', labels: ['docs'] },
      ],
    };
    const issues = issuesFromGitHubFixture('acme', 'widgets', fixture, 'bug');
    expect(issues).toHaveLength(2);

    const first = importTasks(engine, issues);
    expect(first.created).toHaveLength(2);
    expect(first.skipped).toHaveLength(0);
    expect(engine.ctx.store.tryGetWork('github:acme/widgets#10')?.title).toBe('First');

    const second = importTasks(engine, issues);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(2);
    expect(second.skipped.every((s) => /already has task/.test(s.reason))).toBe(true);
    const skipEvents = engine.ctx.store
      .listEvents(first.created[0]!.workId)
      .filter((e) => e.type === 'task.import.skipped');
    expect(skipEvents.length).toBeGreaterThanOrEqual(1);
    engine.ctx.store.close();
  });

  it('FR-001: Jira fixture import records aliases and skips duplicates in-batch', () => {
    const dir = tempProject('import-jira-', dirs);
    const engine = new Engine(openContext(dir));
    const issues = issuesFromJiraFixture({
      issues: [
        { key: 'OPS-1', summary: 'Alpha', description: 'a', labels: ['chore'] },
        { key: 'OPS-1', summary: 'Alpha dup', description: 'dup' },
        { key: 'OPS-2', summary: 'Beta', description: 'b' },
      ],
    });
    const report = importTasks(engine, issues);
    expect(report.created.map((c) => c.alias).sort()).toEqual(['jira:OPS-1', 'jira:OPS-2']);
    expect(report.skipped).toEqual([
      { alias: 'jira:OPS-1', reason: 'duplicate alias in this import batch' },
    ]);
    expect(engine.ctx.store.tryGetWork('OPS-1')?.id).toBe(report.created[0]!.workId);
    engine.ctx.store.close();
  });

  it('FR-005: corrupt GitHub fixture fails closed', () => {
    expect(() => issuesFromGitHubFixture('acme', 'widgets', {} as { issues?: unknown[] })).toThrow(/issues array/i);
    expect(() => issuesFromGitHubFixture('../x', 'widgets', { issues: [] })).toThrow(/invalid GitHub owner/i);
  });
});
