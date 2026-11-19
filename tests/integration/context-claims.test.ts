/**
 * Issue #7, part 1 — repository context, layer 2: the claim model and the deterministic verifiers.
 *
 * The rule under test: a claim is published only if a deterministic verifier proves it against the git objects of
 * the commit it names. The PLANTED FALSE CLAIMS suite must be rejected 100%; every verifier also has positive cases.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ClaimSchema, PUBLISHED_CLAIM_STATUSES, UNIVERSAL_WORDS, claimCommit, parseClaim, universalWordIn } from '../../packages/contracts/dist/index.js';
import { WorkStore } from '../../packages/storage-sqlite/dist/index.js';
import { publishClaim, reverifyOnCommit } from '../../apps/cli/src/engine/context/claims.js';
import { CommitReader, jsonEqual, splitLines, verifyClaim } from '../../apps/cli/src/engine/context/verify.js';

const here = dirname(fileURLToPath(import.meta.url));
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
});
// Some describe blocks build their repository once, when the file is collected, so repositories live until the file ends.
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
const head = (dir: string) => git(dir, 'rev-parse', 'HEAD').trim();

function commitFiles(dir: string, files: Record<string, string | Buffer | null>, msg = 'change'): string {
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

const APP = [
  "import { readFileSync } from 'node:fs';",
  "import { helper } from './util.js';",
  "import _ from 'lodash';",
  '',
  "export const VERSION = '1.0.0';",
  'export function run(): string {',
  "  const text = readFileSync('x', 'utf8');",
  '  return helper(_.trim(text));',
  '}',
  '',
].join('\n');

const BASE: Record<string, string | Buffer> = {
  'package.json': json({ name: 'demo', version: '1.0.0', scripts: { build: 'tsc -p .', test: 'vitest run' }, dependencies: { lodash: '^4.17.21' }, devDependencies: { typescript: '^5.0.0' } }),
  'tsconfig.json': json({ compilerOptions: { strict: true, target: 'ES2022' } }),
  'src/app.ts': APP,
  'src/util.ts': 'export function helper(s: string): string {\n  return s.trim();\n}\n',
  // Text that only LOOKS like an import or a call: a comment, a string and a template literal.
  'src/decoy.ts': ["// import leaked from 'left-pad';", 'const note = "import x from \'left-pad\'";', 'const tpl = `require(\'left-pad\')`;', '// helper(1);', 'export const decoy = 1;', ''].join('\n'),
  'docs/notes.md': '# Notes\nThe quick brown fox\n',
  'data/utf16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('zebra-marker', 'utf16le')]),
};

function newRepo(files: Record<string, string | Buffer | null> = BASE): string {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-claims-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  // A developer's global signing settings must not decide whether the fixture can commit.
  git(dir, 'config', 'commit.gpgSign', 'false');
  // Nor may a developer's hooks, line-ending conversion or attributes: the committed bytes are the bytes written.
  const noHooks = mkdtempSync(join(tmpdir(), 'turbine-claims-hooks-'));
  dirs.push(noHooks);
  git(dir, 'config', 'core.hooksPath', noHooks);
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'core.attributesFile', '/dev/null');
  commitFiles(dir, files, 'base');
  return dir;
}

function openStore(): WorkStore {
  const root = mkdtempSync(join(tmpdir(), 'turbine-claims-db-'));
  dirs.push(root);
  const store = new WorkStore(join(root, 'engine.db'));
  stores.push(store);
  return store;
}

const showAt = (dir: string, commit: string, path: string) => git(dir, 'show', `${commit}:${path}`);
/** 1-based number of the first line of `path` at `commit` that contains `needle`. */
function lineOf(dir: string, commit: string, path: string, needle: string): number {
  const i = splitLines(showAt(dir, commit, path)).findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`${needle} is not in ${path}`);
  return i + 1;
}

type Lines = number | [number, number];
function ev(dir: string, commit: string, path: string, lines?: Lines, quote?: string, blob?: string) {
  const out: Record<string, unknown> = { path, commit, blob: blob ?? git(dir, 'rev-parse', `${commit}:${path}`).trim() };
  if (lines !== undefined) {
    const [start, end] = typeof lines === 'number' ? [lines, lines] : lines;
    out.lines = { start, end };
  }
  if (quote !== undefined) out.quote = quote;
  return out;
}

let counter = 0;
const claim = (o: Record<string, unknown>) => ({ id: `c${++counter}`, section: 'architecture', statement: 'A statement', ...o });

/** One valid claim of each kind, at `commit`. */
function validClaims(dir: string, c: string): Record<string, Record<string, unknown>> {
  const L = (path: string, needle: string) => lineOf(dir, c, path, needle);
  const trimLine = L('src/util.ts', 'return s.trim()');
  return {
    exists: claim({ kind: 'exists', statement: 'Notes live in docs/notes.md', evidence: [ev(dir, c, 'docs/notes.md')], verifier: { kind: 'exists', path: 'docs/notes.md' } }),
    'exists (symbol)': claim({ kind: 'exists', statement: 'run is exported', evidence: [ev(dir, c, 'src/app.ts', L('src/app.ts', 'export function run'))], verifier: { kind: 'exists', path: 'src/app.ts', symbol: 'run' } }),
    quote: claim({ kind: 'quote', statement: 'helper trims its input', evidence: [ev(dir, c, 'src/util.ts', trimLine, 'return s.trim();')], verifier: { kind: 'quote' } }),
    'quote (two lines)': claim({
      kind: 'quote',
      statement: 'The version and the run function',
      evidence: [ev(dir, c, 'src/app.ts', [5, 6], "export const VERSION = '1.0.0';\nexport function run(): string {")],
      verifier: { kind: 'quote' },
    }),
    imports: claim({ kind: 'imports', statement: 'app imports util', evidence: [ev(dir, c, 'src/app.ts', 2)], verifier: { kind: 'imports', from: 'src/app.ts', specifier: './util.js' } }),
    calls: claim({ kind: 'calls', statement: 'run calls readFileSync', evidence: [ev(dir, c, 'src/app.ts', 7)], verifier: { kind: 'calls', path: 'src/app.ts', callee: 'readFileSync' } }),
    'calls (dotted)': claim({ kind: 'calls', statement: 'run calls _.trim', evidence: [ev(dir, c, 'src/app.ts', [7, 8])], verifier: { kind: 'calls', path: 'src/app.ts', callee: '_.trim' } }),
    config: claim({
      kind: 'config',
      statement: 'TypeScript strict mode is on',
      evidence: [ev(dir, c, 'tsconfig.json', L('tsconfig.json', '"strict"'))],
      verifier: { kind: 'config', path: 'tsconfig.json', key: ['compilerOptions', 'strict'], value: true },
    }),
    dependency: claim({
      kind: 'dependency',
      statement: 'Uses lodash 4.x',
      evidence: [ev(dir, c, 'package.json', L('package.json', '"lodash"')), ev(dir, c, 'src/app.ts', 3)],
      verifier: { kind: 'dependency', section: 'dependencies', name: 'lodash', spec: '^4.17.21', usedIn: 'src/app.ts' },
    }),
    command: claim({
      kind: 'command',
      statement: 'Build with tsc',
      evidence: [ev(dir, c, 'package.json', L('package.json', '"build"'))],
      verifier: { kind: 'command', script: 'build', command: 'tsc -p .' },
    }),
    'absence (literal)': claim({
      kind: 'absence',
      statement: 'No file ever mentions the marker',
      evidence: [ev(dir, c, 'package.json')],
      verifier: { kind: 'absence', pattern: { type: 'literal', text: 'zz-not-here-zz' } },
    }),
    'absence (import-specifier)': claim({
      kind: 'absence',
      statement: 'Nothing imports moment',
      evidence: [ev(dir, c, 'package.json')],
      verifier: { kind: 'absence', pattern: { type: 'import-specifier', specifier: 'moment' } },
    }),
    'absence (excluded path)': claim({
      kind: 'absence',
      statement: 'Only the decoy mentions left-pad',
      evidence: [ev(dir, c, 'package.json')],
      verifier: { kind: 'absence', pattern: { type: 'literal', text: 'left-pad' }, exclude: ['src/decoy.ts'] },
    }),
  };
}

describe('criterion 3 — the schema rejects an unknown kind, no evidence, and a universal word without an exhaustive verifier', () => {
  const dir = newRepo();
  const c = head(dir);
  const good = () => structuredClone(validClaims(dir, c).quote!);
  const parse = (o: unknown) => ClaimSchema.safeParse(o);

  it('accepts a valid claim of every kind', () => {
    for (const [name, v] of Object.entries(validClaims(dir, c))) expect(parse(v).success, name).toBe(true);
  });

  it('rejects an unknown kind (and a verifier of an unknown kind)', () => {
    expect(parse({ ...good(), kind: 'vibes' }).success).toBe(false);
    expect(parse({ ...good(), kind: 'vibes', verifier: { kind: 'vibes' } }).success).toBe(false);
  });

  it('rejects a verifier that is for another kind than the claim', () => {
    expect(parse({ ...good(), kind: 'exists' }).success).toBe(false);
  });

  it('rejects a claim with no evidence, or with evidence missing a commit or a blob', () => {
    expect(parse({ ...good(), evidence: [] }).success).toBe(false);
    const { evidence: _drop, ...rest } = good();
    expect(parse(rest).success).toBe(false);
    const e = (good().evidence as Array<Record<string, unknown>>)[0]!;
    const { commit: _c, ...noCommit } = e;
    const { blob: _b, ...noBlob } = e;
    expect(parse({ ...good(), evidence: [noCommit] }).success).toBe(false);
    expect(parse({ ...good(), evidence: [noBlob] }).success).toBe(false);
    expect(parse({ ...good(), evidence: [{ ...e, blob: 'abc' }] }).success).toBe(false);
  });

  it.each(UNIVERSAL_WORDS)('rejects "%s" in a statement of a non-exhaustive kind, in any case', (word) => {
    for (const w of [word, word.toUpperCase(), `${word[0]!.toUpperCase()}${word.slice(1)}`]) {
      const r = parse({ ...good(), statement: `Helper ${w} trims the input` });
      expect(r.success, w).toBe(false);
    }
  });

  it('rejects a universal word hidden by full-width letters, and a statement with an invisible character', () => {
    expect(parse({ ...good(), statement: 'Helper ｎｅｖｅｒ trims' }).success).toBe(false);
    expect(parse({ ...good(), statement: 'Helper al\u200bl trims' }).success).toBe(false);
    expect(universalWordIn('the alloy is fine')).toBeUndefined();
    expect(universalWordIn('Never mind')).toBe('never');
  });

  it('allows a universal word with an exhaustive (absence) claim', () => {
    for (const word of UNIVERSAL_WORDS) {
      const a = { ...validClaims(dir, c)['absence (literal)']!, statement: `The text ${word} appears nowhere` };
      expect(parse(a).success, word).toBe(true);
    }
  });

  it('rejects a path with "..", an absolute path, a backslash and a verifier input that is not cited', () => {
    const q = good();
    const e = (q.evidence as Array<Record<string, unknown>>)[0]!;
    for (const path of ['../etc/passwd', '/etc/passwd', 'src\\util.ts', 'src//util.ts', './src/util.ts']) {
      expect(parse({ ...q, evidence: [{ ...e, path }] }).success, path).toBe(false);
    }
    const imp = validClaims(dir, c).imports!;
    expect(parse({ ...imp, verifier: { kind: 'imports', from: 'src/decoy.ts', specifier: './util.js' } }).success).toBe(false);
    expect(parse({ ...imp, verifier: { kind: 'imports', from: '../app.ts', specifier: './util.js' } }).success).toBe(false);
  });

  it('rejects a quote without lines, a quote whose line count is not the cited range, and a blank quote', () => {
    const e = (good().evidence as Array<Record<string, unknown>>)[0]!;
    const { lines: _l, ...noLines } = e;
    expect(parse({ ...good(), evidence: [noLines] }).success).toBe(false);
    expect(parse({ ...good(), evidence: [{ ...e, lines: { start: 1, end: 2 } }] }).success).toBe(false);
    expect(parse({ ...good(), evidence: [{ ...e, quote: '   ' }] }).success).toBe(false);
    expect(parse({ ...good(), evidence: [{ ...e, quote: 'a\r\nb', lines: { start: 1, end: 2 } }] }).success).toBe(false);
  });

  it('rejects evidence of two different commits, an unknown field, and an unsearchable absence pattern', () => {
    const q = good();
    const e = (q.evidence as Array<Record<string, unknown>>)[0]!;
    expect(parse({ ...q, evidence: [e, { ...e, commit: 'f'.repeat(40) }] }).success).toBe(false);
    expect(parse({ ...q, extra: 1 }).success).toBe(false);
    const a = validClaims(dir, c)['absence (literal)']!;
    for (const pattern of [{ type: 'regex', text: '.*' }, { type: 'literal', text: 'ab' }, { type: 'literal', text: 'caf\u00e9-marker' }, { type: 'import-specifier', specifier: "a'b" }]) {
      expect(parse({ ...a, verifier: { kind: 'absence', pattern } }).success, JSON.stringify(pattern)).toBe(false);
    }
  });

  it('refuses a __proto__ key in untrusted claim JSON', () => {
    const raw = `{"id":"p1","section":"architecture","statement":"x","kind":"exists","evidence":[],"verifier":{"kind":"exists","path":"a"},"__proto__":{"x":1}}`;
    expect(() => parseClaim(JSON.parse(raw))).toThrow(/__proto__/);
  });
});

describe('positive cases — every kind is published when its verifier proves it', () => {
  const dir = newRepo();
  const c = head(dir);
  for (const [name, input] of Object.entries(validClaims(dir, c))) {
    it(`${name}: published as "verified" with the proof recorded`, () => {
      const store = openStore();
      const out = publishClaim(store, dir, dir, input);
      expect(out.published, out.published ? '' : out.reason).toBe(true);
      const stored = store.getClaim(dir, input.id as string)!;
      expect(stored.status).toBe('verified');
      expect(stored.reason).toBeTruthy();
      expect(stored.commit).toBe(c);
      expect(stored.claim.statement).toBe(input.statement);
    });
  }

  it('reads a CRLF and a bare-CR file with the same line numbers as the parsers', () => {
    const d = newRepo({ 'a.ts': "import x from 'one';\r\nimport y from 'two';\rimport z from 'three';\r\nexport {};\r\n" });
    const cm = head(d);
    // The committed blob holds the CRLF and the bare CR as written (no line-ending conversion happened).
    expect(spawnSync('git', ['cat-file', 'blob', `${cm}:a.ts`], { cwd: d, encoding: 'latin1' }).stdout).toBe("import x from 'one';\r\nimport y from 'two';\rimport z from 'three';\r\nexport {};\r\n");
    for (const [spec, line] of [['one', 1], ['two', 2], ['three', 3]] as const) {
      const v = verifyClaim(new CommitReader(d, cm), claim({ kind: 'imports', evidence: [ev(d, cm, 'a.ts', line)], verifier: { kind: 'imports', from: 'a.ts', specifier: spec } }));
      expect(v.ok, `${spec}: ${v.reason}`).toBe(true);
    }
  });

  it('reads a claim at an OLD commit even after the file changed (the pin is the commit)', () => {
    const d = newRepo();
    const c1 = head(d);
    const input = validClaims(d, c1).quote!;
    commitFiles(d, { 'src/util.ts': '// moved\nexport function helper(s: string): string {\n  return s.trim();\n}\n' });
    expect(verifyClaim(new CommitReader(d, c1), input).ok).toBe(true);
    expect(verifyClaim(new CommitReader(d, head(d)), input).ok).toBe(false); // at the new commit that blob is stale
  });

  it('jsonEqual compares JSON by value, with object keys in any order', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual(JSON.parse('{"__proto__":{"x":1}}'), {})).toBe(false);
  });
});

describe('criterion 6 — the planted-false-claims suite: every false claim is rejected (100%)', () => {
  // The repository has two commits (c1, then c2 changes util.ts) and an uncommitted change on top.
  const dir = newRepo();
  const c1 = head(dir);
  const c2 = commitFiles(dir, { 'src/util.ts': 'export function helper(s: string): string {\n  // trim it\n  return s.trim();\n}\n' });
  writeFileSync(join(dir, 'src/draft.ts'), "import leftPad from 'left-pad';\nexport const d = leftPad;\n");
  git(dir, 'add', 'src/draft.ts'); // staged, never committed
  writeFileSync(join(dir, 'src/app.ts'), `import leftPad from 'left-pad';\n${APP}`); // modified, never committed
  const draftBlob = git(dir, 'hash-object', '-w', 'src/draft.ts').trim();
  const dirtyAppBlob = git(dir, 'hash-object', '-w', 'src/app.ts').trim();
  const c = c2;
  const trimLine = lineOf(dir, c, 'src/util.ts', 'return s.trim()');
  const appBlob = git(dir, 'rev-parse', `${c}:src/app.ts`).trim();
  const utilC1Blob = git(dir, 'rev-parse', `${c1}:src/util.ts`).trim();

  const planted: Array<{ name: string; claim: Record<string, unknown>; why: RegExp }> = [
    {
      name: 'wrong file: a path that is not tracked',
      claim: claim({ kind: 'exists', evidence: [ev(dir, c, 'src/missing.ts', undefined, undefined, appBlob)], verifier: { kind: 'exists', path: 'src/missing.ts' } }),
      why: /not tracked/,
    },
    {
      name: 'wrong file: a quote that is in another file',
      claim: claim({ kind: 'quote', evidence: [ev(dir, c, 'src/util.ts', 1, "import { helper } from './util.js';")], verifier: { kind: 'quote' } }),
      why: /quote is not on/,
    },
    {
      name: 'wrong file: an import the cited file does not have',
      claim: claim({ kind: 'imports', evidence: [ev(dir, c, 'src/util.ts', 1)], verifier: { kind: 'imports', from: 'src/util.ts', specifier: 'node:fs' } }),
      why: /does not import/,
    },
    {
      name: 'wrong quote',
      claim: claim({ kind: 'quote', evidence: [ev(dir, c, 'src/util.ts', trimLine, 'return s.trimEnd();')], verifier: { kind: 'quote' } }),
      why: /quote is not on/,
    },
    {
      name: 'wrong quote: right words, wrong case',
      claim: claim({ kind: 'quote', evidence: [ev(dir, c, 'src/util.ts', trimLine, 'RETURN S.TRIM();')], verifier: { kind: 'quote' } }),
      why: /quote is not on/,
    },
    {
      name: 'off-by-one lines: one line too early',
      claim: claim({ kind: 'quote', evidence: [ev(dir, c, 'src/util.ts', trimLine - 1, 'return s.trim();')], verifier: { kind: 'quote' } }),
      why: /quote is not on/,
    },
    {
      name: 'off-by-one lines: one line too late',
      claim: claim({ kind: 'quote', evidence: [ev(dir, c, 'src/util.ts', trimLine + 1, 'return s.trim();')], verifier: { kind: 'quote' } }),
      why: /quote is not on/,
    },
    {
      name: 'off-by-one lines: past the end of the file',
      claim: claim({ kind: 'quote', evidence: [ev(dir, c, 'src/util.ts', 999, 'return s.trim();')], verifier: { kind: 'quote' } }),
      why: /past the end/,
    },
    {
      name: 'off-by-one lines: the cited lines of an import are the line before it',
      claim: claim({ kind: 'imports', evidence: [ev(dir, c, 'src/app.ts', 1)], verifier: { kind: 'imports', from: 'src/app.ts', specifier: './util.js' } }),
      why: /outside the cited lines/,
    },
    {
      name: 'off-by-one lines: a call cited one line early',
      claim: claim({ kind: 'calls', evidence: [ev(dir, c, 'src/app.ts', 6)], verifier: { kind: 'calls', path: 'src/app.ts', callee: 'readFileSync' } }),
      why: /outside the cited lines/,
    },
    {
      name: 'stale blob: the file changed since the blob was recorded',
      claim: claim({ kind: 'quote', evidence: [ev(dir, c, 'src/util.ts', 2, 'return s.trim();', utilC1Blob)], verifier: { kind: 'quote' } }),
      why: /stale/,
    },
    {
      name: 'false "never": the literal text does occur',
      claim: claim({ kind: 'absence', statement: 'helper is never mentioned', evidence: [ev(dir, c, 'package.json')], verifier: { kind: 'absence', pattern: { type: 'literal', text: 'helper' } } }),
      why: /occurs in/,
    },
    {
      name: 'false "never": the specifier is imported',
      claim: claim({ kind: 'absence', statement: 'Nothing imports node:fs', evidence: [ev(dir, c, 'package.json')], verifier: { kind: 'absence', pattern: { type: 'import-specifier', specifier: 'node:fs' } } }),
      why: /occurs in/,
    },
    {
      name: 'false "never": the text occurs only in a UTF-16 file',
      claim: claim({ kind: 'absence', statement: 'zebra-marker never appears', evidence: [ev(dir, c, 'package.json')], verifier: { kind: 'absence', pattern: { type: 'literal', text: 'zebra-marker' } } }),
      why: /data\/utf16\.txt/,
    },
    {
      name: 'false "never": the only occurrence is inside a path that is not excluded',
      claim: claim({ kind: 'absence', statement: 'left-pad never appears', evidence: [ev(dir, c, 'package.json')], verifier: { kind: 'absence', pattern: { type: 'literal', text: 'left-pad' }, exclude: ['docs/'] } }),
      why: /src\/decoy\.ts/,
    },
    {
      name: 'config value that differs',
      claim: claim({ kind: 'config', evidence: [ev(dir, c, 'tsconfig.json', 3)], verifier: { kind: 'config', path: 'tsconfig.json', key: ['compilerOptions', 'strict'], value: false } }),
      why: /is true, not false/,
    },
    {
      name: 'config value of another type',
      claim: claim({ kind: 'config', evidence: [ev(dir, c, 'tsconfig.json', 3)], verifier: { kind: 'config', path: 'tsconfig.json', key: ['compilerOptions', 'strict'], value: 'true' } }),
      why: /is true, not "true"/,
    },
    {
      name: 'config key that does not exist',
      claim: claim({ kind: 'config', evidence: [ev(dir, c, 'tsconfig.json', 3)], verifier: { kind: 'config', path: 'tsconfig.json', key: ['compilerOptions', 'noEmit'], value: true } }),
      why: /no member/,
    },
    {
      name: 'dependency declared with another version',
      claim: claim({ kind: 'dependency', evidence: [ev(dir, c, 'package.json', lineOf(dir, c, 'package.json', '"lodash"'))], verifier: { kind: 'dependency', section: 'dependencies', name: 'lodash', spec: '^3.0.0' } }),
      why: /not "\^3\.0\.0"/,
    },
    {
      name: 'dependency declared in another section',
      claim: claim({ kind: 'dependency', evidence: [ev(dir, c, 'package.json', lineOf(dir, c, 'package.json', '"lodash"'))], verifier: { kind: 'dependency', section: 'devDependencies', name: 'lodash', spec: '^4.17.21' } }),
      why: /no dependency/,
    },
    {
      name: 'dependency that the cited site does not import',
      claim: claim({
        kind: 'dependency',
        evidence: [ev(dir, c, 'package.json', lineOf(dir, c, 'package.json', '"lodash"')), ev(dir, c, 'src/util.ts', 1)],
        verifier: { kind: 'dependency', section: 'dependencies', name: 'lodash', spec: '^4.17.21', usedIn: 'src/util.ts' },
      }),
      why: /does not import lodash/,
    },
    {
      name: 'command that is not the script',
      claim: claim({ kind: 'command', evidence: [ev(dir, c, 'package.json', lineOf(dir, c, 'package.json', '"build"'))], verifier: { kind: 'command', script: 'build', command: 'webpack' } }),
      why: /not "webpack"/,
    },
    {
      name: 'command for a script that does not exist',
      claim: claim({ kind: 'command', evidence: [ev(dir, c, 'package.json', 5)], verifier: { kind: 'command', script: 'deploy', command: 'make deploy' } }),
      why: /no script/,
    },
    {
      name: 'an import that exists only in a staged, uncommitted file',
      claim: claim({ kind: 'imports', evidence: [ev(dir, c, 'src/draft.ts', 1, undefined, draftBlob)], verifier: { kind: 'imports', from: 'src/draft.ts', specifier: 'left-pad' } }),
      why: /not tracked/,
    },
    {
      name: 'an import that exists only in an uncommitted edit (blob of the edited file)',
      claim: claim({ kind: 'imports', evidence: [ev(dir, c, 'src/app.ts', 1, undefined, dirtyAppBlob)], verifier: { kind: 'imports', from: 'src/app.ts', specifier: 'left-pad' } }),
      why: /stale/,
    },
    {
      name: 'an import that exists only in an uncommitted edit (blob of the commit)',
      claim: claim({ kind: 'imports', evidence: [ev(dir, c, 'src/app.ts', 1)], verifier: { kind: 'imports', from: 'src/app.ts', specifier: 'left-pad' } }),
      why: /does not import/,
    },
    {
      name: 'an import written only in a comment',
      claim: claim({ kind: 'imports', evidence: [ev(dir, c, 'src/decoy.ts', 1)], verifier: { kind: 'imports', from: 'src/decoy.ts', specifier: 'left-pad' } }),
      why: /does not import/,
    },
    {
      name: 'an import written only in a string and a template literal',
      claim: claim({ kind: 'imports', evidence: [ev(dir, c, 'src/decoy.ts', [2, 3])], verifier: { kind: 'imports', from: 'src/decoy.ts', specifier: 'left-pad' } }),
      why: /does not import/,
    },
    {
      name: 'a call written only in a comment',
      claim: claim({ kind: 'calls', evidence: [ev(dir, c, 'src/decoy.ts', 4)], verifier: { kind: 'calls', path: 'src/decoy.ts', callee: 'helper' } }),
      why: /no call/,
    },
    {
      name: 'a symbol that is not exported',
      claim: claim({ kind: 'exists', evidence: [ev(dir, c, 'src/app.ts', 6)], verifier: { kind: 'exists', path: 'src/app.ts', symbol: 'runAll' } }),
      why: /no top-level export/,
    },
    ...UNIVERSAL_WORDS.map((word) => ({
      name: `universal word "${word}" on a non-exhaustive kind (quote)`,
      claim: claim({ kind: 'quote', statement: `helper ${word} trims`, evidence: [ev(dir, c, 'src/util.ts', trimLine, 'return s.trim();')], verifier: { kind: 'quote' } }),
      why: /exhaustive/,
    })),
    {
      name: 'universal word on a non-exhaustive kind (config)',
      claim: claim({ kind: 'config', statement: 'Strict is always on', evidence: [ev(dir, c, 'tsconfig.json', 3)], verifier: { kind: 'config', path: 'tsconfig.json', key: ['compilerOptions', 'strict'], value: true } }),
      why: /exhaustive/,
    },
    {
      name: 'unknown kind',
      claim: claim({ kind: 'vibes', evidence: [ev(dir, c, 'src/util.ts', 1)], verifier: { kind: 'vibes' } }),
      why: /./,
    },
    {
      name: 'no evidence',
      claim: claim({ kind: 'exists', evidence: [], verifier: { kind: 'exists', path: 'src/util.ts' } }),
      why: /evidence/,
    },
  ];

  const falseClaims = planted;

  it('the fixture is dirty: an uncommitted file and an uncommitted edit exist', () => {
    expect(git(dir, 'status', '--porcelain')).toMatch(/^A {2}src\/draft\.ts$/m); // staged, not merely untracked
    expect(git(dir, 'status', '--porcelain')).toMatch(/ M src\/app\.ts/);
  });

  it.each(falseClaims.map((p) => [p.name, p] as const))('rejects: %s', (_name, p) => {
    const store = openStore();
    const out = publishClaim(store, dir, dir, p.claim);
    expect(out.published).toBe(false);
    if (!out.published) expect(out.reason).toMatch(p.why);
    expect(store.listClaims(dir, { statuses: PUBLISHED_CLAIM_STATUSES })).toEqual([]);
  });

  it('100% of the planted false claims are rejected, and nothing is left published', () => {
    const store = openStore();
    const outcomes = falseClaims.map((p) => publishClaim(store, dir, dir, p.claim));
    expect(falseClaims.length).toBeGreaterThanOrEqual(35);
    expect(outcomes.filter((o) => o.published)).toEqual([]);
    expect(store.listClaims(dir, { statuses: PUBLISHED_CLAIM_STATUSES })).toEqual([]);
  });

  it('a claim that is invalid is not stored at all; a claim that is valid but false is stored as rejected with the reason', () => {
    const store = openStore();
    const invalid = publishClaim(store, dir, dir, planted.find((p) => p.name.startsWith('no evidence'))!.claim);
    expect(invalid).toMatchObject({ published: false, recorded: false });
    const falseOne = planted.find((p) => p.name === 'wrong quote')!.claim;
    const out = publishClaim(store, dir, dir, falseOne);
    expect(out).toMatchObject({ published: false, recorded: true });
    const rec = store.getClaim(dir, falseOne.id as string)!;
    expect(rec.status).toBe('rejected');
    expect(rec.reason).toMatch(/quote is not on/);
  });

  it('a claim is verified at the commit its evidence names, not at HEAD', () => {
    const atC1 = claim({ kind: 'quote', evidence: [ev(dir, c1, 'src/util.ts', 2, 'return s.trim();')], verifier: { kind: 'quote' } });
    expect(claimCommit(ClaimSchema.parse(atC1))).toBe(c1);
    const store = openStore();
    expect(publishClaim(store, dir, dir, atC1).published).toBe(true);
  });

  it('refuses a commit that is not a full commit id (a branch name or a short id cannot pin)', () => {
    expect(() => new CommitReader(dir, 'HEAD')).toThrow(/full commit id/);
    expect(() => new CommitReader(dir, c.slice(0, 10))).toThrow(/full commit id/);
    expect(() => new CommitReader(dir, 'f'.repeat(40))).toThrow(/not a commit/);
  });

  it('the working tree and the index are never read: the committed text is what is proven', () => {
    // Positive claims at HEAD still pass although app.ts is edited in the working tree.
    const store = openStore();
    const out = publishClaim(store, dir, dir, claim({ kind: 'imports', evidence: [ev(dir, c, 'src/app.ts', 2)], verifier: { kind: 'imports', from: 'src/app.ts', specifier: './util.js' } }));
    expect(out.published).toBe(true);
    // The literal left-pad is in the working tree's app.ts and draft.ts, but the absence claim is judged on the commit.
    const absent = claim({
      kind: 'absence',
      statement: 'left-pad is not used outside the decoy',
      evidence: [ev(dir, c, 'package.json')],
      verifier: { kind: 'absence', pattern: { type: 'literal', text: 'left-pad' }, exclude: ['src/decoy.ts'] },
    });
    expect(publishClaim(store, dir, dir, absent).published).toBe(true);
  });
});

describe('verifiers refuse what they cannot prove (unconfirmed, never a guess)', () => {
  it('imports / calls / exists(symbol) in a file with a syntax error prove nothing', () => {
    const d = newRepo({ 'src/broken.ts': "import { a from './x';\nexport const b = a();\n", 'package.json': json({ name: 'x' }) });
    const cm = head(d);
    const reader = new CommitReader(d, cm);
    const cases = [
      claim({ kind: 'imports', evidence: [ev(d, cm, 'src/broken.ts', 1)], verifier: { kind: 'imports', from: 'src/broken.ts', specifier: './x' } }),
      claim({ kind: 'calls', evidence: [ev(d, cm, 'src/broken.ts', 2)], verifier: { kind: 'calls', path: 'src/broken.ts', callee: 'a' } }),
      claim({ kind: 'exists', evidence: [ev(d, cm, 'src/broken.ts', 2)], verifier: { kind: 'exists', path: 'src/broken.ts', symbol: 'b' } }),
    ];
    for (const k of cases) expect(verifyClaim(reader, k)).toMatchObject({ ok: false, unconfirmed: true });
  });

  it('config in a file that is not JSON, or is invalid JSON, proves nothing', () => {
    const d = newRepo({ 'a.yaml': 'strict: true\n', 'b.json': '{ "strict": true, }}', 'c.json': '{"strict": true}\n' });
    const cm = head(d);
    const reader = new CommitReader(d, cm);
    const mk = (path: string) => claim({ kind: 'config', evidence: [ev(d, cm, path, 1)], verifier: { kind: 'config', path, key: ['strict'], value: true } });
    expect(verifyClaim(reader, mk('a.yaml'))).toMatchObject({ ok: false, unconfirmed: true });
    expect(verifyClaim(reader, mk('b.json')).ok).toBe(false);
    expect(verifyClaim(reader, mk('c.json')).ok).toBe(true);
  });

  it('config does not follow inherited keys (a "constructor" or "__proto__" key is not there)', () => {
    const d = newRepo({ 'c.json': '{"a": {}}\n' });
    const cm = head(d);
    for (const key of [['a', 'constructor'], ['a', '__proto__'], ['a', 'toString']]) {
      const v = verifyClaim(new CommitReader(d, cm), claim({ kind: 'config', evidence: [ev(d, cm, 'c.json', 1)], verifier: { kind: 'config', path: 'c.json', key, value: {} } }));
      expect(v.ok, key.join('.')).toBe(false);
    }
  });

  it('a quote in a binary file proves nothing', () => {
    const d = newRepo({ 'bin.dat': Buffer.from([0x61, 0x00, 0x62, 0x0a]) });
    const cm = head(d);
    const v = verifyClaim(new CommitReader(d, cm), claim({ kind: 'quote', evidence: [ev(d, cm, 'bin.dat', 1, 'a')], verifier: { kind: 'quote' } }));
    expect(v).toMatchObject({ ok: false, unconfirmed: true });
  });

  it('absence refuses when a submodule is in scope (its files are not in the commit)', () => {
    const d = newRepo({ 'a.txt': 'hello\n' });
    git(d, 'update-index', '--add', '--cacheinfo', `160000,${head(d)},vendor/sub`);
    git(d, 'commit', '-qm', 'add a gitlink');
    const cm = head(d);
    const absence = (exclude: string[]) =>
      claim({ kind: 'absence', statement: 'Nothing says zz-not-here-zz', evidence: [ev(d, cm, 'a.txt')], verifier: { kind: 'absence', pattern: { type: 'literal', text: 'zz-not-here-zz' }, exclude } });
    expect(verifyClaim(new CommitReader(d, cm), absence([]))).toMatchObject({ ok: false, unconfirmed: true });
    // Excluding the submodule is stated in the claim itself, so it is allowed.
    expect(verifyClaim(new CommitReader(d, cm), absence(['vendor/sub/'])).ok).toBe(true);
    const out = publishClaim(openStore(), d, d, absence([]));
    expect(out).toMatchObject({ published: false, unconfirmed: true });
  });

  it('absence is vacuous when no file is in scope, and refuses', () => {
    const d = newRepo({ 'a.txt': 'hello\n' });
    const cm = head(d);
    const v = verifyClaim(
      new CommitReader(d, cm),
      claim({ kind: 'absence', statement: 'Nothing imports x', evidence: [ev(d, cm, 'a.txt')], verifier: { kind: 'absence', pattern: { type: 'import-specifier', specifier: 'x' } } }),
    );
    expect(v).toMatchObject({ ok: false, unconfirmed: true });
  });

  it('absence refuses a UTF-32 file it cannot search', () => {
    const d = newRepo({ 'a.txt': 'hello\n', 'wide.txt': Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00]) });
    const cm = head(d);
    const v = verifyClaim(new CommitReader(d, cm), claim({ kind: 'absence', statement: 'No marker', evidence: [ev(d, cm, 'a.txt')], verifier: { kind: 'absence', pattern: { type: 'literal', text: 'marker' } } }));
    expect(v).toMatchObject({ ok: false, unconfirmed: true });
  });

  it('absence finds a literal that occurs in a file that is present twice under two paths, and names both', () => {
    const d = newRepo({ 'a/x.txt': 'needle-text\n', 'b/y.txt': 'needle-text\n' });
    const cm = head(d);
    const v = verifyClaim(new CommitReader(d, cm), claim({ kind: 'absence', statement: 'No needle', evidence: [ev(d, cm, 'a/x.txt')], verifier: { kind: 'absence', pattern: { type: 'literal', text: 'needle-text' } } }));
    expect(v).toMatchObject({ ok: false });
    expect(v.reason).toMatch(/2 file\(s\): a\/x\.txt, b\/y\.txt/);
  });

  it('absence reads a tree of many files exhaustively', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i++) files[`pkg/f${i}.ts`] = `export const v${i} = ${i};\n`;
    files['pkg/f299.ts'] += "// zz-hidden-zz\n";
    const d = newRepo(files);
    const cm = head(d);
    const mk = (text: string) => claim({ kind: 'absence', statement: 'No marker', evidence: [ev(d, cm, 'pkg/f0.ts')], verifier: { kind: 'absence', pattern: { type: 'literal', text } } });
    expect(verifyClaim(new CommitReader(d, cm), mk('zz-hidden-zz')).ok).toBe(false);
    expect(verifyClaim(new CommitReader(d, cm), mk('zz-nothing-zz')).ok).toBe(true);
  });
});

describe('storage — migration v4 and the claim methods', () => {
  const sample = () => {
    const dir = newRepo();
    return { dir, c: head(dir), input: validClaims(dir, head(dir)).quote! };
  };

  it('migration v4 creates the claims table (v3, work_claims, is untouched)', () => {
    const store = openStore();
    const versions = (store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map((r) => r.version);
    expect(versions).toEqual([1, 2, 3, 4]);
    const cols = (store.db.prepare(`PRAGMA table_info(claims)`).all() as Array<{ name: string }>).map((x) => x.name);
    expect(cols).toEqual(['id', 'repo_path', 'section', 'commit', 'data', 'status', 'reason', 'created_at']);
    expect(store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='work_claims'`).all()).toHaveLength(1);
    expect(() => store.db.prepare(`INSERT INTO claims VALUES ('x','r','s','c','{}','maybe',NULL,'t')`).run()).toThrow(/CHECK|constraint/i);
  });

  it('save / get / list round-trip, filters, and per-repository ids', () => {
    const { dir, c, input } = sample();
    const store = openStore();
    const parsed = ClaimSchema.parse(input);
    expect(store.saveClaim({ repoPath: dir, claim: parsed, status: 'verified', reason: 'proof' })).toBe(true);
    const stored = store.getClaim(dir, parsed.id)!;
    expect(stored).toMatchObject({ repoPath: dir, commit: c, section: 'architecture', status: 'verified', reason: 'proof' });
    expect(stored.claim).toEqual(parsed);
    expect(store.getClaim('/elsewhere', parsed.id)).toBeNull();
    expect(store.listClaims(dir)).toHaveLength(1);
    expect(store.listClaims(dir, { section: 'security' })).toEqual([]);
    expect(store.listClaims(dir, { commit: c })).toHaveLength(1);
    expect(store.listClaims(dir, { commit: 'a'.repeat(40) })).toEqual([]);
    expect(store.listClaims(dir, { statuses: ['rejected'] })).toEqual([]);
    expect(store.listClaims(dir, { statuses: [] })).toEqual([]); // an empty status list matches nothing
    expect(store.listClaims(dir, { statuses: ['verified', 'attested'] })).toHaveLength(1);
  });

  it('a rejected or withdrawn claim must record why', () => {
    const { dir, input } = sample();
    const store = openStore();
    const parsed = ClaimSchema.parse(input);
    expect(() => store.saveClaim({ repoPath: dir, claim: parsed, status: 'rejected' })).toThrow(/why/);
    expect(() => store.saveClaim({ repoPath: dir, claim: parsed, status: 'withdrawn', reason: '  ' })).toThrow(/why/);
    expect(() => store.withdrawClaim(dir, parsed.id, ' ')).toThrow(/why/);
  });

  it('a rejection never replaces a published claim; a withdrawn claim stays on record with its reason', () => {
    const { dir, input } = sample();
    const store = openStore();
    const parsed = ClaimSchema.parse(input);
    store.saveClaim({ repoPath: dir, claim: parsed, status: 'verified', reason: 'proof' });
    expect(store.saveClaim({ repoPath: dir, claim: parsed, status: 'rejected', reason: 'later attempt' })).toBe(false);
    expect(store.getClaim(dir, parsed.id)!.status).toBe('verified');
    expect(store.withdrawClaim(dir, parsed.id, 'gone')).toBe(true);
    expect(store.withdrawClaim(dir, parsed.id, 'again')).toBe(false);
    expect(store.getClaim(dir, parsed.id)).toMatchObject({ status: 'withdrawn', reason: 'gone' });
    expect(store.listClaims(dir, { statuses: PUBLISHED_CLAIM_STATUSES })).toEqual([]);
    // After a withdrawal a new attempt can be recorded.
    expect(store.saveClaim({ repoPath: dir, claim: parsed, status: 'rejected', reason: 'later attempt' })).toBe(true);
  });

  it('refuses a claim that does not parse, and a tampered or mismatched row', () => {
    const { dir, input } = sample();
    const store = openStore();
    expect(() => store.saveClaim({ repoPath: dir, claim: { ...input, evidence: [] } as never, status: 'verified' })).toThrow();
    const parsed = ClaimSchema.parse(input);
    store.saveClaim({ repoPath: dir, claim: parsed, status: 'verified', reason: 'proof' });
    store.db.prepare('UPDATE claims SET section = ? WHERE id = ?').run('security', parsed.id);
    expect(() => store.getClaim(dir, parsed.id)).toThrow(/section/);
    store.db.prepare('UPDATE claims SET section = ? WHERE id = ?').run('architecture', parsed.id);
    store.db.prepare('UPDATE claims SET data = replace(data, ?, ?) WHERE id = ?').run('"kind":"quote"', '"kind":"vibes"', parsed.id);
    expect(() => store.getClaim(dir, parsed.id)).toThrow(/kind/);
    // Put the valid JSON back, so only the id is wrong when the row is read.
    store.db.prepare('UPDATE claims SET data = replace(data, ?, ?) WHERE id = ?').run('"kind":"vibes"', '"kind":"quote"', parsed.id);
    expect(store.getClaim(dir, parsed.id)).toMatchObject({ status: 'verified' });
    store.db.prepare('UPDATE claims SET id = ? WHERE id = ?').run('other', parsed.id);
    expect(() => store.listClaims(dir)).toThrow(/actually has id/);
    expect(() => store.getClaim(dir, 'other')).toThrow(/actually has id/);
  });

  it('source layout: the literal status "verified" is written only in engine/context/claims.ts (behaviour is tested below)', () => {
    const root = resolve(here, '../../apps/cli/src');
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /status:\s*'verified'/.test(readFileSync(p, 'utf8'))) hits.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(hits.sort()).toEqual(['engine/context/claims.ts']);
  });
});

describe('criterion 4 — changing a cited file so a claim becomes false removes the claim (reverifyOnCommit)', () => {
  function published(files: Record<string, string | Buffer> = BASE) {
    const dir = newRepo(files);
    const c1 = head(dir);
    const store = openStore();
    const all = validClaims(dir, c1);
    const publish = (name: string) => {
      const out = publishClaim(store, dir, dir, all[name]!);
      expect(out.published, name).toBe(true);
      return all[name]!.id as string;
    };
    return { dir, c1, store, publish };
  }

  it('a claim whose cited blobs did not change is kept and re-pinned to the new commit', () => {
    const { dir, c1, store, publish } = published();
    const ids = [publish('quote'), publish('imports'), publish('config'), publish('absence (literal)')];
    const c2 = commitFiles(dir, { 'README.md': '# readme\n' });
    const r = reverifyOnCommit(store, dir, dir, c1, c2);
    expect(r).toMatchObject({ from: c1, to: c2, withdrawn: [], sections: [] });
    expect(r.kept.sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const s = store.getClaim(dir, id)!;
      expect(s).toMatchObject({ status: 'verified', commit: c2 });
      expect(s.claim.evidence.every((e) => e.commit === c2)).toBe(true);
    }
    expect(store.listClaims(dir, { commit: c1 })).toEqual([]);
    // And the re-pinned claims verify from scratch at the new commit.
    for (const s of store.listClaims(dir)) expect(verifyClaim(new CommitReader(dir, c2), s.claim).ok).toBe(true);
  });

  it('a cited file that changed but still proves the claim keeps it, with the new blob', () => {
    const { dir, c1, store, publish } = published();
    const id = publish('imports');
    const oldBlob = store.getClaim(dir, id)!.claim.evidence[0]!.blob;
    const c2 = commitFiles(dir, { 'src/app.ts': APP.replace("'1.0.0'", "'2.0.0'") });
    const r = reverifyOnCommit(store, dir, dir, c1, c2);
    expect(r.kept).toEqual([id]);
    const s = store.getClaim(dir, id)!;
    expect(s.status).toBe('verified');
    expect(s.claim.evidence[0]!.blob).not.toBe(oldBlob);
    expect(s.claim.evidence[0]!.blob).toBe(git(dir, 'rev-parse', `${c2}:src/app.ts`).trim());
  });

  it('a claim that becomes false is WITHDRAWN: out of the published list, with the reason, an event, and its section reported', () => {
    const { dir, c1, store, publish } = published();
    const quote = publish('quote');
    const keep = publish('config');
    const c2 = commitFiles(dir, { 'src/util.ts': 'export function helper(s: string): string {\n  return s;\n}\n' });
    const r = reverifyOnCommit(store, dir, dir, c1, c2);
    expect(r.kept).toEqual([keep]);
    expect(r.withdrawn).toEqual([{ id: quote, section: 'architecture', reason: expect.stringMatching(/quote is not on/) }]);
    expect(r.sections).toEqual(['architecture']);
    const rec = store.getClaim(dir, quote)!;
    expect(rec).toMatchObject({ status: 'withdrawn' });
    expect(rec.reason).toContain(c2);
    expect(rec.reason).toMatch(/quote is not on/);
    expect(store.listClaims(dir, { statuses: PUBLISHED_CLAIM_STATUSES }).map((s) => s.claim.id)).toEqual([keep]);
    const events = store.db.prepare(`SELECT payload FROM events WHERE type = 'claim.withdrawn'`).all() as Array<{ payload: string }>;
    expect(events.map((e) => JSON.parse(e.payload))).toEqual([expect.objectContaining({ id: quote, from: c1, to: c2 })]);
  });

  it('the lines moving (a line added above the quote) withdraws the claim: an off-by-one is not carried', () => {
    const { dir, c1, store, publish } = published();
    const id = publish('quote');
    const c2 = commitFiles(dir, { 'src/util.ts': '// a new first line\nexport function helper(s: string): string {\n  return s.trim();\n}\n' });
    const r = reverifyOnCommit(store, dir, dir, c1, c2);
    expect(r.withdrawn.map((w) => w.id)).toEqual([id]);
    expect(store.getClaim(dir, id)!.status).toBe('withdrawn');
  });

  it('a deleted cited file withdraws the claim', () => {
    const { dir, c1, store, publish } = published();
    const id = publish('exists');
    const c2 = commitFiles(dir, { 'docs/notes.md': null });
    const r = reverifyOnCommit(store, dir, dir, c1, c2);
    expect(r.withdrawn).toEqual([{ id, section: 'architecture', reason: expect.stringMatching(/not tracked/) }]);
  });

  it('config, dependency and command claims are withdrawn when the manifest value changes', () => {
    const { dir, c1, store, publish } = published();
    const ids = [publish('config'), publish('dependency'), publish('command')];
    const c2 = commitFiles(dir, {
      'tsconfig.json': json({ compilerOptions: { strict: false, target: 'ES2022' } }),
      'package.json': json({ name: 'demo', version: '1.0.0', scripts: { build: 'webpack', test: 'vitest run' }, dependencies: { lodash: '^5.0.0' }, devDependencies: { typescript: '^5.0.0' } }),
    });
    const r = reverifyOnCommit(store, dir, dir, c1, c2);
    expect(r.withdrawn.map((w) => w.id).sort()).toEqual([...ids].sort());
    expect(r.kept).toEqual([]);
  });

  it('an absence claim is checked again whenever the tree changes: a new occurrence in an unrelated file withdraws it', () => {
    const { dir, c1, store, publish } = published();
    const lit = publish('absence (literal)');
    const spec = publish('absence (import-specifier)');
    const c2 = commitFiles(dir, { 'src/new.ts': "// zz-not-here-zz\nimport m from 'moment';\nexport default m;\n" });
    const r = reverifyOnCommit(store, dir, dir, c1, c2);
    expect(r.withdrawn.map((w) => w.id).sort()).toEqual([lit, spec].sort());
    expect(store.listClaims(dir, { statuses: PUBLISHED_CLAIM_STATUSES })).toEqual([]);
  });

  it('an absence claim stays when an unrelated file is added', () => {
    const { dir, c1, store, publish } = published();
    const lit = publish('absence (literal)');
    const c2 = commitFiles(dir, { 'src/new.ts': 'export const n = 1;\n' });
    expect(reverifyOnCommit(store, dir, dir, c1, c2).kept).toEqual([lit]);
  });

  it('an attested claim is withdrawn when a cited file changes, and kept when none does', () => {
    const { dir, c1, store } = published();
    const quote = ClaimSchema.parse(validClaims(dir, c1).quote);
    const exists = ClaimSchema.parse(validClaims(dir, c1).exists);
    store.saveClaim({ repoPath: dir, claim: quote, status: 'attested', reason: 'attested by a person' });
    store.saveClaim({ repoPath: dir, claim: exists, status: 'attested', reason: 'attested by a person' });
    const c2 = commitFiles(dir, { 'src/util.ts': 'export function helper(s: string): string {\n  return s.trim();\n}\n// tail\n' });
    const r = reverifyOnCommit(store, dir, dir, c1, c2);
    expect(r.withdrawn.map((w) => w.id)).toEqual([quote.id]);
    expect(r.withdrawn[0]!.reason).toMatch(/attested again/);
    expect(r.kept).toEqual([exists.id]);
    expect(store.getClaim(dir, exists.id)).toMatchObject({ status: 'attested', commit: c2 });
  });

  it('only claims of the previous commit are touched; rejected and already-withdrawn claims stay as they are', () => {
    const { dir, c1, store, publish } = published();
    const id = publish('quote');
    const other = ClaimSchema.parse(validClaims(dir, c1).config);
    store.saveClaim({ repoPath: dir, claim: other, status: 'rejected', reason: 'earlier failure' });
    const c2 = commitFiles(dir, { 'src/util.ts': 'export {};\n' });
    reverifyOnCommit(store, dir, dir, c1, c2);
    expect(store.getClaim(dir, other.id)).toMatchObject({ status: 'rejected', reason: 'earlier failure', commit: c1 });
    // A second run from c1 finds nothing published at c1 any more.
    expect(reverifyOnCommit(store, dir, dir, c1, c2)).toMatchObject({ kept: [], withdrawn: [], sections: [] });
    expect(store.getClaim(dir, id)!.status).toBe('withdrawn');
  });

  it('chains across commits: kept at c2, then withdrawn at c3 when it stops being true', () => {
    const { dir, c1, store, publish } = published();
    const id = publish('quote');
    const c2 = commitFiles(dir, { 'README.md': 'x\n' });
    expect(reverifyOnCommit(store, dir, dir, c1, c2).kept).toEqual([id]);
    const c3 = commitFiles(dir, { 'src/util.ts': 'export {};\n' });
    expect(reverifyOnCommit(store, dir, dir, c2, c3).withdrawn.map((w) => w.id)).toEqual([id]);
  });

  it('is a no-op for the same commit, and refuses a commit that is not a full commit id; a failure leaves the claims as they were', () => {
    const { dir, c1, store, publish } = published();
    const id = publish('quote');
    expect(reverifyOnCommit(store, dir, dir, c1, c1)).toMatchObject({ kept: [], withdrawn: [] });
    expect(() => reverifyOnCommit(store, dir, dir, c1, 'HEAD')).toThrow(/full commit id/);
    expect(() => reverifyOnCommit(store, dir, dir, 'HEAD', c1)).toThrow(/full commit id/);
    expect(() => reverifyOnCommit(store, dir, dir, c1, 'f'.repeat(40))).toThrow(/not a commit/);
    expect(store.getClaim(dir, id)).toMatchObject({ status: 'verified', commit: c1 });
  });
});

describe('review round 1 (PR #12): findings from the first CodeRabbit pass', () => {
  const quoteClaim = (dir: string, c: string) => validClaims(dir, c).quote!;

  it('publishClaim returns the row it stored, even if another process withdraws the claim right after the commit', () => {
    const dir = newRepo();
    const c = head(dir);
    const input = quoteClaim(dir, c);
    const store = openStore();
    // A second writer that withdraws the claim the moment this call's transaction has committed.
    const racing = new Proxy(store, {
      get(target, prop) {
        if (prop === 'transaction') {
          return <T>(fn: () => T): T => {
            const r = target.transaction(fn);
            target.withdrawClaim(dir, input.id as string, 'withdrawn by another process');
            return r;
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const out = publishClaim(racing, dir, dir, input);
    expect(out.published).toBe(true);
    if (out.published) expect(out.claim.status).toBe('verified');
  });

  describe('manifests are strict JSON; JSONC is only for the configuration files that allow it', () => {
    const lineOfBuild = (text: string) => splitLines(text).findIndex((l) => l.includes('"build"')) + 1;
    const commandClaim = (d: string, c: string, manifest: string) =>
      claim({ kind: 'command', evidence: [ev(d, c, 'package.json', lineOfBuild(manifest))], verifier: { kind: 'command', script: 'build', command: 'tsc' } });

    it('a package.json with a trailing comma, or a comment, proves nothing', () => {
      for (const manifest of ['{\n  "scripts": {\n    "build": "tsc",\n  },\n}\n', '{\n  // note\n  "scripts": {\n    "build": "tsc"\n  }\n}\n']) {
        const d = newRepo({ 'package.json': manifest });
        const c = head(d);
        const out = publishClaim(openStore(), d, d, commandClaim(d, c, manifest));
        expect(out.published, manifest).toBe(false);
        if (!out.published) expect(out.reason).toMatch(/not valid JSON/);
      }
    });

    it('a strict package.json (with a byte order mark) is accepted', () => {
      const manifest = '\ufeff{\n  "scripts": {\n    "build": "tsc"\n  }\n}\n';
      const d = newRepo({ 'package.json': manifest });
      const out = publishClaim(openStore(), d, d, commandClaim(d, head(d), manifest));
      expect(out.published, out.published ? '' : out.reason).toBe(true);
    });

    it('a tsconfig.json with comments and a trailing comma is still read', () => {
      const text = '{\n  // strict mode\n  "compilerOptions": {\n    "strict": true,\n  },\n}\n';
      const d = newRepo({ 'tsconfig.json': text, 'other.json': text });
      const c = head(d);
      const mk = (path: string) => claim({ kind: 'config', evidence: [ev(d, c, path, 4)], verifier: { kind: 'config', path, key: ['compilerOptions', 'strict'], value: true } });
      expect(publishClaim(openStore(), d, d, mk('tsconfig.json')).published).toBe(true);
      // A .json file that is not a known JSONC configuration is judged as the JSON it is named.
      expect(publishClaim(openStore(), d, d, mk('other.json')).published).toBe(false);
    });
  });

  describe('a parser limit is "unconfirmed", an invalid file is not', () => {
    const deep = (n: number) => `${'['.repeat(n)}${']'.repeat(n)}`;
    it('valid JSON nested past the parser limit, with the cited member correct, is unconfirmed', () => {
      const text = `{"scripts":{"build":"tsc"},"deep":${deep(200)}}\n`;
      const d = newRepo({ 'package.json': text, 'tsconfig.json': `{"compilerOptions":{"strict":true},"deep":${deep(200)}}\n` });
      const c = head(d);
      const cmd = claim({ kind: 'command', evidence: [ev(d, c, 'package.json', 1)], verifier: { kind: 'command', script: 'build', command: 'tsc' } });
      const cfg = claim({ kind: 'config', evidence: [ev(d, c, 'tsconfig.json', 1)], verifier: { kind: 'config', path: 'tsconfig.json', key: ['compilerOptions', 'strict'], value: true } });
      for (const k of [cmd, cfg]) {
        const out = publishClaim(openStore(), d, d, k);
        expect(out).toMatchObject({ published: false, unconfirmed: true });
        if (!out.published) expect(out.reason).toMatch(/nested too deeply/);
      }
    });

    it('a number out of range is unconfirmed; a syntax error is a definite failure; a value mismatch stays definite', () => {
      const d = newRepo({ 'big.json': '{"a": 1e400, "b": true}\n', 'bad.json': '{"b": true,,}\n', 'ok.json': '{"b": true}\n' });
      const c = head(d);
      const mk = (path: string, value: unknown) => claim({ kind: 'config', evidence: [ev(d, c, path, 1)], verifier: { kind: 'config', path, key: ['b'], value } });
      expect(publishClaim(openStore(), d, d, mk('big.json', true))).toMatchObject({ published: false, unconfirmed: true });
      expect(publishClaim(openStore(), d, d, mk('bad.json', true))).toMatchObject({ published: false, unconfirmed: false });
      expect(publishClaim(openStore(), d, d, mk('ok.json', false))).toMatchObject({ published: false, unconfirmed: false });
    });
  });

  it('a call chain with tens of thousands of segments does not exhaust the stack', () => {
    const d = newRepo({ 'long.ts': `a${'.b'.repeat(30000)}();\n` });
    const c = head(d);
    const k = claim({ kind: 'calls', evidence: [ev(d, c, 'long.ts', 1)], verifier: { kind: 'calls', path: 'long.ts', callee: 'a.b' } });
    const v = verifyClaim(new CommitReader(d, c), k);
    expect(v.ok).toBe(false); // either "no such call" or "cannot be parsed": it must be an answer, not a thrown RangeError
    expect(() => publishClaim(openStore(), d, d, k)).not.toThrow();
  });

  it('a callee is bounded, so a claim cannot ask for an unbounded name', () => {
    const d = newRepo();
    const c = head(d);
    const k = claim({ kind: 'calls', evidence: [ev(d, c, 'src/app.ts', 7)], verifier: { kind: 'calls', path: 'src/app.ts', callee: `a${'.b'.repeat(500)}` } });
    expect(ClaimSchema.safeParse(k).success).toBe(false);
  });

  it('a "__proto__" key in the expected value is refused before parsing; no row is written and nothing is proven', () => {
    const d = newRepo({ 'c.json': '{"a": {}}\n' });
    const c = head(d);
    const raw = JSON.parse(
      `{"id":"proto1","section":"architecture","statement":"A","kind":"config","evidence":[${JSON.stringify(ev(d, c, 'c.json', 1))}],"verifier":{"kind":"config","path":"c.json","key":["a"],"value":{"__proto__":1}}}`,
    ) as unknown;
    const store = openStore();
    const out = publishClaim(store, d, d, raw);
    expect(out).toMatchObject({ published: false, recorded: false });
    if (!out.published) expect(out.reason).toMatch(/__proto__/);
    expect(store.listClaims(d)).toEqual([]);
    expect(verifyClaim(new CommitReader(d, c), raw)).toMatchObject({ ok: false });
    // An ordinary expected value still passes unchanged.
    const ok = claim({ kind: 'config', evidence: [ev(d, c, 'c.json', 1)], verifier: { kind: 'config', path: 'c.json', key: ['a'], value: {} } });
    expect(publishClaim(store, d, d, ok).published).toBe(true);
  });

  it('a claim nested too deeply to parse is an answer, not a thrown RangeError', () => {
    const d = newRepo({ 'c.json': '{"a": 1}\n' });
    const c = head(d);
    let value: unknown = 1;
    for (let i = 0; i < 20000; i++) value = [value];
    const raw = { id: 'deep1', section: 'architecture', statement: 'A', kind: 'config', evidence: [ev(d, c, 'c.json', 1)], verifier: { kind: 'config', path: 'c.json', key: ['a'], value } };
    const out = publishClaim(openStore(), d, d, raw);
    expect(out).toMatchObject({ published: false, recorded: false });
    expect(verifyClaim(new CommitReader(d, c), raw).ok).toBe(false);
  });

  it('import-specifier absence refuses when a submodule is in scope, as the literal pattern does', () => {
    const d = newRepo({ 'a.ts': 'export const a = 1;\n' });
    git(d, 'update-index', '--add', '--cacheinfo', `160000,${head(d)},vendor/lib`);
    git(d, 'commit', '-qm', 'add a gitlink');
    const cm = head(d);
    const absence = (exclude: string[]) =>
      claim({ kind: 'absence', statement: 'Nothing imports moment', evidence: [ev(d, cm, 'a.ts')], verifier: { kind: 'absence', pattern: { type: 'import-specifier', specifier: 'moment' }, exclude } });
    expect(verifyClaim(new CommitReader(d, cm), absence([]))).toMatchObject({ ok: false, unconfirmed: true });
    expect(verifyClaim(new CommitReader(d, cm), absence(['vendor/lib/'])).ok).toBe(true);
  });

  it('absence over a very large number of paths that share one blob is linear and reports every path', () => {
    const d = newRepo({ 'a.txt': 'x\n' });
    const id = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: d, input: 'needle-text\n', encoding: 'utf8' }).stdout.trim();
    const N = 150_000;
    const lines: string[] = [];
    for (let i = 0; i < N; i++) lines.push(`100644 ${id} 0\tmany/f${i}.txt`);
    const r = spawnSync('git', ['update-index', '--add', '--index-info'], { cwd: d, input: `${lines.join('\n')}\n`, encoding: 'utf8', maxBuffer: 1 << 28 });
    expect(r.status, r.stderr).toBe(0);
    git(d, 'commit', '-qm', 'many paths');
    const cm = head(d);
    const k = claim({ kind: 'absence', statement: 'No needle', evidence: [ev(d, cm, 'a.txt')], verifier: { kind: 'absence', pattern: { type: 'literal', text: 'needle-text' } } });
    const started = Date.now();
    const v = verifyClaim(new CommitReader(d, cm), k);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(new RegExp(`occurs in ${N} file\\(s\\)`));
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 120_000);

  it('saveClaim refuses an empty repository path, so a successful write is always readable', () => {
    const dir = newRepo();
    const store = openStore();
    const parsed = ClaimSchema.parse(quoteClaim(dir, head(dir)));
    expect(() => store.saveClaim({ repoPath: '', claim: parsed, status: 'verified', reason: 'proof' })).toThrow(/repository path/);
    expect(store.listClaims('')).toEqual([]);
  });

  it('fixture repositories commit even when the developer signs commits globally with an unavailable key', () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-claims-gpg-'));
    dirs.push(root);
    const globalConfig = join(root, 'gitconfig');
    writeFileSync(globalConfig, '[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = /usr/bin/false\n');
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      expect(() => newRepo()).not.toThrow();
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
  });

  it('every row of a table in IMPLEMENTATION_STATUS.md has as many cells as its header (an unescaped "|" splits a cell)', () => {
    const lines = readFileSync(resolve(here, '../../docs/IMPLEMENTATION_STATUS.md'), 'utf8').split('\n');
    const cells = (l: string) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).length;
    let header = 0;
    let checked = 0;
    for (const [i, l] of lines.entries()) {
      if (!l.trimStart().startsWith('|')) {
        header = 0;
        continue;
      }
      if (!header) header = cells(l);
      else {
        expect(cells(l), `line ${i + 1}: ${l.slice(0, 60)}`).toBe(header);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe('review round 2 (PR #12): findings from the local CodeRabbit review', () => {
  it('a failed or unconfirmed verifier never leaves a "verified" row, whatever the claim (behavioural)', () => {
    const d = newRepo({ 'ok.ts': "import a from 'a';\n", 'broken.ts': "import { b from 'b';\n" });
    const c = head(d);
    const store = openStore();
    const falseOne = claim({ kind: 'imports', evidence: [ev(d, c, 'ok.ts', 1)], verifier: { kind: 'imports', from: 'ok.ts', specifier: 'zzz' } });
    const unconfirmedOne = claim({ kind: 'imports', evidence: [ev(d, c, 'broken.ts', 1)], verifier: { kind: 'imports', from: 'broken.ts', specifier: 'b' } });
    expect(publishClaim(store, d, d, falseOne)).toMatchObject({ published: false, recorded: true, unconfirmed: false });
    expect(publishClaim(store, d, d, unconfirmedOne)).toMatchObject({ published: false, recorded: true, unconfirmed: true });
    expect(store.listClaims(d).map((s) => s.status)).toEqual(['rejected', 'rejected']);
    expect(store.listClaims(d, { statuses: ['verified'] })).toEqual([]);
  });

  describe('imports the scanner could not read are "unconfirmed", not disproven', () => {
    const run = (text: string, specifier: string, line = 1) => {
      const d = newRepo({ 'm.js': text });
      const cm = head(d);
      return publishClaim(openStore(), d, d, claim({ kind: 'imports', evidence: [ev(d, cm, 'm.js', line)], verifier: { kind: 'imports', from: 'm.js', specifier } }));
    };

    it('a top-level require next to a parameter named require', () => {
      const out = run("const x = require('pkg');\nfunction f(require) { return require; }\n", 'pkg');
      expect(out).toMatchObject({ published: false, unconfirmed: true });
    });

    it('an import whose specifier is written with an escape', () => {
      const out = run("import '\\u0066oo';\n", 'foo');
      expect(out).toMatchObject({ published: false, unconfirmed: true });
    });

    it('an import that is independently proven is still accepted, and a plain miss is still a definite failure', () => {
      expect(run("import '\\u0066oo';\nimport bar from 'bar';\n", 'bar', 2).published).toBe(true);
      expect(run("import 'foo';\n", 'zzz')).toMatchObject({ published: false, unconfirmed: false });
    });

    it('the same holds for the import a dependency claim cites', () => {
      const manifest = '{\n  "dependencies": {\n    "pkg": "^1.0.0"\n  }\n}\n';
      const d = newRepo({ 'package.json': manifest, 'm.js': "import '\\u0070kg';\n" });
      const cm = head(d);
      const out = publishClaim(
        openStore(),
        d,
        d,
        claim({
          kind: 'dependency',
          evidence: [ev(d, cm, 'package.json', 3), ev(d, cm, 'm.js', 1)],
          verifier: { kind: 'dependency', section: 'dependencies', name: 'pkg', spec: '^1.0.0', usedIn: 'm.js' },
        }),
      );
      expect(out).toMatchObject({ published: false, unconfirmed: true });
    });
  });

  describe('reverifyOnCommit compares what the tree holds, not what git diff reports', () => {
    it('a mode-only change (644 to 755) keeps an attestation: the blob did not change', () => {
      const dir = newRepo();
      const c1 = head(dir);
      const store = openStore();
      const exists = ClaimSchema.parse(validClaims(dir, c1).exists);
      store.saveClaim({ repoPath: dir, claim: exists, status: 'attested', reason: 'attested by a person' });
      git(dir, 'update-index', '--chmod=+x', 'docs/notes.md');
      git(dir, 'commit', '-qm', 'make it executable');
      const c2 = head(dir);
      expect(git(dir, 'rev-parse', `${c1}:docs/notes.md`)).toBe(git(dir, 'rev-parse', `${c2}:docs/notes.md`)); // same blob
      const r = reverifyOnCommit(store, dir, dir, c1, c2);
      expect(r.withdrawn).toEqual([]);
      expect(r.kept).toEqual([exists.id]);
      expect(store.getClaim(dir, exists.id)).toMatchObject({ status: 'attested', commit: c2 });
    });

    it('thousands of cited paths do not overflow the command line (and a path missing from a tree is a change)', () => {
      const dir = newRepo();
      const c1 = head(dir);
      const store = openStore();
      const template = ClaimSchema.parse(validClaims(dir, c1).exists);
      const blob = template.evidence[0]!.blob;
      const N = 8000;
      store.transaction(() => {
        for (let i = 0; i < N; i++) {
          const path = `cited/d${i}/${'x'.repeat(380)}.ts`; // about 400 bytes each: over 3 MB of arguments in all
          const k = ClaimSchema.parse({ ...template, id: `many${i}`, evidence: [{ path, commit: c1, blob }], verifier: { kind: 'exists', path } });
          store.saveClaim({ repoPath: dir, claim: k, status: 'attested', reason: 'attested by a person' });
        }
      });
      const c2 = commitFiles(dir, { 'README.md': '# readme\n' });
      const r = reverifyOnCommit(store, dir, dir, c1, c2);
      expect(r.withdrawn).toHaveLength(N); // none of those paths exists at either commit
      expect(store.listClaims(dir, { statuses: PUBLISHED_CLAIM_STATUSES })).toEqual([]);
    }, 120_000);
  });

  it('an integer beyond 2^53, which the JSON reader would round, is "unconfirmed"; ordinary integers verify', () => {
    const d = newRepo({ 'n.json': '{"big": 9007199254740993, "ok": 42, "neg": -9007199254740993}\n' });
    const c = head(d);
    const mk = (key: string, value: unknown) => claim({ kind: 'config', evidence: [ev(d, c, 'n.json', 1)], verifier: { kind: 'config', path: 'n.json', key: [key], value } });
    // The rounded value of 9007199254740993 is 9007199254740992: it must not be taken as a match, nor as a mismatch.
    expect(publishClaim(openStore(), d, d, mk('big', 9007199254740992))).toMatchObject({ published: false, unconfirmed: true });
    expect(publishClaim(openStore(), d, d, mk('big', Number.MAX_SAFE_INTEGER + 2))).toMatchObject({ published: false, unconfirmed: true });
    expect(publishClaim(openStore(), d, d, mk('ok', 42)).published).toBe(true);
  });

  it('the expected-value limit is counted in UTF-8 bytes, not UTF-16 code units', () => {
    const d = newRepo({ 'c.json': '{"a": 1}\n' });
    const c = head(d);
    const mk = (value: unknown) => ({ id: `big${counter++}`, section: 'architecture', statement: 'A', kind: 'config', evidence: [ev(d, c, 'c.json', 1)], verifier: { kind: 'config', path: 'c.json', key: ['a'], value } });
    expect(ClaimSchema.safeParse(mk('€'.repeat(30000))).success).toBe(false); // 30,000 characters, about 90,000 bytes
    expect(ClaimSchema.safeParse(mk('€'.repeat(10000))).success).toBe(true); // about 30,000 bytes
  });

  describe('a directory exclusion covers what is under it and a gitlink there, not a regular file of that name', () => {
    it('a regular file named like the excluded directory is still searched', () => {
      const d = newRepo({ vendor: 'zz-forbidden-zz\n', 'a.txt': 'hello\n' });
      const cm = head(d);
      const k = (exclude: string[]) =>
        claim({ kind: 'absence', statement: 'No marker', evidence: [ev(d, cm, 'a.txt')], verifier: { kind: 'absence', pattern: { type: 'literal', text: 'zz-forbidden-zz' }, exclude } });
      const v = verifyClaim(new CommitReader(d, cm), k(['vendor/']));
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(/vendor/);
      // Excluding that exact file is a different, explicit statement and still works.
      expect(verifyClaim(new CommitReader(d, cm), k(['vendor'])).ok).toBe(true);
    });

    it('a directory exclusion still covers files under it', () => {
      const d = newRepo({ 'vendor/x.txt': 'zz-forbidden-zz\n', 'a.txt': 'hello\n' });
      const cm = head(d);
      const k = claim({
        kind: 'absence',
        statement: 'No marker',
        evidence: [ev(d, cm, 'a.txt')],
        verifier: { kind: 'absence', pattern: { type: 'literal', text: 'zz-forbidden-zz' }, exclude: ['vendor/'] },
      });
      expect(verifyClaim(new CommitReader(d, cm), k).ok).toBe(true);
    });

    it('a directory replaced by a file between commits withdraws the absence claim on reverify', () => {
      const d = newRepo({ 'vendor/x.txt': 'fine\n', 'a.txt': 'hello\n' });
      const c1 = head(d);
      const store = openStore();
      const k = claim({
        kind: 'absence',
        statement: 'No marker',
        evidence: [ev(d, c1, 'a.txt')],
        verifier: { kind: 'absence', pattern: { type: 'literal', text: 'zz-forbidden-zz' }, exclude: ['vendor/'] },
      });
      expect(publishClaim(store, d, d, k).published).toBe(true);
      const c2 = commitFiles(d, { 'vendor/x.txt': null, vendor: 'zz-forbidden-zz\n' });
      const r = reverifyOnCommit(store, d, d, c1, c2);
      expect(r.withdrawn.map((w) => w.id)).toEqual([k.id]);
    });
  });

  it('a reader holds a bounded amount of blob data however many files are read', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`big/f${i}.txt`] = `${String(i).repeat(1024)}\n`.repeat(5 * 1024); // about 5 MiB each, all different
    const d = newRepo(files);
    const reader = new CommitReader(d, head(d));
    for (let i = 0; i < 10; i++) expect(reader.bytes(`big/f${i}.txt`).ok).toBe(true);
    expect(reader.cachedBytes()).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(reader.cachedBytes()).toBeGreaterThan(0);
    // An evicted blob is read again, not lost.
    expect(reader.bytes('big/f0.txt')).toMatchObject({ ok: true });
  });

  it('listClaims keeps the order in which each id was first stored, even when an earlier claim is saved again', () => {
    const dir = newRepo();
    const c = head(dir);
    const store = openStore();
    const a = ClaimSchema.parse(validClaims(dir, c).quote);
    const b = ClaimSchema.parse(validClaims(dir, c).exists);
    store.saveClaim({ repoPath: dir, claim: a, status: 'verified', reason: 'proof' });
    store.saveClaim({ repoPath: dir, claim: b, status: 'verified', reason: 'proof' });
    store.saveClaim({ repoPath: dir, claim: a, status: 'verified', reason: 'proof again' });
    expect(store.listClaims(dir).map((s) => s.claim.id)).toEqual([a.id, b.id]);
  });

  it('fixture repositories commit despite a global pre-commit hook that fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-claims-hook-'));
    dirs.push(root);
    const hooks = join(root, 'hooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const globalConfig = join(root, 'gitconfig');
    writeFileSync(globalConfig, `[core]\n\thooksPath = ${hooks}\n\tautocrlf = true\n`);
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      const d = newRepo({ 'a.txt': 'a\r\nb\r\n' });
      // And a global autocrlf=true did not turn the committed CRLF into LF.
      expect(spawnSync('git', ['cat-file', 'blob', `${head(d)}:a.txt`], { cwd: d, encoding: 'latin1' }).stdout).toBe('a\r\nb\r\n');
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
  });
});
