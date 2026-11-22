import { existsSync, lstatSync, opendirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  OKF_VERSION,
  OkfActorSchema,
  OkfConceptFrontmatterSchema,
  OkfSourceEntrySchema,
  OkfTimestampSchema,
  TURBINE_OKF_PROFILE,
  TURBINE_OKF_PROFILE_CONCEPTS,
  encodeOkfConceptSegment,
  isTurbineOkfConceptType,
  okfEffectiveStatus,
  turbineOkfConceptPath,
  turbineOkfConceptProfile,
  type TurbineOkfConceptType,
} from '@turbine-hall/turbine-contracts';
import type { LintIssue } from '../docs/lint.js';
import { splitFrontmatter } from './frontmatter.js';
import { MAX_BUNDLE_DEPTH, MAX_BUNDLE_FILE_BYTES, MAX_BUNDLE_FILES, knowledgePaths, readBoundedUtf8 } from './paths.js';

const FOOTNOTE_REF = /\[\^([^\]\s]+)\]/g;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RESERVED = new Set(['index.md', 'log.md']);

export type KnowledgeIssue = LintIssue & { code?: string };

/** Validate an OKF v0.3 bundle against the Turbine profile. */
export function validateBundle(dir: string): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];
  if (!existsSync(dir)) {
    issues.push({ level: 'error', file: dir, message: 'bundle directory does not exist', code: 'missing-bundle' });
    return issues;
  }
  let rootReal: string;
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      issues.push({ level: 'error', file: dir, message: 'bundle root must be a real directory (not a symlink)', code: 'bad-root' });
      return issues;
    }
    rootReal = realpathSync(dir);
  } catch (e) {
    issues.push({ level: 'error', file: dir, message: `cannot read bundle root (${(e as Error).message})`, code: 'bad-root' });
    return issues;
  }

  const files = listBundleFiles(rootReal, issues);
  if (issues.some((i) => i.code === 'too-many-files')) return issues;

  const indexRel = 'index.md';
  if (!files.has(indexRel)) {
    issues.push({ level: 'error', file: indexRel, message: 'bundle-root index.md is required', code: 'missing-index' });
  } else {
    validateIndex(rootReal, indexRel, issues);
  }
  if (files.has('log.md')) {
    validateLog(rootReal, 'log.md', issues);
  }

  const indexCommit = readIndexCommit(rootReal, issues);
  const seenConceptPaths = new Set<string>();
  for (const rel of [...files].sort()) {
    const base = rel.split('/').pop()!;
    if (RESERVED.has(base)) {
      // Nested reserved names are not concepts; still enforce OKF §8/§9 rules (E004/E006).
      if (rel.includes('/')) validateNestedReserved(rootReal, rel, base, issues);
      continue;
    }
    if (rel === 'README.md') {
      validateReadme(rootReal, rel, issues);
      continue;
    }
    if (!rel.endsWith('.md')) continue;
    if (rel.split('/').some((p) => p.startsWith('.'))) continue;
    validateConcept(rootReal, rel, issues, seenConceptPaths, indexCommit);
  }

  // Required fixed-layout files for a complete Turbine bundle: path exists AND is the expected concept type.
  for (const profile of TURBINE_OKF_PROFILE_CONCEPTS) {
    if (profile.naming !== 'fixed') continue;
    const path = turbineOkfConceptPath(profile.type);
    if (!files.has(path)) {
      issues.push({
        level: 'error',
        file: path,
        message: `required ${profile.type} concept is missing`,
        code: 'missing-required-concept',
      });
      continue;
    }
    const text = readBounded(rootReal, path, issues);
    if (text === undefined) {
      issues.push({
        level: 'error',
        file: path,
        message: `required ${profile.type} concept is unreadable`,
        code: 'missing-required-concept',
      });
      continue;
    }
    const split = splitFrontmatter(text);
    if (!split.ok || split.data.type !== profile.type) {
      issues.push({
        level: 'error',
        file: path,
        message: `required ${profile.type} concept is missing or not a typed concept at this path`,
        code: 'missing-required-concept',
      });
    }
  }

  return issues;
}

function listBundleFiles(root: string, issues: KnowledgeIssue[]): Set<string> {
  const out = new Set<string>();
  let visited = 0;
  let overflow = false;
  const visit = (rel: string) => {
    visited += 1;
    if (visited > MAX_BUNDLE_FILES) {
      overflow = true;
      issues.push({
        level: 'error',
        file: rel || '.',
        message: `bundle has more than ${MAX_BUNDLE_FILES} entries`,
        code: 'too-many-files',
      });
      return false;
    }
    return true;
  };
  const walk = (abs: string, relBase: string, depth: number) => {
    if (overflow) return;
    if (depth > MAX_BUNDLE_DEPTH) {
      overflow = true;
      issues.push({
        level: 'error',
        file: relBase || '.',
        message: `bundle exceeds max depth ${MAX_BUNDLE_DEPTH}`,
        code: 'too-deep',
      });
      return;
    }
    let dir;
    try {
      dir = opendirSync(abs);
    } catch (e) {
      issues.push({ level: 'error', file: relBase || '.', message: `cannot read directory (${(e as Error).message})`, code: 'read-error' });
      return;
    }
    try {
      for (let ent = dir.readSync(); ent !== null; ent = dir.readSync()) {
        if (overflow) return;
        const name = ent.name;
        if (name.startsWith('.')) continue; // outside the bundle (OKF §3.2)
        const absChild = join(abs, name);
        const rel = relBase ? `${relBase}/${name}` : name;
        if (!visit(rel)) return;
        let st;
        try {
          st = lstatSync(absChild);
        } catch (e) {
          issues.push({ level: 'error', file: rel, message: `cannot stat (${(e as Error).message})`, code: 'read-error' });
          continue;
        }
        if (st.isSymbolicLink()) {
          issues.push({ level: 'error', file: rel, message: 'symbolic links are not part of the bundle', code: 'symlink' });
          continue;
        }
        if (st.isDirectory()) walk(absChild, rel, depth + 1);
        else if (st.isFile()) out.add(rel);
      }
    } finally {
      dir.closeSync();
    }
  };
  walk(root, '', 0);
  return out;
}

/** Nested index.md / log.md: no frontmatter (OKF §8 / §9); root copies are validated elsewhere. */
function validateNestedReserved(root: string, rel: string, base: string, issues: KnowledgeIssue[]): void {
  const text = readBounded(root, rel, issues);
  if (text === undefined) return;
  const startsFm = startsWithFrontmatter(text);
  if (base === 'index.md' && startsFm) {
    issues.push({
      level: 'error',
      file: rel,
      message: 'an index.md below the bundle root must not have frontmatter (OKF §8)',
      code: 'nested-index-frontmatter',
    });
  }
  if (base === 'log.md') {
    // Nested logs get the same frontmatter + date-heading rules as the root log.
    if (startsFm) {
      issues.push({
        level: 'error',
        file: rel,
        message: 'log.md must not have frontmatter (OKF §9)',
        code: 'log-frontmatter',
      });
    }
    for (const line of text.split(/\r\n|\n|\r/)) {
      if (!line.startsWith('## ')) continue;
      const heading = line.slice(3).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(heading)) {
        issues.push({
          level: 'error',
          file: rel,
          message: `a log.md date heading must be YYYY-MM-DD (OKF §9); found ${JSON.stringify(heading)}`,
          code: 'log-date-heading',
        });
      }
    }
  }
}

function readBounded(root: string, rel: string, issues: KnowledgeIssue[]): string | undefined {
  const abs = join(root, rel);
  const resolved = resolve(abs);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    issues.push({ level: 'error', file: rel, message: 'path escapes the bundle root', code: 'path-escape' });
    return undefined;
  }
  try {
    const st = lstatSync(abs);
    if (!st.isFile() || st.isSymbolicLink()) {
      issues.push({ level: 'error', file: rel, message: 'not a regular file', code: 'not-file' });
      return undefined;
    }
    const text = readBoundedUtf8(abs, MAX_BUNDLE_FILE_BYTES);
    if (text === undefined) {
      issues.push({ level: 'error', file: rel, message: 'cannot read file', code: 'read-error' });
      return undefined;
    }
    return text;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('file-too-large:')) {
      issues.push({
        level: 'error',
        file: rel,
        message: `file is over the ${MAX_BUNDLE_FILE_BYTES} byte budget`,
        code: 'file-too-large',
      });
      return undefined;
    }
    issues.push({ level: 'error', file: rel, message: `cannot read (${msg})`, code: 'read-error' });
    return undefined;
  }
}

function validateIndex(root: string, rel: string, issues: KnowledgeIssue[]): void {
  const text = readBounded(root, rel, issues);
  if (text === undefined) return;
  const split = splitFrontmatter(text);
  if (!split.ok) {
    issues.push({ level: 'error', file: rel, message: split.reason, code: 'bad-frontmatter' });
    return;
  }
  const { data } = split;
  if (data.okf_version !== OKF_VERSION) {
    let got: string;
    try {
      got = JSON.stringify(data.okf_version);
    } catch {
      got = '[unserializable]';
    }
    issues.push({
      level: 'error',
      file: rel,
      message: `okf_version must be "${OKF_VERSION}" (got ${got})`,
      code: 'okf-version',
    });
  }
  if (data['x-turbine-profile'] !== TURBINE_OKF_PROFILE) {
    issues.push({
      level: 'error',
      file: rel,
      message: `x-turbine-profile must be "${TURBINE_OKF_PROFILE}"`,
      code: 'profile',
    });
  }
  if (typeof data['x-turbine-commit'] !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(data['x-turbine-commit'])) {
    issues.push({ level: 'error', file: rel, message: 'x-turbine-commit must be a full git object id', code: 'commit' });
  }
}

function startsWithFrontmatter(text: string): boolean {
  // Shared delimiter check: LF, CRLF, or CR-only (OKF / YAML line endings).
  const first = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/, 1)[0] ?? '';
  return first === '---';
}

function validateLog(root: string, rel: string, issues: KnowledgeIssue[]): void {
  const text = readBounded(root, rel, issues);
  if (text === undefined) return;
  if (startsWithFrontmatter(text)) {
    issues.push({ level: 'error', file: rel, message: 'log.md must not have frontmatter (OKF §9)', code: 'log-frontmatter' });
  }
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (!line.startsWith('## ')) continue;
    const heading = line.slice(3).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(heading)) {
      issues.push({
        level: 'error',
        file: rel,
        message: `a log.md date heading must be YYYY-MM-DD (OKF §9); found ${JSON.stringify(heading)}`,
        code: 'log-date-heading',
      });
    }
  }
}

function validateReadme(root: string, rel: string, issues: KnowledgeIssue[]): void {
  const text = readBounded(root, rel, issues);
  if (text === undefined) return;
  const split = splitFrontmatter(text);
  if (split.ok && typeof split.data.type === 'string' && split.data.type.trim()) {
    issues.push({
      level: 'warning',
      file: rel,
      message: 'README.md should not have a type (OKF skips it as a concept)',
      code: 'readme-type',
    });
  }
}


function readIndexCommit(root: string, issues: KnowledgeIssue[]): string | undefined {
  const text = readBounded(root, 'index.md', issues);
  if (text === undefined) return undefined;
  const split = splitFrontmatter(text);
  if (!split.ok) return undefined;
  const c = split.data['x-turbine-commit'];
  return typeof c === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(c) ? c : undefined;
}

function validateConcept(
  root: string,
  rel: string,
  issues: KnowledgeIssue[],
  seen: Set<string>,
  indexCommit: string | undefined,
): void {
  const text = readBounded(root, rel, issues);
  if (text === undefined) return;
  const split = splitFrontmatter(text);
  if (!split.ok) {
    // No type → not a concept (OKF §3.2); warn only.
    if (split.reason.includes('absent')) {
      issues.push({ level: 'warning', file: rel, message: 'markdown file has no frontmatter; skipped as a concept', code: 'not-concept' });
      return;
    }
    issues.push({ level: 'error', file: rel, message: split.reason, code: 'bad-frontmatter' });
    return;
  }
  const type = split.data.type;
  if (typeof type !== 'string' || !type.trim()) {
    issues.push({ level: 'warning', file: rel, message: 'markdown file has no type; skipped as a concept', code: 'not-concept' });
    return;
  }
  if (!isTurbineOkfConceptType(type)) {
    issues.push({
      level: 'error',
      file: rel,
      message: `unknown concept type "${type}" is not in the Turbine profile`,
      code: 'unknown-type',
    });
    return;
  }
  const profile = turbineOkfConceptProfile(type)!;
  // Placement / naming
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (dir !== profile.folder) {
    issues.push({
      level: 'error',
      file: rel,
      message: `${type} must live under ${profile.folder}/ (found ${dir || '(root)'})`,
      code: 'misplaced',
    });
  }
  if (profile.naming === 'fixed' && base !== profile.fixedName) {
    issues.push({
      level: 'error',
      file: rel,
      message: `${type} must be named ${profile.fixedName}`,
      code: 'bad-name',
    });
  }
  if (profile.naming === 'encoded') {
    if (!base.endsWith('.md') || base.startsWith('.')) {
      issues.push({ level: 'error', file: rel, message: 'encoded concept filename is invalid', code: 'bad-name' });
    }
  }
  if (seen.has(rel)) {
    issues.push({ level: 'error', file: rel, message: 'duplicate concept path', code: 'duplicate' });
  }
  seen.add(rel);

  const shape = OkfConceptFrontmatterSchema.safeParse(split.data);
  if (!shape.success) {
    for (const issue of shape.error.issues) {
      const path = issue.path.map(String).join('.') || 'frontmatter';
      issues.push({
        level: 'error',
        file: rel,
        message: `wrong type for ${path}: ${issue.message}`,
        code: `wrong-type:${path}`,
      });
    }
  }

  for (const field of profile.requiredFields) {
    const value = split.data[field];
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
      issues.push({ level: 'error', file: rel, message: `missing required field ${field}`, code: `missing-field:${field}` });
    }
  }
  if (profile.requiresBlob) {
    const blob = split.data['x-turbine-blob'];
    if (typeof blob !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(blob)) {
      issues.push({ level: 'error', file: rel, message: 'x-turbine-blob must be a full git object id', code: 'missing-field:x-turbine-blob' });
    }
  }
  const commit = split.data['x-turbine-commit'];
  if (typeof commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    issues.push({ level: 'error', file: rel, message: 'x-turbine-commit must be a full git object id', code: 'bad-commit' });
  }
  else if (indexCommit && commit !== indexCommit) {
    issues.push({
      level: 'error',
      file: rel,
      message: `x-turbine-commit ${commit.slice(0, 12)} does not match index commit ${indexCommit.slice(0, 12)}`,
      code: 'commit-mismatch',
    });
  }

  // status: unknown is not stable. Only stringify string statuses — other types are shape-validated elsewhere.
  if (typeof split.data.status === 'string') {
    const eff = okfEffectiveStatus(split.data.status);
    if (eff === 'unknown') {
      issues.push({
        level: 'warning',
        file: rel,
        message: `status "${split.data.status}" is not a known lifecycle value (not treated as stable)`,
        code: 'unknown-status',
      });
    }
  }

  // sources shape + footnotes
  validateSourcesAndFootnotes(rel, split.data, split.body, issues);

  // required headings in order
  const headings = collectHeadings(split.body);
  let hi = 0;
  for (const required of profile.requiredHeadings) {
    while (hi < headings.length && headings[hi] !== required) hi++;
    if (hi >= headings.length) {
      issues.push({
        level: 'error',
        file: rel,
        message: `missing required heading "${required}" (in order: ${profile.requiredHeadings.join(' → ')})`,
        code: `missing-heading:${required}`,
      });
      break;
    }
    hi++;
  }

  // generated.by actor shape when present
  const generated = split.data.generated;
  if (generated && typeof generated === 'object' && generated !== null) {
    const g = generated as Record<string, unknown>;
    if (typeof g.by !== 'string' || !OkfActorSchema.safeParse(g.by).success) {
      issues.push({ level: 'error', file: rel, message: 'generated.by must be an OKF actor', code: 'bad-actor' });
    }
    if (typeof g.at === 'string' && !OkfTimestampSchema.safeParse(g.at).success) {
      issues.push({ level: 'error', file: rel, message: 'generated.at must be an RFC 3339 timestamp', code: 'bad-timestamp' });
    }
  }
}

function validateSourcesAndFootnotes(
  rel: string,
  data: Record<string, unknown>,
  body: string,
  issues: KnowledgeIssue[],
): void {
  const sources = data.sources;
  // Absent sources still means proof-bearing bullets must not claim footnotes/ids.
  if (sources !== undefined && !Array.isArray(sources)) {
    issues.push({ level: 'error', file: rel, message: 'sources must be a list', code: 'bad-sources' });
    return;
  }
  const ids = new Set<string>();
  for (const entry of sources ?? []) {
    const parsed = OkfSourceEntrySchema.safeParse(entry);
    if (!parsed.success) {
      issues.push({
        level: 'error',
        file: rel,
        message: `invalid sources entry: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        code: 'bad-source-entry',
      });
      continue;
    }
    if (parsed.data.id) {
      if (ids.has(parsed.data.id)) {
        issues.push({ level: 'error', file: rel, message: `duplicate sources id "${parsed.data.id}"`, code: 'dup-source-id' });
      }
      ids.add(parsed.data.id);
    }
  }

  // Definitions only count in prose (ignore fenced/indented examples).
  const defs = new Set<string>();
  for (const line of proseLines(body)) {
    const m = /^\[\^([^\]\s]+)\]:/.exec(line.trimStart());
    if (m) defs.add(m[1]!);
  }

  // Prose (outside fenced/indented code): every [^id] must match sources[].id (OKF §5.1 / upstream W108).
  const reportedOrphan = new Set<string>();
  for (const line of proseLines(body)) {
    const forRefs = line.replace(/`[^`]*`/g, '');
    for (const m of forRefs.matchAll(FOOTNOTE_REF)) {
      const id = m[1]!;
      const idx = m.index ?? 0;
      // Definition lines also match FOOTNOTE_REF on [^id]: — those are checked via defs below.
      if (forRefs.slice(idx + m[0].length).startsWith(':') && forRefs.slice(0, idx).trim() === '') continue;
      if (!ids.has(id) && !reportedOrphan.has(id)) {
        reportedOrphan.add(id);
        issues.push({
          level: 'error',
          file: rel,
          message: `footnote [^${id}] has no matching sources[].id`,
          code: 'footnote-mismatch',
        });
      }
    }
  }

  // Claim bullets (prose only) must cite a source footnote.
  for (const line of proseLines(body)) {
    if (!/^\s*-\s+\S/.test(line)) continue;
    // Pure navigation links (classify before stripping inline-code labels).
    if (/^\s*-\s+\[[^\]]+\]\([^)]+\)\s*$/.test(line)) continue;
    const stripped = line.replace(/`[^`]*`/g, '');
    const footnotes = [...stripped.matchAll(FOOTNOTE_REF)].map((m) => m[1]!);
    if (!footnotes.length) {
      issues.push({
        level: 'error',
        file: rel,
        message: 'each claim bullet must include a footnote [^id] matching sources[].id',
        code: 'missing-footnote',
      });
      continue;
    }
    for (const id of footnotes) {
      if (!ids.has(id) && !reportedOrphan.has(id)) {
        reportedOrphan.add(id);
        issues.push({
          level: 'error',
          file: rel,
          message: `footnote [^${id}] has no matching sources[].id`,
          code: 'footnote-mismatch',
        });
      }
    }
  }
  for (const id of defs) {
    if (!ids.has(id)) {
      issues.push({
        level: 'error',
        file: rel,
        message: `footnote definition [^${id}] has no matching sources[].id`,
        code: 'footnote-def-mismatch',
      });
    }
  }
}

/** Opening fence marker: backticks or tildes, length >= 3 (CommonMark). */
function openingFence(stripped: string): string | null {
  const m = /^(```+|~~~+)/.exec(stripped);
  return m ? m[1]! : null;
}

/** True when `stripped` closes `fence` (same character, length >= opening; CommonMark). */
function closesFence(stripped: string, fence: string): boolean {
  const m = /^(```+|~~~+)\s*$/.exec(stripped);
  return Boolean(m && m[1]![0] === fence[0] && m[1]!.length >= fence.length);
}

/**
 * Body lines outside fenced and indented code (matches upstream validate.py prose_lines).
 * Inline code is left intact so navigation bullets like `- [`path`](target)` still classify.
 */
function proseLines(body: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const stripped = line.trimStart();
    if (fence === null) {
      const open = openingFence(stripped);
      if (open) {
        fence = open;
        continue;
      }
    } else {
      if (closesFence(stripped, fence)) fence = null;
      continue;
    }
    if (line.startsWith('    ') || line.startsWith('\t')) continue;
    out.push(line);
  }
  return out;
}

function collectHeadings(body: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const stripped = line.trimStart();
    if (fence === null) {
      const open = openingFence(stripped);
      if (open) {
        fence = open;
        continue;
      }
    } else {
      if (closesFence(stripped, fence)) fence = null;
      continue;
    }
    const m = HEADING.exec(line);
    if (m) out.push(m[2]!.trim());
  }
  return out;
}

/** Lint helper: validate `.turbine/knowledge` when present. */
export function lintKnowledgeBundle(projectRoot: string): KnowledgeIssue[] {
  const dir = knowledgePaths(projectRoot).dir;
  if (!existsSync(dir)) return [];
  return validateBundle(dir);
}

/** Expected relative path for a profile concept (for tests / render). */
export function expectedConceptPath(type: TurbineOkfConceptType, key?: string): string {
  return turbineOkfConceptPath(type, key);
}

export { encodeOkfConceptSegment };
