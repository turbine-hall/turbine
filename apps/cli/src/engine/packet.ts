import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './context/render.js';

/**
 * Task packet layout (Phase 3 document standard):
 *
 *   .turbine/tasks/<work-id>/
 *     STATUS.md              — where the task is, who acts next, gate progress, blockers
 *     SPEC.md                — requirements, open questions, context (humans edit requirements here)
 *     PLAN.md                — detailed implementation plan (generated from the plan artifact)
 *     EXECUTIVE-SUMMARY.md   — high-level plan narrative + Mermaid diagrams
 *     REVIEW.md              — what changed (git), traceability, AI review, checks, acceptance checklist
 *     CONTEXT.md             — the files relevant to the task and why (generated from the store; "## Agent notes" kept)
 *     evidence/              — raw JSON and logs (never inlined in the documents above)
 *
 * The legacy keys (request, requirements, plan, …) are kept as aliases so callers that
 * name a stage still land on the right file. `plan` aliases to PLAN.md (canonical plan doc).
 */
export type PacketPaths = {
  dir: string;
  status: string;
  spec: string;
  review: string;
  /** Detailed plan document (generated). */
  planDoc: string;
  /** Executive summary + diagrams (generated). */
  executiveSummary: string;
  /** CONTEXT.md: the files relevant to this task, each with a checkable reason (generated; notes kept). */
  context: string;
  /** The project facts the task context points to (`turbine understand`); shared by every task. */
  projectContext: string;
  evidenceDir: string;
  legacyDir: string;
  // aliases
  request: string;
  assessment: string;
  requirements: string;
  plan: string;
  executionBrief: string;
  changeReport: string;
  verify: string;
  acceptance: string;
};

export function packetPaths(projectRoot: string, workId: string): PacketPaths {
  const dir = join(projectRoot, '.turbine', 'tasks', workId);
  const status = join(dir, 'STATUS.md');
  const spec = join(dir, 'SPEC.md');
  const review = join(dir, 'REVIEW.md');
  const planDoc = join(dir, 'PLAN.md');
  const executiveSummary = join(dir, 'EXECUTIVE-SUMMARY.md');
  return {
    dir,
    status,
    spec,
    review,
    planDoc,
    executiveSummary,
    context: join(dir, 'CONTEXT.md'),
    projectContext: join(projectRoot, '.turbine', 'context', 'PROJECT.md'),
    evidenceDir: join(dir, 'evidence'),
    legacyDir: join(dir, 'legacy'),
    request: spec,
    assessment: spec,
    requirements: spec,
    plan: planDoc,
    executionBrief: status,
    changeReport: review,
    verify: review,
    acceptance: review,
  };
}

export function ensurePacketDir(projectRoot: string, workId: string): PacketPaths {
  const paths = packetPaths(projectRoot, workId);
  mkdirSync(paths.evidenceDir, { recursive: true });
  return paths;
}

export function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content.replace(/\n+$/, '') + '\n', 'utf8');
}

/** Like `writeFile`, but a failure part-way leaves the previous file untouched (temp file, then rename). */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeAtomic(path, content.replace(/\n+$/, '') + '\n');
}

export function readPacketFile(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

/** Move pre-Phase-3 numbered files (00-REQUEST.md … 08-ACCEPTANCE.md) into legacy/ once. */
export function migrateLegacyPacket(paths: PacketPaths): string[] {
  if (!existsSync(paths.dir)) return [];
  const old = readdirSync(paths.dir).filter((f) => /^\d\d-[A-Z_]+\.md$/.test(f));
  if (!old.length) return [];
  mkdirSync(paths.legacyDir, { recursive: true });
  for (const f of old) renameSync(join(paths.dir, f), join(paths.legacyDir, f));
  writeFile(
    join(paths.legacyDir, 'README.md'),
    '# Legacy packet files\n\nThese files were written by an older turbine version and are no longer updated.\nThe current documents are STATUS.md, SPEC.md and REVIEW.md one folder up.\n',
  );
  return old;
}

export function decisionBlock(input: {
  gate: string;
  approved?: boolean;
  reviewer?: string;
  date?: string;
  notes?: string;
  contentHash?: string;
}): string {
  const status = input.approved === true ? 'APPROVED' : input.approved === false ? 'REJECTED' : 'PENDING';
  const lines = [`- Gate: ${input.gate}`, `- Status: **${status}**`];
  if (input.approved !== undefined) {
    lines.push(`- By: ${input.reviewer ?? '(unknown)'}`, `- Date: ${input.date ?? new Date().toISOString().slice(0, 10)}`);
  }
  if (input.contentHash) lines.push(`- Revision: \`${input.contentHash}\``);
  if (input.notes) lines.push(`- Notes: ${input.notes}`);
  return lines.join('\n');
}

/** Legacy parser: detects a hand-written "Approved:" line (used only to warn; it never approves). */
export function parseDecision(markdown: string): { approved: boolean | null } {
  const raw = markdown.match(/^\s*Approved:\s*(yes|no|pending)\s*$/im)?.[1]?.toLowerCase();
  return { approved: raw === 'yes' ? true : raw === 'no' ? false : null };
}

export function sectionBody(markdown: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}[^\\n]*$`, 'im');
  const match = re.exec(markdown);
  if (!match) return '';
  const rest = markdown.slice(match.index + match[0].length);
  const next = rest.search(/^##\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

const bullets = (body: string) =>
  body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter((l) => l && !/^_?none/i.test(l));

export type ParsedSpec = {
  requirements: Array<{ id: string; priority: string; kind: string; statement: string }>;
  openQuestions: string[];
  answers: Array<{ question: string; answer: string }>;
  assumptions: string[];
  nonGoals: string[];
  hasRequirementsSection: boolean;
};

/**
 * Read the human-editable parts of SPEC.md:
 *   ## Requirements      - **FR-001** (P0, behavioral): WHEN … THE SYSTEM SHALL …
 *   ## Open questions    - **Q1**: question …   (append "→ Answer: …" to answer; delete the line to drop it)
 *   ## Context           - 🟡 Assumption — …
 *   ## Non-goals         - …
 */
export function parseSpecMarkdown(markdown: string): ParsedSpec {
  const reqBody = sectionBody(markdown, 'Requirements');
  const requirements = reqBody
    .split('\n')
    .map((l) => l.trim().match(/^- \*\*([\w.-]+)\*\*\s*\((P[012])(?:\s*,\s*([a-z]+))?\)\s*:\s*(.+)$/i))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ id: m[1]!, priority: m[2]!.toUpperCase(), kind: (m[3] ?? 'behavioral').toLowerCase(), statement: m[4]!.trim() }));
  const openQuestions: string[] = [];
  const answers: Array<{ question: string; answer: string }> = [];
  for (const b of bullets(sectionBody(markdown, 'Open questions'))) {
    const text = b.replace(/^\*\*Q\d+\*\*:\s*/, '').replace(/\s+—\s+_[^_]*_\s*$/, '').trim();
    const ans = text.match(/^(.*?)\s*(?:→|->)\s*Answer:\s*(.+)$/i);
    if (ans && ans[2]!.trim()) answers.push({ question: ans[1]!.trim(), answer: ans[2]!.trim() });
    else if (text) openQuestions.push(text.replace(/\s*(?:→|->)\s*Answer:\s*$/i, ''));
  }
  const assumptions = bullets(sectionBody(markdown, 'Context'))
    .filter((b) => b.startsWith('🟡'))
    .map((b) => b.replace(/^🟡\s*(Assumption|Decided)\s*—\s*/, (_m, kind: string) => (kind === 'Decided' ? 'Decided: ' : '')).trim());
  const nonGoals = bullets(sectionBody(markdown, 'Non-goals'));
  return { requirements, openQuestions, answers, assumptions, nonGoals, hasRequirementsSection: reqBody.length > 0 };
}

export type AcceptanceCheck = { id: string; checked: boolean; observed: string };

/** Acceptance checklist lines in REVIEW.md:  - [x] **FR-001** (P0) … — Observed: <what you saw> */
export function parseAcceptanceChecklist(markdown: string): AcceptanceCheck[] {
  return sectionBody(markdown, '5\\. Acceptance')
    .split('\n')
    .map((l) => l.trim().match(/^- \[( |x|X)\]\s+\*\*([\w.-]+)\*\*.*?Observed:\s*(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ id: m[2]!, checked: m[1]!.toLowerCase() === 'x', observed: m[3]!.replace(/^_\(.*\)_$/, '').trim() }));
}
