import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { contentHashText, shortSnapshotId, type ImportEdge, type Reason, type RelevantFile, type TaskContext } from '@turbine-hall/turbine-contracts';
import type { LintIssue } from '../docs/lint.js';
import { TEST_NAMING_RULE, TEST_PATH_RULE } from './relevance.js';

/**
 * CONTEXT.md: the task context as a document.
 *
 *   <!-- GENERATED … -->
 *   <!-- turbine:task-context begin snapshot=… commit=… content=sha256:… -->
 *   (everything Turbine states: how files were chosen, the files, what was left out, what changed)
 *   <!-- turbine:task-context end -->
 *
 *   ## Agent notes        ← the only part anyone may write; kept across renders, never merged into the block
 *
 * The block is a pure function of the stored selection (plus whether it is still current), re-rendered on
 * every render. Its content hash is in the begin marker, so a hand edit is found by `turbine lint` and
 * overwritten by the next render. Text is rendered FROM the structured reasons, never stored.
 */

/** CONTEXT.md is generated text plus the agent's notes; a larger file (a pasted log) is not read into memory. */
export const MAX_CONTEXT_FILE_BYTES = 1024 * 1024;

/**
 * The text of a CONTEXT.md: a regular file of at most `MAX_CONTEXT_FILE_BYTES`. Anything else throws with the reason
 * (a symlink or directory, too large, unreadable); a missing file throws ENOENT. The file is opened without following
 * a link and without blocking (a FIFO named CONTEXT.md is refused, not waited on), and read at most one byte past the limit, so a file that grows after it was checked is still caught.
 */
export function readContextFile(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('is not a regular file (a symlink or directory)');
    if (st.size > MAX_CONTEXT_FILE_BYTES) throw new Error(`is ${st.size} bytes, over the ${MAX_CONTEXT_FILE_BYTES} byte limit for a task context file`);
    const buf = Buffer.alloc(MAX_CONTEXT_FILE_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    if (n > MAX_CONTEXT_FILE_BYTES) throw new Error(`grew past the ${MAX_CONTEXT_FILE_BYTES} byte limit for a task context file while it was read`);
    return buf.subarray(0, n).toString('utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('is not a regular file (a symlink or directory)');
    throw e;
  } finally {
    closeSync(fd);
  }
}

export type Staleness = 'base-commit-changed' | 'snapshot-changed' | 'changes-requested' | 'budget-changed' | 'request-changed' | 'method-changed';

const STALE_TEXT: Record<Staleness, string> = {
  'base-commit-changed': 'the base commit has moved since this was built',
  'snapshot-changed': 'the project snapshot it was built from has been replaced',
  'changes-requested': 'the task re-entered CHANGES_REQUESTED after this was built',
  'budget-changed': 'the size limit of the roles on this task has changed',
  'request-changed': 'the request text has changed',
  'method-changed': 'the ranking rules have changed',
};

// ------------------------------------------------------------ one-line text

const oneLine = (t: string) => t.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').replace(/\s+/g, ' ').trim();

/** Inline code that survives any content: the fence is longer than the longest backtick run inside. */
export function code(text: string): string {
  const flat = oneLine(text);
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

const clip = (t: string, n = 140) => (oneLine(t).length > n ? `${oneLine(t).slice(0, n - 1)}…` : oneLine(t));

function edgeText(e: ImportEdge): string {
  const label = e.kind === 'import-type' ? ' [type-only]' : e.kind === 'dynamic' ? ' [dynamic import]' : e.kind === 'require' ? ' [require]' : e.kind === 're-export' ? ' [re-export]' : e.kind === 'side-effect' ? ' [side-effect import]' : '';
  return `line ${e.line} of ${code(e.from)}: ${code(clip(e.statement))}${label}`;
}

/** The sentence for one reason. It states the evidence the reason carries, so it can be checked by hand. */
export function reasonText(r: Reason): string {
  switch (r.kind) {
    case 'named-in-request': {
      const how =
        r.rule === 'exact-path'
          ? 'exact path'
          : r.rule === 'path-suffix'
            ? 'the end of this path'
            : r.rule === 'unique-basename'
              ? 'file name; the only tracked file with it'
              : `file name; ${r.sharedBy} tracked files have it`;
      return `named in request: “${r.quote}” (${how})`;
    }
    case 'exports-symbol':
      return `exports ${code(r.symbol)} (line ${r.line}: ${code(clip(r.statement))}); the request mentions “${r.quote}” (${r.rule === 'distinctive-name' ? 'a distinctive name' : 'written as code'})`;
    case 'imports':
      return `imports ${code(r.seed)} (${edgeText(r.edge)}; resolved by: ${oneLine(r.edge.resolution)})`;
    case 'imported-by':
      return `imported by ${code(r.seed)} (${edgeText(r.edge)}; resolved by: ${oneLine(r.edge.resolution)})`;
    case 'test-for':
      return r.rule === 'imports' && r.edge
        ? `test for ${code(r.subject)}: it imports it (${edgeText(r.edge)}; resolved by: ${oneLine(r.edge.resolution)}). Test rule: ${TEST_PATH_RULE}`
        : `test for ${code(r.subject)}: ${r.naming ?? TEST_NAMING_RULE}. Test rule: ${TEST_PATH_RULE}`;
    case 'owner':
      return `in package ${code(r.package.dir)}${r.package.name ? ` (${code(r.package.name)})` : ''}, its nearest enclosing package${r.sharesWith ? `; ${code(r.sharesWith)}, which the request points to, is in the same package` : ''}`;
    case 'codeowners':
      return `CODEOWNERS ${code(r.file)} line ${r.line}: ${code(r.rule)}`;
    case 'owner-manifest':
      return `package.json of package ${code(r.package.dir)}, which owns ${code(r.ownerOf)}`;
    case 'path-words':
      return `path mentions rare words: ${r.words.map((w) => `${code(w.word)} (in ${w.files} of ${w.of} paths)`).join(', ')}; weight ${r.weight}`;
  }
}

/** One file as it appears in the list. Its length is what the `maxChars` limit counts. */
export function renderFileEntry(f: RelevantFile): string {
  return [`- ${code(f.path)} — score ${f.score}`, ...f.reasons.map((r) => `  - ${reasonText(r)}`)].join('\n');
}

// ------------------------------------------------------------ the generated block

export type BodyOptions = {
  title: string;
  workId: string;
  stale: Staleness[];
  /** Link to the project facts, relative to CONTEXT.md; undefined for text that is not a file (a prompt). */
  projectLink?: string;
};

const LIST_CAP = 20;
const OMITTED_ROWS = 30;

export function renderContextBody(sel: TaskContext, o: BodyOptions): string {
  const out: string[] = [];
  const short = sel.snapshot.commit.slice(0, 8);
  out.push(`# Task context — ${oneLine(o.title)} (${o.workId})`, '');
  if (o.stale.length) {
    out.push(
      `> ⚠️ **STALE — do not rely on this list.** ${o.stale.map((s) => STALE_TEXT[s]).join('; ')}. Run \`turbine task next ${o.workId}\`: it rebuilds the selection first.`,
      '',
    );
  } else {
    out.push(`> Current: built at commit ${code(short)} and checked against the repository when this was written.`, '');
  }
  if (o.projectLink) out.push(`Read the project facts first: [PROJECT.md](${o.projectLink}).`, '');

  out.push('## How these files were chosen', '');
  out.push(
    '**This is a selection, not a complete list.** Files that matter to the task can be missing from it, and a listed file is only listed because of the reasons shown under it. Each reason can be checked against the commit.',
    '',
    `- Built from commit ${code(sel.snapshot.commit)} (project snapshot ${code(shortSnapshotId(sel.snapshot.hash))}). Uncommitted changes in the checkout are never read.`,
    `- Request: ${sel.request.chars} characters (${code(sel.request.hash.slice(0, 19))}).`,
    '- Signals, strongest first (points a reason adds to a file\'s score):',
    '  1. a path or file name written in the request: exact path 100, end of a path 90, unique file name 70 (a name shared by several files: 70 ÷ files, at least 15; names shared by more than 10 files are not used);',
    '  2. an exported symbol the request mentions (a distinctive name, or one written as code): 60, then 15 for each further symbol (up to 3);',
    '  3. one import away from a file of 1 or 2, in either direction: 30;',
    `  4. a test of a file of 1 or 2: it imports it 25, or the naming rule matches 20 (${TEST_PATH_RULE}; naming rule: ${TEST_NAMING_RULE});`,
    '  5. ownership: the package.json of the package that owns a file of 1 or 2: 10; a file in the same package as one of them: 5; CODEOWNERS is shown and adds nothing;',
    '  6. rare words of the request in the path (weakest, at most 4 points).',
    '- An import is a statement read from a file at the commit, found by parsing the file with the TypeScript parser (comments, strings, regular expressions and JSX text are never read as code; a file with a syntax error states nothing). Relative paths and workspace package names are resolved; `tsconfig` path aliases, sub-path imports of workspace packages and run-time imports are not.',
  );
  const l = sel.limits;
  out.push(
    `- Read: ${l.sourceFilesScanned} of ${l.sourceFiles} source files` +
      `${l.notScannedTooLarge ? `; ${l.notScannedTooLarge} over the size limit for one file` : ''}` +
      `${l.notScannedOverCap ? `; ${l.notScannedOverCap} beyond the scan cap` : ''}` +
      `${l.metadataNotRead ? `; ${l.metadataNotRead} manifest, tsconfig or CODEOWNERS file(s) not read (size limit)` : ''}` +
      `${l.statementsUnconfirmed ? `; ${l.statementsUnconfirmed} require() call(s) not stated because \`require\` is bound in the file` : ''}` +
      `${l.unreadableTotal ? `; ${l.unreadableTotal} could not be parsed, so no import or export is stated for them${l.unreadable.length ? ` (${l.unreadable.slice(0, 5).map(code).join(', ')}${l.unreadableTotal > 5 ? ', …' : ''})` : ''}` : ''}.` +
      ` ${l.unresolvedRelative} relative and ${l.unresolvedPackage} workspace-package imports could not be resolved to a tracked file.`,
    `- ${l.seeds} file(s) were named by the request or export a symbol it mentions; hops and tests were taken from the best ${l.seedsUsedForHops}.${l.hopsTruncated ? ` ${l.hopsTruncated} hop file(s) beyond the per-file limit are not considered.` : ''}${l.testsTruncated ? ` ${l.testsTruncated} test(s) beyond the per-file limit are not considered.` : ''}`,
    l.codeowners
      ? `- CODEOWNERS read from ${code(l.codeowners)}${l.codeownersRulesSkipped ? ` (${l.codeownersRulesSkipped} rule(s) using unsupported syntax were skipped)` : ''}.`
      : '- No CODEOWNERS file in the repository.',
    `- Size limit: at most ${sel.budget.maxFiles} files and ${sel.budget.maxChars} characters of list (${sel.budget.source === 'roles' ? `largest limit asked for by ${sel.budget.roles.join(', ')}` : 'the default; no selected role declares one'}).`,
    `- ${sel.candidates} file(s) have at least one reason; ${sel.files.length} are listed and ${sel.omittedTotal} were left out by the size limit.`,
    '',
  );

  out.push(`## Files (${sel.files.length} listed of ${sel.candidates} with a reason)`, '');
  if (sel.files.length) for (const f of sel.files) out.push(renderFileEntry(f));
  else out.push('_No file has a reason for this request. That does not mean none is relevant._');
  out.push('');

  out.push(`## Left out by the size limit (${sel.omittedTotal})`, '');
  if (!sel.omittedTotal) {
    out.push('_Nothing was left out._');
  } else {
    out.push('Best first. These had reasons but did not fit.', '', '| File | Score | Left out by | Best reason |', '| --- | --- | --- | --- |');
    for (const f of sel.omitted.slice(0, OMITTED_ROWS)) {
      out.push(`| ${code(f.path)} | ${f.score} | ${f.why} | ${reasonText(f.reasons[0]!).replace(/\|/g, '\\|')} |`);
    }
    const more = sel.omittedTotal - Math.min(OMITTED_ROWS, sel.omitted.length);
    if (more > 0) out.push('', `_${more} more (lower scores) are in evidence/context.json${sel.omitted.length < sel.omittedTotal ? `; it keeps the best ${sel.omitted.length}` : ''}._`);
  }
  out.push('');

  if (sel.changes) {
    const c = sel.changes;
    out.push(`## Changes since the previous selection (${code(c.fromCommit.slice(0, 8))} → ${code(c.toCommit.slice(0, 8))})`, '');
    const list = (title: string, items: string[]) => {
      if (!items.length) return;
      out.push(`- ${title} (${items.length}): ${items.slice(0, LIST_CAP).join(', ')}${items.length > LIST_CAP ? `, +${items.length - LIST_CAP} more` : ''}`);
    };
    list('now listed', c.added.map((x) => `${code(x.path)} (${x.score})`));
    list('no longer listed', c.removed.map((x) => `${code(x.path)} (${x.score})`));
    list('score changed', c.rescored.map((x) => `${code(x.path)} ${x.from} → ${x.to}`));
    if (c.gitChanged) list('files of the previous list that git reports as changed between the two commits', c.gitChanged.map((x) => `${code(x.path)} (${x.status})`));
    else if (c.gitUnavailable) out.push(`- git could not compare the two commits: ${oneLine(c.gitUnavailable)}`);
    if (!c.added.length && !c.removed.length && !c.rescored.length && !(c.gitChanged?.length)) out.push('- The listed files and their scores are unchanged.');
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '');
}

// ------------------------------------------------------------ the file: block + agent notes

const HEADER =
  '<!-- GENERATED by `turbine` from the store. The block between the markers is rewritten on every render and checked by `turbine lint`; edit only "## Agent notes". -->';
const BEGIN = /^<!-- turbine:task-context begin ([^>]*?) -->\r?$/m;
const BEGIN_ANY = /^<!-- turbine:task-context begin [^>]*? -->\r?$/gm;
const END = /^<!-- turbine:task-context end -->\r?$/m;
const END_ANY = /^<!-- turbine:task-context end -->\r?$/gm;
const NOTES_HEADING = /^## Agent notes[ \t]*\r?$/m;
export const NOTES_LABEL = '_Written by agents, not by Turbine. Not verified, and never merged into the facts above._';

const attrsOf = (raw: string): Record<string, string> => Object.fromEntries([...raw.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1]!, m[2]!]));

export type ParsedContextFile = {
  /** The generated block, or why there is none. */
  block?: { attrs: Record<string, string>; body: string };
  problem?: string;
  notes: string;
  /** Text outside the block and the notes (not part of either, so a render drops it). */
  stray: string;
};

export function parseContextFile(raw: string): ParsedContextFile {
  const text = raw.replace(/\r\n/g, '\n');
  // Everything from the first "## Agent notes" heading on is notes. The generated block never contains such a
  // line, and markers pasted into the notes must not be mistaken for the block's own.
  const h = NOTES_HEADING.exec(text);
  const head = h ? text.slice(0, h.index) : text;
  let notes = h ? text.slice(h.index + h[0].length) : '';
  notes = notes.replace(/^\s*\n/, '\n').replace(/^\n+/, '');
  if (notes.startsWith(NOTES_LABEL)) notes = notes.slice(NOTES_LABEL.length);
  notes = notes.replace(/^\n+/, '').replace(/\s+$/, '');

  const begins = (head.match(BEGIN_ANY) ?? []).length;
  const ends = (head.match(END_ANY) ?? []).length;
  let outside = head;
  let block: ParsedContextFile['block'];
  let problem: string | undefined;
  if (begins === 0 && ends === 0) {
    problem = 'the generated block (the "turbine:task-context begin/end" markers) is missing';
  } else if (begins !== 1 || ends !== 1) {
    problem = `expected exactly one "turbine:task-context begin" and one "end" marker, found ${begins} and ${ends}`;
  } else {
    const b = BEGIN.exec(head)!;
    const e = END.exec(head)!;
    if (e.index < b.index + b[0].length) {
      problem = 'the "end" marker comes before the "begin" marker';
    } else {
      const start = b.index + b[0].length + 1;
      block = { attrs: attrsOf(b[1]!), body: head.slice(start, Math.max(start, e.index - 1)) };
      outside = head.slice(0, b.index) + head.slice(e.index + e[0].length);
    }
  }
  const stray = outside.replace(HEADER, '').trim();
  return { ...(block ? { block } : {}), ...(problem ? { problem } : {}), notes, stray };
}

/** The hash in the marker covers the provenance fields as well as the body: editing `commit=` or `snapshot=` is caught. */
const blockHash = (snapshot: string, commit: string, body: string) => contentHashText(`snapshot=${snapshot}\ncommit=${commit}\n${body}`);

/** The whole file: header, the block with its hash, and the agent notes kept exactly as written. */
export function renderContextFile(sel: TaskContext, body: string, notes: string): string {
  const marker = `<!-- turbine:task-context begin snapshot=${sel.snapshot.hash} commit=${sel.snapshot.commit} content=${blockHash(sel.snapshot.hash, sel.snapshot.commit, body)} -->`;
  const kept = notes.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return [HEADER, marker, body, '<!-- turbine:task-context end -->', '', '## Agent notes', '', NOTES_LABEL, ...(kept ? ['', kept] : []), ''].join('\n');
}

/** The message CONTEXT.md carries when there is no selection to show. */
export function renderUnavailableFile(title: string, workId: string, reason: string, notes: string): string {
  const body = [`# Task context — ${oneLine(title)} (${workId})`, '', `> No file selection exists: ${oneLine(reason)}. Nothing is claimed about which files matter.`].join('\n');
  const marker = `<!-- turbine:task-context begin snapshot=none commit=none content=${blockHash('none', 'none', body)} -->`;
  const kept = notes.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return [HEADER, marker, body, '<!-- turbine:task-context end -->', '', '## Agent notes', '', NOTES_LABEL, ...(kept ? ['', kept] : []), ''].join('\n');
}

// ------------------------------------------------------------ lint

/** Report what is wrong with a CONTEXT.md on disk: damaged markers, a hand-edited block, text outside the notes. */
export function lintContextFile(raw: string, file = 'CONTEXT.md'): LintIssue[] {
  const p = parseContextFile(raw);
  const issues: LintIssue[] = [];
  if (!p.block) {
    issues.push({ level: 'error', file, message: `${p.problem}; the file is regenerated by \`turbine task next\`, keeping "## Agent notes"` });
    return issues;
  }
  const actual = blockHash(p.block.attrs.snapshot ?? '', p.block.attrs.commit ?? '', p.block.body);
  if (p.block.attrs.content !== actual) {
    issues.push({
      level: 'error',
      file,
      message: 'the generated part was edited by hand (its content hash, which covers the snapshot and commit in the marker, no longer matches); the edit is overwritten on the next render. Put notes under "## Agent notes".',
    });
  }
  if (p.stray) issues.push({ level: 'warning', file, message: 'text outside the generated part and "## Agent notes" is dropped on the next render' });
  return issues;
}

/** `turbine lint`: every task's CONTEXT.md under .turbine/tasks/. Reads files only. */
export function lintTaskContexts(projectRoot: string): LintIssue[] {
  const tasks = join(projectRoot, '.turbine', 'tasks');
  if (!existsSync(tasks)) return [];
  const issues: LintIssue[] = [];
  for (const id of readdirSync(tasks).sort()) {
    const file = join(tasks, id, 'CONTEXT.md');
    let st;
    try {
      st = lstatSync(file);
    } catch {
      continue;
    }
    const name = `.turbine/tasks/${id}/CONTEXT.md`;
    if (!st.isFile()) {
      issues.push({ level: 'error', file: name, message: 'is not a regular file (a symlink or directory)' });
      continue;
    }
    let raw: string;
    try {
      raw = readContextFile(file);
    } catch (e) {
      issues.push({ level: 'error', file: name, message: `cannot be read: ${(e as Error).message}` });
      continue;
    }
    issues.push(...lintContextFile(raw, name));
  }
  return issues;
}
