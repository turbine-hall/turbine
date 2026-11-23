/**
 * Packet → linked GitHub/Jira issue mirroring (#21).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitHubAdapter, listFixtureComments } from '../../packages/adapter-github/dist/index.js';
import { createJiraAdapter, listJiraFixtureComments } from '../../packages/adapter-jira/dist/index.js';
import { openContext, loadConfig, saveConfig } from '../../apps/cli/src/engine/project.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { packetPaths } from '../../apps/cli/src/engine/packet.js';
import {
  buildMirrorBody,
  mirrorLinkedIssues,
  mirrorMarker,
  resolveLinkedIssues,
} from '../../apps/cli/src/engine/issue-mirror.js';
import { cleanup, tempProject } from './fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

describe('issue packet mirror (#21)', () => {
  it('resolveLinkedIssues finds github URLs, aliases, and jira keys', () => {
    const links = resolveLinkedIssues(
      {
        id: 'work_x',
        aliases: ['jira:PROJ-12', 'github:acme/app#9'],
        sourceRefs: [{ provider: 'file', snapshotHash: 'h' }],
        objective: 'see https://github.com/turbine-hall/turbine/issues/21',
      } as any,
    );
    expect(links.some((l) => l.provider === 'jira' && l.key === 'PROJ-12')).toBe(true);
    expect(links.some((l) => l.provider === 'github' && l.key === 'acme/app#9')).toBe(true);
    expect(links.some((l) => l.provider === 'github' && l.key === 'turbine-hall/turbine#21')).toBe(true);
  });

  it('buildMirrorBody includes all packet sections and the sticky marker', async () => {
    const dir = tempProject('turbine-mirror-body-', dirs);
    const engine = new Engine(openContext(dir));
    const work = engine.createTask({
      title: 'Mirror demo',
      text: '# Demo\n\nhttps://github.com/acme/demo/issues/3\n',
      type: 'feature',
    });
    await engine.waitForMirror();
    const body = buildMirrorBody({ work, projectRoot: dir });
    expect(body).toContain(mirrorMarker(work.id));
    expect(body).toMatch(/## Status/);
    expect(body).toMatch(/## Spec/);
    expect(body).toMatch(/## Plan/);
    expect(body).toMatch(/## Executive summary/);
    expect(body).toMatch(/## Review/);
    expect(body).toMatch(/## Context/);
    engine.ctx.store.close();
  });

  it('mirrors to GitHub and Jira fixture sticky comments on sync when issue.comment is allowed', async () => {
    const dir = tempProject('turbine-mirror-sync-', dirs);
    const cfg = loadConfig(join(dir, '.turbine', 'project.yaml'));
    if (!cfg.tools.allow.includes('issue.comment')) cfg.tools.allow.push('issue.comment');
    saveConfig(join(dir, '.turbine', 'project.yaml'), cfg);

    const ghFixtures = { comments: {} as Record<string, any[]> };
    const jiraComments = {} as Record<string, any[]>;
    const github = createGitHubAdapter({ fixtures: ghFixtures });
    const jira = createJiraAdapter({
      siteUrl: 'https://example.atlassian.net',
      fixtures: {
        'PROJ-1': {
          key: 'PROJ-1',
          id: '1',
          summary: 'x',
          description: '',
          issueType: 'Task',
          status: 'Open',
          labels: [],
          updatedAt: new Date().toISOString(),
          url: 'https://example.atlassian.net/browse/PROJ-1',
        },
      },
      commentFixtures: jiraComments,
    });

    const engine = new Engine(openContext(dir));
    engine.mirrorAdapters = { github, jira };
    engine.mirrorFixtureMode = true;

    const work = engine.createTask({
      title: 'Linked work',
      text: [
        '# Linked',
        '',
        'Track https://github.com/acme/app/issues/7 and jira:PROJ-1',
        '',
        'Ship the mirror.',
      ].join('\n'),
      type: 'feature',
    });
    await engine.waitForMirror();
    // createTask only parses github URLs into aliases; add jira alias explicitly for this fixture.
    const stored = engine.ctx.store.getWork(work.id);
    engine.ctx.store.saveWork({
      ...stored,
      aliases: [...stored.aliases, 'jira:PROJ-1'],
      sourceRefs: [
        ...stored.sourceRefs,
        { provider: 'jira', externalId: 'PROJ-1', snapshotHash: stored.sourceRefs[0]!.snapshotHash },
      ],
    });

    await engine.syncFromMarkdown(work.id); // assess
    await engine.waitForMirror();

    const gh = listFixtureComments({ fixtures: ghFixtures }, 'acme', 'app', 7);
    expect(gh.length).toBe(1);
    expect(gh[0]!.body).toContain(mirrorMarker(work.id));
    expect(gh[0]!.body).toMatch(/## Status/);

    const jr = listJiraFixtureComments({ siteUrl: '', commentFixtures: jiraComments }, 'PROJ-1');
    expect(jr.length).toBe(1);
    expect(jr[0]!.body).toContain('## Spec');

    // Second sync updates the same sticky comment (idempotent).
    await engine.syncFromMarkdown(work.id);
    await engine.waitForMirror();
    expect(listFixtureComments({ fixtures: ghFixtures }, 'acme', 'app', 7)).toHaveLength(1);
    expect(listJiraFixtureComments({ siteUrl: '', commentFixtures: jiraComments }, 'PROJ-1')).toHaveLength(1);

    const last = JSON.parse(
      readFileSync(join(packetPaths(dir, work.id).evidenceDir, 'issue-mirror-last.json'), 'utf8'),
    );
    expect(last.targets.every((t: { status: string }) => t.status === 'mirrored')).toBe(true);
    expect(existsSync(join(packetPaths(dir, work.id).evidenceDir, 'issue-mirror.json'))).toBe(true);

    engine.ctx.store.close();
  });

  it('records an explicit skip when issue.comment is not allow-listed', async () => {
    const dir = tempProject('turbine-mirror-deny-', dirs);
    // default allowlist has no issue.comment
    const ghFixtures = { comments: {} as Record<string, any[]> };
    const engine = new Engine(openContext(dir));
    engine.mirrorAdapters = { github: createGitHubAdapter({ fixtures: ghFixtures }) };
    engine.mirrorFixtureMode = true;

    const work = engine.createTask({
      title: 'Denied mirror',
      text: '# X\n\nhttps://github.com/acme/app/issues/1\n',
      type: 'feature',
    });
    await engine.waitForMirror();
    await engine.syncFromMarkdown(work.id);

    expect(listFixtureComments({ fixtures: ghFixtures }, 'acme', 'app', 1)).toHaveLength(0);
    const last = JSON.parse(
      readFileSync(join(packetPaths(dir, work.id).evidenceDir, 'issue-mirror-last.json'), 'utf8'),
    );
    expect(last.targets[0].status).toBe('skipped');
    expect(last.targets[0].reason).toMatch(/allowlist|denied/i);

    engine.ctx.store.close();
  });

  it('skips GitHub mirrors when mirrorRepos does not include the repo (live gate)', async () => {
    const dir = tempProject('turbine-mirror-repos-', dirs);
    const cfg = loadConfig(join(dir, '.turbine', 'project.yaml'));
    if (!cfg.tools.allow.includes('issue.comment')) cfg.tools.allow.push('issue.comment');
    cfg.inputs.adapters.github.enabled = true;
    cfg.inputs.adapters.github.mirrorRepos = ['acme/allowed'];
    saveConfig(join(dir, '.turbine', 'project.yaml'), cfg);

    const ghFixtures = { comments: {} as Record<string, any[]> };
    const github = createGitHubAdapter({ fixtures: ghFixtures });
    const result = await mirrorLinkedIssues({
      projectRoot: dir,
      work: {
        id: 'work_gate',
        title: 'Gate',
        objective: 'https://github.com/acme/other/issues/1',
        aliases: ['github:acme/other#1'],
        sourceRefs: [],
        currentState: 'IMPORTED',
      } as any,
      config: loadConfig(join(dir, '.turbine', 'project.yaml')),
      adapters: { github },
      fixtureMode: false,
    });
    expect(result.targets[0]?.status).toBe('skipped');
    expect(result.targets[0]?.reason).toMatch(/mirrorRepos/);
    expect(listFixtureComments({ fixtures: ghFixtures }, 'acme', 'other', 1)).toHaveLength(0);
  });

  it('rejects non-HTTPS GitHub apiBaseUrl before attaching the token', async () => {
    const adapter = createGitHubAdapter({
      apiBaseUrl: 'http://evil.example/api',
      token: 'secret-token',
    });
    await expect(
      adapter.invoke({
        capability: 'issue.comment',
        workId: 'work_x',
        correlationId: 'corr_x',
        arguments: { owner: 'acme', repo: 'app', number: 1, body: 'hi' },
      }),
    ).rejects.toThrow(/https/i);
  });

  it('mirrors PLAN and REVIEW packet content via sticky comment (FR-006)', async () => {
    const dir = tempProject('turbine-mirror-plan-review-', dirs);
    const cfg = loadConfig(join(dir, '.turbine', 'project.yaml'));
    if (!cfg.tools.allow.includes('issue.comment')) cfg.tools.allow.push('issue.comment');
    saveConfig(join(dir, '.turbine', 'project.yaml'), cfg);

    const ghFixtures = { comments: {} as Record<string, any[]> };
    const github = createGitHubAdapter({ fixtures: ghFixtures });
    const engine = new Engine(openContext(dir));
    engine.mirrorAdapters = { github };
    engine.mirrorFixtureMode = true;

    const work = engine.createTask({
      title: 'Plan review mirror',
      text: '# PR path\n\nhttps://github.com/acme/app/issues/42\n',
      type: 'feature',
    });
    await engine.waitForMirror();
    const paths = packetPaths(dir, work.id);

    // Write plan/review packet files directly — renderPacket would regenerate them from store.
    writeFileSync(paths.planDoc, '# Plan fixture\n\nStep: implement mirror adapters.\n', 'utf8');
    writeFileSync(paths.review, '# Review fixture\n\nFindings: none for fixture path.\n', 'utf8');

    const result = await mirrorLinkedIssues({
      projectRoot: dir,
      work: engine.ctx.store.getWork(work.id),
      config: loadConfig(join(dir, '.turbine', 'project.yaml')),
      adapters: { github },
      fixtureMode: true,
    });
    expect(result.targets[0]?.status).toBe('mirrored');

    const comments = listFixtureComments({ fixtures: ghFixtures }, 'acme', 'app', 42);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toMatch(/## Plan/);
    expect(comments[0]!.body).toContain('implement mirror adapters');
    expect(comments[0]!.body).toMatch(/## Review/);
    expect(comments[0]!.body).toContain('Findings: none for fixture path');

    engine.ctx.store.close();
  });
});
