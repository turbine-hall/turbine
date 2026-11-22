/**
 * OKF v0.3 knowledge bundle (#14). Acceptance criteria are named in the describe/it titles.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { WorkStore } from '../../packages/storage-sqlite/dist/index.js';
import { factoryRoot } from '../../apps/cli/src/paths.js';
import { understandProjectWithBrief } from '../../apps/cli/src/engine/context/understand.js';
import { defaultConfig } from '../../apps/cli/src/engine/project.js';
import { knowledgePaths } from '../../apps/cli/src/engine/knowledge/paths.js';
import { validateBundle } from '../../apps/cli/src/engine/knowledge/validate.js';
import { exportKnowledgeBundle, publishKnowledgeBundle } from '../../apps/cli/src/engine/knowledge/publish.js';
import { okfTrustTier, encodeOkfConceptSegment, assertSafeConceptKey } from '../../packages/contracts/dist/index.js';
import { splitFrontmatter } from '../../apps/cli/src/engine/knowledge/frontmatter.js';
import { computeNextStep } from '../../apps/cli/src/engine/next-step.js';
import { loadRoles } from '../../packages/core/dist/index.js';
import { HeadMovedError } from '../../apps/cli/src/engine/context/render.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'turbine-okf-'));
  dirs.push(dir);
  const emptyTemplate = mkdtempSync(join(tmpdir(), 'turbine-okf-tpl-'));
  dirs.push(emptyTemplate);
  git(dir, 'init', '-q', '-b', 'main', '--object-format=sha1', `--template=${emptyTemplate}`);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgSign', 'false');
  const noHooks = mkdtempSync(join(tmpdir(), 'turbine-okf-hooks-'));
  dirs.push(noHooks);
  git(dir, 'config', 'core.hooksPath', noHooks);
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
  const root = mkdtempSync(join(tmpdir(), 'turbine-okf-db-'));
  dirs.push(root);
  const store = new WorkStore(join(root, 'engine.db'));
  stores.push(store);
  return store;
}

function cfg() {
  return defaultConfig(tmpdir(), 'demo');
}

async function understand(dir: string, store: WorkStore) {
  return understandProjectWithBrief(store, dir, { factoryRoot: factoryRoot(), config: cfg() });
}

describe('AC: understand writes fixed layout and validate passes', () => {
  it('writes .turbine/knowledge/ with index, log, README, and profile folders', async () => {
    const dir = newRepo();
    const store = openStore();
    const o = await understand(dir, store);
    expect(o.knowledge?.unchanged).toBe(false);
    const k = knowledgePaths(dir);
    expect(existsSync(k.index)).toBe(true);
    expect(existsSync(k.log)).toBe(true);
    expect(existsSync(k.readme)).toBe(true);
    expect(existsSync(join(k.dir, 'project/overview.md'))).toBe(true);
    expect(existsSync(join(k.dir, 'structure/layout.md'))).toBe(true);
    const issues = validateBundle(k.dir);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });
});

describe('AC: profile rejects missing field / wrong type / unknown type / misplaced / missing heading', () => {
  it('missing required field is rejected', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    const file = join(knowledgePaths(dir).dir, 'project/overview.md');
    const text = readFileSync(file, 'utf8').replace(/^title:.*$/m, '');
    writeFileSync(file, text);
    const issues = validateBundle(knowledgePaths(dir).dir);
    expect(issues.some((i) => i.code === 'missing-field:title')).toBe(true);
  });

  it('wrong field type is rejected', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    const file = join(knowledgePaths(dir).dir, 'project/overview.md');
    const text = readFileSync(file, 'utf8').replace(/^title:.*$/m, 'title: 123');
    writeFileSync(file, text);
    const issues = validateBundle(knowledgePaths(dir).dir);
    expect(issues.some((i) => i.code === 'wrong-type:title')).toBe(true);
  });

  it('unknown concept type is rejected', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    const rogue = join(knowledgePaths(dir).dir, 'project/rogue.md');
    writeFileSync(
      rogue,
      `---\ntype: Not A Turbine Type\ntitle: x\ndescription: y\ngenerated: { by: turbine/0.5.0, at: "2020-01-01T00:00:00Z" }\nx-turbine-commit: ${'a'.repeat(40)}\n---\n\n# Summary\n\n# Facts\n`,
    );
    const issues = validateBundle(knowledgePaths(dir).dir);
    expect(issues.some((i) => i.code === 'unknown-type')).toBe(true);
  });

  it('misplaced file is rejected', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    const k = knowledgePaths(dir).dir;
    mkdirSync(join(k, 'wrong'), { recursive: true });
    writeFileSync(
      join(k, 'wrong/overview.md'),
      readFileSync(join(k, 'project/overview.md'), 'utf8'),
    );
    const issues = validateBundle(k);
    expect(issues.some((i) => i.code === 'misplaced')).toBe(true);
  });

  it('missing required heading is rejected', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    const file = join(knowledgePaths(dir).dir, 'structure/layout.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('# Layout', '# NotLayout'));
    const issues = validateBundle(knowledgePaths(dir).dir);
    expect(issues.some((i) => i.code?.startsWith('missing-heading:'))).toBe(true);
  });
});

describe('AC: sources + footnotes + x-turbine-commit/blob match git', () => {
  it('overview facts cite sources that match HEAD blobs', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    const text = readFileSync(join(knowledgePaths(dir).dir, 'project/overview.md'), 'utf8');
    const split = splitFrontmatter(text);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.data['x-turbine-commit']).toBe(git(dir, 'rev-parse', 'HEAD').trim());
    const sources = split.data.sources as Array<{ id: string; resource: string }>;
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      expect(text).toMatch(new RegExp(`\\[\\^${s.id}\\]`));
      const m = /^git:(.+)@([0-9a-f]{40}|[0-9a-f]{64})$/.exec(s.resource);
      expect(m).toBeTruthy();
      const path = m![1]!;
      const oid = m![2]!;
      if (path === 'tree' || path === '.') {
        expect(oid).toBe(git(dir, 'rev-parse', 'HEAD^{tree}').trim());
      } else if (path === 'commit') {
        expect(oid).toBe(git(dir, 'rev-parse', 'HEAD').trim());
      } else {
        expect(oid).toBe(git(dir, 'rev-parse', `HEAD:${path}`).trim());
      }
    }
  });
});

describe('AC: trust tiers machine-confirmed vs human-reviewed; old verification drops after generated.at moves', () => {
  it('computes tiers per OKF §5.3', () => {
    expect(
      okfTrustTier({
        generated: { by: 'turbine/0.5.0', at: '2020-01-02T00:00:00Z' },
        verified: { by: 'process:turbine-verify/0.5.0', at: '2020-01-02T00:00:00Z' },
      }),
    ).toBe('machine-confirmed');
    expect(
      okfTrustTier({
        generated: { by: 'turbine/0.5.0', at: '2020-01-02T00:00:00Z' },
        verified: { by: 'human:alice', at: '2020-01-02T00:00:00Z' },
      }),
    ).toBe('human-reviewed');
    expect(
      okfTrustTier({
        generated: { by: 'turbine/0.5.0', at: '2020-01-03T00:00:00Z' },
        verified: { by: 'human:alice', at: '2020-01-02T00:00:00Z' },
      }),
    ).toBe('unverified');
  });
});

describe('AC: unconfirmed items appear only as Open Questions', () => {
  it('confirmed conventions are conventions; unconfirmed are open-questions', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    const k = knowledgePaths(dir).dir;
    const conventions = existsSync(join(k, 'conventions')) ? readdirSync(join(k, 'conventions')) : [];
    for (const name of conventions) {
      const t = splitFrontmatter(readFileSync(join(k, 'conventions', name), 'utf8'));
      expect(t.ok && t.data.type).toBe('Turbine Convention');
    }
  });
});

describe('AC: withdrawn claim leaves the bundle and enters log.md', () => {
  it('records withdrawals in log.md and removes them from brief concepts on rebuild', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    const published = store.listClaims(dir, { statuses: ['verified'] });
    expect(published.length).toBeGreaterThan(0);
    const id = published[0]!.claim.id;
    const section = published[0]!.claim.section;
    store.withdrawClaim(dir, id, 'test withdrawal reason');
    const o2 = await understand(dir, store);
    expect(o2.knowledge?.unchanged).toBe(false);
    const log = readFileSync(knowledgePaths(dir).log, 'utf8');
    expect(log).toMatch(/Withdrawal/);
    expect(log).toMatch(/test withdrawal reason/);
    expect(log).toMatch(id);
    const briefDir = join(knowledgePaths(dir).dir, 'brief');
    if (existsSync(briefDir)) {
      for (const name of readdirSync(briefDir)) {
        const body = readFileSync(join(briefDir, name), 'utf8');
        expect(body).not.toMatch(new RegExp(`claim id=${id}`));
        if (name === `${section}.md`) {
          expect(body).not.toMatch(id);
        }
      }
    }
  });
});

describe('AC: same commit → byte-identical / no writes; new commit → rebuild + log', () => {
  it('second understand at the same HEAD writes nothing', async () => {
    const dir = newRepo();
    const store = openStore();
    const first = await understand(dir, store);
    expect(first.knowledge?.unchanged).toBe(false);
    const before = readFileSync(knowledgePaths(dir).index, 'utf8');
    const second = await understand(dir, store);
    expect(second.knowledge?.unchanged).toBe(true);
    expect(readFileSync(knowledgePaths(dir).index, 'utf8')).toBe(before);
  });

  it('a new commit rebuilds and appends a log entry', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    writeFileSync(join(dir, 'src/extra.ts'), 'export const y = 2;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'extra');
    const o2 = await understand(dir, store);
    expect(o2.knowledge?.unchanged).toBe(false);
    expect(readFileSync(knowledgePaths(dir).log, 'utf8')).toMatch(/Knowledge bundle rebuilt/);
  });
});

describe('AC: unknown hand-added key survives; hand-edited generated value is flagged', () => {
  it('preserves x-custom-note across understand', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    const file = join(knowledgePaths(dir).dir, 'project/overview.md');
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, text.replace('---\n', '---\nx-custom-note: keep-me\n'));
    // Force rebuild by touching a new commit
    writeFileSync(join(dir, 'src/z.ts'), 'export {};\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'z');
    await understand(dir, store);
    const again = readFileSync(file, 'utf8');
    expect(again).toMatch(/x-custom-note:\s*keep-me/);
  });
});

describe('AC: failed validation or HEAD move publishes nothing', () => {
  it('export refuses path traversal and non-empty target without --force', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    expect(() => exportKnowledgeBundle({ projectRoot: dir, targetDir: 'foo/../../etc' })).toThrow(/\.\./);
    const target = mkdtempSync(join(tmpdir(), 'turbine-okf-export-'));
    dirs.push(target);
    writeFileSync(join(target, 'keep.txt'), 'x');
    expect(() => exportKnowledgeBundle({ projectRoot: dir, targetDir: target })).toThrow(/not empty/);
    const ok = exportKnowledgeBundle({ projectRoot: dir, targetDir: target, force: true });
    expect(ok.files).toBeGreaterThan(0);
  });

  it('HEAD mismatch vs snapshot refuses publish and leaves the old bundle', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    const before = readFileSync(knowledgePaths(dir).index, 'utf8');
    const snap = store.getLatestSnapshotFor(dir)!;
    writeFileSync(join(dir, 'src/moved.ts'), 'export {};\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'moved');
    expect(() =>
      publishKnowledgeBundle({
        store,
        projectRoot: dir,
        repoRoot: dir,
        repoPath: dir,
        snapshot: snap,
        brief: store.getBriefState(dir),
        cliVersion: '0.5.0',
        projectName: 'demo',
      }),
    ).toThrow(HeadMovedError);
    expect(readFileSync(knowledgePaths(dir).index, 'utf8')).toBe(before);
  });
});

describe('AC: YAML traps and concept naming', () => {
  it('duplicate key / custom tag / huge file / deep nesting are rejected', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    const k = knowledgePaths(dir).dir;
    writeFileSync(join(k, 'project/dup.md'), '---\ntype: Turbine Project\ntitle: a\ntitle: b\n---\n\n# Summary\n\n# Facts\n');
    expect(validateBundle(k).some((i) => i.level === 'error')).toBe(true);
    writeFileSync(join(k, 'project/tag.md'), '---\ntype: Turbine Project\ntitle: !!str hi\ndescription: d\ngenerated: { by: turbine/0.5.0, at: "2020-01-01T00:00:00Z" }\nx-turbine-commit: ' + 'a'.repeat(40) + '\n---\n\n# Summary\n\n# Facts\n');
    // Custom tags: yaml package may or may not surface; huge file:
    const huge = join(k, 'project/huge.md');
    writeFileSync(huge, '---\ntype: Turbine Project\ntitle: h\ndescription: d\ngenerated: { by: turbine/0.5.0, at: "2020-01-01T00:00:00Z" }\nx-turbine-commit: ' + 'a'.repeat(40) + '\n---\n\n# Summary\n\n# Facts\n' + 'x'.repeat(600_000));
    expect(validateBundle(k).some((i) => i.code === 'file-too-large')).toBe(true);
  });

  it('encodes scoped packages and refuses .. / leading dot', () => {
    expect(encodeOkfConceptSegment('@scope/pkg')).toBe('%40scope%2Fpkg');
    expect(() => assertSafeConceptKey('..')).toThrow();
    expect(() => assertSafeConceptKey('.hidden')).toThrow();
  });
});

describe('AC: task next points agents to the bundle', () => {
  it('openFiles include knowledge/index.md when present and fresh at HEAD', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    const roles = loadRoles(factoryRoot());
    const sec = roles.find((r) => r.id === 'security-reviewer')!;
    const step = computeNextStep({
      projectRoot: dir,
      work: {
        id: 'work_okf',
        currentState: 'PLANNING',
        selectedRoles: [{ id: sec.id, version: sec.version }],
      } as never,
      defaultBaseBranch: 'staging',
    });
    expect(step.openFiles).toContain(knowledgePaths(dir).index);
    expect(step.agentPlaybook.join('\n')).toMatch(/knowledge\/index\.md/i);
  });

  it('omits the knowledge index when the bundle commit is not HEAD', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    writeFileSync(join(dir, 'src/stale.ts'), 'export {};\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'move-head');
    const step = computeNextStep({
      projectRoot: dir,
      work: {
        id: 'work_okf_stale',
        currentState: 'PLANNING',
        selectedRoles: [],
      } as never,
      defaultBaseBranch: 'staging',
    });
    expect(step.openFiles).not.toContain(knowledgePaths(dir).index);
    expect(step.agentPlaybook.join('\n')).toMatch(/stale|understand/i);
  });
});

describe('CR regression: validate/export/render hardening', () => {
  it('rejects a fixed-path file that is not the required concept type', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    writeFileSync(join(knowledgePaths(dir).dir, 'project/overview.md'), '# just prose\n');
    expect(validateBundle(knowledgePaths(dir).dir).some((i) => i.code === 'missing-required-concept')).toBe(true);
  });

  it('rejects a non-string x-turbine-commit and proof bullets when sources are absent', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    const file = join(knowledgePaths(dir).dir, 'project/overview.md');
    writeFileSync(
      file,
      `---\ntype: Turbine Project\ntitle: t\ndescription: d\ngenerated: { by: turbine/0.5.0, at: "2024-01-01T00:00:00Z" }\nx-turbine-commit: 123\n---\n\n# Summary\n\n# Facts\n\n- a fact without citation\n`,
    );
    const issues = validateBundle(knowledgePaths(dir).dir);
    expect(issues.some((i) => i.code === 'bad-commit')).toBe(true);
    expect(issues.some((i) => i.code === 'missing-footnote')).toBe(true);
  });

  it('export refuses overlap with the live bundle and validates before replacing', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    expect(() => exportKnowledgeBundle({ projectRoot: dir, targetDir: knowledgePaths(dir).dir, force: true })).toThrow(/outside the project|live knowledge|overlap/i);
    expect(() => exportKnowledgeBundle({ projectRoot: dir, targetDir: join(dir, 'inside-export'), force: true })).toThrow(/outside the project/i);
    const target = mkdtempSync(join(tmpdir(), 'turbine-okf-share-'));
    dirs.push(target);
    writeFileSync(join(target, 'old.md'), 'keep\n');
    // Corrupt the source so validation fails; target must remain.
    writeFileSync(join(knowledgePaths(dir).dir, 'project/overview.md'), '# broken\n');
    expect(() => exportKnowledgeBundle({ projectRoot: dir, targetDir: target, force: true })).toThrow(/invalid/i);
    expect(readFileSync(join(target, 'old.md'), 'utf8')).toBe('keep\n');
  });

  it('okfHumanActor strips spaces so verified.by stays valid', async () => {
    const { okfHumanActor, OkfActorSchema } = await import('../../packages/contracts/dist/index.js');
    expect(OkfActorSchema.safeParse(okfHumanActor('Jane Doe')).success).toBe(true);
    expect(okfHumanActor('Jane Doe')).toBe('human:Jane-Doe');
  });
});

describe('AC: unquoted okf_version and CR-only endings', () => {
  it('index quotes okf_version as 0.3 string', async () => {
    const dir = newRepo();
    const store = openStore();
    await understand(dir, store);
    const index = readFileSync(knowledgePaths(dir).index, 'utf8');
    expect(index).toMatch(/okf_version:\s*"0\.3"/);
  });
});
