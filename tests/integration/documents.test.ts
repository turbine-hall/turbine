/**
 * Phase 3 — document standard: three readable files, editable requirements, generated
 * visuals, traceability, analysis and lint that gate approvals.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// Same module instance the engine resolves (workspace package → dist).
import { registerModel, type ModelAdapter } from '../../packages/models/dist/index.js';
import { openContext } from '../../apps/cli/src/engine/project.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { packetPaths, parseSpecMarkdown } from '../../apps/cli/src/engine/packet.js';
import { lintMermaid } from '../../apps/cli/src/engine/docs/lint.js';
import { changeMap, gateFlow, userFlowDiagram } from '../../apps/cli/src/engine/docs/visuals.js';
import { cleanup, commitIn, tempProject } from './fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

const read = (p: string) => readFileSync(p, 'utf8');
const token = (engine: Engine, id: string) => engine.pendingApproval(id).confirmToken;
const approve = (engine: Engine, id: string) =>
  engine.decide(id, { action: 'approve', reviewer: 'Ana', confirmToken: token(engine, id), presence: 'test' });

async function assessed(engine: Engine, text = '# Export\n\nManagers with auth permission export leave requests as CSV.') {
  const work = engine.createTask({ title: 'Export leave CSV', text, type: 'feature' });
  await engine.syncFromMarkdown(work.id); // assess
  return engine.ctx.store.getWork(work.id);
}

describe('packet layout', () => {
  it('writes STATUS / SPEC / REVIEW with no inline JSON, a gate diagram, labelled context and raw data in evidence/', async () => {
    const dir = tempProject('turbine-docs-', dirs);
    const engine = new Engine(openContext(dir));
    const work = await assessed(engine);
    const p = packetPaths(dir, work.id);
    for (const f of [p.status, p.spec, p.review]) expect(existsSync(f)).toBe(true);
    expect(existsSync(join(p.evidenceDir, 'spec.json'))).toBe(true);
    const status = read(p.status);
    const spec = read(p.spec);
    expect(status).toMatch(/```mermaid\nflowchart LR/);
    expect(status).toContain('Waiting on you: approve the requirements');
    expect(spec).toContain('## Original request');
    expect(spec.indexOf('## Original request')).toBeLessThan(spec.indexOf('## Requirements'));
    expect(spec.indexOf('## Requirements')).toBeLessThan(spec.indexOf('## Context'));
    expect(spec).toMatch(/## Requirements \(\d+\)/);
    expect(spec).toMatch(/- \*\*FR-001\*\* \(P0, behavioral\): WHEN /);
    expect(spec).toMatch(/export leave requests as CSV/i);
    expect(spec).not.toContain('Users get the requested behaviour');
    expect(spec).toMatch(/- ✅ Verified — .+ _\(package\.json|git|request\)_/);
    expect(spec).toContain('```mermaid\nsequenceDiagram'); // user flow
    for (const f of [status, spec, read(p.review)]) expect(f).not.toContain('```json');
    expect(engine.lintWork(work.id).filter((i) => i.level === 'error')).toEqual([]);
    expect(existsSync(join(dir, '.turbine', 'GLOSSARY.md'))).toBe(true);
    engine.ctx.store.close();
  });

  it('title-only create seeds request items from the title (no empty-body placeholder)', async () => {
    const dir = tempProject('turbine-docs-', dirs);
    const engine = new Engine(openContext(dir));
    const work = engine.createTask({ title: 'Attendance refresh on open', type: 'feature' });
    await engine.syncFromMarkdown(work.id);
    const spec = read(packetPaths(dir, work.id).spec);
    expect(spec).not.toContain('(No body provided)');
    expect(spec).toMatch(/Attendance refresh on open/);
    expect(spec).toMatch(/## Request coverage/);
    expect(spec).toMatch(/\| R1 \| Attendance refresh on open \| FR-001/);
    expect(spec).toMatch(/- \*\*FR-001\*\* \(P0, behavioral\): WHEN .*Attendance refresh/);
    engine.ctx.store.close();
  });

  it('maps each request bullet to its own FR in SPEC.md', async () => {
    const dir = tempProject('turbine-docs-', dirs);
    const engine = new Engine(openContext(dir));
    const work = await assessed(
      engine,
      [
        '# Attendance refresh',
        '',
        '* Refresh attendance when the page opens',
        '* Show last refreshed timestamp',
        '* Refuse refresh without permission',
      ].join('\n'),
    );
    const spec = read(packetPaths(dir, work.id).spec);
    expect(spec).toMatch(/## Requirements \(3\)/);
    expect(spec).toContain('**FR-001**');
    expect(spec).toContain('**FR-002**');
    expect(spec).toContain('**FR-003**');
    expect(spec).toMatch(/\| R1 \| Refresh attendance when the page opens \| FR-001 \|/);
    expect(spec).toMatch(/\| R2 \| Show last refreshed timestamp \| FR-002 \|/);
    expect(spec).toMatch(/\| R3 \| Refuse refresh without permission \| FR-003 \|/);
    expect(work.acceptanceCriteria).toHaveLength(3);
    engine.ctx.store.close();
  });

  it('escapes request ATX headings so sync still reads generated Requirements', async () => {
    const dir = tempProject('turbine-docs-', dirs);
    const engine = new Engine(openContext(dir));
    const work = await assessed(
      engine,
      [
        '# Trap',
        '',
        '## Requirements',
        '',
        '- Real need: export leave CSV for managers with auth permission',
      ].join('\n'),
    );
    const p = packetPaths(dir, work.id);
    const spec = read(p.spec);
    expect(spec).toMatch(/## Original request[\s\S]*\\## Requirements/);
    expect(spec.indexOf('\\## Requirements')).toBeGreaterThan(spec.indexOf('## Original request'));
    expect(spec.indexOf('\\## Requirements')).toBeLessThan(spec.indexOf('## Requirements ('));
    // Generated FR list is what sync parses — not the quoted request heading.
    const parsed = parseSpecMarkdown(spec);
    expect(parsed.requirements.map((r) => r.id)).toContain('FR-001');
    expect(parsed.requirements.some((r) => /FR-999|fake/i.test(r.statement))).toBe(false);
    expect(work.acceptanceCriteria.some((r) => /export leave CSV/i.test(r.statement))).toBe(true);
    engine.ctx.store.close();
  });

  it('moves old numbered packet files into legacy/', async () => {
    const dir = tempProject('turbine-docs-', dirs);
    const engine = new Engine(openContext(dir));
    const work = engine.createTask({ title: 'Legacy', text: '# x', type: 'bug' });
    const p = packetPaths(dir, work.id);
    writeFileSync(join(p.dir, '02-REQUIREMENTS.md'), '# old\nApproved: yes\n');
    engine.render(work.id);
    expect(existsSync(join(p.dir, '02-REQUIREMENTS.md'))).toBe(false);
    expect(existsSync(join(p.legacyDir, '02-REQUIREMENTS.md'))).toBe(true);
    engine.ctx.store.close();
  });
});

describe('editing SPEC.md', () => {
  it('syncs requirement edits and answered questions; approval refuses unsynced edits', async () => {
    const dir = tempProject('turbine-docs-', dirs);
    const engine = new Engine(openContext(dir));
    const work = await assessed(engine, '# Export\n\nExport leave requests as CSV.'); // mock leaves an open question
    expect(work.unknowns.length).toBe(1);
    const p = packetPaths(dir, work.id);
    let md = read(p.spec);
    md = md.replace(/(- \*\*Q1\*\*: .+)/, '$1 → Answer: Only managers of the team')
      .replace(/- \*\*FR-002\*\* \(P1, behavioral\): (.+)/, '- **FR-002** (P0, behavioral): $1');
    writeFileSync(p.spec, md);
    // Not synced yet → approval refused
    expect(() => engine.pendingApproval(work.id)).toThrow(/not synced/);
    const res = await engine.syncFromMarkdown(work.id);
    expect(res.action).toBe('requirements.edit');
    const after = engine.ctx.store.getWork(work.id);
    expect(after.unknowns).toEqual([]);
    expect(after.acceptanceCriteria.find((r) => r.id === 'FR-002')?.priority).toBe('P0');
    expect(after.assumptions.some((a) => a.startsWith('Decided: Only managers of the team'))).toBe(true);
    expect(read(p.spec)).toContain('🟡 Decided — Only managers of the team');
    expect(approve(engine, work.id).work.currentState).toBe('REQUIREMENTS_APPROVED');
    engine.ctx.store.close();
  });

  it('stays in NEEDS_CLARIFICATION while any question is still open', async () => {
    const dir = tempProject('turbine-docs-', dirs);
    const engine = new Engine(openContext(dir));
    const work = await assessed(engine, '# Export\n\nExport leave requests as CSV.');
    const p = packetPaths(dir, work.id);
    // Edit a requirement and ADD a question, without answering it
    writeFileSync(
      p.spec,
      read(p.spec)
        .replace(/(- \*\*FR-002\*\* \(P1, behavioral\): )/, '- **FR-002** (P0, behavioral): ')
        .replace(/(- \*\*Q1\*\*: .+)/, '$1\n- **Q2**: Which columns does the CSV contain?'),
    );
    const res = await engine.syncFromMarkdown(work.id);
    expect(res.work.currentState).toBe('NEEDS_CLARIFICATION');
    expect(read(p.status)).toContain('Waiting on answers to open questions');
    engine.ctx.store.close();
  });

  it('a [NEEDS CLARIFICATION] marker is CRITICAL and blocks requirements approval', async () => {
    const dir = tempProject('turbine-docs-', dirs);
    const engine = new Engine(openContext(dir));
    const work = await assessed(engine);
    const p = packetPaths(dir, work.id);
    writeFileSync(p.spec, read(p.spec).replace(/(- \*\*FR-002\*\* \(P1, behavioral\): )(.+)/, '$1$2 [NEEDS CLARIFICATION: which error code?]'));
    await engine.syncFromMarkdown(work.id);
    expect(engine.analyzeWork(work.id).some((a) => a.severity === 'CRITICAL')).toBe(true);
    expect(() => approve(engine, work.id)).toThrow(/CRITICAL/);
    expect(read(p.status)).toContain('## Problems to fix');
    engine.ctx.store.close();
  });

  it('broken document structure is a lint error that blocks approval', async () => {
    const dir = tempProject('turbine-docs-', dirs);
    const engine = new Engine(openContext(dir));
    const work = await assessed(engine);
    const p = packetPaths(dir, work.id);
    writeFileSync(p.review, read(p.review).replace('## 2. Traceability', '## Trace'));
    expect(engine.lintWork(work.id).some((i) => i.level === 'error' && /Traceability/.test(i.message))).toBe(true);
    expect(() => approve(engine, work.id)).toThrow(/documents are broken/);
    engine.ctx.store.close();
  });
});

describe('request coverage', () => {
  it('flags request items the spec silently dropped and shows them in SPEC.md', async () => {
    const dropper: ModelAdapter = {
      id: 'dropping-spec-writer',
      provider: 'mock',
      capabilities: { text: true, structuredOutput: true, toolCalling: false },
      async run(req) {
        if (req.schemaId === 'assessment') return { content: { facts: [], assumptions: [], unknowns: [], proposedAcceptanceCriteria: [] } };
        if (req.schemaId !== 'specification') return { content: {} };
        expect(req.prompt).toContain('- R1: Users can add a pillar');
        return {
          content: {
            summary: 'Pillars',
            requirements: [{ id: 'FR-001', priority: 'P0', kind: 'behavioral', statement: 'WHEN a user adds a pillar THE SYSTEM SHALL save it' }],
            requestCoverage: [{ itemId: 'R1', requirementIds: ['FR-001'] }, { itemId: 'R3', requirementIds: [], nonGoal: 'Excel import' }],
          },
        };
      },
    };
    registerModel(dropper);
    const dir = tempProject('turbine-docs-', dirs);
    const engine = new Engine(openContext(dir));
    engine.ctx.config.models.profiles.analysis = { provider: 'mock', model: 'dropping-spec-writer', maxOutputTokens: 4000 };
    const work = engine.createTask({
      title: 'Pillars',
      text: '# Pillars\n\n* Users can add a pillar\n* Campaign instructions guide content generation\n* Follow the Excel sheet tab',
      type: 'feature',
    });
    await engine.syncFromMarkdown(work.id);
    const findings = engine.analyzeWork(work.id).filter((f) => f.category === 'coverage' && f.where?.startsWith('R'));
    expect(findings.map((f) => f.where)).toEqual(['R2']);
    expect(findings[0]!.severity).toBe('HIGH');
    const spec = read(packetPaths(dir, work.id).spec);
    expect(spec).toContain('## Request coverage');
    expect(spec).toMatch(/\| R2 \| Campaign instructions guide content generation \| ⚠️ \*\*not covered\*\* \|/);
    expect(spec).toMatch(/\| R3 \| .* \| non-goal: Excel import \|/);
    engine.ctx.store.close();
  });
});

describe('plan analysis', () => {
  it('a P0 requirement with no plan step is CRITICAL and blocks plan approval', async () => {
    const gappy: ModelAdapter = {
      id: 'gappy-planner',
      provider: 'mock',
      capabilities: { text: true, structuredOutput: true, toolCalling: false },
      async run(req) {
        if (req.schemaId !== 'plan') return { content: {} };
        return {
          content: {
            summary: 'Only handles FR-002',
            architecture: 'Auth gate only',
            dataModel: 'no data model change',
            interfaces: 'no interface change',
            executiveSummary: 'Narrow plan that intentionally omits FR-001.',
            diagrams: [{ title: 'Auth only', mermaid: 'flowchart LR\n  req[Request] --> auth[AuthGate]' }],
            steps: [{ id: 'S1', description: 'Refuse unauthorised users', requirementIds: ['FR-002'], files: ['src/auth.js'] }],
            testPlan: [{ requirementId: 'FR-002', test: '403 for others', kind: 'unit' }],
            risks: [],
            estimatedComplexity: 'low',
            codingAgentTokenEstimate: {
              totalTokens: 70000,
              basis: 'low base + 1 step + 1 file',
              confidence: 'estimated',
            },
          },
        };
      },
    };
    registerModel(gappy);
    const dir = tempProject('turbine-docs-', dirs);
    const engine = new Engine(openContext(dir));
    const work = await assessed(engine);
    approve(engine, work.id);
    engine.ctx.config.models.profiles.analysis = { provider: 'mock', model: 'gappy-planner', maxOutputTokens: 4000 };
    await engine.syncFromMarkdown(work.id); // plan
    const findings = engine.analyzeWork(work.id);
    expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'CRITICAL', where: 'FR-001' })]));
    expect(() => approve(engine, work.id)).toThrow(/FR-001 \(P0\) has no plan step/);
    expect(read(packetPaths(dir, work.id).spec)).toContain('Not covered by any plan step: FR-001 (P0)');
    engine.ctx.store.close();
  });
});

describe('traceability, gate and acceptance checklist', () => {
  async function toReview(engine: Engine, withTest: boolean) {
    const work = await assessed(engine);
    approve(engine, work.id); // requirements
    await engine.syncFromMarkdown(work.id); // plan
    approve(engine, work.id); // plan
    const ex = await engine.syncFromMarkdown(work.id); // execute
    const wt = (ex.detail as { result: { worktreePath: string } }).result.worktreePath;
    commitIn(wt, 'src/export.js', 'export const toCsv = (r) => r.join(",");\n');
    if (withTest) commitIn(wt, 'test/export.test.mjs', "import test from 'node:test';\ntest('csv', () => {});\n");
    await engine.syncFromMarkdown(work.id); // capture
    await engine.syncFromMarkdown(work.id); // AI review
    approve(engine, work.id); // code review
    await engine.syncFromMarkdown(work.id); // verify
    return { id: work.id, wt };
  }

  it('linked test + passing checks = FULL; acceptance needs every P0 ticked with an observation', async () => {
    const dir = tempProject('turbine-docs-', dirs);
    const engine = new Engine(openContext(dir));
    const { id } = await toReview(engine, true);
    const trace = engine.traceFor(id);
    expect(trace.map((t) => t.status)).toEqual(['FULL', 'FULL']);
    const p = packetPaths(dir, id);
    const review = read(p.review);
    expect(review).toMatch(/\| FR-001 \| P0 \|.*🟢 FULL \|/);
    expect(review).toMatch(/- \[ \] \*\*FR-001\*\* \(P0\) .* — Observed: _\(what you saw\)_/);

    expect(() => approve(engine, id)).toThrow(/Tick and describe .* FR-001/);
    writeFileSync(
      p.review,
      read(p.review).replace(/- \[ \] (\*\*FR-001\*\*.*Observed: )_\(what you saw\)_/, '- [x] $1Exported 3 rows, opened in Excel'),
    );
    engine.render(id); // re-render must preserve the human's tick and observation
    expect(read(p.review)).toMatch(/- \[x\] \*\*FR-001\*\*.*Observed: Exported 3 rows, opened in Excel/);
    const res = approve(engine, id);
    expect(res.work.currentState).toBe('ACCEPTED');
    expect(engine.gateDecision(id).decision).toBe('PASS');
    engine.ctx.store.close();
  });

  it('without a linked test the P0 is PARTIAL and the gate is CONCERNS (not FAIL)', async () => {
    const dir = tempProject('turbine-docs-', dirs);
    const engine = new Engine(openContext(dir));
    const { id } = await toReview(engine, false);
    expect(engine.traceFor(id)[0]!.status).toBe('PARTIAL');
    const gate = engine.gateDecision(id, ['obl_manual_sqa']);
    expect(gate.decision).toBe('CONCERNS');
    expect(gate.concerns.map((c) => c.id)).toEqual(['obl_requirement_coverage']);
    expect(read(packetPaths(dir, id).status)).toContain('obl_requirement_coverage');
    engine.ctx.store.close();
  });
});

describe('generated diagrams are valid mermaid', () => {
  it('gate flow, change map and user flow pass the mermaid lint; broken ones fail', () => {
    const body = (b: string) => b.replace(/^```mermaid\n/, '').replace(/```$/, '');
    expect(lintMermaid(body(gateFlow('HUMAN_CODE_REVIEW')))).toBeUndefined();
    const map = changeMap([
      {
        repo: 'web', baseCommit: 'a', headCommit: 'b', insertions: 1, deletions: 0, testFilesChanged: [],
        dependencies: { added: [], removed: [], changed: [] },
        files: [{ status: 'A', path: 'src/app/posts/[id]/page.tsx' }, { status: 'M', path: 'lib/"quoted".ts' }],
      },
    ])!;
    expect(lintMermaid(body(map))).toBeUndefined();
    expect(lintMermaid(body(userFlowDiagram([{ from: 'Admin', to: 'App', message: 'clicks "Delete"' }, { from: 'App', to: 'API', message: 'DELETE /x' }])!))).toBeUndefined();
    expect(lintMermaid('flowchart LR\n  a[broken')).toMatch(/unbalanced/);
    expect(lintMermaid('notadiagram')).toMatch(/unknown diagram type/);
    mkdirSync(join('/tmp'), { recursive: true });
  });
});

describe('plan must touch every repository in scope', () => {
  it('flags a declared repo that no plan step changes, and accepts "<repo>:path" files', async () => {
    const { analyze } = await import('../../apps/cli/src/engine/docs/analyze.js');
    const requirements = [{ id: 'FR-001', statement: 'WHEN x THE SYSTEM SHALL y', kind: 'behavioral' as const, status: 'confirmed' as const, priority: 'P0' as const }];
    const plan = (files: string[]) => ({
      summary: '',
      risks: [],
      diagrams: [] as Array<{ title: string; mermaid: string }>,
      steps: [{ id: 'S1', description: 'do it', requirementIds: ['FR-001'], files }],
      testPlan: [{ requirementId: 'FR-001', test: 't', kind: 'unit' }],
    });
    const base = { state: 'PLAN_REVIEW' as const, requirements, unknowns: [], facts: [], repos: ['backend'] };
    const trace = [{ requirementId: 'FR-001', priority: 'P0', statement: '', steps: ['S1'], plannedTests: ['t'], files: [], tests: [], checks: 'not-run' as const, planned: true }];
    const missing = analyze({ ...base, plan: plan(['src/ui.tsx']), trace });
    expect(missing.map((f) => f.message)).toEqual([expect.stringMatching(/Repository "backend" is in scope but no plan step changes it/)]);
    const ok = analyze({ ...base, plan: plan(['src/ui.tsx', 'backend:src/modules/x/prompts.ts']), trace });
    expect(ok).toEqual([]);
  });
});

describe('planned files must exist or be clearly new', () => {
  it('suggests the real file when the plan names a near-miss (campaign.entity.ts → campaign.schema.ts)', async () => {
    const { analyze } = await import('../../apps/cli/src/engine/docs/analyze.js');
    const requirements = [{ id: 'FR-001', statement: 'WHEN x THE SYSTEM SHALL y', kind: 'behavioral' as const, status: 'confirmed' as const, priority: 'P0' as const }];
    const plan = {
      summary: '',
      risks: [],
      diagrams: [] as Array<{ title: string; mermaid: string }>,
      steps: [{ id: 'S1', description: 'd', requirementIds: ['FR-001'], files: ['src/a.ts'] }],
      testPlan: [{ requirementId: 'FR-001', test: 't', kind: 'unit' }],
    };
    const trace = [{ requirementId: 'FR-001', priority: 'P0', statement: '', steps: ['S1'], plannedTests: ['t'], files: [], tests: [], checks: 'not-run' as const, planned: true }];
    const out = analyze({
      state: 'PLAN_REVIEW', requirements, unknowns: [], facts: [], plan, trace,
      missingPlanFiles: [
        { file: 'backend:entities/campaign.entity.ts', suggestion: 'backend:entities/campaign.schema.ts', dirExists: true },
        { file: 'backend:modules/uploads/x.ts', dirExists: false },
        { file: 'src/new-thing.ts', dirExists: true },
      ],
    });
    expect(out.map((f) => `${f.severity} ${f.where}`)).toEqual(['HIGH backend:entities/campaign.entity.ts', 'MEDIUM backend:modules/uploads/x.ts']);
  });
});
