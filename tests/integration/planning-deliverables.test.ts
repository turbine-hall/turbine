/**
 * Planning deliverables (#17): PLAN.md, EXECUTIVE-SUMMARY.md (Mermaid), coding-agent token estimate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { openContext } from '../../apps/cli/src/engine/project.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { packetPaths } from '../../apps/cli/src/engine/packet.js';
import { normalizePlan } from '../../apps/cli/src/engine/docs/normalize.js';
import { lintPacket, lintMermaid } from '../../apps/cli/src/engine/docs/lint.js';
import { renderExecutiveSummary, renderPlan } from '../../apps/cli/src/engine/docs/render.js';
import type { PacketData } from '../../apps/cli/src/engine/docs/render.js';
import { computeNextStep } from '../../apps/cli/src/engine/next-step.js';
import { getSkill, loadSkills } from '../../packages/skills/dist/index.js';
import { factoryRoot } from '../../apps/cli/src/paths.js';
import { cleanup, tempProject } from './fixture.js';


const dirs: string[] = [];
afterEach(() => cleanup(dirs));

const token = (engine: Engine, id: string) => engine.pendingApproval(id).confirmToken;
const approve = (engine: Engine, id: string) =>
  engine.decide(id, { action: 'approve', reviewer: 'Ana', confirmToken: token(engine, id), presence: 'test' });

describe('planning deliverables (#17)', () => {
  it('loads plan-change and plan-executive-summary skills', () => {
    const root = factoryRoot();
    const ids = loadSkills(root).map((s) => s.id);
    expect(ids).toContain('core/plan-change');
    expect(ids).toContain('core/plan-executive-summary');
    expect(getSkill(root, 'core/plan-change').version).toBe('0.2.0');
  });

  it('renderPlan and renderExecutiveSummary stay lint-shaped when summary/diagrams are empty', () => {
    const plan = normalizePlan({
      summary: '',
      steps: [{ id: 'S1', description: 'Do the thing', requirementIds: ['FR-001'], files: ['a.ts'] }],
      testPlan: [],
      risks: [],
      estimatedComplexity: 'low',
    });
    expect(plan.diagrams).toEqual([]);
    const packet = {
      projectRoot: '/tmp',
      track: 'standard' as const,
      work: { id: 'W-empty', title: 'Empty fields', type: 'feature', currentState: 'PLAN_REVIEW' },
      plan: { hash: 'abc123', data: plan },
      decisions: [],
      evidenceFiles: [],
      trace: [],
      changeSetId: undefined,
    } as unknown as PacketData;
    const planMd = renderPlan(packet);
    const execMd = renderExecutiveSummary(packet);
    expect(planMd).toContain('## Summary');
    expect(planMd).toContain('_No summary provided._');
    expect(execMd).toContain('```mermaid');
    expect(execMd).toContain('No diagram provided by plan');
    const mermaid = execMd.match(/```mermaid\n([\s\S]*?)```/)?.[1] ?? '';
    expect(lintMermaid(mermaid)).toBeUndefined();
  });

  it('normalizePlan keeps detailed fields, diagrams, and estimated token budget', () => {
    const plan = normalizePlan({
      summary: 'Ship the feature',
      architecture: 'Extend the CLI packet renderer',
      dataModel: 'no data model change',
      interfaces: 'no interface change',
      executiveSummary: 'Humans get a clearer plan packet.',
      diagrams: [{ title: 'Flow', mermaid: 'flowchart LR\n  a[Spec] --> b[Plan]' }],
      steps: [{ id: 'S1', description: 'Render PLAN.md', requirementIds: ['FR-001'], files: ['apps/cli/src/engine/docs/render.ts'] }],
      testPlan: [{ requirementId: 'FR-001', test: 'packet includes PLAN.md', kind: 'unit' }],
      risks: [{ risk: 'doc churn', mitigation: 'lint headings' }],
      estimatedComplexity: 'medium',
      codingAgentTokenEstimate: {
        totalTokens: 185000,
        inputTokens: 129500,
        outputTokens: 55500,
        basis: 'medium base + steps + files',
        confidence: 'estimated',
      },
    });
    expect(plan.architecture).toMatch(/CLI/);
    expect(plan.diagrams).toHaveLength(1);
    expect(plan.codingAgentTokenEstimate?.confidence).toBe('estimated');
    expect(plan.codingAgentTokenEstimate?.totalTokens).toBe(185000);
    expect(plan.executiveSummary).toMatch(/clearer plan/);
  });

  it('planning writes PLAN.md and EXECUTIVE-SUMMARY.md with Mermaid and token estimate', async () => {
    const dir = tempProject('turbine-plan-docs-', dirs);
    const engine = new Engine(openContext(dir));
    const work = engine.createTask({
      title: 'Export leave CSV',
      text: '# Export\n\nManagers with auth permission export leave requests as CSV.',
      type: 'feature',
    });
    await engine.syncFromMarkdown(work.id); // assess
    let w = engine.ctx.store.getWork(work.id);
    // Answer any open questions so we can approve requirements.
    if (w.unknowns.length) {
      const p = packetPaths(dir, w.id);
      let md = readFileSync(p.spec, 'utf8');
      w.unknowns.forEach((_, i) => {
        md = md.replace(new RegExp(`(- \\*\\*Q${i + 1}\\*\\*: .+)`), '$1 → Answer: decided for test');
      });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(p.spec, md);
      await engine.syncFromMarkdown(w.id);
    }
    expect(approve(engine, w.id).work.currentState).toBe('REQUIREMENTS_APPROVED');
    await engine.syncFromMarkdown(w.id); // plan
    w = engine.ctx.store.getWork(w.id);
    expect(w.currentState).toBe('PLAN_REVIEW');

    const paths = packetPaths(dir, w.id);
    expect(existsSync(paths.planDoc)).toBe(true);
    expect(existsSync(paths.executiveSummary)).toBe(true);
    const planMd = readFileSync(paths.planDoc, 'utf8');
    const execMd = readFileSync(paths.executiveSummary, 'utf8');
    expect(planMd).toMatch(/^# Plan —/m);
    expect(planMd).toContain('## Architecture');
    expect(planMd).toContain('## Coding-agent token estimate');
    expect(planMd).toMatch(/Confidence \| `estimated`/);
    expect(execMd).toContain('## Overview');
    expect(execMd).toContain('## Diagrams');
    expect(execMd).toContain('```mermaid');
    const mermaid = execMd.match(/```mermaid\n([\s\S]*?)```/)?.[1] ?? '';
    expect(lintMermaid(mermaid)).toBeUndefined();

    const spec = readFileSync(paths.spec, 'utf8');
    expect(spec).toContain('[PLAN.md](PLAN.md)');
    expect(spec).toContain('[EXECUTIVE-SUMMARY.md](EXECUTIVE-SUMMARY.md)');
    expect(spec).not.toMatch(/\| Step \| What \| Requirements \| Files \|/);

    const lint = lintPacket(paths, {
      track: 'standard',
      requirementIds: w.acceptanceCriteria.map((c) => c.id),
      hasPlan: true,
    });
    expect(lint.filter((i) => i.level === 'error')).toEqual([]);

    const step = computeNextStep({
      projectRoot: dir,
      work: w,
      defaultBaseBranch: 'staging',
    });
    expect(step.openFiles).toEqual(expect.arrayContaining([paths.planDoc, paths.executiveSummary]));
    expect(step.doNow).toMatch(/PLAN\.md/);

    const art = engine.ctx.store.getLatestArtifact(w.id, 'plan')!;
    const raw = JSON.parse(engine.ctx.store.getArtifactContent(art.id)) as Record<string, unknown>;
    const normalized = normalizePlan(raw);
    expect(normalized.codingAgentTokenEstimate?.confidence).toBe('estimated');
    expect(normalized.diagrams.length).toBeGreaterThan(0);

    engine.ctx.store.close();
  });
});
