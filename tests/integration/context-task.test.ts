/**
 * Issue #8 — repository context, layer 3: task context (CONTEXT.md).
 *
 * One describe block per acceptance criterion, plus planted traps: an import that exists only in an
 * uncommitted file, a reason edited to say something false, a hand-edited generated block, a moved base
 * commit and a CHANGES_REQUESTED re-entry.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_BUDGET,
  parseTaskContext,
  type RelevantFile,
  type TaskContext,
  type WorkPackage,
} from '../../packages/contracts/dist/index.js';
import { contextBudgetFor, loadRoles } from '../../packages/core/dist/index.js';
import { createMockModelAdapter, registerModel, type ModelAdapter } from '../../packages/models/dist/index.js';
import type { WorkStore } from '../../packages/storage-sqlite/dist/index.js';
import { openContext } from '../../apps/cli/src/engine/project.js';
import { Engine } from '../../apps/cli/src/engine/engine.js';
import { packetPaths } from '../../apps/cli/src/engine/packet.js';
import { computeNextStep } from '../../apps/cli/src/engine/next-step.js';
import { scanModule } from '../../apps/cli/src/engine/context/js-scan.js';
import { applyBudget, rankFiles, verifyRelevantFiles, type VerifyInput } from '../../apps/cli/src/engine/context/relevance.js';
import { makeResolver, modeOf } from '../../apps/cli/src/engine/context/import-graph.js';
import { buildTaskContext } from '../../apps/cli/src/engine/context/task-context.js';
import {
  NOTES_LABEL,
  lintContextFile,
  lintTaskContexts,
  parseContextFile,
  renderContextBody,
  renderFileEntry,
} from '../../apps/cli/src/engine/context/task-render.js';
import { cleanup, commitIn, git, tempProject } from './fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const factory = resolve(here, '../..');
const dirs: string[] = [];
const stores: WorkStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  cleanup(dirs);
});

const head = (dir: string): string => git(dir, 'rev-parse', 'HEAD').stdout.trim();

/** Write and commit several files at once (null deletes a file). */
function commitFiles(dir: string, files: Record<string, string | null>, msg = 'change'): string {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) {
      git(dir, 'rm', '-q', '-f', file);
      continue;
    }
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
    git(dir, 'add', file);
  }
  git(dir, 'commit', '-qm', msg);
  return head(dir);
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

const FILES: Record<string, string> = {
  'package.json': json({ name: 'leave-app', version: '1.0.0', private: true, workspaces: ['packages/*'], scripts: { test: 'vitest run' } }),
  'packages/shared/package.json': json({ name: '@leave/shared', version: '1.0.0', main: 'src/index.ts' }),
  'packages/shared/src/index.ts': 'export const SHARED_LIMIT = 30;\n',
  'src/leave/export-csv.ts':
    "import { formatRow } from './format.js';\nimport { SHARED_LIMIT } from '@leave/shared';\n\nexport function exportLeaveCsv(rows: string[][]): string {\n  return rows.slice(0, SHARED_LIMIT).map(formatRow).join('\\n');\n}\n",
  'src/leave/format.ts': 'export function formatRow(row: string[]): string {\n  return row.join(",");\n}\n',
  'src/leave/format.test.ts': "describe('row formatting', () => {});\n",
  'src/leave/service.ts': "import { exportLeaveCsv } from './export-csv.js';\n\nexport function runExport(): string {\n  return exportLeaveCsv([]);\n}\n",
  'tests/leave/export-csv.test.ts': "import { exportLeaveCsv } from '../../src/leave/export-csv.js';\nvoid exportLeaveCsv;\n",
  'src/unrelated/thing.ts': 'export const unrelated = 1;\n',
  CODEOWNERS: '/src/leave/ @leave-team\n',
};

const TITLE = 'Export leave requests as CSV';
const TEXT = '# Export leave requests as CSV\n\nManagers need an export button. The change belongs in src/leave/export-csv.ts and it should reuse `formatRow`.\n';

function project(extra: Record<string, string | null> = {}): string {
  const dir = tempProject('turbine-ctx3-', dirs);
  commitFiles(dir, { ...FILES, ...extra }, 'app');
  return dir;
}

function engineFor(dir: string): Engine {
  const engine = new Engine(openContext(dir));
  stores.push(engine.ctx.store);
  return engine;
}

const newTask = (engine: Engine) => engine.createTask({ title: TITLE, text: TEXT, type: 'feature' });

async function assessed(engine: Engine): Promise<WorkPackage> {
  const t = newTask(engine);
  await engine.assess(t.id);
  return engine.ctx.store.getWork(t.id);
}

const AC = (statement: string) => [{ id: 'ac_1', statement, kind: 'behavioral' as const, status: 'confirmed' as const }];

async function toRequirementsApproved(engine: Engine): Promise<WorkPackage> {
  const work = await assessed(engine);
  engine.editRequirements(work.id, { acceptanceCriteria: AC('Managers can export leave requests as CSV'), unknowns: [] });
  const spec = engine.ctx.store.getLatestArtifact(work.id, 'specification')!;
  engine.approveRequirements(work.id, spec.contentHash, 'tester');
  return engine.ctx.store.getWork(work.id);
}

async function toPlanApproved(engine: Engine): Promise<WorkPackage> {
  const work = await toRequirementsApproved(engine);
  await engine.plan(work.id);
  const plan = engine.ctx.store.getLatestArtifact(work.id, 'plan')!;
  engine.approvePlan(work.id, plan.contentHash, 'tester');
  return engine.ctx.store.getWork(work.id);
}

/** PLAN_APPROVED → implement in the worktree → AI review → human review requests changes → CHANGES_REQUESTED. */
async function toChangesRequested(engine: Engine): Promise<WorkPackage> {
  const work = await toPlanApproved(engine);
  const executed = await engine.execute(work.id);
  const commit = commitIn(executed.result.worktreePath!, 'feature.txt');
  await engine.syncFromMarkdown(work.id);
  await engine.aiReview(work.id);
  engine.humanReview(work.id, 'tester', 'request-changes', 'needs another look', { commit });
  return engine.ctx.store.getWork(work.id);
}

const requestOf = (engine: Engine, work: WorkPackage): string =>
  (engine as unknown as { requestTextOf(w: WorkPackage): string }).requestTextOf(work);

function storedContext(engine: Engine, workId: string): TaskContext {
  const art = engine.ctx.store.getLatestArtifact(workId, 'repo-context');
  if (!art) throw new Error('no repo-context artifact');
  const sel = parseTaskContext(engine.ctx.store.getArtifactContent(art.id));
  if (!sel) throw new Error('repo-context artifact does not parse');
  return sel;
}

const contextArtifacts = (engine: Engine, workId: string) => engine.ctx.store.listArtifacts(workId).filter((a) => a.type === 'repo-context');
const read = (path: string) => readFileSync(path, 'utf8');
const fileOf = (sel: TaskContext, path: string) => sel.files.find((f) => f.path === path);

/** The commit's own data, read with plain git (not with the code under test). */
function verifyInput(dir: string, commit: string, request: string): VerifyInput {
  const listing = git(dir, 'ls-tree', '-r', '-l', commit).stdout.trim().split('\n');
  const files = listing.map((l) => {
    const m = /^(\d+) blob (\S+)\s+(\d+|-)\t(.*)$/.exec(l)!;
    return { path: m[4]!, size: Number(m[3]) };
  });
  const cache = new Map<string, string | undefined>();
  const text = (p: string) => {
    if (!cache.has(p)) {
      const r = git(dir, 'show', `${commit}:${p}`);
      cache.set(p, r.status === 0 ? r.stdout : undefined);
    }
    return cache.get(p);
  };
  return {
    request,
    files,
    text,
    workspaces: [
      { dir: '.', name: 'leave-app' },
      { dir: 'packages/shared', name: '@leave/shared' },
    ],
  };
}

/** A selection that was built, then looked at through plain git. */
async function selectionOf(dir: string): Promise<{ engine: Engine; work: WorkPackage; sel: TaskContext; input: VerifyInput }> {
  const engine = engineFor(dir);
  const work = await assessed(engine);
  const sel = storedContext(engine, work.id);
  return { engine, work, sel, input: verifyInput(dir, sel.snapshot.commit, requestOf(engine, work)) };
}

// =================================================================== criterion (a)

describe('criterion a — every listed file has a reason that can be re-checked at the recorded commit', () => {
  it('assess builds the selection from the commit; every reason re-derives from the blobs (checked with plain git)', async () => {
    const dir = project();
    const { sel, input } = await selectionOf(dir);
    expect(sel.snapshot.commit).toBe(head(dir));
    expect(sel.files.length).toBeGreaterThan(3);
    for (const f of sel.files) expect(f.reasons.length, f.path).toBeGreaterThan(0);
    expect(verifyRelevantFiles(sel.files, input)).toEqual([]);
    expect(verifyRelevantFiles(sel.omitted, input)).toEqual([]);

    // Independently of the verifier: every import edge is a statement at that line of that blob.
    let edges = 0;
    for (const f of sel.files) {
      for (const r of f.reasons) {
        if (r.kind !== 'imports' && r.kind !== 'imported-by' && !(r.kind === 'test-for' && r.edge)) continue;
        const edge = r.kind === 'test-for' ? r.edge! : r.edge;
        const blob = git(dir, 'show', `${sel.snapshot.commit}:${edge.from}`).stdout.split('\n');
        expect(blob[edge.line - 1], `${edge.from}:${edge.line}`).toContain(edge.statement.split('\n')[0]!);
        expect(edge.statement).toContain(edge.specifier);
        edges++;
      }
    }
    expect(edges).toBeGreaterThan(2);
  });

  it('the request is quoted exactly: "named in request" and symbol reasons point at real text of the request', async () => {
    const dir = project();
    const { engine, work, sel } = await selectionOf(dir);
    const request = requestOf(engine, work);
    expect(request).toContain(TEXT.trim());
    const named = fileOf(sel, 'src/leave/export-csv.ts')!;
    const quote = named.reasons.find((r) => r.kind === 'named-in-request')!;
    expect(quote).toMatchObject({ kind: 'named-in-request', rule: 'exact-path', quote: 'src/leave/export-csv.ts', sharedBy: 1, points: 100 });
    if (quote.kind === 'named-in-request') expect(request.slice(quote.offset, quote.offset + quote.quote.length)).toBe('src/leave/export-csv.ts');
    const symbol = fileOf(sel, 'src/leave/format.ts')!.reasons.find((r) => r.kind === 'exports-symbol')!;
    expect(symbol).toMatchObject({ kind: 'exports-symbol', symbol: 'formatRow', rule: 'distinctive-name', quote: 'formatRow' });
    if (symbol.kind === 'exports-symbol') {
      expect(request.slice(symbol.offset, symbol.offset + symbol.quote.length)).toBe('formatRow');
      expect(symbol.statement).toContain('export function formatRow');
    }
  });

  it('the six signals each give reasons, strongest first (named > symbol > one hop > test > owner > path words)', async () => {
    const dir = project();
    const { sel } = await selectionOf(dir);
    const all = sel.files.flatMap((f) => f.reasons);
    for (const k of ['named-in-request', 'exports-symbol', 'imports', 'imported-by', 'test-for'] as const) {
      expect(
        all.some((r) => r.kind === k),
        k,
      ).toBe(true);
    }
    // 1. a path named in the request
    expect(sel.files[0]!.path).toBe('src/leave/export-csv.ts');
    // 2. an exported symbol the request mentions
    expect(fileOf(sel, 'src/leave/format.ts')).toBeDefined();
    // 3. one hop, relative and workspace package
    // service.ts imports the seed (kind "imports": this file imports the seed); the seed imports shared (kind "imported-by")
    const service = fileOf(sel, 'src/leave/service.ts')!;
    expect(service.reasons[0]).toMatchObject({ kind: 'imports', seed: 'src/leave/export-csv.ts', points: 30 });
    expect(service.score).toBe(35); // 30 for the import, 5 for sharing the package of a named file; CODEOWNERS adds 0
    const shared = fileOf(sel, 'packages/shared/src/index.ts')!;
    const viaPackage = shared.reasons.find((r) => r.kind === 'imported-by');
    expect(viaPackage).toMatchObject({ kind: 'imported-by', seed: 'src/leave/export-csv.ts' });
    if (viaPackage?.kind === 'imported-by') expect(viaPackage.edge.resolution).toContain('workspace package "@leave/shared"');
    // 4. related tests: by import and by naming rule, each stating the rule
    const byImport = fileOf(sel, 'tests/leave/export-csv.test.ts')!.reasons.find((r) => r.kind === 'test-for');
    expect(byImport).toMatchObject({ kind: 'test-for', rule: 'imports', subject: 'src/leave/export-csv.ts', points: 25 });
    const byName = fileOf(sel, 'src/leave/format.test.ts')!.reasons.find((r) => r.kind === 'test-for');
    expect(byName).toMatchObject({ kind: 'test-for', rule: 'naming', subject: 'src/leave/format.ts', points: 20 });
    // 5. owning package and CODEOWNERS
    expect(all.some((r) => r.kind === 'owner' || r.kind === 'owner-manifest')).toBe(true);
    // 6. the old IDF path match is the weakest signal: at most 4 points, below every other signal
    for (const r of all) if (r.kind === 'path-words') expect(r.points).toBeLessThanOrEqual(4);
    // best first
    const scores = sel.files.map((f) => f.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    // the rendered text carries the evidence of each reason
    const body = renderContextBody(sel, { title: TITLE, workId: 'w', stale: [] });
    expect(body).toContain('named in request: “src/leave/export-csv.ts” (exact path)');
    expect(body).toContain('imports');
    expect(body).toContain('test for `src/leave/export-csv.ts`: it imports it');
    expect(body).toContain('a path is a test if its file name is *.test.* or *.spec.*');
    expect(body).toContain('workspace package "@leave/shared"');
  });

  it('a plain word is not a symbol: only a distinctive name, or one written as code, counts', () => {
    const files = [{ path: 'src/a.ts', size: 40 }];
    const text = (p: string) => (p === 'src/a.ts' ? 'export function render() {}\nexport function renderInvoiceTotals() {}\n' : undefined);
    const rank = (request: string) => rankFiles({ request, files, text, workspaces: [], notScanned: { tooLarge: 0, overCap: 0 } }).ranked;
    expect(rank('we should render the page')).toEqual([]); // "render" is an ordinary word
    expect(rank('call `render` once')[0]!.reasons[0]).toMatchObject({ kind: 'exports-symbol', symbol: 'render', rule: 'code-span' });
    expect(rank('call render() once')[0]!.reasons[0]).toMatchObject({ kind: 'exports-symbol', symbol: 'render', rule: 'code-span' });
    expect(rank('fix renderInvoiceTotals rounding')[0]!.reasons[0]).toMatchObject({ kind: 'exports-symbol', symbol: 'renderInvoiceTotals', rule: 'distinctive-name' });
  });

  it('a file with no reason is not listed (an unrelated file never appears)', async () => {
    const dir = project();
    const { sel } = await selectionOf(dir);
    expect(fileOf(sel, 'src/unrelated/thing.ts')).toBeUndefined();
    expect(sel.omitted.find((f) => f.path === 'src/unrelated/thing.ts')).toBeUndefined();
    const rank = (request: string) => {
      const input = verifyInput(dir, head(dir), request);
      return rankFiles({ ...input, notScanned: { tooLarge: 0, overCap: 0 } }).ranked;
    };
    expect(rank('Nothing here points anywhere.')).toEqual([]);
  });

  it('PLANTED FALSE REASON: an import that exists only in an uncommitted file never appears; committing it makes it appear', async () => {
    const dir = project();
    const engine = engineFor(dir);
    // Uncommitted: a new file, and an edit of a committed file. Both import the file the request names.
    writeFileSync(join(dir, 'src/leave/draft.ts'), "import { exportLeaveCsv } from './export-csv.js';\nexport const draft = exportLeaveCsv;\n");
    writeFileSync(join(dir, 'src/unrelated/thing.ts'), "import { exportLeaveCsv } from '../leave/export-csv.js';\nexport const unrelated = exportLeaveCsv;\n");
    const work = await assessed(engine);
    const sel = storedContext(engine, work.id);
    const everything = JSON.stringify([sel.files, sel.omitted]);
    expect(everything).not.toContain('draft.ts');
    expect(fileOf(sel, 'src/unrelated/thing.ts')).toBeUndefined();
    expect(sel.omitted.some((f) => f.path === 'src/unrelated/thing.ts')).toBe(false);
    expect(read(packetPaths(dir, work.id).context)).not.toContain('draft.ts');
    expect(read(join(packetPaths(dir, work.id).evidenceDir, 'context.json'))).not.toContain('draft.ts');
    expect(verifyRelevantFiles(sel.files, verifyInput(dir, sel.snapshot.commit, requestOf(engine, work)))).toEqual([]);

    // Commit them: the same statements are now readable at the recorded commit, so the reasons appear.
    commitFiles(dir, {
      'src/leave/draft.ts': read(join(dir, 'src/leave/draft.ts')),
      'src/unrelated/thing.ts': read(join(dir, 'src/unrelated/thing.ts')),
    });
    const rebuilt = (engine.ensureTaskContext(engine.ctx.store.getWork(work.id)) as { selection: TaskContext }).selection;
    expect(rebuilt.snapshot.commit).toBe(head(dir));
    const draft = fileOf(rebuilt, 'src/leave/draft.ts')!;
    expect(draft.reasons[0]).toMatchObject({ kind: 'imports', seed: 'src/leave/export-csv.ts', points: 30 });
  });

  it('PLANTED FALSE REASON: a reason edited to say something untrue is rejected by the verifier, one way per kind', async () => {
    const dir = project();
    const { sel, input } = await selectionOf(dir);
    const fresh = (): RelevantFile[] => structuredClone(sel.files);
    const problems = (mutate: (files: RelevantFile[]) => void): string[] => {
      const files = fresh();
      mutate(files);
      return verifyRelevantFiles(files, input);
    };
    const get = (files: RelevantFile[], p: string) => files.find((f) => f.path === p)!;

    // an import edge claimed for a file that does not contain it
    expect(
      problems((fs) => {
        const f = get(fs, 'src/leave/service.ts');
        const r = f.reasons[0]!;
        if (r.kind === 'imports') r.edge = { ...r.edge, from: 'src/unrelated/thing.ts' };
      }).join('\n'),
    ).toMatch(/no such statement at src\/unrelated\/thing\.ts:1/);
    // a line number that is not the statement
    expect(
      problems((fs) => {
        const r = get(fs, 'src/leave/service.ts').reasons[0]!;
        if (r.kind === 'imports') r.edge = { ...r.edge, line: 3 };
      }).join('\n'),
    ).toMatch(/no such statement/);
    // an import of something that is not what the statement resolves to
    expect(
      problems((fs) => {
        const r = get(fs, 'src/leave/service.ts').reasons[0]!;
        if (r.kind === 'imports') r.edge = { ...r.edge, to: 'src/unrelated/thing.ts' };
      }).join('\n'),
    ).toMatch(/does not resolve to src\/unrelated\/thing\.ts/);
    // the edge pointing the other way round than the reason says
    expect(
      problems((fs) => {
        const r = get(fs, 'packages/shared/src/index.ts').reasons[0]!;
        if (r.kind === 'imported-by') r.seed = 'src/leave/service.ts';
      }).join('\n'),
    ).toMatch(/the edge is not src\/leave\/service\.ts → packages\/shared\/src\/index\.ts/);
    // a quote that the request does not contain
    expect(
      problems((fs) => {
        const r = get(fs, 'src/leave/export-csv.ts').reasons.find((x) => x.kind === 'named-in-request')!;
        if (r.kind === 'named-in-request') r.quote = 'src/payroll/run.ts';
      }).join('\n'),
    ).toMatch(/the request does not contain "src\/payroll\/run\.ts"/);
    // a quote that names another file
    expect(
      problems((fs) => {
        const f = get(fs, 'src/leave/format.ts');
        f.reasons = [{ kind: 'named-in-request', points: 100, rule: 'exact-path', quote: 'src/leave/export-csv.ts', offset: requestOffset(input.request, 'src/leave/export-csv.ts'), sharedBy: 1 }];
        f.score = 100;
      }).join('\n'),
    ).toMatch(/does not name this file/);
    // a symbol the file does not export
    expect(
      problems((fs) => {
        const f = get(fs, 'src/leave/export-csv.ts');
        f.reasons.push({ kind: 'exports-symbol', points: 0, symbol: 'formatRow', rule: 'code-span', line: 1, statement: 'export function formatRow', quote: 'formatRow', offset: requestOffset(input.request, 'formatRow') });
      }).join('\n'),
    ).toMatch(/does not export formatRow/);
    // a test claim for a file that is not a test
    expect(
      problems((fs) => {
        const f = get(fs, 'src/leave/service.ts');
        f.reasons = [{ kind: 'test-for', points: 20, rule: 'naming', subject: 'src/leave/export-csv.ts', naming: 'x' }];
        f.score = 20;
      }).join('\n'),
    ).toMatch(/not a test by the stated rule/);
    // no reason at all, an untracked path, and a score that is not the sum of its reasons
    expect(problems((fs) => (get(fs, 'src/leave/service.ts').reasons = [])).join('\n')).toMatch(/listed without a reason/);
    expect(problems((fs) => (get(fs, 'src/leave/service.ts').path = 'src/leave/ghost.ts')).join('\n')).toMatch(/not a tracked file at the commit/);
    expect(problems((fs) => (get(fs, 'src/leave/service.ts').score = 99)).join('\n')).toMatch(/score does not equal the sum/);
  });

  it('a stored selection that has been tampered with does not parse (reasons must carry evidence)', async () => {
    const dir = project();
    const { engine, work } = await selectionOf(dir);
    const art = engine.ctx.store.getLatestArtifact(work.id, 'repo-context')!;
    const raw = JSON.parse(engine.ctx.store.getArtifactContent(art.id)) as { files: Array<{ reasons: unknown[] }> };
    raw.files[0]!.reasons = [];
    expect(parseTaskContext(JSON.stringify(raw))).toBeUndefined();
    raw.files[0]!.reasons = [{ kind: 'named-in-request', points: 1, rule: 'exact-path', quote: 'x', offset: 0, sharedBy: 1, free: 'text' }];
    expect(parseTaskContext(JSON.stringify(raw))).toBeUndefined();
  });

  it('the artifact references the Layer 1 snapshot it was read at', async () => {
    const dir = project();
    const { engine, work, sel } = await selectionOf(dir);
    const art = engine.ctx.store.getLatestArtifact(work.id, 'repo-context')!;
    const snapshot = engine.ctx.store.getLatestSnapshotFor(dir)!;
    expect(sel.snapshot).toEqual({ hash: snapshot.hash, commit: snapshot.commit });
    expect(art.relatedCommit).toBe(snapshot.commit);
    expect(art.type).toBe('repo-context');
    const header = read(packetPaths(dir, work.id).context);
    expect(header).toContain(`snapshot=${snapshot.hash}`);
    expect(header).toContain(`commit=${snapshot.commit}`);
    expect(engine.ctx.store.listEvents(work.id).some((e) => e.type === 'context.selected')).toBe(true);
  });
});

function requestOffset(request: string, needle: string): number {
  const at = request.indexOf(needle);
  if (at < 0) throw new Error(`"${needle}" is not in the request`);
  return at;
}

// =================================================================== criterion (b)

describe('criterion b — the list respects the role size limit; omitted files are listed with their scores', () => {
  async function build(budget: { maxFiles: number; maxChars: number }) {
    const dir = project();
    const engine = engineFor(dir);
    const work = await assessed(engine);
    const built = buildTaskContext(
      dir,
      engine.ctx.store,
      { workId: work.id, request: requestOf(engine, work), budget: { ...budget, source: 'roles', roles: ['backend-developer'] }, changesCycle: 0 },
      'initial',
    );
    if ('unavailable' in built) throw new Error(built.unavailable);
    return { dir, engine, work, sel: built.selection };
  }

  it('maxFiles: lists that many, everything else is omitted with its score and why', async () => {
    const { sel } = await build({ maxFiles: 2, maxChars: 8000 });
    expect(sel.files).toHaveLength(2);
    expect(sel.omittedTotal).toBe(sel.candidates - 2);
    expect(sel.omittedTotal).toBeGreaterThan(0);
    expect(sel.omitted.length).toBe(sel.omittedTotal);
    for (const o of sel.omitted) {
      expect(o.why).toBe('maxFiles');
      expect(o.score).toBeGreaterThan(0);
      expect(o.reasons.length).toBeGreaterThan(0);
      expect(o.score).toBeLessThanOrEqual(Math.min(...sel.files.map((f) => f.score)));
    }
    const body = renderContextBody(sel, { title: TITLE, workId: 'w', stale: [] });
    expect(body).toContain(`## Left out by the size limit (${sel.omittedTotal})`);
    for (const o of sel.omitted) expect(body).toContain(`| \`${o.path}\` | ${o.score} | maxFiles |`);
    expect(body).toContain('Size limit: at most 2 files and 8000 characters');
    expect(body).toContain('largest limit asked for by backend-developer');
  });

  it('maxChars: the rendered list never exceeds the limit', async () => {
    const { sel } = await build({ maxFiles: 50, maxChars: 1500 });
    const used = sel.files.reduce((n, f) => n + renderFileEntry(f).length, 0);
    expect(used).toBeLessThanOrEqual(1500);
    expect(sel.omitted.length).toBeGreaterThan(0);
    expect(sel.omitted.every((o) => o.why === 'maxChars' || o.why === 'maxFiles')).toBe(true);
    expect(sel.omitted[0]!.why).toBe('maxChars');
    // listed + omitted account for every candidate
    expect(sel.files.length + sel.omittedTotal).toBe(sel.candidates);
  });

  it('applyBudget is exact on its own: stops at the first entry that does not fit, and records the rest', () => {
    const f = (path: string, score: number): RelevantFile => ({
      path,
      score,
      reasons: [{ kind: 'path-words', points: score, words: [{ word: 'x', files: 1, of: 2 }], weight: score }],
    });
    const ranked = [f('a', 4), f('b', 3), f('c', 2), f('d', 1)];
    const r = applyBudget(ranked, { maxFiles: 10, maxChars: 500 }, (x) => (x.path === 'c' ? 400 : 100));
    expect(r.files.map((x) => x.path)).toEqual(['a', 'b']);
    expect(r.omitted).toEqual([expect.objectContaining({ path: 'c', score: 2, why: 'maxChars' }), expect.objectContaining({ path: 'd', score: 1, why: 'maxChars' })]);
    expect(r.omittedTotal).toBe(2);
    const capped = applyBudget(ranked, { maxFiles: 1, maxChars: 500 }, () => 1, 2);
    expect(capped.omittedTotal).toBe(3);
    expect(capped.omitted).toHaveLength(2); // the list of omitted files is capped; the count is not
  });

  it('the list is never described as complete; what was left out and how files were chosen are always rendered', async () => {
    const { sel } = await build({ maxFiles: 50, maxChars: 8000 });
    const body = renderContextBody(sel, { title: TITLE, workId: 'w', stale: [] });
    expect(body).toContain('**This is a selection, not a complete list.**');
    expect(body).toContain('## How these files were chosen');
    expect(body).toContain('## Left out by the size limit (0)');
    expect(body).toContain('_Nothing was left out._');
    expect(body).not.toMatch(/all (the )?(relevant|affected) files|complete list of|these are all/i);
    expect(body).toMatch(/Uncommitted changes in the checkout are never read/);
    // the same rendering is what a prompt gets
    const none = renderContextBody({ ...sel, files: [], omitted: [], omittedTotal: 0, candidates: 0 }, { title: TITLE, workId: 'w', stale: [] });
    expect(none).toContain('_No file has a reason for this request. That does not mean none is relevant._');
  });

  it('a role may declare context_budget; it is validated, defaults apply otherwise, and the largest asked for wins', () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-ctx3-roles-'));
    dirs.push(root);
    mkdirSync(join(root, 'roles'));
    const role = (id: string, extra: Record<string, unknown>, inputs = ['repository-context']) =>
      writeFileSync(join(root, 'roles', `${id}.json`), json({ id, version: '0.1.0', responsibility: id, inputs, ...extra }));
    role('small', { context_budget: { maxFiles: 5, maxChars: 2000 } });
    role('large', { context_budget: { maxFiles: 40, maxChars: 4000 } });
    role('blind', { context_budget: { maxFiles: 200, maxChars: 100000 } }, ['work-package']);
    role('plain', {});
    const roles = loadRoles(root);
    const by = (ids: string[]) => contextBudgetFor(roles.filter((r) => ids.includes(r.id)));
    expect(by(['plain'])).toEqual({ ...DEFAULT_CONTEXT_BUDGET, source: 'default', roles: [] });
    expect(by(['small'])).toEqual({ maxFiles: 5, maxChars: 2000, source: 'roles', roles: ['small'] });
    expect(by(['small', 'large', 'plain'])).toEqual({ maxFiles: 40, maxChars: 4000, source: 'roles', roles: ['large', 'small'] });
    expect(by(['blind'])).toEqual({ ...DEFAULT_CONTEXT_BUDGET, source: 'default', roles: [] }); // does not read repository context

    role('broken', { context_budget: { maxFiles: 0, maxChars: 10 } });
    expect(() => loadRoles(root)).toThrow(/roles\/broken\.json: context_budget must be/);
    // every shipped role still loads
    expect(loadRoles(factory).length).toBeGreaterThan(10);
  });

  it('end to end: a role budget in the roles directory limits the stored selection and says who asked for it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-ctx3-factory-'));
    dirs.push(root);
    for (const entry of readdirSync(factory)) {
      if (entry === 'roles' || entry === 'node_modules' || entry === '.git') continue;
      symlinkSync(join(factory, entry), join(root, entry));
    }
    cpSync(join(factory, 'roles'), join(root, 'roles'), { recursive: true });
    for (const f of readdirSync(join(root, 'roles'))) {
      const p = join(root, 'roles', f);
      const r = JSON.parse(read(p)) as { inputs: string[] };
      if (r.inputs.includes('repository-context')) writeFileSync(p, json({ ...r, context_budget: { maxFiles: 2, maxChars: 6000 } }));
    }
    const dir = project();
    const engine = engineFor(dir);
    engine.ctx.factoryRoot = root;
    const work = await toRequirementsApproved(engine);
    // Roles are chosen by the assessment itself, so the selection that went into it used the default limit...
    expect(work.selectedRoles.length).toBeGreaterThan(0);
    expect(storedContext(engine, work.id).budget).toMatchObject({ maxFiles: 20, source: 'default' });
    // ...and the next selection (REQUIREMENTS_APPROVED reads the context) uses the limit of the roles now on the task.
    engine.next(work.id);
    const sel = storedContext(engine, work.id);
    expect(sel.trigger).toBe('budget-changed');
    expect(sel.budget).toMatchObject({ maxFiles: 2, maxChars: 6000, source: 'roles' });
    expect(sel.budget.roles.length).toBeGreaterThan(0);
    expect(sel.files).toHaveLength(2);
    expect(sel.omittedTotal).toBe(sel.candidates - 2);
    expect(read(packetPaths(dir, work.id).context)).toContain(`## Left out by the size limit (${sel.omittedTotal})`);
    expect(read(packetPaths(dir, work.id).context)).toContain('Size limit: at most 2 files and 6000 characters');
  });
});

// =================================================================== criterion (c)

describe('criterion c — the selection is rebuilt before `next` points to it when the base commit moved or the task re-entered CHANGES_REQUESTED', () => {
  it('a new base commit: `next` rebuilds first, records what changed, and the old selection is never served as current', async () => {
    const dir = project();
    const engine = engineFor(dir);
    const work = await toPlanApproved(engine);
    const before = storedContext(engine, work.id);
    const count = contextArtifacts(engine, work.id).length;

    // unchanged checkout: `next` changes nothing
    engine.next(work.id);
    expect(contextArtifacts(engine, work.id)).toHaveLength(count);

    const commit = commitFiles(dir, { 'src/leave/export-csv-extra.ts': "import { formatRow } from './format.js';\nexport const extra = formatRow;\n" });
    expect(commit).not.toBe(before.snapshot.commit);

    // A render alone does not rebuild; it says the file is stale and why.
    engine.render(work.id);
    const paths = packetPaths(dir, work.id);
    expect(read(paths.context)).toContain('STALE — do not rely on this list');
    expect(read(paths.context)).toContain('the base commit has moved since this was built');
    expect(read(paths.context)).not.toContain('Current: built at commit');
    expect(JSON.parse(read(join(paths.evidenceDir, 'context.json')))).toMatchObject({ current: false, stale: ['base-commit-changed'] });

    // `next` rebuilds before it points anywhere.
    const next = engine.next(work.id);
    const after = storedContext(engine, work.id);
    expect(contextArtifacts(engine, work.id)).toHaveLength(count + 1);
    expect(after.snapshot.commit).toBe(commit);
    expect(after.trigger).toBe('base-commit-changed');
    expect(after.snapshot.hash).toBe(engine.ctx.store.getLatestSnapshotFor(dir)!.hash);
    expect(after.snapshot.hash).not.toBe(before.snapshot.hash);
    expect(after.changes).toMatchObject({ fromCommit: before.snapshot.commit, toCommit: commit });
    expect(after.changes!.added.map((x) => x.path)).toContain('src/leave/export-csv-extra.ts');
    expect(next.openFiles).toContain(paths.context);
    const md = read(paths.context);
    expect(md).toContain(`commit=${commit}`);
    expect(md).toContain('Current: built at commit');
    expect(md).not.toContain('STALE');
    expect(md).toContain(`Changes since the previous selection (\`${before.snapshot.commit.slice(0, 8)}\` → \`${commit.slice(0, 8)}\`)`);
    expect(md).toContain('now listed');
    expect(md).toContain('`src/leave/export-csv-extra.ts`');
    expect(JSON.parse(read(join(paths.evidenceDir, 'context.json')))).toMatchObject({ current: true, stale: [] });
    expect(engine.ctx.store.listEvents(work.id).filter((e) => e.type === 'context.selected').at(-1)!.payload).toMatchObject({ trigger: 'base-commit-changed', commit });

    // and a second `next` at the same commit is a no-op
    engine.next(work.id);
    expect(contextArtifacts(engine, work.id)).toHaveLength(count + 1);
  });

  it('re-entering CHANGES_REQUESTED: the stored selection is stale as soon as the task is sent back, and `next` rebuilds it (same commit)', async () => {
    const dir = project();
    const engine = engineFor(dir);
    const work = await toChangesRequested(engine);
    expect(work.currentState).toBe('CHANGES_REQUESTED');
    const paths = packetPaths(dir, work.id);
    const old = storedContext(engine, work.id);
    expect(old.changesCycle).toBe(0);
    expect(engine.ctx.store.listEvents(work.id).filter((e) => e.type === 'task.changes-requested')).toHaveLength(1);

    // What a reader of CONTEXT.md sees before `next`: the file says the selection is out of date.
    const staleMd = read(paths.context);
    expect(staleMd).toContain('STALE — do not rely on this list');
    expect(staleMd).toContain('the task re-entered CHANGES_REQUESTED after this was built');
    expect(staleMd).not.toContain('Current: built at commit');

    const count = contextArtifacts(engine, work.id).length;
    const next = engine.next(work.id);
    const fresh = storedContext(engine, work.id);
    expect(contextArtifacts(engine, work.id)).toHaveLength(count + 1);
    expect(fresh.snapshot.commit).toBe(old.snapshot.commit); // same base commit; still rebuilt
    expect(fresh.trigger).toBe('changes-requested');
    expect(fresh.changesCycle).toBe(1);
    expect(fresh.changes).toMatchObject({ fromCommit: old.snapshot.commit, toCommit: old.snapshot.commit });
    const md = read(paths.context);
    expect(md).toContain('Current: built at commit');
    expect(md).not.toContain('STALE');
    expect(md).toContain('The listed files and their scores are unchanged.');
    expect(next.openFiles).toContain(paths.context);
    expect(next.agentPlaybook[0]).toMatch(/^Read PROJECT\.md and CONTEXT\.md before implementing/);
  });

  it('`execute` and `plan` also rebuild first (a CHANGES_REQUESTED cycle never reads the old selection)', async () => {
    const dir = project();
    const engine = engineFor(dir);
    const work = await toChangesRequested(engine);
    const old = storedContext(engine, work.id);
    await engine.execute(work.id);
    const fresh = storedContext(engine, work.id);
    expect(fresh.trigger).toBe('changes-requested');
    expect(fresh.changesCycle).toBe(old.changesCycle + 1);
    expect(engine.ctx.store.getWork(work.id).currentState).toBe('IMPLEMENTING');
  });

  it('a rebuild that cannot run is stated in CONTEXT.md; the old selection is not left in place as current', async () => {
    const dir = project();
    const engine = engineFor(dir);
    const work = await toPlanApproved(engine);
    const paths = packetPaths(dir, work.id);
    expect(read(paths.context)).toContain('Current: built at commit');
    commitFiles(dir, { 'src/leave/new.ts': 'export const created = true;\n' });
    const id = git(dir, 'rev-parse', 'HEAD:src/leave/new.ts').stdout.trim();
    rmSync(join(dir, '.git', 'objects', id.slice(0, 2), id.slice(2)), { force: true });

    const next = engine.next(work.id); // does not throw: it reports
    const md = read(paths.context);
    expect(md).toContain('No file selection exists: the selection could not be rebuilt');
    expect(md).not.toContain('Current: built at commit');
    expect(md).not.toContain('## Files (');
    expect(next.openFiles).toContain(paths.context);
    // and lint is clean: this is the generated text, not an edit
    expect(lintTaskContexts(dir)).toEqual([]);
  });

  it('a changed size limit or request also rebuilds (a stored selection only stands for the inputs it was built from)', async () => {
    const dir = project();
    const engine = engineFor(dir);
    const work = await toPlanApproved(engine);
    const count = contextArtifacts(engine, work.id).length;
    engine.next(work.id);
    expect(contextArtifacts(engine, work.id)).toHaveLength(count);
    // the request text changed: the selection is for another request
    const source = engine.ctx.store.getLatestArtifact(work.id, 'source')!;
    const sourceText = JSON.parse(engine.ctx.store.getArtifactContent(source.id)) as { text: string };
    expect(sourceText.text).toContain('formatRow');
    const changed = { ...engine.ctx.store.getWork(work.id), title: 'Export leave requests as XLSX' };
    engine.ctx.store.saveWork(changed);
    engine.next(work.id);
    expect(contextArtifacts(engine, work.id)).toHaveLength(count + 1);
    expect(storedContext(engine, work.id).trigger).toBe('request-changed');
  });
});

// =================================================================== criterion (d)

describe('criterion d — agent notes survive re-renders; edits to the generated part are overwritten and reported by `turbine lint`', () => {
  const NOTES = 'I read export-csv.ts.\n\n- the CSV needs a BOM for Excel\n\n<!-- turbine:task-context end -->\nmore text';

  async function withNotes() {
    const dir = project();
    const engine = engineFor(dir);
    const work = await toPlanApproved(engine);
    const paths = packetPaths(dir, work.id);
    writeFileSync(paths.context, `${read(paths.context).replace(/\n+$/, '')}\n\n${NOTES}\n`);
    return { dir, engine, work, paths };
  }

  it('notes are parsed, kept verbatim through every kind of re-render, and labelled as agent notes', async () => {
    const { dir, engine, work, paths } = await withNotes();
    const parsed = parseContextFile(read(paths.context));
    expect(parsed.notes).toContain('the CSV needs a BOM for Excel');
    expect(parsed.problem).toBeUndefined();
    expect(parsed.notes.startsWith('I read export-csv.ts.')).toBe(true);

    engine.render(work.id); // re-render from the store
    engine.next(work.id); // current: no rebuild
    commitFiles(dir, { 'src/leave/other.ts': "import { formatRow } from './format.js';\nexport const o = formatRow;\n" });
    engine.next(work.id); // rebuilt at a new commit
    const md = read(paths.context);
    expect(md).toContain('## Agent notes');
    expect(md).toContain(NOTES_LABEL);
    expect(parseContextFile(md).notes).toBe(NOTES.trim());
    // the notes come after the facts and are never merged into them
    const notesAt = md.search(/^## Agent notes$/m);
    expect(notesAt).toBeGreaterThan(md.indexOf('\n<!-- turbine:task-context end -->\n'));
    expect(md.slice(0, notesAt)).not.toContain('BOM for Excel');
    expect(read(join(paths.evidenceDir, 'context.json'))).not.toContain('BOM for Excel');
    expect(JSON.stringify(storedContext(engine, work.id))).not.toContain('BOM for Excel');
    expect(lintTaskContexts(dir)).toEqual([]);
  });

  it('a hand edit of the generated part is reported by lint, overwritten by the next render, and the notes stay', async () => {
    const { dir, engine, work, paths } = await withNotes();
    expect(lintTaskContexts(dir)).toEqual([]);
    const md = read(paths.context);
    writeFileSync(paths.context, md.replace('## Files (', '- src/fake.ts — score 999\n\n## Files ('));
    const issues = lintTaskContexts(dir);
    expect(issues).toEqual([expect.objectContaining({ level: 'error', file: `.turbine/tasks/${work.id}/CONTEXT.md`, message: expect.stringContaining('edited by hand') })]);
    expect(engine.lintWork(work.id).some((i) => i.level === 'error' && i.file === 'CONTEXT.md' && /edited by hand/.test(i.message))).toBe(true);

    engine.render(work.id);
    const fixed = read(paths.context);
    expect(fixed).not.toContain('src/fake.ts');
    expect(fixed).toBe(md); // regenerated exactly, notes included
    expect(lintTaskContexts(dir)).toEqual([]);
    expect(parseContextFile(fixed).notes).toBe(NOTES.trim());
  });

  it('a damaged or deleted marker is reported; text outside the notes is flagged; nothing is guessed', async () => {
    const { dir, engine, work, paths } = await withNotes();
    const md = read(paths.context);
    writeFileSync(paths.context, md.replace(/^<!-- turbine:task-context begin [^\n]*-->$/m, ''));
    expect(lintTaskContexts(dir)[0]).toMatchObject({ level: 'error', message: expect.stringMatching(/exactly one .*begin.* and one .*end.* marker, found 0 and 1/) });
    engine.render(work.id);
    expect(read(paths.context)).toBe(md);

    writeFileSync(paths.context, md.replace('## Agent notes', 'Some stray text.\n\n## Agent notes'));
    expect(lintContextFile(read(paths.context))).toEqual([expect.objectContaining({ level: 'warning', message: expect.stringContaining('outside the generated part') })]);
    engine.render(work.id);
    expect(read(paths.context)).not.toContain('Some stray text.');

    // a hand edit of the marker's commit or hash is also caught
    const attrs = md.match(/begin snapshot=(\S+) commit=(\S+) content=(\S+) -->/)!;
    writeFileSync(paths.context, md.replace(`content=${attrs[3]}`, `content=sha256:${'0'.repeat(64)}`));
    expect(lintTaskContexts(dir)[0]).toMatchObject({ level: 'error' });
  });

  it('the CLI: `turbine lint` exits 3 on a hand-edited CONTEXT.md and 0 once it is regenerated', async () => {
    const { dir, engine, work, paths } = await withNotes();
    const tsx = join(factory, 'node_modules', '.bin', 'tsx');
    const cli = join(factory, 'apps', 'cli', 'src', 'index.ts');
    const run = (...args: string[]) => spawnSync(tsx, [cli, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, INIT_CWD: dir, PWD: dir } });
    const clean = run('lint');
    expect(clean.stdout).not.toContain('CONTEXT.md');
    const md = read(paths.context);
    writeFileSync(paths.context, md.replace('## Files (', '- src/fake.ts — score 999\n\n## Files ('));
    const bad = run('lint');
    expect(bad.status).toBe(3);
    expect(bad.stdout).toContain(`.turbine/tasks/${work.id}/CONTEXT.md`);
    expect(bad.stdout).toContain('edited by hand');
    engine.render(work.id);
    expect(run('lint').status).toBe(0);
  });
});

// =================================================================== criterion (e)

describe('criterion e — `turbine task next` tells agents to read PROJECT.md and CONTEXT.md before planning and implementing', () => {
  const PLAN_LINE = /^Read PROJECT\.md and CONTEXT\.md before planning\./;
  const IMPL_LINE = /^Read PROJECT\.md and CONTEXT\.md before implementing\./;

  it('REQUIREMENTS_APPROVED, PLAN_APPROVED, IMPLEMENTING and CHANGES_REQUESTED, through the engine', async () => {
    const dir = project();
    const engine = engineFor(dir);
    const work = await toRequirementsApproved(engine);
    const paths = packetPaths(dir, work.id);
    const check = (state: string, line: RegExp) => {
      const w = engine.ctx.store.getWork(work.id);
      expect(w.currentState).toBe(state);
      const step = engine.next(work.id);
      expect(step.openFiles, state).toEqual(expect.arrayContaining([paths.context, paths.projectContext]));
      expect(existsSync(paths.context) && existsSync(paths.projectContext)).toBe(true);
      expect(step.agentPlaybook[0], state).toMatch(line);
      expect(step.agentPlaybook[0], state).toContain('not a complete list');
      return step;
    };
    check('REQUIREMENTS_APPROVED', PLAN_LINE);

    await engine.plan(work.id);
    const plan = engine.ctx.store.getLatestArtifact(work.id, 'plan')!;
    engine.approvePlan(work.id, plan.contentHash, 'tester');
    check('PLAN_APPROVED', IMPL_LINE);

    const executed = await engine.execute(work.id);
    check('IMPLEMENTING', IMPL_LINE);

    const commit = commitIn(executed.result.worktreePath!, 'feature.txt');
    await engine.syncFromMarkdown(work.id);
    await engine.aiReview(work.id);
    engine.humanReview(work.id, 'tester', 'request-changes', 'again', { commit });
    check('CHANGES_REQUESTED', IMPL_LINE);
  });

  it('PLANNING (computed directly) and states that do not read the context', async () => {
    const dir = project();
    const engine = engineFor(dir);
    const work = await toRequirementsApproved(engine);
    const paths = packetPaths(dir, work.id);
    const planning = computeNextStep({ projectRoot: dir, work: { ...work, currentState: 'PLANNING' }, defaultBaseBranch: 'staging' });
    expect(planning.openFiles).toEqual(expect.arrayContaining([paths.context, paths.projectContext]));
    expect(planning.agentPlaybook[0]).toMatch(PLAN_LINE);
    const review = computeNextStep({ projectRoot: dir, work: { ...work, currentState: 'REQUIREMENTS_REVIEW' }, defaultBaseBranch: 'staging' });
    expect(review.agentPlaybook.join('\n')).not.toContain('PROJECT.md and CONTEXT.md');
    // a file that does not exist is never offered to open
    rmSync(paths.context);
    const missing = computeNextStep({ projectRoot: dir, work: { ...work, currentState: 'PLANNING' }, defaultBaseBranch: 'staging' });
    expect(missing.openFiles).not.toContain(paths.context);
    expect(missing.openFiles).toContain(paths.projectContext);
  });

  it('STATUS.md links CONTEXT.md; the CLI `task next` prints both files', async () => {
    const dir = project();
    const engine = engineFor(dir);
    const work = await toPlanApproved(engine);
    const paths = packetPaths(dir, work.id);
    expect(read(paths.status)).toContain('[CONTEXT.md](CONTEXT.md)');
    expect(read(paths.status)).toContain('a selection, not a complete list');
    expect(read(paths.context)).toContain('[PROJECT.md](');
    expect(read(paths.context)).toContain('../context/PROJECT.md');
    expect(existsSync(join(dir, '.turbine', 'context', 'PROJECT.md'))).toBe(true);
    engine.ctx.store.close();

    const tsx = join(factory, 'node_modules', '.bin', 'tsx');
    const cli = join(factory, 'apps', 'cli', 'src', 'index.ts');
    const out = spawnSync(tsx, [cli, 'task', 'next', work.id, '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, INIT_CWD: dir, PWD: dir } });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain('CONTEXT.md');
    expect(out.stdout).toContain('PROJECT.md');
    expect(out.stdout).toContain('Read PROJECT.md and CONTEXT.md before implementing');
  });
});

// =================================================================== prompts

describe('the assess, plan and execute prompts get the rendered context, not the raw JSON dump', () => {
  it('each prompt carries TASK_CONTEXT with reasons, the "selection, not complete" wording and the omitted list', async () => {
    const prompts: Array<{ schemaId: string; prompt: string }> = [];
    const mock = createMockModelAdapter('ctx3-spy');
    const spy: ModelAdapter = {
      ...mock,
      id: 'ctx3-spy',
      async run(req) {
        prompts.push({ schemaId: req.schemaId, prompt: req.prompt });
        return mock.run(req);
      },
    };
    registerModel(spy);
    const dir = project();
    const engine = engineFor(dir);
    engine.ctx.config.models.profiles.analysis = { provider: 'mock', model: 'ctx3-spy', maxOutputTokens: 4000 };
    engine.ctx.config.models.profiles.implementation = { provider: 'mock', model: 'ctx3-spy', maxOutputTokens: 4000 };
    const work = await toPlanApproved(engine);
    await engine.execute(work.id);

    const forSchema = (id: string) => prompts.find((p) => p.schemaId === id)?.prompt ?? '';
    for (const id of ['assessment', 'plan', 'implement']) {
      const prompt = forSchema(id);
      expect(prompt, id).toContain('TASK_CONTEXT');
      expect(prompt, id).toContain('**This is a selection, not a complete list.**');
      expect(prompt, id).toContain('named in request: “src/leave/export-csv.ts” (exact path)');
      expect(prompt, id).toContain('## Left out by the size limit');
      expect(prompt, id).not.toContain('"collectedAt"');
      expect(prompt, id).not.toContain('"relatedFiles"');
      expect(prompt, id).not.toContain('STALE');
    }
    expect(forSchema('assessment')).toContain('## PROJECT_EVIDENCE');
    expect(forSchema('assessment')).toMatch(/- .* \[source: [^\]]+\]/);
    expect(forSchema('plan')).toContain('PROJECT_EVIDENCE (each line ends with its source)');
  });
});

// =================================================================== the scanner

describe('the import scanner states only what it can find at a line of the text', () => {
  const ok = (src: string) => {
    const r = scanModule(src);
    if (!r.ok) throw new Error(r.reason);
    return r;
  };

  it('reads every kind of import and export as a statement with its line and exact text', () => {
    const src = [
      "import a from './a';",
      "import type { T } from './t';",
      "import './side';",
      "export * from './re';",
      "export { x } from './x';",
      "const d = await import('./dyn');",
      "const r = require('./req');",
      'export const alpha = 1;',
      'export function beta() {}',
      'export default class {}',
    ].join('\n');
    const scan = ok(src);
    const byName = Object.fromEntries(scan.imports.map((i) => [i.specifier, i]));
    expect(byName['./a']).toMatchObject({ kind: 'import', line: 1, statement: "import a from './a'" });
    expect(byName['./t']).toMatchObject({ kind: 'import-type', line: 2 });
    expect(byName['./side']).toMatchObject({ kind: 'side-effect', line: 3 });
    expect(byName['./re']).toMatchObject({ kind: 're-export', line: 4 });
    expect(byName['./x']).toMatchObject({ kind: 're-export', line: 5 });
    expect(byName['./dyn']).toMatchObject({ kind: 'dynamic', line: 6 });
    expect(byName['./req']).toMatchObject({ kind: 'require', line: 7 });
    expect(scan.exports.map((e) => e.name)).toEqual(expect.arrayContaining(['alpha', 'beta']));
    expect(scan.exports.find((e) => e.name === 'alpha')).toMatchObject({ line: 8, statement: expect.stringContaining('export const alpha') });
  });

  it('an import inside a comment, string, template or regex literal is never read', () => {
    const src = [
      "// import './in-line-comment';",
      "/* import './in-block-comment'; */",
      "const s = \"import './in-string';\";",
      "const t = `import './in-template';`;",
      "const re = /import '.\\/in-regex'/;",
      "import real from './real';",
    ].join('\n');
    expect(ok(src).imports.map((i) => i.specifier)).toEqual(['./real']);
  });

  it('text that cannot be tokenised exactly states nothing at all', () => {
    for (const src of ["import a from './a';\nconst s = 'unterminated\n", "import a from './a';\n/* never closed", 'const t = `never closed']) {
      const scan = scanModule(src);
      expect(scan.ok).toBe(false);
    }
  });
});

// =================================================================== review follow-ups (PR #11)

describe('review follow-ups (PR #11): every hole a reviewer found stays closed', () => {
  describe('conditional workspace exports are resolved for the way the file imports the package', () => {
    const manifest = (name: string, extra: Record<string, unknown>) => json({ name, version: '1.0.0', ...extra });
    const files = [
      'packages/dual/package.json',
      'packages/dual/esm.mjs',
      'packages/dual/cjs.cjs',
      'packages/same/package.json',
      'packages/same/index.js',
      'packages/ordered/package.json',
      'packages/ordered/i.mjs',
      'packages/ordered/d.js',
      'packages/ordered/c.cjs',
      'packages/hidden/package.json',
      'packages/hidden/old.js',
      'src/a.ts',
    ];
    const texts: Record<string, string> = {
      'packages/dual/package.json': manifest('@w/dual', { exports: { '.': { import: './esm.mjs', require: './cjs.cjs' } } }),
      'packages/same/package.json': manifest('@w/same', { exports: { import: './index.js', require: './index.js' } }),
      'packages/ordered/package.json': manifest('@w/ordered', { exports: { require: './c.cjs', default: './d.js', import: './i.mjs' } }),
      'packages/hidden/package.json': manifest('@w/hidden', { main: 'old.js', exports: { './sub': './sub.js' } }),
    };
    const workspaces = [
      { dir: 'packages/dual', name: '@w/dual' },
      { dir: 'packages/same', name: '@w/same' },
      { dir: 'packages/ordered', name: '@w/ordered' },
      { dir: 'packages/hidden', name: '@w/hidden' },
    ];
    const resolver = () => makeResolver(new Set(files), (p) => texts[p], workspaces);

    it('import and require get their own target; the cache does not mix them', () => {
      const r = resolver();
      expect(r.resolve('src/a.ts', '@w/dual', 'import')).toMatchObject({ to: 'packages/dual/esm.mjs' });
      expect(r.resolve('src/a.ts', '@w/dual', 'require')).toMatchObject({ to: 'packages/dual/cjs.cjs' });
      expect(r.resolve('src/a.ts', '@w/dual', 'import')).toMatchObject({ to: 'packages/dual/esm.mjs', resolution: expect.stringContaining('import condition') });
      expect(r.resolve('src/a.ts', '@w/dual', 'require')).toMatchObject({ resolution: expect.stringContaining('require condition') });
    });

    it('a type-only import (mode not known) states an edge only when both modes agree', () => {
      const r = resolver();
      expect(r.resolve('src/a.ts', '@w/dual', 'unknown')).toEqual({ unresolved: 'package' });
      expect(r.resolve('src/a.ts', '@w/same', 'unknown')).toMatchObject({ to: 'packages/same/index.js' });
      expect(modeOf('require')).toBe('require');
      expect(modeOf('import-type')).toBe('unknown');
      for (const k of ['import', 'side-effect', 're-export', 'dynamic'] as const) expect(modeOf(k)).toBe('import');
    });

    it('conditions are tried in the order the manifest writes them; main is not used when exports exist', () => {
      const r = resolver();
      expect(r.resolve('src/a.ts', '@w/ordered', 'import')).toMatchObject({ to: 'packages/ordered/d.js' }); // "default" comes before "import"
      expect(r.resolve('src/a.ts', '@w/ordered', 'require')).toMatchObject({ to: 'packages/ordered/c.cjs' });
      expect(r.resolve('src/a.ts', '@w/hidden', 'import')).toEqual({ unresolved: 'package' }); // exports hides main
    });

    it('the graph states the edge for the mode of the statement (checked through ranking)', () => {
      const all = [...files, 'src/b.cts'];
      const source: Record<string, string> = {
        ...texts,
        'src/a.ts': "import { x } from '@w/dual';\nexport const a = x;\n",
        'src/b.cts': "const x = require('@w/dual');\nexport const b = x;\n",
      };
      const rank = (request: string) =>
        rankFiles({ request, files: all.map((path) => ({ path, size: 1 })), text: (p) => source[p], workspaces, notScanned: { tooLarge: 0, overCap: 0 } }).ranked;
      const fromA = rank('Change src/a.ts');
      expect(fromA.map((f) => f.path)).toContain('packages/dual/esm.mjs');
      expect(fromA.map((f) => f.path)).not.toContain('packages/dual/cjs.cjs');
      const fromB = rank('Change src/b.cts');
      expect(fromB.map((f) => f.path)).toContain('packages/dual/cjs.cjs');
      expect(fromB.map((f) => f.path)).not.toContain('packages/dual/esm.mjs');
      // and the verifier re-derives each edge in its own mode
      const input = { request: 'Change src/b.cts', files: all.map((path) => ({ path, size: 1 })), text: (p: string) => source[p], workspaces };
      expect(verifyRelevantFiles(fromB, input)).toEqual([]);
    });
  });

  describe('JSX closing tags are not regular expressions', () => {
    const imports = (src: string) => {
      const r = scanModule(src);
      if (!r.ok) throw new Error(r.reason);
      return r.imports.map((i) => i.specifier);
    };

    it('imports after `</div>`, `</>` and `</Foo.Bar>` are still found', () => {
      expect(imports("import a from './a';\nexport const X = () => <div>Hello</div>;\nimport b from './b';\n")).toEqual(['./a', './b']);
      expect(imports("import a from './a';\nexport const Y = () => <><p>one</p><p>two</p></>;\nimport b from './b';\n")).toEqual(['./a', './b']);
      expect(imports("import a from './a';\nexport const Z = () => <Foo.Bar>text</Foo.Bar>;\nimport b from './b';\n")).toEqual(['./a', './b']);
    });

    it('a regular expression inside a JSX expression is still a regular expression, and a division is still a division', () => {
      expect(imports("import a from './a';\nexport const X = (s: string) => <div>{s.replace(/<\\/div>/g, '')}</div>;\nimport b from './b';\n")).toEqual(['./a', './b']);
      expect(imports("import a from './a';\nconst half = (n: number) => n / 2;\nconst r = (n: number) => n < 3 ? n / 2 : 0;\nimport b from './b';\n")).toEqual(['./a', './b']);
    });
  });

  describe('the verifier uses the ranking rule for names in the request, not substring matching', () => {
    const files = ['src/cart.ts', 'src/cart.tsx', 'a/util.ts', 'b/util.ts'].map((path) => ({ path, size: 1 }));
    const request = 'Update cart.tsx and see a/util.ts';
    const input = { request, files, text: () => undefined, workspaces: [] };
    const ranked = () => rankFiles({ ...input, notScanned: { tooLarge: 0, overCap: 0 } }).ranked;

    it('what ranking produced verifies', () => {
      expect(verifyRelevantFiles(ranked(), input)).toEqual([]);
      expect(ranked().map((f) => f.path).sort()).toEqual(['a/util.ts', 'src/cart.tsx']);
    });

    it('a planted reason quoting "cart.ts" out of "cart.tsx" for src/cart.ts is rejected', () => {
      const at = request.indexOf('cart.ts');
      const forged: RelevantFile = {
        path: 'src/cart.ts',
        score: 70,
        reasons: [{ kind: 'named-in-request', points: 70, rule: 'unique-basename', quote: 'cart.ts', offset: at, sharedBy: 1 }],
      };
      expect(request.slice(at, at + 'cart.ts'.length)).toBe('cart.ts'); // it is in the text, as a substring
      expect(verifyRelevantFiles([forged], input).join('\n')).toMatch(/"cart\.ts" does not name this file/);
    });

    it('a wrong ambiguity count, wrong points or a wrong offset is rejected', () => {
      const real = ranked().find((f) => f.path === 'src/cart.tsx')!;
      const tweak = (patch: Partial<Extract<RelevantFile['reasons'][number], { kind: 'named-in-request' }>>): string[] => {
        const f = structuredClone(real);
        Object.assign(f.reasons[0]!, patch);
        f.score = f.reasons.reduce((n, r) => n + r.points, 0);
        return verifyRelevantFiles([f], input);
      };
      expect(tweak({ sharedBy: 2 }).join('\n')).toMatch(/does not name this file/);
      expect(tweak({ points: 100 }).join('\n')).toMatch(/does not name this file/);
      expect(tweak({ rule: 'exact-path' }).join('\n')).toMatch(/does not name this file/);
      expect(tweak({ offset: request.indexOf('cart.tsx') + 1, quote: 'art.tsx' }).join('\n')).toMatch(/does not name this file/);
    });
  });

  describe('assess reads the facts and the file selection at one commit', () => {
    it('HEAD moving once between the two reads: both are read again and agree', async () => {
      const dir = project();
      const engine = engineFor(dir);
      const real = engine.ensureTaskContext.bind(engine);
      let calls = 0;
      engine.ensureTaskContext = (w) => {
        if (calls++ === 0) commitFiles(dir, { 'src/leave/moved.ts': 'export const moved = true;\n' });
        return real(w);
      };
      const t = newTask(engine);
      await engine.assess(t.id);
      expect(calls).toBe(2);
      const sel = storedContext(engine, t.id);
      expect(sel.snapshot.commit).toBe(head(dir));
      expect(engine.ctx.store.getLatestSnapshotFor(dir)!.commit).toBe(sel.snapshot.commit);
      expect(engine.ctx.store.getWork(t.id).currentState).not.toBe('ASSESSING');
    });

    it('HEAD moving every time: the task stops before any model call, and can be retried', async () => {
      const dir = project();
      const engine = engineFor(dir);
      const prompts: string[] = [];
      const mock = createMockModelAdapter('ctx3-pin-spy');
      registerModel({ ...mock, id: 'ctx3-pin-spy', async run(req) { prompts.push(req.schemaId); return mock.run(req); } });
      engine.ctx.config.models.profiles.analysis = { provider: 'mock', model: 'ctx3-pin-spy', maxOutputTokens: 4000 };
      const real = engine.ensureTaskContext.bind(engine);
      let moving = true;
      let n = 0;
      engine.ensureTaskContext = (w) => {
        if (moving) commitFiles(dir, { [`src/leave/moving-${n++}.ts`]: 'export const m = 1;\n' });
        return real(w);
      };
      const t = newTask(engine);
      await expect(engine.assess(t.id)).rejects.toMatchObject({ code: 'E_CONTEXT_UNAVAILABLE' });
      expect(prompts).toEqual([]);
      expect(engine.ctx.store.getWork(t.id).currentState).toBe('ASSESSING');
      moving = false;
      await engine.assess(t.id);
      expect(prompts).toContain('assessment');
      expect(storedContext(engine, t.id).snapshot.commit).toBe(head(dir));
    });
  });

  describe('execute stays retryable when the context cannot be prepared', () => {
    it('a failure refreshing the context leaves the task in PLAN_APPROVED with no worktree; fixing it lets execute run', async () => {
      const dir = project();
      const engine = engineFor(dir);
      const work = await toPlanApproved(engine);
      const paths = packetPaths(dir, work.id);
      // The evidence folder cannot be written: a file stands where the folder belongs.
      rmSync(paths.evidenceDir, { recursive: true, force: true });
      writeFileSync(paths.evidenceDir, 'not a folder');
      // A new commit makes the selection stale, so execute has to rebuild and write.
      commitFiles(dir, { 'src/leave/late.ts': "import { formatRow } from './format.js';\nexport const late = formatRow;\n" });

      await expect(engine.execute(work.id)).rejects.toThrow();
      expect(engine.ctx.store.getWork(work.id).currentState).toBe('PLAN_APPROVED');
      expect(existsSync(join(dir, '.turbine', 'worktrees', work.id))).toBe(false);
      expect(engine.repoStates(work.id)).toEqual([]);

      rmSync(paths.evidenceDir, { force: true });
      const executed = await engine.execute(work.id);
      expect(engine.ctx.store.getWork(work.id).currentState).toBe('IMPLEMENTING');
      expect(existsSync(executed.result.worktreePath!)).toBe(true);
      expect(storedContext(engine, work.id).snapshot.commit).toBe(head(dir));
    });

    it('the same holds when the task was sent back (CHANGES_REQUESTED stays CHANGES_REQUESTED)', async () => {
      const dir = project();
      const engine = engineFor(dir);
      const work = await toChangesRequested(engine);
      const paths = packetPaths(dir, work.id);
      rmSync(paths.evidenceDir, { recursive: true, force: true });
      writeFileSync(paths.evidenceDir, 'not a folder');
      await expect(engine.execute(work.id)).rejects.toThrow();
      expect(engine.ctx.store.getWork(work.id).currentState).toBe('CHANGES_REQUESTED');
      rmSync(paths.evidenceDir, { force: true });
      await engine.execute(work.id);
      expect(engine.ctx.store.getWork(work.id).currentState).toBe('IMPLEMENTING');
    });
  });
});
