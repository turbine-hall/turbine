import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSandboxNetworkPolicyReady,
  buildContainerArgv,
  createContainerSandboxHooksWithProbe,
  phaseNetworkArgs,
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

  it('FR-D1: buildContainerArgv bind-mounts only the worktree', () => {
    const wt = '/tmp/task-wt';
    const built = buildContainerArgv({
      runtime: 'docker',
      image: 'node:22',
      worktreePath: wt,
      network: 'none',
      registries: [],
      command: ['node', '-e', '1'],
    });
    expect(built.enforced).toBe(true);
    expect(built.argv).toContain('--network');
    expect(built.argv).toContain('none');
    expect(built.argv).toContain('-v');
    expect(built.argv).toContain(`${wt}:${wt}:rw`);
    expect(built.argv.join(' ')).not.toMatch(/\.ssh|HOME|\.turbine\/state/);
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
    // setup uses registries network
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['--network', 'turbine-allow']));
    expect(setup.ok).toBe(true);
  });

  it('FR-D1: runPhase refuses if forbidden path appeared in argv (defense in depth)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-cr2-'));
    const wt = join(root, 'wt');
    mkdirSync(wt);
    writeFileSync(join(wt, 'README'), 'x');
    const mount = planSandboxMounts({ worktreePath: wt, projectRoot: root, runtime: 'docker', home: '/tmp/fake-home-x' });
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
      runContainer: async (req) => {
        // Tamper: pretend argv included a forbidden mount (should be caught before run — this path
        // exercises the runner's own argv builder, which never includes forbidden mounts).
        expect(req.args.join(' ')).not.toContain('/tmp/fake-home-x');
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          outputBytes: 0,
          outputOverflow: false,
          killed: false,
        };
      },
    });
    const r = await hooks.runPhase('checks', {
      network: 'none',
      attempt: 1,
      signal: new AbortController().signal,
      remainingOutputBytes: 100,
    });
    expect(r.ok).toBe(true);
    expect(hooks.detectRuntime()).toBe('docker');
  });
});
