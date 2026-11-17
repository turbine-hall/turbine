/**
 * Phase 2 — real evidence: implementation is captured from git, checks really run in the
 * worktree, AI review is grounded in the diff, and multi-repo tasks bind to every repo.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// Same module instance the engine resolves (workspace package → dist).
import { registerModel, type ModelAdapter } from '../../packages/models/dist/index.js';
import { openContext } from '../../apps/cli/src/engine/project.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { packetPaths } from '../../apps/cli/src/engine/packet.js';
import { cleanup, commitIn, git, makeRepo, tempProject } from './fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

const AC = [{ id: 'ac_1', statement: 'User can upload a spreadsheet', kind: 'behavioral' as const, status: 'confirmed' as const }];

async function toRequirementsApproved(engine: Engine) {
  const work = engine.createTask({ title: 'Upload sources', text: '# Upload\n\nUsers upload a spreadsheet.', type: 'feature' });
  await engine.assess(work.id);
  engine.editRequirements(work.id, { acceptanceCriteria: AC, unknowns: [] });
  const spec = engine.ctx.store.getLatestArtifact(work.id, 'specification')!;
  engine.approveRequirements(work.id, spec.contentHash, 'pm');
  return engine.ctx.store.getWork(work.id);
}

async function approvePlan(engine: Engine, id: string) {
  await engine.plan(id);
  const plan = engine.ctx.store.getLatestArtifact(id, 'plan')!;
  engine.approvePlan(id, plan.contentHash, 'lead');
}

async function toImplementing(engine: Engine) {
  const work = await toRequirementsApproved(engine);
  await approvePlan(engine, work.id);
  const executed = await engine.execute(work.id);
  return { id: work.id, wt: executed.result.worktreePath!, executed };
}

describe('G3: implementation is captured from git', () => {
  it('execute writes nothing into the worktree and the change report is computed from git', async () => {
    const dir = tempProject('turbine-p2-', dirs);
    const engine = new Engine(openContext(dir));
    const { id, wt } = await toImplementing(engine);
    expect(git(wt, 'status', '--porcelain').stdout.trim()).toBe(''); // clean: no handoff file
    commitIn(wt, 'src/upload.js', 'export const upload = () => 1;\n');
    await engine.syncFromMarkdown(id);
    const report = readFileSync(packetPaths(dir, id).changeReport, 'utf8');
    expect(report).toContain('`src/upload.js`');
    expect(report).toContain('nothing in this section is written by an AI');
    expect(report).toContain('Test files changed: **none**');
    engine.ctx.store.close();
  });

  it('approving code review is refused while the worktree has uncommitted changes', async () => {
    const engine = new Engine(openContext(tempProject('turbine-p2-', dirs)));
    const { id, wt } = await toImplementing(engine);
    commitIn(wt, 'a.js');
    await engine.syncFromMarkdown(id);
    await engine.aiReview(id);
    writeFileSync(join(wt, 'a.js'), 'changed but not committed\n');
    expect(() => engine.pendingApproval(id)).toThrow(/Uncommitted changes/);
    engine.ctx.store.close();
  });
});

describe('G4: checks really run, in the worktree', () => {
  it('blocks verification when no checks are configured', async () => {
    const engine = new Engine(openContext(tempProject('turbine-p2-', dirs, [])));
    const { id, wt } = await toImplementing(engine);
    const head = commitIn(wt, 'a.js');
    await engine.syncFromMarkdown(id);
    await engine.aiReview(id);
    engine.humanReview(id, 'dev', 'approve', undefined, { commit: head });
    await expect(engine.verify(id)).rejects.toThrow(/No quality checks configured/);
    expect(engine.ctx.store.getWork(id).currentState).toBe('VERIFYING');
    expect(engine.ctx.store.listEvidence(id).filter((e) => e.kind === 'unit' || e.kind === 'lint')).toHaveLength(0);
    engine.ctx.store.close();
  });

  it('a failing check (only failing inside the worktree) requests changes; a fix passes', async () => {
    const dir = tempProject('turbine-p2-', dirs);
    const engine = new Engine(openContext(dir));
    const { id, wt } = await toImplementing(engine);
    // LINT_FAIL exists only on the task branch → proves checks run in the worktree, not the main checkout
    const head = commitIn(wt, 'LINT_FAIL');
    await engine.syncFromMarkdown(id);
    await engine.aiReview(id);
    engine.humanReview(id, 'dev', 'approve', undefined, { commit: head });
    const v = await engine.verify(id);
    expect(v.failed).toBe(true);
    expect(v.work.currentState).toBe('CHANGES_REQUESTED');
    const results = engine.ctx.store.listEvidence(id).filter((e) => e.commitSha === head).map((e) => `${e.kind}=${e.result}`);
    expect(results).toEqual(expect.arrayContaining(['lint=failed', 'unit=passed']));
    expect(readFileSync(packetPaths(dir, id).verify, 'utf8')).toMatch(/Output: .*node lint\.mjs/);

    // Fix: remove the file, commit; CHANGES_REQUESTED → IMPLEMENTING (same worktree) → captured
    git(wt, 'rm', '-q', 'LINT_FAIL');
    git(wt, 'commit', '-qm', 'fix lint');
    const fixed = git(wt, 'rev-parse', 'HEAD').stdout.trim();
    expect((await engine.syncFromMarkdown(id)).work.currentState).toBe('IMPLEMENTING');
    expect((await engine.syncFromMarkdown(id)).work.currentState).toBe('AI_REVIEW');
    await engine.aiReview(id);
    engine.humanReview(id, 'dev', 'approve', undefined, { commit: fixed });
    const v2 = await engine.verify(id);
    expect(v2.failed).toBe(false);
    const gate = engine.gateDecision(id);
    expect(gate.blocking.map((b) => b.id)).toEqual(['obl_manual_sqa']);
    engine.ctx.store.close();
  });
});

describe('G9: AI review is grounded in the diff', () => {
  it('discards uncited / invented findings and flags false claims (the LinkedIn review failure)', async () => {
    const dir = tempProject('turbine-p2-', dirs);
    const engine = new Engine(openContext(dir));
    const liar: ModelAdapter = {
      id: 'liar-reviewer',
      provider: 'mock',
      capabilities: { text: true, structuredOutput: true, toolCalling: false },
      async run(req) {
        if (req.schemaId !== 'review') return { content: {} };
        return {
          content: {
            findings: [
              { severity: 'low', claim: 'The implementation plan addresses all acceptance criteria' },
              { severity: 'high', claim: 'Unsafe parsing in the PDF parser', file: 'src/pdf.js' },
              { severity: 'high', claim: 'Uses eval', file: 'src/upload.js', quote: 'eval(input)' },
              { severity: 'medium', claim: 'No size limit on upload', file: 'src/upload.js', quote: 'export const upload = (f) => parse(f);' },
            ],
            claims: { dependenciesAdded: ['multer', 'xlsx', 'pdf-parse'], testFilesChanged: ['test/upload.test.mjs'] },
            summary: 'Comprehensive tests were added.',
          },
        };
      },
    };
    registerModel(liar);
    engine.ctx.config.models.profiles.analysis = { provider: 'mock', model: 'liar-reviewer', maxOutputTokens: 4000 };

    const { id, wt } = await toImplementing(engine);
    commitIn(wt, 'src/upload.js', 'export const upload = (f) => parse(f);\n');
    writeFileSync(join(wt, 'package.json'), JSON.stringify({ name: 'x', dependencies: { xlsx: '0.18.5', multer: '2.0.0' } }));
    git(wt, 'add', 'package.json');
    git(wt, 'commit', '-qm', 'deps');
    await engine.syncFromMarkdown(id);
    const { review } = await engine.aiReview(id);

    expect(review.findings.map((f) => f.claim)).toEqual(['No size limit on upload', 'No size limit on upload', 'No size limit on upload']);
    expect(review.lenses).toEqual(['spec-compliance', 'tests', 'security']); // new deps → security lens
    const reasons = review.discarded.map((d) => d.reason);
    expect(reasons).toEqual(
      expect.arrayContaining(['no changed file cited', 'cited file is not part of this change', 'quoted code does not appear in the diff']),
    );
    expect(review.claimMismatches.map((m) => m.claim)).toEqual([
      'adds dependency "pdf-parse"',
      'test file "test/upload.test.mjs" changed',
    ]);
    expect(review.disposition).toBe('needs-attention');
    const ev = engine.ctx.store.listEvidence(id).find((e) => e.kind === 'review')!;
    expect(ev.result).toBe('failed');
    const md = readFileSync(packetPaths(dir, id).review, 'utf8');
    expect(md).toContain('The AI said things git does not support');
    expect(md).toContain('adds dependency "pdf-parse"');
    expect(md).not.toContain('```json');
    engine.ctx.store.close();
  });
});

describe('G10: multi-repo tasks', () => {
  it('binds approvals and checks to every repo; a backend commit makes the review stale', async () => {
    const dir = tempProject('turbine-p2-', dirs);
    const backend = makeRepo('turbine-backend-', dirs);
    const engine = new Engine(openContext(dir));
    const work = await toRequirementsApproved(engine);
    engine.addRepository(work.id, { path: backend, name: 'backend', checks: ['node lint.mjs'] });
    await approvePlan(engine, work.id);
    expect(() => engine.addRepository(work.id, { path: makeRepo('turbine-other-', dirs) })).toThrow(/changes the approved scope/);

    const executed = await engine.execute(work.id);
    const repos = executed.result.repos;
    expect(repos.map((r) => r.name)).toEqual([expect.any(String), 'backend']);
    const backendWt = repos[1]!.worktreePath;
    expect(existsSync(backendWt)).toBe(true);
    expect(git(backend, 'branch', '--list', `turbine/${work.id}`).stdout).toContain(`turbine/${work.id}`);

    // Only the backend changes: still counts as implementation
    commitIn(backendWt, 'src/extract.js', 'export const extract = () => [];\n');
    expect((await engine.syncFromMarkdown(work.id)).work.currentState).toBe('AI_REVIEW');
    await engine.aiReview(work.id);
    const pending = engine.pendingApproval(work.id);
    expect(pending.subject).toHaveLength(40); // change-set id over both repos
    engine.decide(work.id, { action: 'approve', reviewer: 'dev', confirmToken: pending.confirmToken, presence: 'test' });

    const v = await engine.verify(work.id);
    expect(v.failed).toBe(false);
    expect(v.runs.map((r) => `${r.repo}:${r.command}`)).toEqual(
      expect.arrayContaining(['backend:node lint.mjs', expect.stringMatching(/:node --test$/)]),
    );

    // A later commit in the backend only → detected, review/checks become stale
    commitIn(backendWt, 'src/extract.js', 'export const extract = () => [1];\n');
    const res = await engine.syncFromMarkdown(work.id);
    expect(res.action).toBe('code.changed');
    expect(res.work.currentState).toBe('AI_REVIEW');
    const blocking = engine.gateDecision(work.id).blocking.map((b) => b.id);
    expect(blocking).toEqual(expect.arrayContaining(['obl_code_review', 'obl_automated_checks']));
    engine.ctx.store.close();
  });
});
