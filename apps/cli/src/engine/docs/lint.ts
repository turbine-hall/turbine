import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { LINE_BUDGET, type Track } from './render.js';
import { parseSpecMarkdown, type PacketPaths } from '../packet.js';
import { lintContextFile, readContextFile } from '../context/task-render.js';

/**
 * `turbine task lint` — structural checks on the packet documents. The engine generates them,
 * so lint mostly catches human edits that broke the structure the engine parses, and keeps
 * the documents inside their size budget. Errors block approvals; warnings do not.
 */
export type LintIssue = { level: 'error' | 'warning'; file: string; message: string };

const REQUIRED: Record<'STATUS.md' | 'SPEC.md' | 'REVIEW.md', string[]> = {
  'STATUS.md': ['## Documents'],
  'SPEC.md': ['## Requirements', '## Open questions', '## Context', '## Non-goals', '## Decisions'],
  'REVIEW.md': ['## 1. What changed', '## 2. Traceability', '## 3. AI review', '## 4. Checks', '## 5. Acceptance', '## Decisions'],
};

const PLAN_REQUIRED = ['## Summary', '## Architecture', '## Data model', '## Interfaces', '## Steps', '## Test plan', '## Risks', '## Coding-agent token estimate'];
const EXEC_REQUIRED = ['## Overview', '## Diagrams'];

const MERMAID_TYPES = /^(flowchart|graph|sequenceDiagram|stateDiagram(-v2)?|classDiagram|erDiagram|gantt|pie|journey)\b/;

export function lintMermaid(block: string): string | undefined {
  const lines = block.split('\n').filter((l) => l.trim());
  if (!lines.length || !MERMAID_TYPES.test(lines[0]!.trim())) return `unknown diagram type "${lines[0]?.trim() ?? ''}"`;
  for (const [open, close] of [['[', ']'], ['(', ')'], ['{', '}']] as const) {
    const o = block.split(open).length - 1;
    const c = block.split(close).length - 1;
    if (o !== c) return `unbalanced ${open}${close}`;
  }
  if ((block.split('"').length - 1) % 2 !== 0) return 'unbalanced quotes';
  return undefined;
}

function lintMarkdownDoc(
  issues: LintIssue[],
  name: string,
  path: string,
  requiredHeadings: string[],
  budget: number,
  track: Track,
): string | undefined {
  if (!existsSync(path)) {
    issues.push({ level: 'error', file: name, message: 'missing' });
    return undefined;
  }
  const md = readFileSync(path, 'utf8');
  for (const h of requiredHeadings) {
    if (!md.split('\n').some((l) => l.startsWith(h))) issues.push({ level: 'error', file: name, message: `missing section "${h}"` });
  }
  if (/```json/i.test(md)) issues.push({ level: 'error', file: name, message: 'raw JSON inline — raw data belongs in evidence/' });
  const blocks = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]!);
  blocks.forEach((b, i) => {
    const problem = lintMermaid(b);
    if (problem) issues.push({ level: 'error', file: name, message: `diagram ${i + 1}: ${problem}` });
  });
  const count = md.split('\n').length;
  if (count > budget) issues.push({ level: 'warning', file: name, message: `${count} lines (budget for ${track} track: ${budget})` });
  return md;
}

export function lintPacket(paths: PacketPaths, opts: { track: Track; requirementIds: string[]; hasPlan?: boolean }): LintIssue[] {
  const issues: LintIssue[] = [];
  const files = { 'STATUS.md': paths.status, 'SPEC.md': paths.spec, 'REVIEW.md': paths.review } as const;
  for (const [name, path] of Object.entries(files) as Array<[keyof typeof REQUIRED, string]>) {
    const budgetKey = name === 'STATUS.md' ? 'status' : name === 'SPEC.md' ? 'spec' : 'review';
    const md = lintMarkdownDoc(issues, name, path, REQUIRED[name], LINE_BUDGET[opts.track][budgetKey], opts.track);
    if (!md) continue;
    if (name === 'SPEC.md') {
      const parsed = parseSpecMarkdown(md);
      const ids = new Set(parsed.requirements.map((r) => r.id));
      for (const id of opts.requirementIds.filter((x) => !ids.has(x))) {
        issues.push({ level: 'error', file: name, message: `requirement ${id} is missing or not in the "- **ID** (P0, kind): …" format` });
      }
      const contextBullets = md.split(/^## Context/m)[1]?.split(/^## /m)[0]?.split('\n').filter((l) => l.startsWith('- ')) ?? [];
      for (const b of contextBullets) {
        if (!/^- (✅ Verified|🟡 (Assumption|Decided)|❓ Question|_None_|_…)/.test(b)) {
          issues.push({ level: 'warning', file: name, message: `context line without a Verified/Assumption label: "${b.slice(0, 60)}"` });
        }
      }
    }
    if (name === 'REVIEW.md') {
      const trace = md.split(/^## 2\. Traceability/m)[1]?.split(/^## /m)[0] ?? '';
      for (const id of opts.requirementIds) {
        if (!trace.includes(`| ${id} |`)) issues.push({ level: 'error', file: name, message: `requirement ${id} missing from traceability` });
      }
    }
  }
  const planPresent = opts.hasPlan ?? existsSync(paths.planDoc);
  if (planPresent) {
    lintMarkdownDoc(issues, 'PLAN.md', paths.planDoc, PLAN_REQUIRED, LINE_BUDGET[opts.track].plan, opts.track);
    const execMd = lintMarkdownDoc(
      issues,
      'EXECUTIVE-SUMMARY.md',
      paths.executiveSummary,
      EXEC_REQUIRED,
      LINE_BUDGET[opts.track].executiveSummary,
      opts.track,
    );
    if (execMd && !/```mermaid/.test(execMd)) {
      issues.push({ level: 'error', file: 'EXECUTIVE-SUMMARY.md', message: 'missing Mermaid diagram fence' });
    }
  }
  // CONTEXT.md is generated from the store; a hand edit to the generated part is reported (and overwritten).
  // `lstat`, not `existsSync`: a dangling symlink is an entry that exists, and it is reported, not skipped.
  let present = true;
  try {
    lstatSync(paths.context);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') present = false;
  }
  if (present) {
    try {
      issues.push(...lintContextFile(readContextFile(paths.context)));
    } catch (e) {
      issues.push({ level: 'error', file: 'CONTEXT.md', message: `cannot be read: ${(e as Error).message}` });
    }
  }
  return issues;
}
