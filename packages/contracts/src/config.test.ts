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
        sandboxAllowNetwork: 'turbine-allow',
      },
    });
    expect(cfg.execution.sandboxImage).toBe('docker.io/library/node:22-bookworm');
    expect(cfg.execution.sandboxRegistries).toEqual(['registry.npmjs.org', 'localhost']);
    expect(cfg.execution.sandboxModelProxyUrl).toBe('https://proxy.example.com/v1');
    expect(cfg.execution.sandboxImplementer).toBe('claude-code');
    expect(cfg.execution.sandboxAllowNetwork).toBe('turbine-allow');
  });

  it('refuses sandboxImage with path traversal or absolute path', () => {
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
  });

  it('refuses sandboxModelProxyUrl with credentials or non-http scheme', () => {
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
