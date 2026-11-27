import { describe, expect, it } from 'vitest';
import { ProjectConfigSchema } from './config.js';

const base = {
  schemaVersion: 1 as const,
  project: { name: 't', root: '/tmp/t', nonProductionOnly: true },
  framework: { id: 'turbine', version: '0.5.0', policyProfile: 'standard' as const },
  inputs: { default: 'file' as const },
  models: {},
};

describe('execution sandbox config (FR-D6)', () => {
  it('accepts sandboxImage, sandboxRegistries, sandboxModelProxyUrl, sandboxImplementer', () => {
    const cfg = ProjectConfigSchema.parse({
      ...base,
      execution: {
        mode: 'sandboxed-unattended',
        sandboxImage: 'docker.io/library/node:22-bookworm',
        sandboxRegistries: ['registry.npmjs.org', 'localhost'],
        sandboxModelProxyUrl: 'https://proxy.example.com/v1',
        sandboxImplementer: 'claude-code',
        sandboxAllowNetwork: 'turbine-reg',
        sandboxModelProxyNetwork: 'turbine-proxy',
      },
    });
    expect(cfg.execution.sandboxImage).toBe('docker.io/library/node:22-bookworm');
    expect(cfg.execution.sandboxRegistries).toEqual(['registry.npmjs.org', 'localhost']);
    expect(cfg.execution.sandboxModelProxyUrl).toBe('https://proxy.example.com/v1');
    expect(cfg.execution.sandboxImplementer).toBe('claude-code');
    expect(cfg.execution.sandboxAllowNetwork).toBe('turbine-reg');
    expect(cfg.execution.sandboxModelProxyNetwork).toBe('turbine-proxy');
  });

  it('refuses sandboxImage with path traversal, absolute path, or leading hyphen', () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...base,
        execution: { sandboxImage: '../evil:latest' },
      }),
    ).toThrow(/sandboxImage/);
    expect(() =>
      ProjectConfigSchema.parse({
        ...base,
        execution: { sandboxImage: '/var/run/docker.sock' },
      }),
    ).toThrow(/sandboxImage/);
    expect(() =>
      ProjectConfigSchema.parse({
        ...base,
        execution: { sandboxImage: '-eEVIL=1' },
      }),
    ).toThrow(/sandboxImage/);
  });

  it('refuses sandboxModelProxyUrl with credentials, non-http scheme, or raw traversal', () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...base,
        execution: { sandboxModelProxyUrl: 'https://user:pass@proxy.example.com' },
      }),
    ).toThrow();
    expect(() =>
      ProjectConfigSchema.parse({
        ...base,
        execution: { sandboxModelProxyUrl: 'file:///etc/passwd' },
      }),
    ).toThrow();
    expect(() =>
      ProjectConfigSchema.parse({
        ...base,
        execution: { sandboxModelProxyUrl: 'https://proxy.example.com/api/../v1' },
      }),
    ).toThrow();
  });

  it('refuses registry hostnames that look like credential mounts or paths', () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...base,
        execution: { sandboxRegistries: ['registry.npmjs.org/../.ssh'] },
      }),
    ).toThrow();
    expect(() =>
      ProjectConfigSchema.parse({
        ...base,
        execution: { sandboxRegistries: ['https://registry.npmjs.org'] },
      }),
    ).toThrow();
  });

  it('refuses unknown sandboxImplementer ids', () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...base,
        execution: { sandboxImplementer: 'fixture' },
      }),
    ).toThrow();
  });

  it('defaults sandboxImage and empty registries', () => {
    const cfg = ProjectConfigSchema.parse(base);
    expect(cfg.execution.sandboxImage).toBe('docker.io/library/node:22-bookworm');
    expect(cfg.execution.sandboxRegistries).toEqual([]);
    expect(cfg.execution.sandboxImplementer).toBeUndefined();
  });
});

describe('git.defaultBaseBranch', () => {
  it('defaults to main and retains an explicit base branch', () => {
    const defaults = ProjectConfigSchema.parse(base);
    expect(defaults.git.defaultBaseBranch).toBe('main');
    expect(defaults.git.maxSubtaskPrChangedLines).toBe(400);

    const cfg = ProjectConfigSchema.parse({
      ...base,
      git: { defaultBaseBranch: 'test', maxSubtaskPrChangedLines: 200 },
    });
    expect(cfg.git.defaultBaseBranch).toBe('test');
    expect(cfg.git.maxSubtaskPrChangedLines).toBe(200);
  });

  it('refuses empty or invalid defaultBaseBranch', () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...base,
        git: { defaultBaseBranch: '' },
      }),
    ).toThrow();
    expect(() =>
      ProjectConfigSchema.parse({
        ...base,
        git: { defaultBaseBranch: 'main;rm -rf /' },
      }),
    ).toThrow(/git.defaultBaseBranch/);
    expect(() =>
      ProjectConfigSchema.parse({
        ...base,
        git: { defaultBaseBranch: 'foo..bar' },
      }),
    ).toThrow(/git.defaultBaseBranch/);
    expect(() =>
      ProjectConfigSchema.parse({
        ...base,
        git: { defaultBaseBranch: 'release/' },
      }),
    ).toThrow(/git.defaultBaseBranch/);
    expect(() =>
      ProjectConfigSchema.parse({
        ...base,
        git: { defaultBaseBranch: 'heads/main.lock' },
      }),
    ).toThrow(/git.defaultBaseBranch/);
    expect(ProjectConfigSchema.parse({ ...base, git: { defaultBaseBranch: 'release/next' } }).git.defaultBaseBranch).toBe(
      'release/next',
    );
  });
});
