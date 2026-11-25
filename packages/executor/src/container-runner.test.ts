import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentCliCommand,
  assertSandboxNetworkPolicyReady,
  buildContainerArgv,
  createContainerSandboxHooksWithProbe,
  findForbiddenBindInArgv,
  parseBindHostsFromArgv,
  phaseNetworkArgs,
  resolveLinkedGitMounts,
  sandboxPromptPath,
  writeSandboxPrompt,
  type ContainerRunRequest,
} from './container-runner.js';
import { planSandboxMounts } from './sandbox.js';

describe('container phase runner', () => {
  it('FR-D2: none network is always enforced; allow-list scopes need sandboxAllowNetwork', () => {
    expect(phaseNetworkArgs('none', { registries: [] }).enforced).toBe(true);
    expect(phaseNetworkArgs('registries', { registries: ['registry.npmjs.org'] }).enforced).toBe(false);
    expect(
      phaseNetworkArgs('registries', {
        registries: ['registry.npmjs.org'],
        allowNetwork: 'turbine-allow',
      }).enforced,
    ).toBe(true);
    expect(
      phaseNetworkArgs('model-proxy', {
        registries: [],
        allowNetwork: 'turbine-allow',
        modelProxyUrl: 'https://proxy.example.com',
      }).args,
    ).toEqual(
      expect.arrayContaining(['--network', 'turbine-allow', '-e', 'HTTPS_PROXY=https://proxy.example.com']),
    );
  });

  it('FR-D2: assertSandboxNetworkPolicyReady refuses incomplete allow-list config', () => {
    expect(() =>
      assertSandboxNetworkPolicyReady({ registries: [], allowNetwork: 'n', modelProxyUrl: 'https://p.example.com' }),
    ).toThrow(/registries/i);
    expect(() =>
      assertSandboxNetworkPolicyReady({
        registries: ['registry.npmjs.org'],
        modelProxyUrl: 'https://proxy.example.com',
      }),
    ).toThrow(/sandboxAllowNetwork/i);
  });

  it('FR-D1: buildContainerArgv bind-mounts worktree, names the container, and can add Git mounts', () => {
    const wt = '/tmp/task-wt';
    const git = '/tmp/project/.git';
    const built = buildContainerArgv({
      runtime: 'docker',
      image: 'node:22',
      worktreePath: wt,
      network: 'none',
      registries: [],
      command: ['node', '-e', '1'],
      extraMounts: [{ host: git, dest: git, mode: 'rw' }],
      containerName: 'turbine-sbx-test',
    });
    expect(built.enforced).toBe(true);
    expect(built.argv).toContain('--name');
    expect(built.argv).toContain('turbine-sbx-test');
    expect(built.argv).toContain(`${wt}:${wt}:rw`);
    expect(built.argv).toContain(`${git}:${git}:rw`);
    expect(built.argv.join(' ')).not.toMatch(/\.ssh|HOME|\.turbine\/state/);
  });

  it('FR-D1: forbidden-mount scan uses bind hosts and skips home so worktrees under $HOME work', () => {
    const home = '/home/alice';
    const wt = '/home/alice/project/.turbine/worktrees/task';
    const argv = ['run', '-v', `${wt}:${wt}:rw`, 'node:22', 'true'];
    const forbidden = [home, `${home}/.ssh`, '/proj/.turbine/state'];
    expect(findForbiddenBindInArgv(argv, forbidden, home)).toBeUndefined();
    expect(
      findForbiddenBindInArgv(['run', '-v', `${home}/.ssh:/x:ro`, 'img', 't'], forbidden, home),
    ).toBe(`${home}/.ssh`);
    expect(parseBindHostsFromArgv(argv)).toEqual([wt]);
  });

  it('FR-D4: agentCliCommand uses provider-specific non-interactive shapes', () => {
    const p = '/wt/.turbine-sandbox-prompt.md';
    expect(agentCliCommand('claude-code', p)[0]).toBe('sh');
    expect(agentCliCommand('claude-code', p).join(' ')).toMatch(/claude -p/);
    expect(agentCliCommand('codex', p).join(' ')).toMatch(/codex exec/);
    expect(agentCliCommand('claude-code', p).join(' ')).not.toMatch(/--prompt-file/);
  });

  it('FR-D3: writeSandboxPrompt refuses to follow a pre-existing symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-prompt-'));
    const wt = join(root, 'wt');
    const outside = join(root, 'outside.txt');
    mkdirSync(wt);
    writeFileSync(outside, 'secret');
    symlinkSync(outside, sandboxPromptPath(wt));
    writeSandboxPrompt(wt, 'SAFE_PROMPT');
    expect(readFileSync(sandboxPromptPath(wt), 'utf8')).toBe('SAFE_PROMPT');
    expect(readFileSync(outside, 'utf8')).toBe('secret');
  });

  it('FR-D3: injected runContainer egress blocked → egressOpen false allows preflight', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-cr-'));
    const wt = join(root, 'wt');
    mkdirSync(wt);
    writeFileSync(join(wt, 'README'), 'x');
    const mount = planSandboxMounts({ worktreePath: wt, projectRoot: root, runtime: 'docker', home: '/tmp/no-home' });
    const calls: ContainerRunRequest[] = [];
    const hooks = createContainerSandboxHooksWithProbe({
      worktreePath: wt,
      projectRoot: root,
      image: 'node:22',
      registries: ['registry.npmjs.org'],
      modelProxyUrl: 'https://proxy.example.com',
      allowNetwork: 'turbine-allow',
      runtime: 'docker',
      mount,
      egressOpen: false,
      home: '/tmp/no-home',
      runContainer: async (req) => {
        calls.push(req);
        return {
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          outputBytes: 2,
          outputOverflow: false,
          killed: false,
        };
      },
    });
    expect(hooks.egressProbeSucceeds()).toBe(false);
    const setup = await hooks.runPhase('setup', {
      network: 'none',
      attempt: 1,
      signal: new AbortController().signal,
      remainingOutputBytes: 1000,
    });
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['--network', 'turbine-allow']));
    expect(calls[0]?.containerName).toBeTruthy();
    expect(setup.ok).toBe(true);
  });

  it('resolveLinkedGitMounts returns [] for a plain repo worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-git-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    expect(resolveLinkedGitMounts(root)).toEqual([]);
  });
});
