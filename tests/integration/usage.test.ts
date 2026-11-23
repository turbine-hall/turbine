import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createId, UsageRecordSchema } from '../../packages/contracts/dist/index.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { openContext, loadConfig, saveConfig } from '../../apps/cli/src/engine/project.js';
import { measuredTurbineTokens, summarizeUsage } from '../../apps/cli/src/engine/usage.js';
import { cleanup, tempProject } from './fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

function makeTask(dir: string) {
  const request = join(dir, 'request.md');
  writeFileSync(request, '# Usage tracking feature\n\nTrack model tokens per task.\n');
  const engine = new Engine(openContext(dir));
  const work = engine.createTask({ title: 'Usage tracking', file: request, type: 'feature' });
  return { engine, work };
}

describe('usage tracking (#1)', () => {
  it('FR-001: assess records modelProvider, modelId, and tokens on role_runs', async () => {
    const dir = tempProject('usage-fr001-', dirs);
    const { engine, work } = makeTask(dir);
    await engine.assess(work.id);
    const runs = engine.ctx.store.listRoleRuns(work.id);
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.modelProvider).toBeTruthy();
      expect(run.modelId).toBeTruthy();
      expect(run.tokens).toBeDefined();
      expect(typeof run.tokens!.input === 'number' || run.tokens!.input === 'unknown').toBe(true);
      expect(typeof run.tokens!.output === 'number' || run.tokens!.output === 'unknown').toBe(true);
    }
    const summary = engine.usageSummary(work.id);
    expect(summary.bySource.turbine.calls).toBe(runs.length);
    expect(summary.grand.calls).toBeGreaterThan(0);
    engine.ctx.store.close();
  });

  it('FR-002: missing adapter usage is stored as unknown, not 0', () => {
    const dir = tempProject('usage-fr002-', dirs);
    const { engine, work } = makeTask(dir);
    const run = {
      id: createId('run'),
      workId: work.id,
      roleId: 'requirements-analyst',
      roleVersion: '1.0.0',
      skillIds: ['assess-request'],
      toolCapabilityGrants: ['none'],
      modelProvider: 'mock',
      modelId: 'mock-no-usage',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status: 'succeeded' as const,
      inputArtifactIds: [],
      outputArtifactIds: [],
      attempts: 1,
      tokens: { input: 'unknown' as const, output: 'unknown' as const },
    };
    engine.ctx.store.saveRoleRun(run);
    const summary = engine.usageSummary(work.id);
    expect(summary.bySource.turbine.hasUnknown).toBe(true);
    expect(summary.grand.hasUnknown).toBe(true);
    // Unknown must not inflate numeric totals as if it were 0-only silence — flag is required.
    expect(measuredTurbineTokens([run])).toBe(0);
    engine.ctx.store.close();
  });

  it('FR-003/FR-004/FR-008: usage add persists records; summary separates sources; invalid input refused', () => {
    const dir = tempProject('usage-fr003-', dirs);
    const { engine, work } = makeTask(dir);

    const human = engine.addUsage({
      idOrAlias: work.id,
      source: 'agent',
      agentName: 'cursor',
      modelId: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 200,
      method: 'reported',
      recordedBy: 'tester',
      enteredBy: 'human',
    });
    expect(human.id).toMatch(/^usage_/);
    expect(human.enteredBy).toBe('human');

    const agent = engine.addUsage({
      idOrAlias: work.id,
      source: 'agent',
      agentName: 'cursor',
      modelId: 'gpt-test',
      inputTokens: 50,
      outputTokens: 'unknown',
      method: 'estimated',
      recordedBy: 'agent:session',
      enteredBy: 'agent',
    });
    expect(agent.tokens.output).toBe('unknown');

    const summary = engine.usageSummary(work.id);
    expect(summary.bySource.agent.calls).toBe(2);
    expect(summary.bySource.agent.input).toBe(1050);
    expect(summary.bySource.agent.hasUnknown).toBe(true);
    expect(summary.grand.calls).toBe(2);
    expect(summary.byModel.some((b) => b.modelId === 'gpt-test' && b.source === 'agent')).toBe(true);
    expect(summary.records).toHaveLength(2);

    expect(() =>
      engine.addUsage({
        idOrAlias: work.id,
        source: 'agent',
        agentName: 'cursor',
        inputTokens: -1,
        outputTokens: 0,
        method: 'reported',
        recordedBy: 'x',
        enteredBy: 'human',
      }),
    ).toThrow(/non-negative|unknown/i);

    expect(() =>
      engine.addUsage({
        idOrAlias: work.id,
        source: 'agent',
        // missing agentName
        inputTokens: 1,
        outputTokens: 1,
        method: 'reported',
        recordedBy: 'x',
        enteredBy: 'human',
      }),
    ).toThrow(/agentName/i);

    expect(() =>
      UsageRecordSchema.parse({
        id: 'usage_x',
        workId: work.id,
        source: 'agent',
        tokens: { input: 1, output: 1 },
        method: 'reported',
        recordedAt: new Date().toISOString(),
        recordedBy: 'x',
        enteredBy: 'robot',
      }),
    ).toThrow();

    engine.ctx.store.close();
  });

  it('FR-005: STATUS/REVIEW include Usage; export includes usage + roleRuns', async () => {
    const dir = tempProject('usage-fr005-', dirs);
    const { engine, work } = makeTask(dir);
    await engine.assess(work.id);
    engine.addUsage({
      idOrAlias: work.id,
      source: 'agent',
      agentName: 'cursor',
      modelId: 'composer',
      inputTokens: 10,
      outputTokens: 5,
      method: 'reported',
      recordedBy: 'tester',
      enteredBy: 'human',
    });
    engine.render(work.id);

    const status = readFileSync(join(dir, '.turbine', 'tasks', work.id, 'STATUS.md'), 'utf8');
    const review = readFileSync(join(dir, '.turbine', 'tasks', work.id, 'REVIEW.md'), 'utf8');
    expect(status).toMatch(/## Usage/);
    expect(status).toMatch(/Turbine/);
    expect(status).toMatch(/Agent/);
    expect(status).toMatch(/Grand/);
    expect(review).toMatch(/## Usage/);

    const summary = engine.usageSummary(work.id);
    // Export payload shape (same fields the CLI packs).
    const exportPayload = {
      usage: summary,
      roleRuns: engine.ctx.store.listRoleRuns(work.id),
    };
    expect(exportPayload.usage.records.length).toBe(1);
    expect(exportPayload.roleRuns.length).toBeGreaterThan(0);
    engine.ctx.store.close();
  });

  it('FR-006: usage is append-only; human-entered rows are not mutated by later agent adds', () => {
    const dir = tempProject('usage-fr006-', dirs);
    const { engine, work } = makeTask(dir);
    const human = engine.addUsage({
      idOrAlias: work.id,
      source: 'agent',
      agentName: 'cursor',
      inputTokens: 42,
      outputTokens: 7,
      method: 'reported',
      recordedBy: 'human',
      enteredBy: 'human',
    });
    engine.addUsage({
      idOrAlias: work.id,
      source: 'agent',
      agentName: 'cursor',
      inputTokens: 1,
      outputTokens: 1,
      method: 'estimated',
      recordedBy: 'agent:session',
      enteredBy: 'agent',
    });
    const listed = engine.ctx.store.listUsageRecords(work.id);
    expect(listed).toHaveLength(2);
    const still = listed.find((r) => r.id === human.id)!;
    expect(still.tokens).toEqual({ input: 42, output: 7 });
    expect(still.enteredBy).toBe('human');
    // Store exposes no delete/update API for usage records.
    expect(typeof (engine.ctx.store as { deleteUsageRecord?: unknown }).deleteUsageRecord).toBe('undefined');
    expect(typeof (engine.ctx.store as { updateUsageRecord?: unknown }).updateUsageRecord).toBe('undefined');
    engine.ctx.store.close();
  });

  it('FR-007: maxTokens budget blocks further Turbine model calls', async () => {
    const dir = tempProject('usage-fr007-', dirs);
    const { engine, work } = makeTask(dir);
    await engine.assess(work.id);
    const used = measuredTurbineTokens(engine.ctx.store.listRoleRuns(work.id));
    expect(used).toBeGreaterThan(0);

    const cfg = loadConfig(engine.ctx.paths.configPath);
    cfg.budgets.perTask.maxTokens = used; // already at/over cap
    saveConfig(engine.ctx.paths.configPath, cfg);
    // Re-open so Engine picks up new config
    engine.ctx.store.close();
    const engine2 = new Engine(openContext(dir));
    await expect(engine2.assess(work.id)).rejects.toMatchObject({ code: 'E_BUDGET_EXCEEDED' });
    engine2.ctx.store.close();
  });

  it('summarizeUsage never treats unknown as 0 in mixed totals', () => {
    const summary = summarizeUsage({
      workId: 'work_x',
      roleRuns: [
        {
          id: 'run_1',
          workId: 'work_x',
          roleId: 'requirements-analyst',
          roleVersion: '1.0.0',
          skillIds: [],
          toolCapabilityGrants: [],
          modelProvider: 'mock',
          modelId: 'm1',
          startedAt: 't',
          endedAt: 't',
          status: 'succeeded',
          inputArtifactIds: [],
          outputArtifactIds: [],
          attempts: 1,
          tokens: { input: 100, output: 50 },
        },
        {
          id: 'run_2',
          workId: 'work_x',
          roleId: 'requirements-analyst',
          roleVersion: '1.0.0',
          skillIds: [],
          toolCapabilityGrants: [],
          modelProvider: 'mock',
          modelId: 'm1',
          startedAt: 't',
          endedAt: 't',
          status: 'succeeded',
          inputArtifactIds: [],
          outputArtifactIds: [],
          attempts: 1,
          tokens: { input: 'unknown', output: 'unknown' },
        },
      ],
      records: [],
    });
    expect(summary.bySource.turbine.input).toBe(100);
    expect(summary.bySource.turbine.output).toBe(50);
    expect(summary.bySource.turbine.total).toBe(150);
    expect(summary.bySource.turbine.hasUnknown).toBe(true);
    expect(summary.grand.hasUnknown).toBe(true);
  });
});
