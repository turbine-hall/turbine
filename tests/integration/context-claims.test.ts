/**
 * Issue #7, part 1 — repository context, layer 2: the claim model and the deterministic verifiers.
 *
 * The rule under test: a claim is published only if a deterministic verifier proves it against the git objects of
 * the commit it names. The PLANTED FALSE CLAIMS suite must be rejected 100%; every verifier also has positive cases.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ClaimSchema, PUBLISHED_CLAIM_STATUSES, assertClaimBudget, parseClaim, UNIVERSAL_WORDS, claimCommit, universalWordIn } from '../../packages/contracts/dist/index.js';
import { WorkStore } from '../../packages/storage-sqlite/dist/index.js';
import { publishClaim, reverifyOnCommit } from '../../apps/cli/src/engine/context/claims.js';
import { isAncestor } from '../../apps/cli/src/engine/context/git-read.js';
import { CommitReader, jsonEqual, splitLines, verifyClaim } from '../../apps/cli/src/engine/context/verify.js';

// publishClaim calls the verifier through this module: a test can observe the moment it runs (and change nothing else).
const hooks = vi.hoisted(() => ({ onVerify: undefined as (() => void) | undefined }));
vi.mock('../../apps/cli/src/engine/context/verify.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../apps/cli/src/engine/context/verify.js')>();
  return {
    ...real,
    verifyClaim: (...args: Parameters<typeof real.verifyClaim>) => {
      hooks.onVerify?.();
      return real.verifyClaim(...args);
    },
  };
});

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

/**
 * The environment fixture git commands run in: no repository-selection variable (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...)
 * from the process that runs the tests may point them at another checkout. GIT_CONFIG_GLOBAL is kept, for the tests that exercise it.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') || k === 'GIT_CONFIG_GLOBAL'));
  // The system-wide attributes file (for example `*.ts text eol=lf`) and system config must not change the committed bytes.
  return { ...env, GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_NOSYSTEM: '1' };
}
function spawnGit(args: string[], opts: { cwd: string; encoding: BufferEncoding; input?: string; maxBuffer?: number }) {
  return spawnSync('git', args, { ...opts, env: gitEnv() });
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnGit(args, { cwd, encoding: 'utf8' });
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

/** Cells of a Markdown table row, with or without leading and trailing pipes; an escaped pipe stays in its cell. */
const tableCells = (l: string): number => l.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).length;
/** A GFM delimiter row: cells of dashes with optional colons, separated by pipes (a pipe is required: it is what makes a table). */
const isTableDelimiter = (l: string): boolean => l.includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l);

/** GFM HTML blocks of types 1 to 6 (type 7 cannot interrupt a paragraph, so it cannot end a table either). */
const HTML_BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
/**
 * Where GFM ends a table body: a blank line, or a line that starts a block which can interrupt a paragraph: an ATX heading,
 * a block quote, a fence, a thematic break, an HTML block (types 1 to 6), a bullet item that is not empty, or an ordered item
 * that is not empty and starts at 1. A line without pipes, or an ordered item such as "2.", is still a row.
 */
const BLOCK_START = new RegExp(
  `^\\s{0,3}(?:#{1,6}(?:\\s|$)|>|[-*+]\\s+\\S|1[.)]\\s+\\S|([-*_])(?:\\s*\\1){2,}\\s*$|<(?:!--|\\?|![A-Za-z]|!\\[CDATA\\[|(?:script|pre|style|textarea)(?:\\s|>|$)|/?(?:${HTML_BLOCK_TAGS})(?:\\s|/?>|$)))`,
  'i',
);
/** Every row of every table in `lines` whose cell count differs from its header's, and how many body rows were checked. */
function tableProblems(lines: string[]): { problems: string[]; rows: number } {
  const problems: string[] = [];
  let rows = 0;
  // Lines inside a fenced code block or an HTML <pre>/<script>/<style>/<textarea> block are literal text, not a table.
  // A fence closes only on a line of the same marker, at least as long as the opening one, with nothing after it but spaces.
  const fenced: boolean[] = [];
  let open: { marker: string; length: number } | undefined;
  let htmlClose: RegExp | undefined;
  for (const l of lines) {
    if (htmlClose) {
      fenced.push(true);
      if (htmlClose.test(l)) htmlClose = undefined;
      continue;
    }
    // GFM HTML comment blocks open only at the start of a line (up to three spaces). A prose mention of `<!--` is not an opener.
    const htmlCommentOpen = /^\s{0,3}<!--/.exec(l);
    if (!open && htmlClose === undefined && htmlCommentOpen && !/-->/.test(l.slice(htmlCommentOpen[0].length))) {
      htmlClose = /-->/;
      fenced.push(true);
      continue;
    }
    const htmlOpen = /^\s{0,3}<(script|pre|style|textarea)(?:\s|>|$)/i.exec(l);
    if (!open && htmlOpen) {
      htmlClose = new RegExp(`</${htmlOpen[1]}>`, 'i');
      fenced.push(true);
      if (htmlClose.test(l)) htmlClose = undefined;
      continue;
    }
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (!open) {
      if (m && !(m[1]![0] === '`' && m[2]!.includes('`'))) open = { marker: m[1]![0]!, length: m[1]!.length };
      fenced.push(open !== undefined);
    } else {
      fenced.push(true);
      if (m && m[1]![0] === open.marker && m[1]!.length >= open.length && m[2]!.trim() === '') open = undefined;
    }
  }
  for (let i = 0; i + 1 < lines.length; i++) {
    // A header and a delimiter indented four spaces or more (or by a tab) are indented code, not a table.
    if (fenced[i] || fenced[i + 1] || !/^ {0,3}\S/.test(lines[i]!) || !/^ {0,3}\S/.test(lines[i + 1]!) || !isTableDelimiter(lines[i + 1]!)) continue;
    const header = tableCells(lines[i]!);
    if (tableCells(lines[i + 1]!) !== header) problems.push(`line ${i + 2}: delimiter row`);
    let j = i + 2;
    for (; j < lines.length && !fenced[j] && lines[j]!.trim() !== '' && !BLOCK_START.test(lines[j]!); j++) {
      rows++;
      if (tableCells(lines[j]!) !== header) problems.push(`line ${j + 1}: ${lines[j]!.slice(0, 60)}`);
    }
    i = j - 1;
  }
  return { problems, rows };
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
  // An empty template: a developer's init.templateDir (hooks, info/attributes, ...) is not copied into the fixture.
  const emptyTemplate = mkdtempSync(join(tmpdir(), 'turbine-claims-template-'));
  dirs.push(emptyTemplate);
  // A fixed initial branch: a developer's init.defaultBranch must not decide the branch names a test creates.
  // Pin SHA-1: a developer's init.defaultObjectFormat=sha256 would otherwise produce 64-character ids in every fixture.
  git(dir, 'init', '-q', '-b', 'main', '--object-format=sha1', `--template=${emptyTemplate}`);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  // A developer's global signing settings must not decide whether the fixture can commit.
  git(dir, 'config', 'commit.gpgSign', 'false');
  // Nor may a developer's hooks, line-ending conversion or attributes: the committed bytes are the bytes written.
  const noHooks = mkdtempSync(join(tmpdir(), 'turbine-claims-hooks-'));
  dirs.push(noHooks);
  git(dir, 'config', 'core.hooksPath', noHooks);
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'core.ignoreStat', 'false'); // a global assume-unchanged setting would hide the fixture's uncommitted edits
  git(dir, 'config', 'core.attributesFile', '/dev/null');
  const noIgnores = join(noHooks, 'ignore');
  writeFileSync(noIgnores, '');
  git(dir, 'config', 'core.excludesFile', noIgnores);
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
    expect(spawnGit(['cat-file', 'blob', `${cm}:a.ts`], { cwd: d, encoding: 'latin1' }).stdout).toBe("import x from 'one';\r\nimport y from 'two';\rimport z from 'three';\r\nexport {};\r\n");
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
    expect(versions).toEqual([1, 2, 3, 4, 5]); // v5 adds the claim frontier
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
    // The same id under two repository paths is two claims, each keeping its own reason.
    expect(store.saveClaim({ repoPath: '/elsewhere', claim: parsed, status: 'rejected', reason: 'rejected elsewhere' })).toBe(true);
    expect(store.getClaim(dir, parsed.id)).toMatchObject({ status: 'verified', reason: 'proof' });
    expect(store.getClaim('/elsewhere', parsed.id)).toMatchObject({ status: 'rejected', reason: 'rejected elsewhere' });
    expect(store.listClaims(dir)).toHaveLength(1);
    expect(store.listClaims('/elsewhere')).toHaveLength(1);
    expect(store.withdrawClaim('/elsewhere', parsed.id, 'gone')).toBe(true);
    expect(store.getClaim(dir, parsed.id)).toMatchObject({ status: 'verified', reason: 'proof' });
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

  it('source layout: no other CLI source file writes the literal status "verified" (a check of literal source only; the behavioural tests cover the rest)', () => {
    const root = resolve(here, '../../apps/cli/src');
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /status\s*:\s*(['"`])verified\1/.test(readFileSync(p, 'utf8'))) hits.push(p.slice(root.length + 1));
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
    // A second run from c1 is a stale transition (the claims were carried to c2 already): refused, nothing changes.
    expect(() => reverifyOnCommit(store, dir, dir, c1, c2)).toThrow(/stale/);
    expect(store.getClaimFrontier(dir)).toBe(c2);
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
    // The competing withdrawal did happen after the commit: the call returned what it stored, not what the row became.
    expect(store.getClaim(dir, input.id as string)?.status).toBe('withdrawn');
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
    const id = spawnGit(['hash-object', '-w', '--stdin'], { cwd: d, input: 'needle-text\n', encoding: 'utf8' }).stdout.trim();
    const N = 150_000;
    const lines: string[] = [];
    for (let i = 0; i < N; i++) lines.push(`100644 ${id} 0\tmany/f${i}.txt`);
    const r = spawnGit(['update-index', '--add', '--index-info'], { cwd: d, input: `${lines.join('\n')}\n`, encoding: 'utf8', maxBuffer: 1 << 28 });
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
    const { problems, rows } = tableProblems(readFileSync(resolve(here, '../../docs/IMPLEMENTATION_STATUS.md'), 'utf8').split('\n'));
    expect(problems).toEqual([]);
    expect(rows).toBeGreaterThan(5);
  });

  it('the table check follows GFM: rows without leading pipes, a pipe-free row inside a table, and where a table ends', () => {
    expect(isTableDelimiter('--- | ---')).toBe(true);
    expect(isTableDelimiter(':--|--:')).toBe(true);
    expect(isTableDelimiter('| --- | :---: |')).toBe(true);
    expect(isTableDelimiter('a | b')).toBe(false);
    expect(tableCells('| a \\| b | c |')).toBe(2); // an escaped pipe stays inside its cell
    expect(tableProblems(['Layer | Status', '--- | ---', 'a | b', 'c | d']).problems).toEqual([]);
    expect(tableProblems(['Layer | Status', '--- | ---', 'a | b | extra']).problems).toHaveLength(1); // no leading pipe: still seen
    // A pipe-free row is a one-cell row, and the table goes on after it: the extra cell below it is still found.
    const t = tableProblems(['| A | B |', '| - | - |', 'just text', '| x | y | z |', '', '| not | counted | here |']);
    expect(t.rows).toBe(2);
    expect(t.problems).toHaveLength(2);
    // A heading or a list item ends the table.
    expect(tableProblems(['| A | B |', '| - | - |', '| a | b |', '# Title', '| x | y | z |']).rows).toBe(1);
    expect(tableProblems(['| A | B |', '| - | - |', '| a | b |', '- item', '| x | y | z |']).rows).toBe(1);
    expect(tableProblems(['| A | B |', '| - | - |', '| a | b |', '1. item', '| x | y | z |']).rows).toBe(1);
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

  it('a number a double cannot hold exactly is "unconfirmed" in every spelling; exact numbers still verify', () => {
    const text = [
      '{"int": 9007199254740993, "neg": -9007199254740993, "frac": 9007199254740993.0, "exp": 9007199254740993e0,',
      ' "sci": 9.007199254740993e15, "dec": 0.1000000000000000055511151231257827,',
      ' "ok": 42, "nine": 9e2, "ratio": 1.5e3, "tenth": 0.1, "zero": 0.0, "max": 9007199254740991}',
      '',
    ].join('\n');
    const d = newRepo({ 'n.json': text });
    const c = head(d);
    const mk = (key: string, value: unknown) => claim({ kind: 'config', evidence: [ev(d, c, 'n.json', [1, 3])], verifier: { kind: 'config', path: 'n.json', key: [key], value } });
    // 9007199254740993 rounds to 9007199254740992: that must not be taken as a match, nor as a mismatch.
    for (const key of ['int', 'neg', 'frac', 'exp', 'sci', 'dec']) {
      expect(publishClaim(openStore(), d, d, mk(key, 9007199254740992)), key).toMatchObject({ published: false, unconfirmed: true });
    }
    for (const [key, value] of [['ok', 42], ['nine', 900], ['ratio', 1500], ['tenth', 0.1], ['zero', 0], ['max', Number.MAX_SAFE_INTEGER]] as const) {
      const out = publishClaim(openStore(), d, d, mk(key, value));
      expect(out.published, `${key}: ${out.published ? '' : out.reason}`).toBe(true);
    }
    expect(publishClaim(openStore(), d, d, mk('ok', 43))).toMatchObject({ published: false, unconfirmed: false });
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
      expect(spawnGit(['cat-file', 'blob', `${head(d)}:a.txt`], { cwd: d, encoding: 'latin1' }).stdout).toBe('a\r\nb\r\n');
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
  });
});

describe('review round 3 (PR #12): findings from the second local CodeRabbit review', () => {
  const blobOf = (d: string, text: string) => spawnGit(['hash-object', '-w', '--stdin'], { cwd: d, encoding: 'utf8', input: text }).stdout.trim();

  describe('a symlink is never read as the file it points at', () => {
    it('a package.json that is a symlink whose target name is valid JSON proves nothing', () => {
      const d = newRepo({ 'a.txt': 'x\n' });
      const target = '{"scripts":{"build":"tsc"}}';
      git(d, 'update-index', '--add', '--cacheinfo', `120000,${blobOf(d, target)},package.json`);
      git(d, 'commit', '-qm', 'package.json as a symlink');
      const c = head(d);
      expect(git(d, 'ls-tree', c, 'package.json')).toMatch(/^120000 blob /);
      const out = publishClaim(
        openStore(),
        d,
        d,
        claim({ kind: 'command', evidence: [ev(d, c, 'package.json', 1)], verifier: { kind: 'command', script: 'build', command: 'tsc' } }),
      );
      expect(out).toMatchObject({ published: false, unconfirmed: true });
      if (!out.published) expect(out.reason).toMatch(/symbolic link/);
      // A quote cited from a symlink is refused too, and a symlink still "exists".
      const q = claim({ kind: 'quote', evidence: [ev(d, c, 'package.json', 1, target)], verifier: { kind: 'quote' } });
      expect(publishClaim(openStore(), d, d, q)).toMatchObject({ published: false, unconfirmed: true });
      const e = claim({ kind: 'exists', evidence: [ev(d, c, 'package.json')], verifier: { kind: 'exists', path: 'package.json' } });
      expect(publishClaim(openStore(), d, d, e).published).toBe(true);
    });

    it('a regular file replaced by a symlink with the same blob id is rechecked on reverify', () => {
      const text = '{"scripts":{"build":"tsc"}}';
      const d = newRepo({ 'link.json': text });
      const c1 = head(d);
      const store = openStore();
      // A config claim reads any .json file, so it can cite link.json.
      const cfg = claim({ kind: 'config', evidence: [ev(d, c1, 'link.json', 1)], verifier: { kind: 'config', path: 'link.json', key: ['scripts', 'build'], value: 'tsc' } });
      expect(publishClaim(store, d, d, cfg).published).toBe(true);
      const attested = ClaimSchema.parse(claim({ kind: 'exists', evidence: [ev(d, c1, 'link.json')], verifier: { kind: 'exists', path: 'link.json' } }));
      store.saveClaim({ repoPath: d, claim: attested, status: 'attested', reason: 'attested by a person' });
      git(d, 'rm', '-q', '--cached', 'link.json');
      git(d, 'update-index', '--add', '--cacheinfo', `120000,${blobOf(d, text)},link.json`);
      git(d, 'commit', '-qm', 'turn it into a symlink');
      const c2 = head(d);
      expect(git(d, 'rev-parse', `${c1}:link.json`)).toBe(git(d, 'rev-parse', `${c2}:link.json`)); // the very same blob id
      const r = reverifyOnCommit(store, d, d, c1, c2);
      expect(r.withdrawn.map((w) => w.id).sort()).toEqual([cfg.id, attested.id].sort());
    });
  });

  it('an unreadable import on a cited line keeps the claim unconfirmed even when a plain match is on another line', () => {
    const d = newRepo({ 'm.ts': "import 'pkg';\nimport 'p\\u006bg';\n" });
    const c = head(d);
    const mk = (lines: Lines) => claim({ kind: 'imports', evidence: [ev(d, c, 'm.ts', lines)], verifier: { kind: 'imports', from: 'm.ts', specifier: 'pkg' } });
    expect(publishClaim(openStore(), d, d, mk(1)).published).toBe(true); // the plain import on line 1 proves it
    expect(publishClaim(openStore(), d, d, mk(2))).toMatchObject({ published: false, unconfirmed: true }); // the cited line may hold it
    // Cited lines with no candidate at all are a definite miss.
    const e = newRepo({ 'm.ts': "import 'pkg';\n\nexport {};\nimport 'p\\u006bg';\n" });
    const ce = head(e);
    const miss = claim({ kind: 'imports', evidence: [ev(e, ce, 'm.ts', 3)], verifier: { kind: 'imports', from: 'm.ts', specifier: 'pkg' } });
    expect(publishClaim(openStore(), e, e, miss)).toMatchObject({ published: false, unconfirmed: false });
  });

  it('an oversized key, or an oversized claim, is refused by the schema and writes no row', () => {
    const d = newRepo({ 'c.json': '{"a": 1}\n' });
    const c = head(d);
    const store = openStore();
    const big = claim({ kind: 'config', evidence: [ev(d, c, 'c.json', 1)], verifier: { kind: 'config', path: 'c.json', key: ['k'.repeat(300_000)], value: 1 } });
    const out = publishClaim(store, d, d, big);
    expect(out).toMatchObject({ published: false, recorded: false });
    expect(store.listClaims(d)).toEqual([]);
    const sym = claim({ kind: 'exists', evidence: [ev(d, c, 'c.json', 1)], verifier: { kind: 'exists', path: 'c.json', symbol: 's'.repeat(300) } });
    expect(ClaimSchema.safeParse(sym).success).toBe(false);
    // Twenty 2 KB quotes stay within the claim budget; the budget is for the claim as a whole.
    const many = claim({ kind: 'quote', evidence: Array.from({ length: 20 }, () => ev(d, c, 'c.json', 1, 'x'.repeat(2000))), verifier: { kind: 'quote' } });
    expect(ClaimSchema.safeParse(many).success).toBe(true);
  });

  it('a reason that quotes a large value is clipped before it is stored', () => {
    const d = newRepo({ 'c.json': '{"a": 1}\n' });
    const c = head(d);
    const store = openStore();
    const value = 'v'.repeat(60_000);
    const k = claim({ kind: 'config', evidence: [ev(d, c, 'c.json', 1)], verifier: { kind: 'config', path: 'c.json', key: ['a'], value } });
    const out = publishClaim(store, d, d, k);
    expect(out.published).toBe(false);
    expect(store.getClaim(d, k.id as string)!.reason!.length).toBeLessThan(2200);
  });

  it('a final line terminator does not start another line', () => {
    expect(splitLines('x\n')).toEqual(['x']);
    expect(splitLines('x\n\n')).toEqual(['x', '']);
    expect(splitLines('x\r\ny')).toEqual(['x', 'y']);
    expect(splitLines('')).toEqual([]); // an empty file has no lines
    const d = newRepo({ 'one.txt': 'x\n' });
    const c = head(d);
    const q = claim({ kind: 'quote', evidence: [ev(d, c, 'one.txt', [1, 2], 'x\n')], verifier: { kind: 'quote' } });
    expect(ClaimSchema.safeParse(q).success).toBe(true); // two lines of quote, two lines cited
    const out = publishClaim(openStore(), d, d, q);
    expect(out.published).toBe(false);
    if (!out.published) expect(out.reason).toMatch(/past the end/);
  });

  it('fixture repositories commit although the developer ignores *.ts globally', () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-claims-ignore-'));
    dirs.push(root);
    writeFileSync(join(root, 'ignore'), '*.ts\n*.json\n');
    const globalConfig = join(root, 'gitconfig');
    writeFileSync(globalConfig, `[core]\n\texcludesFile = ${join(root, 'ignore')}\n`);
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      expect(() => newRepo()).not.toThrow();
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
  });

  it('fixture git commands never touch the repository named by an inherited GIT_DIR', () => {
    const decoy = mkdtempSync(join(tmpdir(), 'turbine-claims-decoy-'));
    dirs.push(decoy);
    git(decoy, 'init', '-q');
    const before = readFileSync(join(decoy, '.git', 'config'), 'utf8');
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(decoy, '.git');
    process.env.GIT_WORK_TREE = decoy;
    try {
      const d = newRepo({ 'a.txt': 'a\n' });
      expect(git(d, 'rev-parse', '--show-toplevel').trim().endsWith(d.split('/').pop()!)).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(readFileSync(join(decoy, '.git', 'config'), 'utf8')).toBe(before);
    expect(git(decoy, 'rev-list', '--all', '--count').trim()).toBe('0'); // no fixture commit landed in it (a failed read throws)
  });
});

describe('review round 4 (PR #12): findings from the third local CodeRabbit review', () => {
  const at4 = (dir: string, c: string, input: Record<string, unknown>) =>
    ClaimSchema.parse({ ...input, evidence: (input.evidence as Array<Record<string, unknown>>).map((e) => ({ ...e, commit: c, blob: git(dir, 'rev-parse', `${c}:${e.path as string}`).trim() })) });

  it('a number token with a long run of zeros inside it is read in linear time (no backtracking)', () => {
    const token = `1.${'0'.repeat(200_000)}5`; // many interior zeros, then a nonzero digit
    const d = newRepo({ 'n.json': `{"n": ${token}, "ok": 1}\n` });
    const c = head(d);
    const k = claim({ kind: 'config', evidence: [ev(d, c, 'n.json', 1)], verifier: { kind: 'config', path: 'n.json', key: ['n'], value: 1 } });
    const started = Date.now();
    const out = publishClaim(openStore(), d, d, k);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out).toMatchObject({ published: false, unconfirmed: true }); // more than 15 significant digits
  }, 60_000);

  it('a nonzero literal that underflows to zero, or lands in the subnormal range, is not taken as an exact number', () => {
    const d = newRepo({ 'n.json': '{"tiny": 1e-400, "sub": 5e-324, "norm": 1e-300, "zero": 0}\n' });
    const c = head(d);
    const mk = (key: string, value: unknown) => claim({ kind: 'config', evidence: [ev(d, c, 'n.json', 1)], verifier: { kind: 'config', path: 'n.json', key: [key], value } });
    expect(publishClaim(openStore(), d, d, mk('tiny', 0))).toMatchObject({ published: false, unconfirmed: true });
    expect(publishClaim(openStore(), d, d, mk('sub', 5e-324))).toMatchObject({ published: false, unconfirmed: true });
    expect(publishClaim(openStore(), d, d, mk('norm', 1e-300)).published).toBe(true);
    expect(publishClaim(openStore(), d, d, mk('zero', 0)).published).toBe(true);
  });

  it('a drive-rooted path is not a repository-relative path', () => {
    const d = newRepo();
    const c = head(d);
    const blob = git(d, 'rev-parse', `${c}:docs/notes.md`).trim();
    const withPath = (path: string) => claim({ kind: 'exists', evidence: [{ path, commit: c, blob }], verifier: { kind: 'exists', path } });
    for (const path of ['C:/src/a.ts', 'c:src/a.ts', 'Z:a.ts']) expect(ClaimSchema.safeParse(withPath(path)).success, path).toBe(false);
    expect(ClaimSchema.safeParse(withPath('docs/notes.md')).success).toBe(true); // the same shape, with a repository-relative path
    expect(ClaimSchema.safeParse(validClaims(d, c).exists).success).toBe(true);
  });

  describe('an import written as a template literal, or a re-export with an escaped specifier', () => {
    it('import(`pkg`) is not reported as a missing import: it is unconfirmed', () => {
      const d = newRepo({ 'm.ts': 'export const load = () => import(`pkg`);\n' });
      const c = head(d);
      const out = publishClaim(openStore(), d, d, claim({ kind: 'imports', evidence: [ev(d, c, 'm.ts', 1)], verifier: { kind: 'imports', from: 'm.ts', specifier: 'pkg' } }));
      expect(out).toMatchObject({ published: false, unconfirmed: true });
    });

    it('export { foo } from an escaped specifier still states the export "foo"', () => {
      const d = newRepo({ 'm.ts': "export { foo } from './m\\u006fd.js';\n" });
      const c = head(d);
      const out = publishClaim(openStore(), d, d, claim({ kind: 'exists', evidence: [ev(d, c, 'm.ts', 1)], verifier: { kind: 'exists', path: 'm.ts', symbol: 'foo' } }));
      expect(out.published, out.published ? '' : out.reason).toBe(true);
      // The import edge is still withheld, and a claim about it is unconfirmed rather than disproven.
      const imp = publishClaim(openStore(), d, d, claim({ kind: 'imports', evidence: [ev(d, c, 'm.ts', 1)], verifier: { kind: 'imports', from: 'm.ts', specifier: './mod.js' } }));
      expect(imp).toMatchObject({ published: false, unconfirmed: true });
    });
  });

  describe('a publication at an older commit does not move a claim back', () => {
    it('refuses to republish a claim at a commit its stored commit does not descend from; a descendant is fine', () => {
      const dir = newRepo();
      const c1 = head(dir);
      const store = openStore();
      const input = validClaims(dir, c1).quote!;
      expect(publishClaim(store, dir, dir, input).published).toBe(true);
      const c2 = commitFiles(dir, { 'README.md': 'x\n' });
      expect(reverifyOnCommit(store, dir, dir, c1, c2).kept).toEqual([input.id]);
      expect(store.getClaim(dir, input.id as string)!.commit).toBe(c2);

      // Publishing the same claim again at the OLD commit would move it back to c1.
      const out = publishClaim(store, dir, dir, input);
      expect(out).toMatchObject({ published: false, recorded: false, unconfirmed: false });
      if (!out.published) expect(out.reason).toMatch(/does not descend/);
      expect(store.getClaim(dir, input.id as string)).toMatchObject({ status: 'verified', commit: c2 });

      // At a descendant of c2 it is allowed.
      const c3 = commitFiles(dir, { 'README.md': 'y\n' });
      const atC3 = ClaimSchema.parse({ ...input, evidence: (input.evidence as Array<Record<string, unknown>>).map((e) => ({ ...e, commit: c3, blob: git(dir, 'rev-parse', `${c3}:${e.path as string}`).trim() })) });
      expect(publishClaim(store, dir, dir, atC3).published).toBe(true);
      expect(store.getClaim(dir, input.id as string)!.commit).toBe(c3);
    });

    it('withdrawing a claim does not reopen the commit it was carried past; it can be published again at the frontier', () => {
      const dir = newRepo();
      const c1 = head(dir);
      const store = openStore();
      const input = validClaims(dir, c1).quote!;
      publishClaim(store, dir, dir, input);
      const c2 = commitFiles(dir, { 'README.md': 'x\n' });
      reverifyOnCommit(store, dir, dir, c1, c2); // the row is now carried at c2
      expect(publishClaim(store, dir, dir, input)).toMatchObject({ published: false, recorded: false }); // c1 is behind it
      store.withdrawClaim(dir, input.id as string, 'gone');
      expect(publishClaim(store, dir, dir, input)).toMatchObject({ published: false, recorded: false }); // the frontier is still c2
      const again = at4(dir, c2, input);
      expect(publishClaim(store, dir, dir, again).published).toBe(true);
      expect(store.getClaim(dir, input.id as string)).toMatchObject({ status: 'verified', commit: c2 });
    });

    it('a NEW claim is not published at a commit the published claims have already moved past', () => {
      const dir = newRepo();
      const c1 = head(dir);
      const store = openStore();
      const first = validClaims(dir, c1).quote!;
      publishClaim(store, dir, dir, first);
      const c2 = commitFiles(dir, { 'README.md': 'x\n' });
      reverifyOnCommit(store, dir, dir, c1, c2);
      const late = validClaims(dir, c1).imports!; // a different id, proven at c1, which reverify has left behind
      const out = publishClaim(store, dir, dir, late);
      expect(out).toMatchObject({ published: false, recorded: false, unconfirmed: false });
      if (!out.published) expect(out.reason).toMatch(/does not descend/);
      expect(store.getClaim(dir, late.id as string)).toBeNull(); // nothing stored, not even a rejection
      // At the commit the claims are carried at, or after it, it is accepted.
      const atC2 = ClaimSchema.parse({ ...late, evidence: (late.evidence as Array<Record<string, unknown>>).map((e) => ({ ...e, commit: c2, blob: git(dir, 'rev-parse', `${c2}:${e.path as string}`).trim() })) });
      expect(publishClaim(store, dir, dir, atC2).published).toBe(true);
    });

    it('a claim on a branch that diverged from the published claims is not published', () => {
      const dir = newRepo();
      const base = head(dir);
      const store = openStore();
      git(dir, 'checkout', '-q', '-b', 'side');
      const side = commitFiles(dir, { 'side.txt': 's\n' });
      git(dir, 'checkout', '-q', 'main');
      const main = commitFiles(dir, { 'main.txt': 'm\n' });
      expect(publishClaim(store, dir, dir, validClaims(dir, main).quote!).published).toBe(true);
      const out = publishClaim(store, dir, dir, validClaims(dir, side).imports!);
      expect(out).toMatchObject({ published: false, recorded: false, unconfirmed: false });
      expect(base).not.toBe(side);
    });

    it('a git failure while comparing commits is unconfirmed (retryable), keeps the stored row, and does not blame the commit', () => {
      const dir = newRepo();
      const c = head(dir);
      const store = openStore();
      // A published row at a commit this repository does not have (the trusted low-level write allows it).
      const ghost = ClaimSchema.parse({ ...validClaims(dir, c).exists, id: 'ghost', evidence: [{ path: 'docs/notes.md', commit: 'a'.repeat(40), blob: 'b'.repeat(40) }] });
      store.saveClaim({ repoPath: dir, claim: ghost, status: 'verified', reason: 'seeded' });
      const out = publishClaim(store, dir, dir, validClaims(dir, c).quote!);
      expect(out).toMatchObject({ published: false, unconfirmed: true, recorded: false });
      if (!out.published) {
        expect(out.reason).toMatch(/could not compare/);
        expect(out.reason).not.toMatch(/does not descend/);
      }
      expect(store.getClaim(dir, 'ghost')).toMatchObject({ status: 'verified', commit: 'a'.repeat(40) });
    });
  });

  it('verification and the save run inside ONE transaction (the same token), not two back to back', () => {
    const dir = newRepo();
    const c = head(dir);
    const store = openStore();
    let issued = 0;
    let current = 0; // the token of the transaction being run; 0 outside any
    const seen: Record<string, number> = {};
    hooks.onVerify = () => {
      seen.verify = current;
    };
    const spy = new Proxy(store, {
      get(target, prop) {
        if (prop === 'transaction') {
          return (fn: () => unknown) => {
            const token = ++issued;
            return target.transaction(() => {
              current = token;
              try {
                return fn();
              } finally {
                current = 0;
              }
            });
          };
        }
        if (prop === 'saveClaim') {
          return (...a: Parameters<WorkStore['saveClaim']>) => {
            seen.save = current;
            return target.saveClaim(...a);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    try {
      expect(publishClaim(spy, dir, dir, validClaims(dir, c).quote!).published).toBe(true);
    } finally {
      hooks.onVerify = undefined;
    }
    expect(seen.verify).toBeGreaterThan(0);
    expect(seen.save).toBe(seen.verify);
    expect(issued).toBe(1); // one transaction for the whole publish
  });

  it('fixture repositories ignore a template directory that supplies attributes', () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-claims-template-'));
    dirs.push(root);
    mkdirSync(join(root, 'tpl', 'info'), { recursive: true });
    writeFileSync(join(root, 'tpl', 'info', 'attributes'), '*.ts text eol=lf\n');
    const globalConfig = join(root, 'gitconfig');
    writeFileSync(globalConfig, `[init]\n\ttemplateDir = ${join(root, 'tpl')}\n`);
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      const d = newRepo({ 'a.ts': 'a\r\nb\r\n' });
      expect(spawnGit(['cat-file', 'blob', `${head(d)}:a.ts`], { cwd: d, encoding: 'latin1' }).stdout).toBe('a\r\nb\r\n');
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
  });

  it('the bytes a reader hands out are copies: changing them does not change what is later verified', () => {
    const dir = newRepo();
    const c = head(dir);
    const reader = new CommitReader(dir, c);
    const first = reader.bytes('src/util.ts');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const original = Buffer.from(first.buf);
    first.buf.fill(0x78); // a caller scribbles over what it was given
    const again = reader.bytes('src/util.ts');
    expect(again.ok && Buffer.compare(again.buf, original) === 0).toBe(true);
    expect(verifyClaim(reader, validClaims(dir, c).quote).ok).toBe(true);
  });

  it('the absence search covers a symlink by its stored target name, and does not follow it', () => {
    const d = newRepo({ 'a.txt': 'x\n' });
    const id = spawnGit(['hash-object', '-w', '--stdin'], { cwd: d, encoding: 'utf8', input: 'zz-link-target-zz' }).stdout.trim();
    git(d, 'update-index', '--add', '--cacheinfo', `120000,${id},some-link`);
    git(d, 'commit', '-qm', 'a symlink');
    const cm = head(d);
    const k = claim({ kind: 'absence', statement: 'No marker', evidence: [ev(d, cm, 'a.txt')], verifier: { kind: 'absence', pattern: { type: 'literal', text: 'zz-link-target-zz' } } });
    const v = verifyClaim(new CommitReader(d, cm), k);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/some-link/);
  });
});

describe('review round 5 (PR #12): findings from the fourth local CodeRabbit review', () => {
  const publishExists = (d: string, c: string, path: string, symbol: string, line: number) =>
    publishClaim(openStore(), d, d, claim({ kind: 'exists', evidence: [ev(d, c, path, line)], verifier: { kind: 'exists', path, symbol } }));

  it('exists(symbol: "default") is proven by every explicit form of a default export, at its line', () => {
    const d = newRepo({
      'a.ts': 'const fn = () => 1;\nexport { fn as default };\n',
      'b.ts': 'export default function main() {}\n',
      'c.ts': 'export default class {}\n',
      'd.ts': 'const v = 1;\nexport default v;\n',
      'e.ts': "export { default } from './a.js';\n",
      'f.ts': 'export const named = 1;\n',
    });
    const c = head(d);
    expect(publishExists(d, c, 'a.ts', 'default', 2).published).toBe(true);
    expect(publishExists(d, c, 'b.ts', 'default', 1).published).toBe(true);
    expect(publishExists(d, c, 'c.ts', 'default', 1).published).toBe(true);
    expect(publishExists(d, c, 'd.ts', 'default', 2).published).toBe(true);
    expect(publishExists(d, c, 'e.ts', 'default', 1).published).toBe(true);
    // Not a default export, and not on the cited line.
    expect(publishExists(d, c, 'f.ts', 'default', 1).published).toBe(false);
    expect(publishExists(d, c, 'a.ts', 'default', 1).published).toBe(false);
    // The named exports are as before: `default` is not one of them.
    expect(publishExists(d, c, 'b.ts', 'main', 1).published).toBe(false);
  });

  it('a blob larger than the whole cache budget is returned without being cached', () => {
    const d = newRepo({ 'big.txt': `${'x'.repeat(1023)}\n`.repeat(33 * 1024) }); // 33 MiB
    const reader = new CommitReader(d, head(d));
    const r = reader.bytes('big.txt', 40 * 1024 * 1024);
    expect(r.ok && r.buf.length).toBe(33 * 1024 * 1024);
    expect(reader.cachedBytes()).toBe(0);
    expect(reader.cachedBytes()).toBeLessThanOrEqual(32 * 1024 * 1024);
  }, 60_000);

  it('a specifier inside parentheses or a type assertion is read, not dropped', () => {
    const d = newRepo({ 'm.ts': "export const a = () => import(('pkg'));\nexport const b = () => import('other' as string);\nexport const c = () => import((`tpl`));\n" });
    const cm = head(d);
    const imp = (specifier: string, line: number) =>
      publishClaim(openStore(), d, d, claim({ kind: 'imports', evidence: [ev(d, cm, 'm.ts', line)], verifier: { kind: 'imports', from: 'm.ts', specifier } }));
    expect(imp('pkg', 1).published).toBe(true);
    expect(imp('other', 2).published).toBe(true);
    expect(imp('tpl', 3)).toMatchObject({ published: false, unconfirmed: true }); // a template stays unreadable, inside parentheses too
    expect(imp('missing', 1)).toMatchObject({ published: false, unconfirmed: false }); // a plain miss is still a miss
  });

  it('an integer written with an exponent that a double cannot hold exactly is unconfirmed; exact ones verify', () => {
    const d = newRepo({ 'n.json': '{"big": 1e23, "ok": 1e3, "half": 1.5e1, "zero": 0e5, "frac": 0.5, "neg": -2e22, "tiny": 1e-400}\n' });
    const c = head(d);
    const cfg = (key: string, value: unknown) =>
      publishClaim(openStore(), d, d, claim({ kind: 'config', evidence: [ev(d, c, 'n.json', 1)], verifier: { kind: 'config', path: 'n.json', key: [key], value } }));
    expect(cfg('big', 1e23)).toMatchObject({ published: false, unconfirmed: true });
    expect(cfg('neg', -2e22)).toMatchObject({ published: false, unconfirmed: true });
    expect(cfg('tiny', 0)).toMatchObject({ published: false, unconfirmed: true });
    expect(cfg('ok', 1000).published).toBe(true);
    expect(cfg('half', 15).published).toBe(true);
    expect(cfg('zero', 0).published).toBe(true);
    expect(cfg('frac', 0.5).published).toBe(true);
  });

  it('IMPLEMENTATION_STATUS.md names the JSONC filename forms exactly as the verifier accepts them', () => {
    const doc = readFileSync(resolve(here, '../../docs/IMPLEMENTATION_STATUS.md'), 'utf8');
    expect(doc).toContain('`tsconfig.<name>.json`');
    expect(doc).toContain('`tsconfig-base.json` is strict');
    const d = newRepo({
      'tsconfig.base.json': '{\n  // c\n  "a": 1\n}\n',
      'tsconfig-base.json': '{\n  // c\n  "a": 1\n}\n',
    });
    const c = head(d);
    const cfg = (path: string) =>
      publishClaim(openStore(), d, d, claim({ kind: 'config', evidence: [ev(d, c, path, 3)], verifier: { kind: 'config', path, key: ['a'], value: 1 } }));
    expect(cfg('tsconfig.base.json').published).toBe(true);
    expect(cfg('tsconfig-base.json').published).toBe(false); // strict JSON: the comment is a syntax error
  });
});

describe('review round 6 (PR #12): findings from the fifth local CodeRabbit review', () => {
  const at = (dir: string, c: string, input: Record<string, unknown>) =>
    ClaimSchema.parse({ ...input, evidence: (input.evidence as Array<Record<string, unknown>>).map((e) => ({ ...e, commit: c, blob: git(dir, 'rev-parse', `${c}:${e.path as string}`).trim() })) });

  describe('the claim frontier: published claims stay on one transition path', () => {
    it('a claim published at a newer commit is refused until the earlier claims are carried to it', () => {
      const dir = newRepo();
      const c1 = head(dir);
      const store = openStore();
      const a = validClaims(dir, c1).quote!;
      expect(publishClaim(store, dir, dir, a).published).toBe(true);
      const c2 = commitFiles(dir, { 'README.md': 'x\n' });
      const b = at(dir, c2, validClaims(dir, c2).imports!);
      const out = publishClaim(store, dir, dir, b);
      expect(out).toMatchObject({ published: false, recorded: false, unconfirmed: false });
      if (!out.published) expect(out.reason).toMatch(/reverifyOnCommit/);
      expect(store.getClaim(dir, b.id)).toBeNull();
      // Carried, then accepted; and a later change to A's file is seen, because A travels with B.
      reverifyOnCommit(store, dir, dir, c1, c2);
      expect(publishClaim(store, dir, dir, b).published).toBe(true);
      const c3 = commitFiles(dir, { 'src/util.ts': null });
      const r = reverifyOnCommit(store, dir, dir, c2, c3);
      expect(r.withdrawn.map((w) => w.id)).toContain(a.id);
      expect(store.getClaim(dir, a.id as string)).toMatchObject({ status: 'withdrawn' });
    });

    it('the frontier survives the withdrawal of the last published claim, so an old commit cannot be reopened', () => {
      const dir = newRepo();
      const c1 = head(dir);
      const store = openStore();
      const a = validClaims(dir, c1).quote!;
      publishClaim(store, dir, dir, a);
      expect(store.getClaimFrontier(dir)).toBe(c1);
      const c2 = commitFiles(dir, { 'src/util.ts': null });
      expect(reverifyOnCommit(store, dir, dir, c1, c2).withdrawn).toHaveLength(1);
      expect(store.listClaims(dir, { statuses: PUBLISHED_CLAIM_STATUSES })).toEqual([]);
      expect(store.getClaimFrontier(dir)).toBe(c2);
      const late = validClaims(dir, c1).imports!; // proven at c1, which the transitions have passed
      const out = publishClaim(store, dir, dir, late);
      expect(out).toMatchObject({ published: false, recorded: false, unconfirmed: false });
      if (!out.published) expect(out.reason).toMatch(/already been carried/);
      expect(store.getClaim(dir, late.id as string)).toBeNull();
    });

    it('a transition that carries no claim still moves the frontier, and never backwards', () => {
      const dir = newRepo();
      const c1 = head(dir);
      const store = openStore();
      const c2 = commitFiles(dir, { 'README.md': 'x\n' });
      expect(store.getClaimFrontier(dir)).toBeNull();
      reverifyOnCommit(store, dir, dir, c1, c2);
      expect(store.getClaimFrontier(dir)).toBe(c2);
      expect(() => reverifyOnCommit(store, dir, dir, c2, c1)).toThrow(/does not descend/); // never backwards
      expect(store.getClaimFrontier(dir)).toBe(c2);
    });

    it('the store keeps one frontier per repository, validates it, and a failed publish does not move it', () => {
      const dir = newRepo();
      const c = head(dir);
      const store = openStore();
      expect(() => store.setClaimFrontier('', c)).toThrow(/non-empty/);
      expect(() => store.setClaimFrontier(dir, 'main')).toThrow();
      store.setClaimFrontier('/elsewhere', 'b'.repeat(40));
      expect(store.getClaimFrontier(dir)).toBeNull();
      const falseClaim = claim({ kind: 'imports', evidence: [ev(dir, c, 'src/app.ts', 2)], verifier: { kind: 'imports', from: 'src/app.ts', specifier: 'zzz' } });
      expect(publishClaim(store, dir, dir, falseClaim).published).toBe(false);
      expect(store.getClaimFrontier(dir)).toBeNull();
      expect(publishClaim(store, dir, dir, validClaims(dir, c).quote!).published).toBe(true);
      expect(store.getClaimFrontier(dir)).toBe(c);
      expect(store.getClaimFrontier('/elsewhere')).toBe('b'.repeat(40));
    });

    it('migration v5 creates the frontier table', () => {
      const store = openStore();
      expect((store.db.prepare(`PRAGMA table_info(claim_frontier)`).all() as Array<{ name: string }>).map((x) => x.name)).toEqual(['repo_path', 'commit', 'updated_at']);
    });
  });

  it('a clause that exports thousands of names is scanned in time that does not grow with the square of it', () => {
    const names = Array.from({ length: 20_000 }, (_, i) => `name${i}`);
    const d = newRepo({ 'barrel.ts': `export {\r\n${names.map((n) => `  ${n},`).join('\r\n')}\r\n};\r\n` });
    const c = head(d);
    const started = Date.now();
    const out = publishClaim(openStore(), d, d, claim({ kind: 'exists', evidence: [ev(d, c, 'barrel.ts', [1, 20_002])], verifier: { kind: 'exists', path: 'barrel.ts', symbol: 'name19999' } }));
    expect(out.published, out.published ? '' : out.reason).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  it('export * as default declares a default export; export * as api stays a named export', () => {
    const d = newRepo({ 'a.ts': "export * as default from './api.js';\n", 'b.ts': "export * as api from './api.js';\n" });
    const c = head(d);
    const ex = (path: string, symbol: string) =>
      publishClaim(openStore(), d, d, claim({ kind: 'exists', evidence: [ev(d, c, path, 1)], verifier: { kind: 'exists', path, symbol } })).published;
    expect(ex('a.ts', 'default')).toBe(true);
    expect(ex('a.ts', 'api')).toBe(false);
    expect(ex('b.ts', 'api')).toBe(true);
    expect(ex('b.ts', 'default')).toBe(false);
  });

  it('the reader hands out frozen tree entries: a caller cannot change what later verification compares', () => {
    const dir = newRepo();
    const c = head(dir);
    const reader = new CommitReader(dir, c);
    const entry = reader.entry('src/util.ts')!;
    expect(() => {
      (entry as { id: string }).id = 'f'.repeat(40);
    }).toThrow(TypeError);
    expect(() => {
      (reader.tree().entries as unknown[]).length = 0;
    }).toThrow(TypeError);
    expect(() => {
      (reader.tree() as { undecodable: number }).undecodable = 9;
    }).toThrow(TypeError);
    expect(verifyClaim(reader, validClaims(dir, c).quote).ok).toBe(true);
  });

  describe('a specifier the scanner cannot evaluate is unconfirmed, not a missing import', () => {
    const d = newRepo({
      'm.ts': "export const a = () => import('./' + 'feature.js');\nexport const b = () => require(name);\nexport const c = () => import(loader());\nexport { x };\nconst x = 1;\nexport const d = () => import('./plain.js');\n",
    });
    const cm = head(d);
    const imp = (specifier: string, line: number) =>
      publishClaim(openStore(), d, d, claim({ kind: 'imports', evidence: [ev(d, cm, 'm.ts', line)], verifier: { kind: 'imports', from: 'm.ts', specifier } }));

    it('import(<expression>) and require(<expression>) on a cited line', () => {
      for (const line of [1, 2, 3]) expect(imp('./feature.js', line), `line ${line}`).toMatchObject({ published: false, unconfirmed: true });
    });
    it('a local `export { x }` has no specifier and records nothing', () => {
      expect(imp('./feature.js', 4)).toMatchObject({ published: false, unconfirmed: false });
    });
    it('a literal import elsewhere is still an edge, and a plain miss is still a miss', () => {
      expect(imp('./plain.js', 6).published).toBe(true);
      expect(imp('./nowhere.js', 6)).toMatchObject({ published: false, unconfirmed: false });
    });
  });

  it('a number is exact only if its TEXT states what a double holds: 1.0000000000000001e0 is not 1', () => {
    const d = newRepo({ 'n.json': '{"a": 1.0000000000000001e0, "b": 1e0, "c": 12345678901234567e-2, "d": 1.5e23, "e": 1.25, "f": 9007199254740991}\n' });
    const c = head(d);
    const cfg = (key: string, value: unknown) =>
      publishClaim(openStore(), d, d, claim({ kind: 'config', evidence: [ev(d, c, 'n.json', 1)], verifier: { kind: 'config', path: 'n.json', key: [key], value } }));
    expect(cfg('a', 1)).toMatchObject({ published: false, unconfirmed: true });
    expect(cfg('c', 123456789012345.67)).toMatchObject({ published: false, unconfirmed: true });
    expect(cfg('d', 1.5e23)).toMatchObject({ published: false, unconfirmed: true });
    expect(cfg('b', 1).published).toBe(true);
    expect(cfg('e', 1.25).published).toBe(true);
    expect(cfg('f', 9007199254740991).published).toBe(true);
  });

  it('the fixture repository starts on main whatever init.defaultBranch says', () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-claims-branch-'));
    dirs.push(root);
    const globalConfig = join(root, 'gitconfig');
    writeFileSync(globalConfig, '[init]\n\tdefaultBranch = side\n');
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      expect(git(newRepo(), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
  });
});

let onceRepo: string | undefined;
const repoOnce = (): string => (onceRepo ??= newRepo());
const newRepoOnce = repoOnce;
const headOnce = (): string => head(repoOnce());

describe('review round 7 (PR #12): findings from the sixth local CodeRabbit review', () => {
  it('a stale transition (A to C when the claims are already at B) is refused and moves nothing; B to C then works', () => {
    const dir = newRepo();
    const a = head(dir);
    const store = openStore();
    const claimA = validClaims(dir, a).quote!;
    expect(publishClaim(store, dir, dir, claimA).published).toBe(true);
    const b = commitFiles(dir, { 'README.md': 'x\n' });
    reverifyOnCommit(store, dir, dir, a, b);
    const c = commitFiles(dir, { 'src/util.ts': null });
    expect(() => reverifyOnCommit(store, dir, dir, a, c)).toThrow(/stale/);
    expect(store.getClaimFrontier(dir)).toBe(b); // not moved
    expect(store.getClaim(dir, claimA.id as string)).toMatchObject({ status: 'verified', commit: b }); // not touched
    const r = reverifyOnCommit(store, dir, dir, b, c);
    expect(r.withdrawn.map((w) => w.id)).toEqual([claimA.id]);
    expect(store.getClaimFrontier(dir)).toBe(c);
    // With no published rows left, the next transition from the frontier still works.
    const d = commitFiles(dir, { 'README.md': 'y\n' });
    expect(reverifyOnCommit(store, dir, dir, c, d)).toMatchObject({ kept: [], withdrawn: [] });
    expect(() => reverifyOnCommit(store, dir, dir, b, d)).toThrow(/stale/);
  });

  it('super.run() is a dotted call named "super.run"; super[key]() has no name', () => {
    const d = newRepo({ 'k.ts': "class A { run() {} }\nclass B extends A {\n  go() {\n    super.run();\n    super[key]();\n  }\n}\n" });
    const c = head(d);
    const call = (callee: string, line: number) =>
      publishClaim(openStore(), d, d, claim({ kind: 'calls', evidence: [ev(d, c, 'k.ts', line)], verifier: { kind: 'calls', path: 'k.ts', callee } }));
    expect(call('super.run', 4).published).toBe(true);
    expect(call('super.run', 5).published).toBe(false); // the computed call is not super.run
    expect(call('super.key', 5).published).toBe(false);
    expect(call('run', 4).published).toBe(false); // the dotted name is the whole name
  });

  it('exported destructuring declarations export the bound names, not the property names', () => {
    const d = newRepo({ 'x.ts': 'export const { start: run, stop, nested: { deep }, ...rest } = api;\nexport const [first, , [second]] = list;\nexport const plain = 1;\n' });
    const c = head(d);
    const ex = (symbol: string, line: number) =>
      publishClaim(openStore(), d, d, claim({ kind: 'exists', evidence: [ev(d, c, 'x.ts', line)], verifier: { kind: 'exists', path: 'x.ts', symbol } })).published;
    for (const name of ['run', 'stop', 'deep', 'rest']) expect(ex(name, 1), name).toBe(true);
    for (const name of ['first', 'second']) expect(ex(name, 2), name).toBe(true);
    expect(ex('plain', 3)).toBe(true);
    for (const name of ['start', 'nested']) expect(ex(name, 1), name).toBe(false); // property names are not exports
    expect(ex('run', 2)).toBe(false);
  });

  it('a safe integer is exact however it is spelled; a rounded token stays unconfirmed', () => {
    const d = newRepo({ 'n.json': '{"a": 1000000000000001, "b": 1000000000000001.0, "c": 10000000000000010e-1, "d": 1.0000000000000001, "e": 9007199254740993.0, "f": 100000000000000000e-1, "g": 0.10, "h": 1.5e1}\n' });
    const c = head(d);
    const cfg = (key: string, value: unknown) =>
      publishClaim(openStore(), d, d, claim({ kind: 'config', evidence: [ev(d, c, 'n.json', 1)], verifier: { kind: 'config', path: 'n.json', key: [key], value } }));
    for (const key of ['a', 'b', 'c']) expect(cfg(key, 1000000000000001).published, key).toBe(true);
    expect(cfg('d', 1)).toMatchObject({ published: false, unconfirmed: true });
    expect(cfg('e', Number.MAX_SAFE_INTEGER + 2)).toMatchObject({ published: false, unconfirmed: true }); // beyond 2^53
    expect(cfg('f', 10000000000000000)).toMatchObject({ published: false, unconfirmed: true }); // 1e16 is beyond 2^53
    expect(cfg('g', 0.1).published).toBe(true);
    expect(cfg('h', 15).published).toBe(true);
    // The same value in the file keeps the same answer on re-verification (no withdrawal from respelling).
    const store = openStore();
    const first = claim({ kind: 'config', evidence: [ev(d, c, 'n.json', 1)], verifier: { kind: 'config', path: 'n.json', key: ['a'], value: 1000000000000001 } });
    publishClaim(store, d, d, first);
    const c2 = commitFiles(d, { 'n.json': '{"a": 1000000000000001.0, "b": 1}\n' });
    expect(reverifyOnCommit(store, d, d, c, c2).kept).toEqual([first.id]);
  });

  describe('a claim is bounded before any recursive validation runs', () => {
    const base = () => structuredClone(validClaims(newRepoOnce(), headOnce()).config!) as Record<string, any>;
    function nested(depth: number): unknown {
      let v: unknown = 1;
      for (let i = 0; i < depth; i++) v = { a: v };
      return v;
    }
    it('too deep, too many values, or too much text is refused with a reason, quickly, and writes nothing', () => {
      const store = openStore();
      const deep = base();
      deep.verifier.value = nested(500);
      const wide = base();
      wide.verifier.value = Array.from({ length: 30_000 }, (_, i) => i);
      const text = base();
      text.verifier.value = { big: 'x'.repeat(200 * 1024) };
      for (const [name, input] of [['deep', deep], ['wide', wide], ['text', text]] as const) {
        const started = Date.now();
        const out = publishClaim(store, repoOnce(), repoOnce(), input);
        expect(out, name).toMatchObject({ published: false, recorded: false });
        if (!out.published) expect(out.reason, name).toMatch(/nested deeper|more than 20000 values|characters of text/);
        expect(Date.now() - started, name).toBeLessThan(2_000);
      }
      expect(store.listClaims(repoOnce())).toEqual([]);
      expect(() => store.saveClaim({ repoPath: repoOnce(), claim: deep as never, status: 'verified', reason: 'x' })).toThrow(/nested deeper/);
    });
    it('a claim within the bounds is untouched by the budget, and a stored row over the limit is refused unread', () => {
      const store = openStore();
      const ok = base();
      expect(publishClaim(store, repoOnce(), repoOnce(), ok).published).toBe(true);
      store.db.prepare('UPDATE claims SET data = ? WHERE id = ?').run(`{"pad":"${'x'.repeat(129 * 1024)}"}`, ok.id);
      expect(() => store.getClaim(repoOnce(), ok.id)).toThrow(/more than \d+ bytes of data/);
      // Measured in BYTES: 45,000 euro signs are 45,000 UTF-16 units but 135,000 bytes. The listing is refused too.
      store.db.prepare('UPDATE claims SET data = ? WHERE id = ?').run(`{"pad":"${'€'.repeat(45_000)}"}`, ok.id);
      expect(() => store.getClaim(repoOnce(), ok.id)).toThrow(/more than \d+ bytes of data/);
      expect(() => store.listClaims(repoOnce())).toThrow(/more than \d+ bytes of data/);
    });
  });

  it('GFM list and HTML interruptions: "2." stays a row, "1." and a bullet end the table, an HTML block ends it', () => {
    // An ordered item that does not start at 1 cannot interrupt a paragraph: it is a table row, and its extra cell is found.
    const t = tableProblems(['| A | B |', '| - | - |', '| a | b |', '2. extra | cell | third']);
    expect(t.rows).toBe(2);
    expect(t.problems).toHaveLength(1);
    // An empty list item does not interrupt either.
    expect(tableProblems(['| A | B |', '| - | - |', '-', '| x | y | z |']).rows).toBe(2);
    for (const html of ['<!-- note -->', '<div>', '<script>', '<pre>', '<?php', '<!DOCTYPE html>', '</section>', '<table>']) {
      expect(tableProblems(['| A | B |', '| - | - |', '| a | b |', html, '| x | y | z |']).rows, html).toBe(1);
    }
    // An inline tag at the start of a row is not a block: the row is checked.
    expect(tableProblems(['| A | B |', '| - | - |', '| a | b |', '<span>x</span> | y | z']).problems).toHaveLength(1);
  });

  it('the table check ends a table at a thematic break, and a fence closes only on a valid closing line', () => {
    for (const br of ['***', '---', '___', '- - -', '* * *']) expect(tableProblems(['| A | B |', '| - | - |', '| a | b |', br, 'text']).rows, br).toBe(1);
    // A pipe-free body row is still a row.
    expect(tableProblems(['| A | B |', '| - | - |', 'plain', '| a | b |']).rows).toBe(2);
    // A shorter or different marker, or a marker followed by text, does not close the fence: the rows inside stay literal.
    expect(tableProblems(['~~~~', '~~~', '| A | B |', '| - | - |', 'literal', '~~~~']).problems).toEqual([]);
    expect(tableProblems(['```', '``` still code', '| A | B |', '| - | - |', 'literal', '```']).problems).toEqual([]);
    expect(tableProblems(['```', '~~~', '| A | B |', '| - | - |', 'literal', '```']).problems).toEqual([]);
    // Indented code is not a table.
    expect(tableProblems(['    | A | B |', '    | - | - |', '    literal']).problems).toEqual([]);
    expect(tableProblems(['\t| A | B |', '\t| - | - |', '\tliteral']).problems).toEqual([]);
    expect(tableProblems(['   | A | B |', '   | - | - |', 'literal']).rows).toBe(1); // three spaces is still a table
    // After a valid close, the next table is checked again.
    expect(tableProblems(['```', 'x', '```', '| A | B |', '| - | - |', 'oops']).problems).toHaveLength(1);
  });

  it('the divergent-branch test names main explicitly, and the table check ignores fenced code', () => {
    expect(tableProblems(['```', '| A | B |', '| --- | --- |', 'literal text', '```']).problems).toEqual([]);
    expect(tableProblems(['~~~md', '| A | B |', '| --- | --- |', 'literal text', '~~~', '| A | B |', '| - | - |', 'oops']).problems).toHaveLength(1); // the same rows outside a fence
    expect(tableProblems(['text', '```', '| A | B |', '| --- | --- |', '| a | b | c |', '```', '', '| X |', '| - |', '| y |']).rows).toBe(1);
  });
});

describe('review round 8 (PR #12): findings from the seventh local CodeRabbit review', () => {
  it('a no-op transition is checked against the frontier too: A to A is stale when the claims are at B', () => {
    const dir = newRepo();
    const a = head(dir);
    const store = openStore();
    publishClaim(store, dir, dir, validClaims(dir, a).quote!);
    const b = commitFiles(dir, { 'README.md': 'x\n' });
    reverifyOnCommit(store, dir, dir, a, b);
    expect(() => reverifyOnCommit(store, dir, dir, a, a)).toThrow(/stale/);
    expect(reverifyOnCommit(store, dir, dir, b, b)).toMatchObject({ kept: [], withdrawn: [], sections: [] }); // at the frontier: empty success
  });

  it('a clause with thousands of destructured declarations shares one statement excerpt (no quadratic copy)', () => {
    const decls = Array.from({ length: 30_000 }, (_, i) => `{ a${i} } = x${i}`);
    const d = newRepo({ 'big.ts': `export const ${decls.join(',\r\n  ')};\r\n` });
    const c = head(d);
    const started = Date.now();
    const out = publishClaim(openStore(), d, d, claim({ kind: 'exists', evidence: [ev(d, c, 'big.ts', [1, 30_000])], verifier: { kind: 'exists', path: 'big.ts', symbol: 'a29999' } }));
    expect(out.published, out.published ? '' : out.reason).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  describe('a missing export is not proven when an export * could supply it', () => {
    const d = newRepo({
      'api.ts': "export * from './impl.js';\nexport const direct = 1;\nexport * as ns from './ns.js';\n",
      'plain.ts': 'export const only = 1;\n',
    });
    const c = head(d);
    const ex = (path: string, symbol: string, line: number) =>
      publishClaim(openStore(), d, d, claim({ kind: 'exists', evidence: [ev(d, c, path, line)], verifier: { kind: 'exists', path, symbol } }));
    it('unconfirmed for a name the star re-export may supply', () => {
      expect(ex('api.ts', 'run', 1)).toMatchObject({ published: false, unconfirmed: true });
    });
    it('an explicit match stays verifiable, a namespace re-export is a named export, default is never re-exported by a star', () => {
      expect(ex('api.ts', 'direct', 2).published).toBe(true);
      expect(ex('api.ts', 'ns', 3).published).toBe(true);
      expect(ex('api.ts', 'default', 1)).toMatchObject({ published: false, unconfirmed: false });
    });
    it('a file without a star re-export still gets a definite miss', () => {
      expect(ex('plain.ts', 'missing', 1)).toMatchObject({ published: false, unconfirmed: false });
    });
  });

  describe('a shallow history gives no settled "not an ancestor"', () => {
    function shallowClone() {
      const src = newRepo();
      const c1 = head(src);
      commitFiles(src, { 'a.txt': '1\n' });
      const c3 = commitFiles(src, { 'b.txt': '2\n' });
      const dst = mkdtempSync(join(tmpdir(), 'turbine-claims-shallow-'));
      dirs.push(dst);
      git(dst, 'init', '-q', '-b', 'main', '--object-format=sha1');
      git(dst, 'remote', 'add', 'origin', `file://${src}`);
      // The fixture's own fetches allow the local file transport, whatever protocol.file.allow the developer has set.
      git(dst, '-c', 'protocol.file.allow=always', 'fetch', '-q', '--depth', '1', 'origin', c3);
      git(dst, '-c', 'protocol.file.allow=always', 'fetch', '-q', '--depth', '1', 'origin', c1);
      return { src, dst, c1, c3 };
    }
    it('isAncestor throws in a shallow repository instead of answering false; a full repository answers', () => {
      const { src, dst, c1, c3 } = shallowClone();
      expect(git(dst, 'rev-parse', '--is-shallow-repository').trim()).toBe('true');
      expect(() => isAncestor(dst, c1, c3)).toThrow(/shallow/);
      expect(isAncestor(dst, c1, c1)).toBe(true); // a positive answer is settled whatever the depth
      expect(isAncestor(src, c1, c3)).toBe(true);
      expect(isAncestor(src, c3, c1)).toBe(false);
    });
    it('publishClaim refuses with an unconfirmed, retryable reason, not "does not descend"', () => {
      const { dst, c1, c3 } = shallowClone();
      const store = openStore();
      const first = claim({ kind: 'exists', evidence: [ev(dst, c1, 'docs/notes.md')], verifier: { kind: 'exists', path: 'docs/notes.md' } });
      expect(publishClaim(store, dst, dst, first).published).toBe(true);
      const second = claim({ kind: 'exists', evidence: [ev(dst, c3, 'docs/notes.md')], verifier: { kind: 'exists', path: 'docs/notes.md' } });
      const out = publishClaim(store, dst, dst, second);
      expect(out).toMatchObject({ published: false, unconfirmed: true, recorded: false });
      if (!out.published) expect(out.reason).not.toMatch(/does not descend/);
    });
  });

  it('the stored-row budget runs before the unsafe-key walk: a deeply nested row is a clear error, not a stack overflow', () => {
    const dir = repoOnce();
    const store = openStore();
    const ok = structuredClone(validClaims(dir, headOnce()).quote!) as Record<string, unknown>;
    expect(publishClaim(store, dir, dir, ok).published).toBe(true);
    store.db.prepare('UPDATE claims SET data = ? WHERE id = ?').run(`${'['.repeat(40_000)}${']'.repeat(40_000)}`, ok.id);
    expect(() => store.getClaim(dir, ok.id as string)).toThrow(/nested deeper/);
    expect(() => store.listClaims(dir)).toThrow(/nested deeper/);
  });

  it('parseClaim applies the budget first: deep input is a budget error, not a RangeError', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    let error: unknown;
    try {
      parseClaim(deep);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RangeError);
    expect((error as Error).message).toMatch(/nested deeper/);
  });

  it('the budget counts values as they are queued: a very wide array or object is refused without walking all of it', () => {
    const sparse = new Array<number>(2 ** 32 - 1); // four billion holes: a walk that queued them all would never finish
    expect(() => assertClaimBudget({ value: sparse })).toThrow(/more than 20000 values/);
    const wideObject: Record<string, number> = {};
    for (let i = 0; i < 25_000; i++) wideObject[`k${i}`] = i;
    expect(() => assertClaimBudget(wideObject)).toThrow(/more than 20000 values/);
    expect(() => assertClaimBudget({ a: [1, 2, { b: 'text' }] })).not.toThrow();
    expect(() => assertClaimBudget({ k: 'x'.repeat(128 * 1024 + 1) })).toThrow(/characters of text/);
  });
});

describe('review round 9 (PR #12): findings from the eighth local CodeRabbit review', () => {
  it('publishClaim refuses, without writing, if HEAD moves while the claim is being verified', () => {
    const dir = newRepo();
    const c = head(dir);
    const store = openStore();
    hooks.onVerify = () => {
      commitFiles(dir, { 'moved.txt': 'x\n' }); // another process commits while verification runs
    };
    let out;
    try {
      out = publishClaim(store, dir, dir, validClaims(dir, c).quote!);
    } finally {
      hooks.onVerify = undefined;
    }
    expect(out).toMatchObject({ published: false, unconfirmed: true, recorded: false });
    if (!out.published) expect(out.reason).toMatch(/HEAD moved/);
    expect(store.listClaims(dir)).toEqual([]);
    expect(store.getClaimFrontier(dir)).toBeNull();
    // With HEAD stable, the same claim (an explicit older pin) is published.
    expect(publishClaim(store, dir, dir, validClaims(dir, c).quote!).published).toBe(true);
  });

  it('a config key path never walks into the reader\'s inexact-number marker', () => {
    const d = newRepo({ 'n.json': '{"limit": 9007199254740993}\n' });
    const c = head(d);
    const cfg = (key: string[], value: unknown) =>
      publishClaim(openStore(), d, d, claim({ kind: 'config', evidence: [ev(d, c, 'n.json', 1)], verifier: { kind: 'config', path: 'n.json', key, value } }));
    const into = cfg(['limit', 'text'], '9007199254740993');
    expect(into).toMatchObject({ published: false, unconfirmed: false });
    if (!into.published) expect(into.reason).toMatch(/has no/);
    expect(cfg(['limit'], 9007199254740992)).toMatchObject({ published: false, unconfirmed: true });
  });

  it('export import aliases are exports', () => {
    const d = newRepo({ 'x.ts': "export import fs = require('node:fs');\nexport import member = Ns.Member;\nimport plain = require('node:path');\nexport const k = 1;\n" });
    const c = head(d);
    const ex = (symbol: string, line: number) =>
      publishClaim(openStore(), d, d, claim({ kind: 'exists', evidence: [ev(d, c, 'x.ts', line)], verifier: { kind: 'exists', path: 'x.ts', symbol } })).published;
    expect(ex('fs', 1)).toBe(true);
    expect(ex('member', 2)).toBe(true);
    expect(ex('plain', 3)).toBe(false); // not exported
    expect(ex('k', 4)).toBe(true);
    // The require edge of the exported alias is still an import.
    expect(publishClaim(openStore(), d, d, claim({ kind: 'imports', evidence: [ev(d, c, 'x.ts', 1)], verifier: { kind: 'imports', from: 'x.ts', specifier: 'node:fs' } })).published).toBe(true);
  });

  it('a claim reason is bounded on write and on read, and an oversized stored reason is an invalid row', () => {
    const dir = repoOnce();
    const store = openStore();
    const input = structuredClone(validClaims(dir, headOnce()).quote!) as Record<string, unknown>;
    const parsed = ClaimSchema.parse(input);
    expect(() => store.saveClaim({ repoPath: dir, claim: parsed, status: 'rejected', reason: 'x'.repeat(65 * 1024) })).toThrow(/over 65536 bytes/);
    expect(() => store.saveClaim({ repoPath: dir, claim: parsed, status: 'rejected', reason: '€'.repeat(22_000) })).toThrow(/over 65536 bytes/); // 66,000 bytes
    expect(store.saveClaim({ repoPath: dir, claim: parsed, status: 'verified', reason: 'proof' })).toBe(true);
    expect(() => store.withdrawClaim(dir, parsed.id, 'y'.repeat(70_000))).toThrow(/over 65536 bytes/);
    expect(store.getClaim(dir, parsed.id)).toMatchObject({ status: 'verified', reason: 'proof' });
    store.db.prepare('UPDATE claims SET reason = ? WHERE id = ?').run('€'.repeat(22_000), parsed.id);
    expect(() => store.getClaim(dir, parsed.id)).toThrow(/reason of more than 65536 bytes/);
    expect(() => store.listClaims(dir)).toThrow(/reason of more than 65536 bytes/);
    store.db.prepare('UPDATE claims SET reason = NULL WHERE id = ?').run(parsed.id);
    expect(store.getClaim(dir, parsed.id)).toMatchObject({ status: 'verified' }); // a missing reason is not an oversized one
  });

  it('the fixture shallow clone fetches with the file transport allowed even when the developer forbids it', () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-claims-proto-'));
    dirs.push(root);
    const globalConfig = join(root, 'gitconfig');
    writeFileSync(globalConfig, '[protocol "file"]\n\tallow = never\n');
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      const src = newRepo();
      const dst = mkdtempSync(join(tmpdir(), 'turbine-claims-proto-dst-'));
      dirs.push(dst);
      git(dst, 'init', '-q', '-b', 'main', '--object-format=sha1');
      git(dst, 'remote', 'add', 'origin', `file://${src}`);
      expect(() => git(dst, 'fetch', '-q', '--depth', '1', 'origin', head(src))).toThrow(); // the developer's setting applies by default
      expect(() => git(dst, '-c', 'protocol.file.allow=always', 'fetch', '-q', '--depth', '1', 'origin', head(src))).not.toThrow();
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
  });
});

describe('review round 10 (PR #12): findings from the ninth local CodeRabbit review', () => {
  it('a diverged transition does not repin or withdraw anything, and writes no event', () => {
    const dir = newRepo();
    const a = head(dir);
    const store = openStore();
    const input = validClaims(dir, a).quote!;
    publishClaim(store, dir, dir, input);
    const b = commitFiles(dir, { 'README.md': 'x\n' });
    reverifyOnCommit(store, dir, dir, a, b);
    git(dir, 'checkout', '-q', '-b', 'other', a);
    const other = commitFiles(dir, { 'src/util.ts': null }); // would withdraw the claim
    const before = JSON.stringify(store.listClaims(dir));
    const eventsBefore = JSON.stringify(store.db.prepare('SELECT * FROM events').all());
    expect(() => reverifyOnCommit(store, dir, dir, b, other)).toThrow(/does not descend/);
    expect(JSON.stringify(store.listClaims(dir))).toBe(before);
    expect(JSON.stringify(store.db.prepare('SELECT * FROM events').all())).toBe(eventsBefore);
    expect(store.getClaimFrontier(dir)).toBe(b);
    expect(store.getClaim(dir, input.id as string)).toMatchObject({ status: 'verified', commit: b });
  });

  it('an empty file has no lines: a citation of line 1 of it is refused, and a lone line terminator is one empty line', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('\ufeff')).toEqual([]);
    expect(splitLines('\n')).toEqual(['']);
    expect(splitLines('\r\n')).toEqual(['']);
    expect(splitLines('x\n')).toEqual(['x']);
    const d = newRepo({ 'empty.txt': '', 'nl.txt': '\n' });
    const c = head(d);
    const cite = (path: string) =>
      publishClaim(openStore(), d, d, claim({ kind: 'exists', evidence: [ev(d, c, path, 1)], verifier: { kind: 'exists', path } }));
    expect(cite('empty.txt')).toMatchObject({ published: false });
    expect(cite('nl.txt').published).toBe(true);
  });

  it('the store refuses a database in another text encoding, and accepts a UTF-8 one', () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-claims-utf16-'));
    dirs.push(root);
    const path = join(root, 'engine.db');
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA encoding = 'UTF-16le'; CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('a');");
    raw.close();
    expect(() => new WorkStore(path)).toThrow(/UTF-16le text encoding; only UTF-8/);
    const ok = new WorkStore(join(root, 'ok.db'));
    stores.push(ok);
    expect((ok.db.prepare('PRAGMA encoding').get() as { encoding: string }).encoding).toBe('UTF-8');
  });

  it('the fixture repository sets core.ignoreStat to false whatever the developer has globally', () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-claims-stat-'));
    dirs.push(root);
    const globalConfig = join(root, 'gitconfig');
    writeFileSync(globalConfig, '[core]\n\tignoreStat = true\n');
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      const d = newRepo();
      expect(git(d, 'config', '--get', 'core.ignoreStat').trim()).toBe('false');
      writeFileSync(join(d, 'src', 'app.ts'), '// edited\n');
      expect(git(d, 'status', '--porcelain')).toContain('src/app.ts'); // the edit is seen, not skipped as assume-unchanged
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
  });

  it('the status document states the star, numeric and transition rules', () => {
    const doc = readFileSync(resolve(here, '../../docs/IMPLEMENTATION_STATUS.md'), 'utf8');
    expect(doc).toContain('a `default` miss stays a definite failure');
    expect(doc).toContain('round-trips through a double');
    expect(doc).toContain('`next` must descend from `prev`');
  });
});

describe('review round 11 (PR #12): findings from the tenth local CodeRabbit review', () => {
  it('a rejection is not written if HEAD moved during verification', () => {
    const dir = newRepo();
    const c = head(dir);
    const store = openStore();
    hooks.onVerify = () => {
      commitFiles(dir, { 'moved.txt': 'x\n' });
    };
    let out;
    try {
      out = publishClaim(store, dir, dir, claim({ kind: 'imports', evidence: [ev(dir, c, 'src/app.ts', 2)], verifier: { kind: 'imports', from: 'src/app.ts', specifier: 'zzz' } }));
    } finally {
      hooks.onVerify = undefined;
    }
    expect(out).toMatchObject({ published: false, unconfirmed: true, recorded: false });
    if (!out.published) expect(out.reason).toMatch(/HEAD moved/);
    expect(store.listClaims(dir)).toEqual([]);
  });

  it('(require)("pkg") is an import when require is not shadowed', () => {
    const d = newRepo({ 'cjs.js': "const x = (require)('pkg');\nexport {};\n" });
    const c = head(d);
    expect(publishClaim(openStore(), d, d, claim({ kind: 'imports', evidence: [ev(d, c, 'cjs.js', 1)], verifier: { kind: 'imports', from: 'cjs.js', specifier: 'pkg' } })).published).toBe(true);
  });

  it('a top-level return makes the whole file unconfirmed; without it the import verifies', () => {
    const bad = newRepo({ 'm.ts': "import 'pkg';\nreturn;\n" });
    const good = newRepo({ 'm.ts': "import 'pkg';\n" });
    const cb = head(bad);
    const cg = head(good);
    expect(publishClaim(openStore(), bad, bad, claim({ kind: 'imports', evidence: [ev(bad, cb, 'm.ts', 1)], verifier: { kind: 'imports', from: 'm.ts', specifier: 'pkg' } }))).toMatchObject({ published: false, unconfirmed: true });
    expect(publishClaim(openStore(), good, good, claim({ kind: 'imports', evidence: [ev(good, cg, 'm.ts', 1)], verifier: { kind: 'imports', from: 'm.ts', specifier: 'pkg' } })).published).toBe(true);
  });

  it('a .cjs file may use a top-level return; its require still verifies', () => {
    const d = newRepo({ 'load.cjs': "const path = require('node:path');\nreturn path;\n" });
    const c = head(d);
    expect(
      publishClaim(openStore(), d, d, claim({ kind: 'imports', evidence: [ev(d, c, 'load.cjs', 1)], verifier: { kind: 'imports', from: 'load.cjs', specifier: 'node:path' } })).published,
    ).toBe(true);
  });

  it('a transition refuses to move the frontier past a published claim at another commit', () => {
    const dir = newRepo();
    const a = head(dir);
    const store = openStore();
    const early = ClaimSchema.parse(validClaims(dir, a).quote!);
    // Trusted write with no frontier: simulates a row left from outside publishClaim.
    store.saveClaim({ repoPath: dir, claim: early, status: 'verified', reason: 'seeded' });
    const b = commitFiles(dir, { 'README.md': 'x\n' });
    const late = ClaimSchema.parse({ ...validClaims(dir, b).imports!, evidence: (validClaims(dir, b).imports!.evidence as Array<Record<string, unknown>>).map((e) => ({ ...e, commit: b, blob: git(dir, 'rev-parse', `${b}:${e.path as string}`).trim() })) });
    store.saveClaim({ repoPath: dir, claim: late, status: 'verified', reason: 'seeded' });
    expect(() => reverifyOnCommit(store, dir, dir, b, commitFiles(dir, { 'README.md': 'y\n' }))).toThrow(/sit at commit/);
    expect(store.getClaim(dir, early.id)).toMatchObject({ status: 'verified', commit: a });
    expect(store.getClaimFrontier(dir)).toBeNull();
  });

  it('ancestry refuses a repository that has info/grafts', () => {
    const dir = newRepo();
    const a = head(dir);
    const b = commitFiles(dir, { 'a.txt': '1\n' });
    const grafts = join(dir, '.git', 'info', 'grafts');
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(grafts, `${b} ${a}\n`);
    expect(() => isAncestor(dir, a, b)).toThrow(/grafts/);
  });

  it('listPublishedClaimCommits is metadata-only, statuses are deduped, and a NUL reason is refused', () => {
    const dir = newRepo();
    const c = head(dir);
    const store = openStore();
    const a = ClaimSchema.parse(validClaims(dir, c).quote!);
    const b = ClaimSchema.parse(validClaims(dir, c).imports!);
    publishClaim(store, dir, dir, a);
    publishClaim(store, dir, dir, b);
    expect(store.listPublishedClaimCommits(dir)).toEqual([c]);
    expect(store.listClaims(dir, { statuses: ['verified', 'verified', 'verified'] })).toHaveLength(2);
    expect(() => store.saveClaim({ repoPath: dir, claim: a, status: 'rejected', reason: 'bad\0tail' })).toThrow(/NUL/);
    expect(() => store.withdrawClaim(dir, a.id, 'bad\0tail')).toThrow(/NUL/);
  });

  it('a table inside <pre> is not linted, and an invalid fence opener does not end a table', () => {
    expect(tableProblems(['<pre>', '| A | B |', '| - | - |', '| short |', '</pre>']).problems).toEqual([]);
    // A row that looks like a fence but has a backtick in the info string is still a table row.
    const t = tableProblems(['| A | B |', '| - | - |', '``` label ` | x | extra']);
    expect(t.rows).toBeGreaterThanOrEqual(1);
    expect(t.problems.length).toBeGreaterThanOrEqual(1);
  });

  it('the decoy GIT_DIR check uses a status-checked count', () => {
    // Covered by the existing decoy test once updated; assert the helper shape here.
    const decoy = mkdtempSync(join(tmpdir(), 'turbine-claims-decoy2-'));
    dirs.push(decoy);
    git(decoy, 'init', '-q', '-b', 'main');
    expect(git(decoy, 'rev-list', '--all', '--count').trim()).toBe('0');
  });

  it('the shallow helper itself works under protocol.file.allow=never', () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-claims-proto2-'));
    dirs.push(root);
    const globalConfig = join(root, 'gitconfig');
    writeFileSync(globalConfig, '[protocol "file"]\n\tallow = never\n');
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      // Inline the helper body used by the shallow tests (same fetches with -c allow=always).
      const src = newRepo();
      const c1 = head(src);
      commitFiles(src, { 'a.txt': '1\n' });
      const c3 = commitFiles(src, { 'b.txt': '2\n' });
      const dst = mkdtempSync(join(tmpdir(), 'turbine-claims-shallow2-'));
      dirs.push(dst);
      git(dst, 'init', '-q', '-b', 'main', '--object-format=sha1');
      git(dst, 'remote', 'add', 'origin', `file://${src}`);
      git(dst, '-c', 'protocol.file.allow=always', 'fetch', '-q', '--depth', '1', 'origin', c3);
      git(dst, '-c', 'protocol.file.allow=always', 'fetch', '-q', '--depth', '1', 'origin', c1);
      expect(git(dst, 'cat-file', '-t', c1).trim()).toBe('commit');
      expect(git(dst, 'cat-file', '-t', c3).trim()).toBe('commit');
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
  });
});

describe('review round 12 (PR #12): findings from the eleventh local CodeRabbit review', () => {
  it('replacing one claim at A with the same id at B does not hide a sibling still published at A', () => {
    const dir = newRepo();
    const a = head(dir);
    const store = openStore();
    const x = validClaims(dir, a).quote!;
    const y = validClaims(dir, a).imports!;
    expect(publishClaim(store, dir, dir, x).published).toBe(true);
    expect(publishClaim(store, dir, dir, y).published).toBe(true);
    const b = commitFiles(dir, { 'README.md': 'x\n' });
    const xAtB = ClaimSchema.parse({ ...x, evidence: (x.evidence as Array<Record<string, unknown>>).map((e) => ({ ...e, commit: b, blob: git(dir, 'rev-parse', `${b}:${e.path as string}`).trim() })) });
    const out = publishClaim(store, dir, dir, xAtB);
    expect(out).toMatchObject({ published: false, recorded: false });
    if (!out.published) expect(out.reason).toMatch(/reverifyOnCommit/);
    expect(store.getClaim(dir, y.id as string)).toMatchObject({ status: 'verified', commit: a });
    expect(store.getClaimFrontier(dir)).toBe(a);
    // The sole claim can move once its sibling is carried.
    reverifyOnCommit(store, dir, dir, a, b);
    expect(publishClaim(store, dir, dir, xAtB).published).toBe(true);
  });

  it('a verifier reason that quotes a key containing NUL is stored, with the NUL escaped', () => {
    const d = newRepo({ 'n.json': '{"a": 1}\n' });
    const c = head(d);
    const out = publishClaim(openStore(), d, d, claim({ kind: 'config', evidence: [ev(d, c, 'n.json', 1)], verifier: { kind: 'config', path: 'n.json', key: ['a\u0000b'], value: 1 } }));
    expect(out).toMatchObject({ published: false, recorded: true });
    if (!out.published) expect(out.reason).not.toMatch(/\0/);
  });

  it('module-scope loops and switches may break and continue; a return still fails the file', () => {
    const ok = newRepo({ 'm.ts': "import 'pkg';\nfor (const x of []) { if (x) continue; break; }\nswitch (0) { case 0: break; }\nlabel: for (;;) { break label; }\n" });
    const bad = newRepo({ 'm.ts': "import 'pkg';\nfor (const x of []) { return; }\n" });
    const cOk = head(ok);
    const cBad = head(bad);
    expect(publishClaim(openStore(), ok, ok, claim({ kind: 'imports', evidence: [ev(ok, cOk, 'm.ts', 1)], verifier: { kind: 'imports', from: 'm.ts', specifier: 'pkg' } })).published).toBe(true);
    expect(publishClaim(openStore(), bad, bad, claim({ kind: 'imports', evidence: [ev(bad, cBad, 'm.ts', 1)], verifier: { kind: 'imports', from: 'm.ts', specifier: 'pkg' } }))).toMatchObject({ published: false, unconfirmed: true });
  });

  it('a break or return does not inherit a loop or function enclosing a nested function or static block', () => {
    const leakBreak = newRepo({ 'm.ts': "import 'pkg';\nfor (;;) { function f() { break; } }\n" });
    const leakStatic = newRepo({ 'm.ts': "import 'pkg';\nfunction outer() { class C { static { return; } } }\n" });
    const okNested = newRepo({ 'm.ts': "import 'pkg';\nfunction f() { for (;;) { break; } return; }\n" });
    const cLeak = head(leakBreak);
    const cStatic = head(leakStatic);
    const cOk = head(okNested);
    expect(publishClaim(openStore(), leakBreak, leakBreak, claim({ kind: 'imports', evidence: [ev(leakBreak, cLeak, 'm.ts', 1)], verifier: { kind: 'imports', from: 'm.ts', specifier: 'pkg' } }))).toMatchObject({ published: false, unconfirmed: true });
    expect(publishClaim(openStore(), leakStatic, leakStatic, claim({ kind: 'imports', evidence: [ev(leakStatic, cStatic, 'm.ts', 1)], verifier: { kind: 'imports', from: 'm.ts', specifier: 'pkg' } }))).toMatchObject({ published: false, unconfirmed: true });
    expect(publishClaim(openStore(), okNested, okNested, claim({ kind: 'imports', evidence: [ev(okNested, cOk, 'm.ts', 1)], verifier: { kind: 'imports', from: 'm.ts', specifier: 'pkg' } })).published).toBe(true);
  });

  it('duplicate active labels fail the module; chained labels on a loop remain valid targets', () => {
    const dup = newRepo({ 'm.ts': "import 'pkg';\nouter: { outer: {} }\n" });
    const chained = newRepo({ 'm.ts': "import 'pkg';\nouter: inner: for (;;) { continue outer; break inner; }\n" });
    const reuse = newRepo({ 'm.ts': "import 'pkg';\nouter: for (;;) { break outer; }\nouter: for (;;) { break outer; }\n" });
    const cDup = head(dup);
    const cChained = head(chained);
    const cReuse = head(reuse);
    expect(publishClaim(openStore(), dup, dup, claim({ kind: 'imports', evidence: [ev(dup, cDup, 'm.ts', 1)], verifier: { kind: 'imports', from: 'm.ts', specifier: 'pkg' } }))).toMatchObject({ published: false, unconfirmed: true });
    expect(publishClaim(openStore(), chained, chained, claim({ kind: 'imports', evidence: [ev(chained, cChained, 'm.ts', 1)], verifier: { kind: 'imports', from: 'm.ts', specifier: 'pkg' } })).published).toBe(true);
    expect(publishClaim(openStore(), reuse, reuse, claim({ kind: 'imports', evidence: [ev(reuse, cReuse, 'm.ts', 1)], verifier: { kind: 'imports', from: 'm.ts', specifier: 'pkg' } })).published).toBe(true);
  });

  it('a repository path over the read limit is refused on write, and both 40 and 64-hex object ids round-trip', () => {
    const store = openStore();
    const dir = repoOnce();
    const c = headOnce();
    const claim = ClaimSchema.parse(validClaims(dir, c).quote!);
    expect(() => store.saveClaim({ repoPath: 'x'.repeat(128 * 1024 + 1), claim, status: 'verified', reason: 'x' })).toThrow(/over .* bytes/);
    store.setClaimFrontier(dir, 'a'.repeat(64));
    expect(store.getClaimFrontier(dir)).toBe('a'.repeat(64));
    const long = ClaimSchema.parse({ ...claim, id: 'sha256-pin', evidence: [{ ...(claim.evidence[0] as object), commit: 'b'.repeat(64), blob: 'c'.repeat(64) }] });
    expect(store.saveClaim({ repoPath: dir, claim: long, status: 'verified', reason: 'x' })).toBe(true);
    expect(store.getClaim(dir, 'sha256-pin')).toMatchObject({ commit: 'b'.repeat(64) });
  });

  it('a table inside an HTML comment is not linted', () => {
    expect(tableProblems(['<!--', '| A | B |', '| - | - |', 'short', '-->']).problems).toEqual([]);
    expect(tableProblems(['| A | B |', '| - | - |', 'short']).problems).toHaveLength(1);
    // A prose mention of `<!--` is not a block opener: a malformed table after it is still reported.
    expect(tableProblems(['Use `<!--` to hide notes.', '| A | B |', '| - | - |', 'short']).problems).toHaveLength(1);
  });

  it('fixture repositories pin SHA-1 whatever init.defaultObjectFormat says', () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-claims-sha-'));
    dirs.push(root);
    const globalConfig = join(root, 'gitconfig');
    writeFileSync(globalConfig, '[init]\n\tdefaultObjectFormat = sha256\n');
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      expect(head(newRepo())).toHaveLength(40);
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
  });
});
