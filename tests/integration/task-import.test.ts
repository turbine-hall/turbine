import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { openContext } from '../../apps/cli/src/engine/project.js';
import {
  importTasks,
  issuesFromGitHubFixture,
  issuesFromJiraFixture,
  scrubForeignGitHubIssueUrls,
} from '../../apps/cli/src/engine/task-import.js';
import { cleanup, tempProject } from './fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

describe('task import (Part F / #50)', () => {
  it('does not let a body, title, or Source URL claim another issue alias', () => {
    const dir = tempProject('import-link-', dirs);
    const engine = new Engine(openContext(dir));
    const issues = issuesFromGitHubFixture('acme', 'widgets', {
      issues: [
        {
          number: 1,
          title: 'First see https://github.com/acme/widgets/issues/2',
          body: 'See https://github.com/acme/widgets/issues/2 for context',
          labels: ['bug'],
          url: 'https://github.com/acme/widgets/issues/2',
        },
        { number: 2, title: 'Second', body: 'standalone', labels: ['bug'] },
      ],
    });
    const report = importTasks(engine, issues);
    expect(report.created).toHaveLength(2);
    expect(report.skipped).toHaveLength(0);
    const first = engine.ctx.store.getWork('github:acme/widgets#1');
    const second = engine.ctx.store.getWork('github:acme/widgets#2');
    expect(first.id).not.toBe(second.id);
    expect(first.aliases).toEqual(['github:acme/widgets#1']);
    expect(second.aliases).toEqual(['github:acme/widgets#2']);
    expect(first.title).toContain('github-issue acme/widgets#2');
    expect(first.title).not.toMatch(/github\.com\/acme\/widgets\/issues\/2/i);
    expect(scrubForeignGitHubIssueUrls('see https://github.com/acme/widgets/issues/9', 'acme/widgets#1')).toContain(
      'github-issue acme/widgets#9',
    );
    engine.ctx.store.close();
  });

  it('fails closed when prior work for an alias is unreadable', () => {
    const dir = tempProject('import-corrupt-', dirs);
    const engine = new Engine(openContext(dir));
    const realGet = engine.ctx.store.getWork.bind(engine.ctx.store);
    engine.ctx.store.getWork = ((idOrAlias: string) => {
      if (idOrAlias === 'github:acme/widgets#9') throw new SyntaxError('Unexpected token in JSON');
      return realGet(idOrAlias);
    }) as typeof engine.ctx.store.getWork;
    expect(() =>
      importTasks(engine, [
        {
          alias: 'github:acme/widgets#9',
          title: 'Broken prior',
          body: 'x',
          provider: 'github',
          externalId: 'acme/widgets#9',
        },
      ]),
    ).toThrow(/unreadable prior work/i);
    engine.ctx.store.close();
  });

  it('rejects non-array fixture labels fail-closed', () => {
    expect(() =>
      issuesFromGitHubFixture('acme', 'widgets', {
        issues: [{ number: 1, title: 'x', labels: 'bug' as unknown as string[] }],
      }),
    ).toThrow(/labels must be a string array/i);
    expect(() =>
      issuesFromJiraFixture({
        issues: [{ key: 'OPS-9', summary: 'x', labels: 'chore' as unknown as string[] }],
      }),
    ).toThrow(/labels must be a string array/i);
  });

  it('FR-001: Jira create records jira:KEY and KEY aliases in one save', () => {
    const dir = tempProject('import-jira-alias-', dirs);
    const engine = new Engine(openContext(dir));
    const issues = issuesFromJiraFixture({
      issues: [{ key: 'OPS-7', summary: 'Gamma', description: 'g', labels: ['chore'] }],
    });
    const report = importTasks(engine, issues);
    expect(report.created).toHaveLength(1);
    const work = engine.ctx.store.getWork(report.created[0]!.workId);
    expect(work.aliases.sort()).toEqual(['OPS-7', 'jira:OPS-7'].sort());
    expect(engine.ctx.store.tryGetWork('OPS-7')?.id).toBe(work.id);
    expect(engine.ctx.store.tryGetWork('jira:OPS-7')?.id).toBe(work.id);
    engine.ctx.store.close();
  });

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
