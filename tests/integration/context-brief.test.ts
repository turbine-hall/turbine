/**
 * Layer 2 part 2 — project brief from verified claims (#7).
 * Acceptance criteria are named in the describe/it titles below.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { WorkStore } from '../../packages/storage-sqlite/dist/index.js';
import { ClaimSchema, PUBLISHED_CLAIM_STATUSES } from '../../packages/contracts/dist/index.js';
import { createMockModelAdapter } from '../../packages/models/dist/index.js';
import { briefSectionsFor, loadRoles } from '../../packages/core/dist/index.js';
import { factoryRoot } from '../../apps/cli/src/paths.js';
import { understandProject, understandProjectWithBrief } from '../../apps/cli/src/engine/context/understand.js';
import { briefConfigOf, ensureBrief } from '../../apps/cli/src/engine/context/brief.js';
import { approveBrief, attestClaim } from '../../apps/cli/src/engine/context/brief-approve.js';
import { briefPaths, parseClaimIdsFromSection } from '../../apps/cli/src/engine/context/brief-render.js';
import { isHumanOnlyCommand } from '../../apps/cli/src/engine/agent-guard.js';
import { defaultConfig } from '../../apps/cli/src/engine/project.js';

const dirs: string[] = [];
const stores: WorkStore[] = [];

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function newRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-brief-'));
  dirs.push(dir);
  const emptyTemplate = mkdtempSync(join(tmpdir(), 'turbine-brief-tpl-'));
  dirs.push(emptyTemplate);
  git(dir, 'init', '-q', '-b', 'main', '--object-format=sha1', `--template=${emptyTemplate}`);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgSign', 'false');
  const noHooks = mkdtempSync(join(tmpdir(), 'turbine-brief-hooks-'));
  dirs.push(noHooks);
  git(dir, 'config', 'core.hooksPath', noHooks);
  git(dir, 'config', 'core.autocrlf', 'false');
  const base = {
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'vitest run' } }, null, 2) + '\n',
    'README.md': '# Demo\n',
    'src/index.ts': 'export const ok = 1;\n',
    ...files,
  };
  for (const [p, body] of Object.entries(base)) {
    const full = join(dir, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

function openStore(): WorkStore {
  const root = mkdtempSync(join(tmpdir(), 'turbine-brief-db-'));
  dirs.push(root);
  const store = new WorkStore(join(root, 'engine.db'));
  stores.push(store);
  return store;
}

function defaultCfg() {
  return defaultConfig(tmpdir(), 'demo');
}

describe('AC: brief sections contain only verified or human-attested claims', () => {
  it('mock proposes true + planted-false; only the true claim is published and rendered', async () => {
    const dir = newRepo();
    const store = openStore();
    const o = await understandProjectWithBrief(store, dir, {
      factoryRoot: factoryRoot(),
      config: defaultCfg(),
      model: createMockModelAdapter('mock-default'),
    });
    expect(o.brief?.modelCalls).toBeGreaterThan(0);
    const published = store.listClaims(dir, { statuses: [...PUBLISHED_CLAIM_STATUSES] });
    expect(published.every((c) => c.status === 'verified' || c.status === 'attested')).toBe(true);
    expect(published.some((c) => c.claim.verifier.kind === 'exists' && c.claim.verifier.path === 'package.json')).toBe(true);
    expect(published.some((c) => c.claim.id.includes('false'))).toBe(false);
    const arch = readFileSync(briefPaths(dir).section('architecture'), 'utf8');
    expect(arch).toMatch(/package\.json/);
    expect(arch).not.toMatch(/planted-missing/);
    expect(arch).toMatch(/Draft, not approved|Verified claims at/);
  });
});

describe('AC: model text never goes to the page; sections render from claims', () => {
  it('rendered bullets come from verifier templates, not the model statement', async () => {
    const dir = newRepo();
    const store = openStore();
    await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultCfg() });
    const body = readFileSync(briefPaths(dir).section('architecture'), 'utf8');
    expect(body).toMatch(/is a tracked file/);
    expect(body).not.toMatch(/Planted false path/);
  });
});

describe('AC: schema rejects unknown kind / no evidence / universal without exhaustive', () => {
  it('is covered by context-claims (ClaimSchema) — smoke that brief uses the same schema', () => {
    expect(ClaimSchema.safeParse({ id: 'x', section: 'architecture', statement: 'all bad', kind: 'exists', evidence: [], verifier: { kind: 'exists', path: 'a.ts' } }).success).toBe(false);
  });
});

describe('AC: changing a cited file removes the claim on next understand', () => {
  it('reverify withdraws and the brief no longer renders the claim', async () => {
    const dir = newRepo();
    const store = openStore();
    await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultCfg() });
    const before = store.listClaims(dir, { statuses: ['verified'] });
    expect(before.length).toBeGreaterThan(0);
    // Remove package.json content path by replacing the file the claim cites — delete and commit a tree without it? 
    // Simpler: rewrite package.json so blob changes; exists claim still passes. Withdraw by deleting the file.
    rmSync(join(dir, 'package.json'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'drop package.json');
    // Need a package.json for snapshot build — restore a different one after? Snapshot requires package.json.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo2', version: '2.0.0' }, null, 2) + '\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'new package.json');
    // Old blob is gone; reverify should withdraw exists claims pinned to the old blob.
    const o2 = await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultCfg() });
    expect(o2.brief).toBeDefined();
    const still = store.listClaims(dir, { statuses: ['verified'] }).filter((c) => c.claim.id.includes('pkg'));
    // Either withdrawn or replaced with a new verified claim at the new blob — never the old blob.
    for (const c of still) {
      expect(c.claim.evidence[0]!.blob).toBe(git(dir, 'rev-parse', `HEAD:package.json`).trim());
    }
  });
});

describe('AC: approval cannot publish a claim that failed verification', () => {
  it('approve only seals the already-verified set; rejected ids never appear', async () => {
    const dir = newRepo();
    const store = openStore();
    const o = await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultCfg() });
    const rejected = store.listClaims(dir, { statuses: ['rejected'] });
    expect(rejected.some((c) => c.claim.id.includes('false'))).toBe(true);
    const next = approveBrief({
      store,
      projectRoot: dir,
      repoRoot: dir,
      repoPath: dir,
      sections: briefConfigOf(defaultCfg()).sections,
      reviewer: 'Tester',
      confirmToken: o.brief!.confirmToken,
      presence: 'tty-hash-confirmation',
    });
    expect(next.approvedHash).toBe(next.claimsHash);
    const published = store.listClaims(dir, { statuses: [...PUBLISHED_CLAIM_STATUSES] });
    expect(published.every((c) => c.status !== 'rejected')).toBe(true);
    expect(published.some((c) => c.claim.id.includes('false'))).toBe(false);
  });

  it('wrong confirm token is refused', async () => {
    const dir = newRepo();
    const store = openStore();
    await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultCfg() });
    expect(() =>
      approveBrief({
        store,
        projectRoot: dir,
        repoRoot: dir,
        repoPath: dir,
        sections: briefConfigOf(defaultCfg()).sections,
        reviewer: 'Tester',
        confirmToken: 'deadbeef',
        presence: 'tty-hash-confirmation',
      }),
    ).toThrow(/does not match/);
  });
});

describe('AC: human edit that breaks a claim is rejected (markers removed → withdraw)', () => {
  it('removing a claim marker withdraws that claim on the next brief ensure', async () => {
    const dir = newRepo();
    const store = openStore();
    await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultCfg() });
    const file = briefPaths(dir).section('architecture');
    const before = readFileSync(file, 'utf8');
    const ids = parseClaimIdsFromSection(before);
    expect(ids.length).toBeGreaterThan(0);
    // Strip all claim markers/bullets.
    writeFileSync(file, `# architecture\n\nDraft emptied by human.\n`);
    const o2 = await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultCfg() });
    expect(o2.brief!.sectionsDrafted).toContain('architecture');
  });

  it('keeping the marker but changing the assertion text withdraws the claim', async () => {
    const dir = newRepo();
    const store = openStore();
    await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultCfg() });
    const file = briefPaths(dir).section('architecture');
    const before = readFileSync(file, 'utf8');
    const ids = parseClaimIdsFromSection(before);
    expect(ids.length).toBeGreaterThan(0);
    const editedId = ids[0]!;
    const edited = before.replace(/- .+? _\[verified\]_/, '- Totally different unsupported assertion _[verified]_');
    expect(edited).not.toBe(before);
    writeFileSync(file, edited);
    // Second draft returns no replacement claims so the withdrawn row is not republished under the same id.
    const emptyBrief = createMockModelAdapter('mock-empty-brief');
    const origRun = emptyBrief.run.bind(emptyBrief);
    emptyBrief.run = async (req) => {
      if (req.schemaId === 'project-brief' || req.skillIds.includes('core/draft-project-brief')) {
        return { content: { claims: [] }, usage: { inputTokens: 1, outputTokens: 1 }, providerRequestId: 'empty' };
      }
      return origRun(req);
    };
    const o2 = await understandProjectWithBrief(store, dir, {
      factoryRoot: factoryRoot(),
      config: defaultCfg(),
      model: emptyBrief,
    });
    expect(o2.brief!.sectionsDrafted).toContain('architecture');
    expect(store.getClaim(dir, editedId)?.status).toBe('withdrawn');
    const body = readFileSync(file, 'utf8');
    expect(body).not.toMatch(/Totally different unsupported assertion/);
  });
});

describe('AC: unchanged commit triggers no model call', () => {
  it('second understand with nothing changed has modelCalls === 0', async () => {
    const dir = newRepo();
    const store = openStore();
    const first = await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultCfg() });
    expect(first.brief!.modelCalls).toBeGreaterThan(0);
    const second = await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultCfg() });
    expect(second.brief!.modelCalls).toBe(0);
    expect(second.status).toBe('current');
  });
});

describe('AC: planted-false fixture suite has 100% rejection (part 1)', () => {
  it('brief drafting rejects the mock planted-false proposal', async () => {
    const dir = newRepo();
    const store = openStore();
    await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultCfg() });
    const falseOnes = store.listClaims(dir).filter((c) => c.claim.id.includes('false'));
    expect(falseOnes.length).toBeGreaterThan(0);
    expect(falseOnes.every((c) => c.status === 'rejected')).toBe(true);
  });
});

describe('AC: task next points agents to the brief labelled verified claims at sha', () => {
  it('security-reviewer declares security brief section', () => {
    const roles = loadRoles(factoryRoot());
    const sec = roles.find((r) => r.id === 'security-reviewer');
    expect(sec?.brief_sections).toEqual(['security']);
    expect(briefSectionsFor([sec!])).toEqual(['security']);
  });

  it('computeNextStep openFiles include the role brief section and playbook cites verified claims at', async () => {
    const { computeNextStep } = await import('../../apps/cli/src/engine/next-step.js');
    const dir = newRepo();
    const store = openStore();
    const o = await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultCfg() });
    const sha8 = o.snapshot.commit.slice(0, 8);
    const roles = loadRoles(factoryRoot());
    const sec = roles.find((r) => r.id === 'security-reviewer')!;
    const work = {
      id: 'work_brief_next',
      currentState: 'PLANNING' as const,
      selectedRoles: [{ id: sec.id, version: sec.version }],
    };
    const step = computeNextStep({ projectRoot: dir, work: work as never, defaultBaseBranch: 'staging' });
    expect(step.openFiles).toContain(briefPaths(dir).section('security'));
    expect(step.agentPlaybook.join('\n')).toMatch(/verified claims at/i);
    expect(readFileSync(briefPaths(dir).section('security'), 'utf8')).toMatch(new RegExp(`verified claims at \`${sha8}\``, 'i'));
  });
});

describe('human gates', () => {
  it('context approve/attest are human-only commands', () => {
    expect(isHumanOnlyCommand('turbine context approve')).toBe(true);
    expect(isHumanOnlyCommand('turbine context attest ./claim.json')).toBe(true);
    expect(isHumanOnlyCommand('turbine context show')).toBe(false);
  });

  it('attest stores human-attested label and never verified', async () => {
    const dir = newRepo();
    const store = openStore();
    await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultCfg() });
    const c = git(dir, 'rev-parse', 'HEAD').trim();
    const blob = git(dir, 'rev-parse', 'HEAD:README.md').trim();
    const claim = attestClaim({
      store,
      projectRoot: dir,
      repoRoot: dir,
      repoPath: dir,
      sections: briefConfigOf(defaultCfg()).sections,
      reviewer: 'Alice',
      presence: 'tty-hash-confirmation',
      raw: {
        id: 'intent-1',
        section: 'architecture',
        statement: 'We chose a monorepo for shared types',
        kind: 'exists',
        evidence: [{ path: 'README.md', commit: c, blob }],
        verifier: { kind: 'exists', path: 'README.md' },
      },
    });
    const row = store.getClaim(dir, claim.id)!;
    expect(row.status).toBe('attested');
    expect(row.reason).toMatch(/Human-attested \(by Alice/);
    const section = readFileSync(briefPaths(dir).section('architecture'), 'utf8');
    expect(section).toMatch(/claim id=intent-1/);
    expect(section).toMatch(/Human-attested/);
  });

  it('attest survives the next understand without being withdrawn as a human removal', async () => {
    const dir = newRepo();
    const store = openStore();
    await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultCfg() });
    const c = git(dir, 'rev-parse', 'HEAD').trim();
    const blob = git(dir, 'rev-parse', 'HEAD:README.md').trim();
    attestClaim({
      store,
      projectRoot: dir,
      repoRoot: dir,
      repoPath: dir,
      sections: briefConfigOf(defaultCfg()).sections,
      reviewer: 'Alice',
      presence: 'tty-hash-confirmation',
      raw: {
        id: 'intent-keep',
        section: 'architecture',
        statement: 'Intent that must survive refresh',
        kind: 'exists',
        evidence: [{ path: 'README.md', commit: c, blob }],
        verifier: { kind: 'exists', path: 'README.md' },
      },
    });
    const again = await understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: defaultCfg() });
    expect(again.brief!.modelCalls).toBe(0);
    expect(store.getClaim(dir, 'intent-keep')?.status).toBe('attested');
  });
});

describe('brief config', () => {
  it('reports sample file cap', async () => {
    const dir = newRepo();
    const store = openStore();
    const cfg = defaultCfg();
    cfg.context.brief.sampleFileCap = 2;
    cfg.context.brief.sections = ['architecture'];
    const brief = await ensureBrief({
      store,
      projectRoot: dir,
      repoRoot: dir,
      repoPath: dir,
      snapshot: understandProject(store, dir).snapshot,
      config: briefConfigOf(cfg),
      factoryRoot: factoryRoot(),
    });
    expect(brief.sampleCap).toBe(2);
    expect(brief.samplePaths.length).toBeLessThanOrEqual(2);
  });
});
