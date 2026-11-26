import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudeCodeImplementer,
  createCodexImplementer,
  createFixtureImplementer,
  createImplementerFromConfig,
  formatImplementerPrompt,
} from './agent-adapter.js';
import { sandboxPromptPath } from './container-runner.js';

describe('agent adapters (FR-D4 / FR-D5 / FR-D7)', () => {
  it('FR-D4: formatImplementerPrompt includes SPEC+PLAN+CONTEXT+knowledge', () => {
    const text = formatImplementerPrompt({
      workId: 'work_x',
      spec: 'SPEC-BODY',
      plan: 'PLAN-BODY',
      context: 'CTX-BODY',
      knowledge: 'KNOW-BODY',
    });
    expect(text).toContain('SPEC-BODY');
    expect(text).toContain('PLAN-BODY');
    expect(text).toContain('CTX-BODY');
    expect(text).toContain('KNOW-BODY');
  });

  it('FR-D4: containerDelegated writes prompt and returns commits+usage without host spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-adapter-'));
    const wt = join(root, 'wt');
    mkdirSync(wt);
    const impl = createClaudeCodeImplementer({ containerDelegated: true, modelId: 'claude-test' });
    const result = await impl.run({
      workId: 'work_1',
      spec: 's',
      plan: 'p',
      context: 'c',
      knowledge: 'k',
      worktreePath: wt,
      listCommits: () => ['abc123'],
    });
    expect(result.ok).toBe(true);
    expect(result.commits).toEqual(['abc123']);
    expect(result.usage?.provider).toBe('anthropic');
    expect(result.usage?.modelId).toBe('claude-test');
    expect(result.report).toMatch(/unverified/i);
    expect(readFileSync(sandboxPromptPath(wt), 'utf8')).toContain('## SPEC');
  });

  it('FR-D4: codex containerDelegated records openai provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-adapter-codex-'));
    const wt = join(root, 'wt');
    mkdirSync(wt);
    const impl = createImplementerFromConfig('codex', { containerDelegated: true });
    const result = await impl.run({
      workId: 'work_2',
      spec: 's',
      plan: 'p',
      context: 'c',
      knowledge: 'k',
      worktreePath: wt,
      listCommits: () => ['def456'],
    });
    expect(result.commits).toEqual(['def456']);
    expect(result.usage?.provider).toBe('openai');
    expect(impl.id).toBe('codex');
  });

  it('FR-D7: host stub spawn (injectable bin) records exit without live API keys', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-adapter-stub-'));
    const wt = join(root, 'wt');
    mkdirSync(wt);
    const stub = join(root, 'stub-cli');
    writeFileSync(stub, '#!/bin/sh\necho stub-ok\nexit 0\n');
    chmodSync(stub, 0o755);
    const impl = createCodexImplementer({ bin: stub, extraArgs: [] });
    const result = await impl.run({
      workId: 'work_3',
      spec: 's',
      plan: 'p',
      context: 'c',
      knowledge: 'k',
      worktreePath: wt,
      listCommits: () => ['stubcommit'],
    });
    expect(result.ok).toBe(true);
    expect(result.commits).toEqual(['stubcommit']);
    expect(result.report).toMatch(/stub-ok/);
  });

  it('FR-D7: host stub respects AbortSignal and does not use spawnSync', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-adapter-abort-'));
    const wt = join(root, 'wt');
    mkdirSync(wt);
    const stub = join(root, 'stub-hang');
    writeFileSync(stub, '#!/bin/sh\nsleep 30\n');
    chmodSync(stub, 0o755);
    const impl = createClaudeCodeImplementer({ bin: stub, extraArgs: [] });
    const ac = new AbortController();
    const pending = impl.run({
      workId: 'work_abort',
      spec: 's',
      plan: 'p',
      context: 'c',
      knowledge: 'k',
      worktreePath: wt,
      signal: ac.signal,
      listCommits: () => [],
    });
    setTimeout(() => ac.abort(), 50);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/abort/i);
  });

  it('FR-D5: fixture report is labeled unverified prose', async () => {
    const impl = createFixtureImplementer({
      commits: [],
      report: 'I totally finished everything',
      ok: true,
    });
    const result = await impl.run({
      workId: 'w',
      spec: 's',
      plan: 'p',
      context: 'c',
      knowledge: 'k',
    });
    expect(result.report).toMatch(/I totally finished everything|unverified/i);
    expect(result.commits).toEqual([]);
  });

  it('refuses when worktreePath is missing for live adapters', async () => {
    const impl = createClaudeCodeImplementer({ containerDelegated: true });
    const result = await impl.run({
      workId: 'w',
      spec: 's',
      plan: 'p',
      context: 'c',
      knowledge: 'k',
    });
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/worktreePath/);
  });
});
