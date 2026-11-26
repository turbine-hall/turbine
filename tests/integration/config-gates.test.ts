import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, openContext } from '../../apps/cli/src/engine/project.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { cleanup, tempProject } from './fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

describe('humanGates cannot be switched off (FR-A10, AC3)', () => {
  it('false gate toggles are rejected', () => {
    for (const gate of ['requirements', 'plan', 'codeReview', 'sqaAcceptance']) {
      const dir = tempProject('turbine-gates-cfg-', dirs);
      const configPath = join(dir, '.turbine', 'project.yaml');
      const yaml = readFileSync(configPath, 'utf8').replace(new RegExp(`(\\n\\s+${gate}:) true`), '$1 false');
      expect(yaml, gate).toMatch(new RegExp(`${gate}: false`));
      writeFileSync(configPath, yaml);
      let caught: { code?: string; message?: string } | undefined;
      try {
        loadConfig(configPath);
      } catch (e) {
        caught = e as { code?: string; message?: string };
      }
      expect(caught?.code, gate).toBe('E_CONFIG');
      expect(caught?.message).toMatch(new RegExp(`humanGates\\.${gate}`));
      expect(caught?.message).toMatch(/lane policies/);
    }
  });

  it('true, omitted and requirePrApproval: false still load', () => {
    const dir = tempProject('turbine-gates-cfg-', dirs);
    const configPath = join(dir, '.turbine', 'project.yaml');
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(/\n\s+codeReview: true/, ''));
    const cfg = loadConfig(configPath);
    expect(cfg.humanGates.codeReview).toBe(true);
    expect(cfg.humanGates.requirePrApproval).toBe(false);
  });

  it('`config set humanGates.codeReview false` is refused and leaves the live config unchanged', () => {
    const dir = tempProject('turbine-gates-cfg-', dirs);
    const engine = new Engine(openContext(dir));
    expect(() => engine.setConfig('humanGates.codeReview', 'false')).toThrow(/lane policies/);
    expect(engine.ctx.config.humanGates.codeReview).toBe(true);
    expect(loadConfig(join(dir, '.turbine', 'project.yaml')).humanGates.codeReview).toBe(true);
    engine.ctx.store.close();
  });

  it('reports disabled gates even when a sibling gate value has the wrong type', () => {
    const dir = tempProject('turbine-gates-cfg-', dirs);
    const configPath = join(dir, '.turbine', 'project.yaml');
    let yaml = readFileSync(configPath, 'utf8').replace(/(\n\s+requirements:) true/, '$1 false');
    yaml = yaml.replace(/(\n\s+requirePrApproval:) false/, '$1 "false"');
    expect(yaml).toMatch(/requirements: false/);
    expect(yaml).toMatch(/requirePrApproval: ["']false["']/);
    writeFileSync(configPath, yaml);
    let caught: { code?: string; message?: string; details?: { issues?: Array<{ path: string }> } } | undefined;
    try {
      loadConfig(configPath);
    } catch (e) {
      caught = e as typeof caught;
    }
    expect(caught?.code).toBe('E_CONFIG');
    expect(caught?.message).toMatch(/humanGates\.requirements/);
    const paths = (caught?.details?.issues ?? []).map((i) => i.path);
    expect(paths.some((p) => p.includes('requirePrApproval'))).toBe(true);
  });
});
