import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AcceptanceCriterion, Decision, WorkPackage, WorkState } from '@turbine-hall/turbine-contracts';
import type { GateDecision } from '@turbine-hall/turbine-evidence-contract';
import type { RepoFacts, RepoState } from '../changeset.js';
import type { CheckRun } from '../checks.js';
import type { NextStep } from '../next-step.js';
import {
  decisionBlock,
  migrateLegacyPacket,
  packetPaths,
  parseAcceptanceChecklist,
  readPacketFile,
  writeFile,
  type AcceptanceCheck,
} from '../packet.js';
import type { ReviewResult } from '../review.js';
import type { AnalysisFinding } from './analyze.js';
import type { Fact, NormalizedPlan, NormalizedSpec } from './normalize.js';
import type { TraceRow } from './trace.js';
import { changeMap, gateFlow, userFlowDiagram } from './visuals.js';

/** Size of the paperwork scales with the work (BMad-style tracks). Gates do not change. */
export type Track = 'trivial' | 'standard' | 'full';
export function trackFor(work: WorkPackage): Track {
  if (work.risk.profile === 'comprehensive') return 'full';
  if ((work.type === 'maintenance' || work.type === 'bug') && work.acceptanceCriteria.length <= 4) return 'trivial';
  return 'standard';
}
export const LINE_BUDGET: Record<
  Track,
  { spec: number; review: number; status: number; plan: number; executiveSummary: number }
> = {
  trivial: { spec: 90, review: 180, status: 60, plan: 120, executiveSummary: 80 },
  standard: { spec: 160, review: 260, status: 70, plan: 220, executiveSummary: 120 },
  full: { spec: 260, review: 360, status: 80, plan: 360, executiveSummary: 160 },
};
const LIST_CAP: Record<Track, number> = { trivial: 5, standard: 8, full: 12 };

export type PacketData = {
  projectRoot: string;
  work: WorkPackage;
  track: Track;
  next: NextStep;
  notes: string[];
  sourceText: string;
  facts: Fact[];
  spec?: { hash: string; data: NormalizedSpec };
  plan?: { hash: string; data: NormalizedPlan };
  repos: RepoState[];
  changeSetId?: string;
  implemented: boolean;
  changeFacts: RepoFacts[];
  review?: ReviewResult;
  runs?: CheckRun[];
  decisions: Decision[];
  gate?: GateDecision;
  trace: TraceRow[];
  analysis: AnalysisFinding[];
  evidenceFiles: string[];
  /** CONTEXT.md exists for this task (the relevant files and why; a selection, not a complete list). */
  contextFile?: boolean;
};

const esc = (t: string) => t.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const short = (h?: string) => (h ? h.replace(/^sha256:/, '').slice(0, 8) : '—');

function latestDecision(decisions: Decision[], gate: Decision['gate']): Decision | undefined {
  return decisions
    .filter((d) => d.gate === gate && !d.invalidatedAt)
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
}

function decisionFor(decisions: Decision[], gate: Decision['gate'], label: string, revision?: string): string {
  const d = latestDecision(decisions, gate);
  const bound = d && revision && !(d.artifactHashes.includes(revision) || d.commitSha === revision) ? undefined : d;
  return [
    `### ${label}`,
    '',
    decisionBlock({
      gate,
      approved: bound ? bound.action === 'approve' : undefined,
      reviewer: bound?.actorId,
      date: bound?.decidedAt.slice(0, 10),
      notes: bound?.rationale && !/^Local attestation/.test(bound.rationale) ? bound.rationale : undefined,
      contentHash: revision,
    }),
  ].join('\n');
}

const DECIDE_HINT = [
  '> **To decide:** read the document, then run `turbine task approve <work-id>` (or `turbine task reject <work-id>`)',
  '> in **your own terminal**. It shows what you are approving and asks you to type its short code.',
  '> Editing the Decisions section has no effect. AI agents must not run these commands.',
].join('\n');

const STATE_HEADLINE: Partial<Record<WorkState, [string, string]>> = {
  IMPORTED: ['📥', 'New request'],
  ASSESSING: ['🔎', 'Being assessed'],
  NEEDS_CLARIFICATION: ['❓', 'Waiting on answers to open questions'],
  REQUIREMENTS_REVIEW: ['📝', 'Waiting on you: approve the requirements'],
  REQUIREMENTS_APPROVED: ['🧭', 'Requirements approved — planning next'],
  PLANNING: ['🧭', 'Planning'],
  PLAN_REVIEW: ['🗺️', 'Waiting on you: approve the plan'],
  PLAN_APPROVED: ['🛠️', 'Plan approved — ready to implement'],
  IMPLEMENTING: ['🛠️', 'Implementing in the worktree'],
  CHANGES_REQUESTED: ['🔁', 'Changes requested — fix and commit'],
  AI_REVIEW: ['🤖', 'AI review next'],
  HUMAN_CODE_REVIEW: ['👀', 'Waiting on you: code review'],
  VERIFYING: ['🧪', 'Running checks'],
  HUMAN_ACCEPTANCE: ['✅', 'Waiting on you: acceptance'],
  ACCEPTED: ['🎉', 'Accepted (not merged, not deployed)'],
  BLOCKED: ['⛔', 'Blocked'],
  FAILED: ['💥', 'Failed'],
  CANCELLED: ['🚫', 'Cancelled'],
  PAUSED_BUDGET: ['⏸️', 'Paused: budget'],
  PAUSED_POLICY: ['⏸️', 'Paused: policy'],
};

function reviewMinutes(d: PacketData): number | undefined {
  switch (d.work.currentState) {
    case 'REQUIREMENTS_REVIEW':
    case 'NEEDS_CLARIFICATION':
      return 5 + 2 * d.work.acceptanceCriteria.length;
    case 'PLAN_REVIEW':
      return 5 + 2 * (d.plan?.data.steps.length ?? 3);
    case 'HUMAN_CODE_REVIEW': {
      const lines = d.changeFacts.reduce((n, f) => n + f.insertions + f.deletions, 0);
      return Math.min(120, 10 + Math.ceil(lines / 40));
    }
    case 'HUMAN_ACCEPTANCE':
      return 5 + 3 * d.work.acceptanceCriteria.filter((r) => r.priority === 'P0').length;
    default:
      return undefined;
  }
}

function capped<T>(items: T[], cap: number, render: (t: T) => string, more: string): string[] {
  const out = items.slice(0, cap).map(render);
  if (items.length > cap) out.push(`- _…and ${items.length - cap} more — ${more}_`);
  return out;
}

// ---------------------------------------------------------------- STATUS.md
export function renderStatus(d: PacketData): string {
  const [icon, headline] = STATE_HEADLINE[d.work.currentState] ?? ['•', d.work.currentState];
  const mins = reviewMinutes(d);
  const lines = [
    `# ${icon} ${headline}`,
    '',
    `**${d.work.title}** · ${d.work.type} · risk: ${d.work.risk.profile} · track: ${d.track} · state: \`${d.work.currentState}\``,
    '',
    `> **Next — ${d.next.who === 'human' ? 'you (human)' : d.next.who === 'agent' ? 'the agent' : 'human or agent'}${mins ? `, ~${mins} min` : ''}:** ${d.next.doNow}`,
    '',
    gateFlow(d.work.currentState),
  ];
  if (d.notes.length) lines.push('', '## What just happened', '', ...d.notes.map((n) => `- ${n}`));
  const blocking = d.analysis.filter((a) => a.severity === 'CRITICAL' || a.severity === 'HIGH');
  if (blocking.length) {
    lines.push('', '## Problems to fix', '', '| Severity | Where | Problem |', '|---|---|---|');
    for (const a of blocking.slice(0, 8)) lines.push(`| ${a.severity} | ${a.where ?? '—'} | ${esc(a.message)} |`);
    if (blocking.length > 8) lines.push(`| … | | ${blocking.length - 8} more: \`turbine task analyze ${d.work.id}\` |`);
    if (blocking.some((a) => a.severity === 'CRITICAL')) lines.push('', '_CRITICAL problems block approval of this gate._');
  }
  if (d.gate && d.implemented) {
    lines.push('', `## Evidence gate: **${d.gate.decision}**`, '');
    if (!d.gate.blocking.length && !d.gate.concerns.length) lines.push('Everything required is satisfied at the current change set.');
    for (const b of d.gate.blocking) lines.push(`- ⛔ ${b.id}: ${b.reason}${d.gate.waived.some((w) => w.id === b.id) ? ' _(waived)_' : ''}`);
    for (const c of d.gate.concerns) lines.push(`- ⚠️ ${c.id}: ${c.reason}`);
  }
  if (d.repos.length && ['PLAN_APPROVED', 'IMPLEMENTING', 'CHANGES_REQUESTED', 'AI_REVIEW', 'HUMAN_CODE_REVIEW', 'VERIFYING', 'HUMAN_ACCEPTANCE'].includes(d.work.currentState)) {
    lines.push('', '## Where the code goes', '', '| Repo | Worktree | Branch |', '|---|---|---|');
    for (const r of d.repos) lines.push(`| ${r.name} | \`${r.worktreePath}\` | \`${r.branch}\` |`);
    lines.push('', 'Your main checkout is not changed until the branch is merged through a PR.');
  }
  if (d.next.commands.length) {
    lines.push('', '## Commands', '', '```bash', ...d.next.commands.filter((c) => c !== 'true'), '```');
  }
  lines.push(
    '',
    '## Documents',
    '',
    '- [SPEC.md](SPEC.md) — requirements, open questions, context',
    ...(d.plan
      ? [
          '- [PLAN.md](PLAN.md) — detailed implementation plan (architecture, data, steps, tests, token estimate)',
          '- [EXECUTIVE-SUMMARY.md](EXECUTIVE-SUMMARY.md) — high-level plan narrative and diagrams',
        ]
      : []),
    '- [REVIEW.md](REVIEW.md) — what changed, traceability, AI review, checks, acceptance',
    ...(d.contextFile
      ? ['- [CONTEXT.md](CONTEXT.md) — files that may matter to this task, each with a checkable reason (a selection, not a complete list)']
      : []),
    '- [evidence/](evidence/) — raw data and logs',
    `- [Glossary](${relative(packetPaths(d.projectRoot, d.work.id).dir, join(d.projectRoot, '.turbine', 'GLOSSARY.md'))}) — gate, worktree, change set, P0…`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------- SPEC.md
function requirementLine(r: AcceptanceCriterion): string {
  return `- **${r.id}** (${r.priority ?? 'P1'}, ${r.kind}): ${r.statement}`;
}

export function renderSpec(d: PacketData): string {
  const cap = LIST_CAP[d.track];
  const w = d.work;
  const lines = [
    `# Spec — ${w.title}`,
    '',
    `\`${w.id}\` · ${w.type} · track: ${d.track} · requirements revision \`${short(d.spec?.hash)}\`${d.plan ? ` · plan revision \`${short(d.plan.hash)}\`` : ''}`,
    '',
  ];
  if (d.spec?.data.summary) lines.push(`> ${d.spec.data.summary}`, '');
  lines.push(
    '## Requirements',
    '',
    '_P0 = must work to accept · P1 = should · P2 = nice to have. Edit lines in this format, then run `turbine task sync`:_',
    '_`- **FR-001** (P0, behavioral): WHEN … THE SYSTEM SHALL …`_',
    '',
    ...(w.acceptanceCriteria.length ? w.acceptanceCriteria.map(requirementLine) : ['- _None yet_']),
    '',
    '## Open questions',
    '',
  );
  if (w.unknowns.length) {
    lines.push('_These block approval. Answer by appending `→ Answer: …` to the line, then `turbine task sync`._', '');
    w.unknowns.forEach((q, i) => lines.push(`- **Q${i + 1}**: ${q}`));
  } else lines.push('- _None_');
  lines.push('', '## Context', '');
  const factLines = capped(d.facts, cap, (f) => `- ✅ Verified — ${f.text} _(${f.source})_`, 'see evidence/assessment.json');
  const assumptionLines = w.assumptions.map((a) => (a.startsWith('Decided: ') ? `- 🟡 Decided — ${a.slice(9)}` : `- 🟡 Assumption — ${a}`));
  lines.push(...(factLines.length || assumptionLines.length ? [...factLines, ...assumptionLines] : ['- _None_']));
  lines.push('', '## Non-goals', '', ...(w.nonGoals.length ? w.nonGoals.map((n) => `- ${n}`) : ['- _None_']));
  const items = d.spec?.data.requestItems ?? [];
  if (items.length) {
    const cov = new Map((d.spec?.data.requestCoverage ?? []).map((c) => [c.itemId, c]));
    const ids = new Set(w.acceptanceCriteria.map((r) => r.id));
    lines.push('', '## Request coverage', '', '_Every line of the original request, and where it went. ⚠️ = dropped._', '', '| # | Request item | Covered by |', '|---|---|---|');
    for (const it of items) {
      const c = cov.get(it.id);
      const reqs = (c?.requirementIds ?? []).filter((x) => ids.has(x));
      const where = reqs.length ? reqs.join(', ') : c?.nonGoal ? `non-goal: ${esc(c.nonGoal)}` : c?.question ? `question: ${esc(c.question)}` : '⚠️ **not covered**';
      lines.push(`| ${it.id} | ${esc(it.text.length > 110 ? `${it.text.slice(0, 107)}…` : it.text)} | ${where} |`);
    }
  }
  if (d.track !== 'trivial' && d.spec) {
    const flow = userFlowDiagram(d.spec.data.userFlow);
    if (flow) lines.push('', '## User flow', '', flow);
  }
  if (d.plan) {
    const p = d.plan.data;
    lines.push('', '## Plan', '');
    if (p.summary) lines.push(p.summary, '');
    lines.push(
      `- Full plan: [PLAN.md](PLAN.md) (revision \`${short(d.plan.hash)}\`)`,
      `- Executive summary: [EXECUTIVE-SUMMARY.md](EXECUTIVE-SUMMARY.md)`,
    );
    const planCoverage = d.trace.filter((t) => !t.planned);
    if (planCoverage.length) {
      lines.push('', `> ⚠️ Not covered by any plan step: ${planCoverage.map((t) => `${t.requirementId} (${t.priority})`).join(', ')}`);
    }
  }
  lines.push(
    '',
    '## Reviewer checklist',
    '',
    '- [ ] Every requirement is something you could check by hand (no vague words)',
    '- [ ] P0 marks exactly what must work for you to accept',
    '- [ ] Each 🟡 assumption is acceptable, or turned into a requirement',
    ...(d.plan
      ? [
          '- [ ] Read PLAN.md and EXECUTIVE-SUMMARY.md',
          '- [ ] Every requirement has a plan step and a test',
          '- [ ] The plan does not touch anything listed in Non-goals',
        ]
      : []),
    '',
    '## Decisions',
    '',
    DECIDE_HINT,
    '',
    decisionFor(d.decisions, 'requirements', 'Requirements', d.spec?.hash),
  );
  if (d.plan) lines.push('', decisionFor(d.decisions, 'plan', 'Plan', d.plan.hash));
  lines.push('', '<details><summary>Original request</summary>', '', d.sourceText.trim().slice(0, 4000), '', '</details>');
  return lines.join('\n');
}

// ---------------------------------------------------------------- REVIEW.md
const FILE_STATUS: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', T: 'type changed' };
const SEVERITY_ICON: Record<string, string> = { high: '🔴 high', medium: '🟠 medium', low: '⚪ low' };
const TRACE_ICON: Record<string, string> = { FULL: '🟢 FULL', PARTIAL: '🟡 PARTIAL', NONE: '🔴 NONE' };

export function renderReview(d: PacketData, previousChecks: AcceptanceCheck[]): string {
  const w = d.work;
  const lines = [`# Review — ${w.title}`, '', `\`${w.id}\` · change set \`${short(d.changeSetId)}\` · state \`${w.currentState}\``];

  // 1. What changed
  lines.push('', '## 1. What changed', '');
  if (!d.implemented) {
    lines.push('_Nothing committed yet. This section is filled from git once code is committed in the worktree._');
  } else {
    lines.push('> Read from git — nothing in this section is written by an AI.', '', '| Repo | Base → Head | Files | +/- |', '|---|---|---|---|');
    for (const r of d.repos) {
      const f = d.changeFacts.find((x) => x.repo === r.name);
      lines.push(`| ${r.name} | \`${short(r.baseCommit)}\` → \`${short(r.headCommit)}\` | ${f?.files.length ?? 0} | ${f ? `+${f.insertions} / -${f.deletions}` : '—'} |`);
    }
    const map = changeMap(d.changeFacts);
    if (map) lines.push('', map);
    for (const f of d.changeFacts.filter((x) => x.files.length)) {
      lines.push('', `**${f.repo}**`, '', '| Change | File |', '|---|---|');
      for (const file of f.files.slice(0, 30)) lines.push(`| ${FILE_STATUS[file.status[0] ?? ''] ?? file.status} | \`${file.path}\` |`);
      if (f.files.length > 30) lines.push(`| … | ${f.files.length - 30} more — see evidence/change.json |`);
      const deps = f.dependencies;
      lines.push('');
      for (const x of deps.added) lines.push(`- ➕ dependency \`${x.name}@${x.to}\` (${x.section})`);
      for (const x of deps.changed) lines.push(`- 🔄 dependency \`${x.name}\` ${x.from} → ${x.to}`);
      for (const x of deps.removed) lines.push(`- ➖ dependency \`${x.name}\``);
      lines.push(`- Test files changed: ${f.testFilesChanged.length ? f.testFilesChanged.map((t) => `\`${t}\``).join(', ') : '**none**'}`);
    }
    lines.push('', '<details><summary>How to inspect the diff</summary>', '', '```bash');
    for (const r of d.repos) lines.push(`cd "${r.worktreePath}" && git diff ${short(r.baseCommit)}...HEAD`);
    lines.push('```', '', '</details>');
  }

  // 2. Traceability
  lines.push('', '## 2. Traceability', '');
  if (!d.trace.length) lines.push('_No requirements yet._');
  else {
    lines.push(
      d.implemented
        ? '_FULL = a changed test is linked to the requirement and all checks pass · PARTIAL = planned/touched but not proven · NONE = not in the plan._'
        : '_Before code: does each requirement have a plan step and a planned test?_',
      '',
      '| Req | Pri | Plan steps | Planned tests | Code | Tests (verified) | Status |',
      '|---|---|---|---|---|---|---|',
    );
    for (const t of d.trace) {
      const status = t.status ? TRACE_ICON[t.status] : t.planned ? '📋 planned' : '⚠️ not planned';
      lines.push(
        `| ${t.requirementId} | ${t.priority} | ${t.steps.join(', ') || '—'} | ${t.plannedTests.length} | ${t.files.length ? t.files.map((f) => `\`${f.split('/').pop()}\``).join(', ') : '—'} | ${t.tests.length ? t.tests.map((f) => `\`${f.split('/').pop()}\``).join(', ') : '—'} | ${status} |`,
      );
    }
  }

  // 3. AI review
  lines.push('', '## 3. AI review', '');
  const r = d.review;
  if (!r || r.changeSetId !== d.changeSetId) {
    lines.push(r ? '_The AI review is for an older change set; it will run again._' : '_Not run yet._');
  } else {
    lines.push(
      `**${r.disposition === 'needs-attention' ? '⚠️ Needs attention' : 'No blocking findings'}** — lenses: ${r.lenses.join(', ')}. Only findings tied to a changed file (and, if quoted, to code really in the diff) are kept. This is advice, not approval.`,
      '',
    );
    if (!r.findings.length) lines.push('No findings. (Zero findings is a valid result — still read the diff.)');
    else {
      lines.push('| ID | Severity | Lens | Where | Finding |', '|---|---|---|---|---|');
      for (const f of r.findings) lines.push(`| ${f.id} | ${SEVERITY_ICON[f.severity] ?? f.severity} | ${f.lens} | \`${f.repo ? `${f.repo}:` : ''}${f.file}${f.line ? `:${f.line}` : ''}\` | ${esc(f.claim)} |`);
    }
    if (r.claimMismatches.length) {
      lines.push('', '**⚠️ The AI said things git does not support — treat its review with caution:**', '');
      for (const m of r.claimMismatches) lines.push(`- It said it ${m.claim} — ${m.reason}`);
    }
    if (r.discarded.length) {
      lines.push('', `<details><summary>${r.discarded.length} unverifiable item(s) discarded</summary>`, '');
      for (const x of r.discarded.slice(0, 25)) lines.push(`- (${x.lens}) ${x.claim}${x.file ? ` [\`${x.file}\`]` : ''} — _${x.reason}_`);
      lines.push('', '</details>');
    }
  }
  const codeFindings = d.analysis.filter((a) => a.gate === 'code-review');
  if (codeFindings.length) {
    lines.push('', '**Consistency checks (deterministic):**', '', ...codeFindings.map((a) => `- ${a.severity}: ${a.message}`));
  }

  // 4. Checks
  lines.push('', '## 4. Checks', '');
  if (!d.runs?.length) lines.push('_Not run yet. Runs every `quality.checks` command in the worktree at the change set under review._');
  else {
    lines.push('| Repo | Step | Kind | Command | Result | Time |', '|---|---|---|---|---|---|');
    for (const x of d.runs) {
      lines.push(`| ${x.repo} | ${x.phase} | ${x.kind} | \`${x.command}\` | ${x.passed ? '✅ passed' : `❌ ${x.error ?? `exit ${x.exitCode}`}`} | ${(x.durationMs / 1000).toFixed(1)}s |`);
    }
    for (const x of d.runs.filter((y) => !y.passed && y.error !== 'not run: setup failed').slice(0, 3)) {
      const tail = `${x.stderrTail}\n${x.stdoutTail}`.trim().split('\n').slice(-30).join('\n');
      lines.push('', `<details><summary>Output: ${x.repo} — ${x.command}</summary>`, '', '```text', tail || '(no output)', '```', '', '</details>');
    }
  }

  // 5. Acceptance
  lines.push('', '## 5. Acceptance', '');
  if (!d.trace.length) lines.push('_No requirements._');
  else {
    lines.push(
      '_Try the change yourself. For each requirement, tick the box and write what you observed. Every **P0** must be ticked with an observation before `turbine task approve` will accept._',
      '',
    );
    for (const t of d.trace) {
      const prev = previousChecks.find((c) => c.id === t.requirementId);
      lines.push(`- [${prev?.checked ? 'x' : ' '}] **${t.requirementId}** (${t.priority}) ${esc(t.statement)} — Observed: ${prev?.observed || '_(what you saw)_'}`);
    }
  }

  // Decisions + checklist
  lines.push(
    '',
    '## Reviewer checklist (code review)',
    '',
    '- [ ] I read the diff (section 1 → How to inspect)',
    '- [ ] Each P0 requirement is implemented in the code',
    '- [ ] I checked every 🔴/🟠 AI finding and every HIGH consistency problem',
    '- [ ] New dependencies, if any, are acceptable',
    '',
    '## Decisions',
    '',
    DECIDE_HINT,
    '',
    decisionFor(d.decisions, 'code-review', 'Code review', d.changeSetId),
    '',
    decisionFor(d.decisions, 'sqa-acceptance', 'Acceptance', d.changeSetId),
  );
  if (d.evidenceFiles.length) lines.push('', `Raw evidence: ${d.evidenceFiles.map((f) => `[${f}](evidence/${f})`).join(' · ')}`);
  return lines.join('\n');
}

/** Detailed plan document (architecture, steps, tests, coding-agent token estimate). */
export function renderPlan(d: PacketData): string {
  const w = d.work;
  const p = d.plan?.data;
  if (!p) {
    return [`# Plan — ${w.title}`, '', `_No plan yet for \`${w.id}\`._`, ''].join('\n');
  }
  const cap = LIST_CAP[d.track];
  const lines = [
    `# Plan — ${w.title}`,
    '',
    `\`${w.id}\` · plan revision \`${short(d.plan!.hash)}\` · complexity: ${p.complexity ?? '—'}`,
    '',
  ];
  if (p.summary) lines.push('## Summary', '', p.summary, '');
  lines.push('## Architecture', '', p.architecture?.trim() || '_No architecture notes._', '');
  lines.push('## Data model', '', p.dataModel?.trim() || '_No data model change._', '');
  lines.push('## Interfaces', '', p.interfaces?.trim() || '_No interface change._', '');
  lines.push('## Steps', '', '| Step | What | Requirements | Files |', '|---|---|---|---|');
  for (const s of p.steps) {
    lines.push(
      `| ${s.id} | ${esc(s.description)} | ${s.requirementIds.join(', ') || '—'} | ${s.files.map((f) => `\`${f}\``).join(', ') || '—'} |`,
    );
  }
  lines.push('', '## Test plan', '');
  if (p.testPlan.length) {
    lines.push('| Requirement | Test | Kind |', '|---|---|---|');
    for (const t of p.testPlan) lines.push(`| ${t.requirementId || '—'} | ${esc(t.test)} | ${t.kind} |`);
  } else lines.push('- _No tests planned_');
  lines.push('', '## Risks', '');
  if (p.risks.length) {
    lines.push(...capped(p.risks, Math.max(cap, p.risks.length), (r) => `- ${r.risk}${r.mitigation ? ` → _${r.mitigation}_` : ''}`, 'see evidence/plan.json'));
  } else lines.push('- _None_');
  lines.push('', '## Coding-agent token estimate', '');
  const est = p.codingAgentTokenEstimate;
  if (est) {
    lines.push(
      `| Field | Value |`,
      `|---|---|`,
      `| Total tokens | ${est.totalTokens} |`,
      ...(est.inputTokens !== undefined ? [`| Input (est.) | ${est.inputTokens} |`] : []),
      ...(est.outputTokens !== undefined ? [`| Output (est.) | ${est.outputTokens} |`] : []),
      `| Confidence | \`${est.confidence}\` (not billed / not measured) |`,
      `| Basis | ${esc(est.basis)} |`,
      '',
    );
  } else {
    lines.push('_No coding-agent token estimate on this plan._', '');
  }
  const planCoverage = d.trace.filter((t) => !t.planned);
  if (planCoverage.length) {
    lines.push(`> ⚠️ Not covered by any plan step: ${planCoverage.map((t) => `${t.requirementId} (${t.priority})`).join(', ')}`, '');
  }
  lines.push('Also see [EXECUTIVE-SUMMARY.md](EXECUTIVE-SUMMARY.md) and [SPEC.md](SPEC.md).');
  return lines.join('\n');
}

/** High-level narrative + Mermaid diagrams for human plan review. */
export function renderExecutiveSummary(d: PacketData): string {
  const w = d.work;
  const p = d.plan?.data;
  if (!p) {
    return [`# Executive summary — ${w.title}`, '', `_No plan yet for \`${w.id}\`._`, ''].join('\n');
  }
  const lines = [
    `# Executive summary — ${w.title}`,
    '',
    `\`${w.id}\` · plan revision \`${short(d.plan!.hash)}\``,
    '',
    '## Overview',
    '',
    p.executiveSummary?.trim() || p.summary || '_No executive summary provided._',
    '',
    '## Diagrams',
    '',
  ];
  if (p.diagrams.length) {
    for (const diagram of p.diagrams) {
      lines.push(`### ${diagram.title}`, '', '```mermaid', diagram.mermaid.trim(), '```', '');
    }
  } else {
    lines.push('_No diagrams on this plan._', '');
  }
  lines.push('Full detail: [PLAN.md](PLAN.md). Requirements: [SPEC.md](SPEC.md).');
  return lines.join('\n');
}

/** Write STATUS.md, SPEC.md, PLAN.md, EXECUTIVE-SUMMARY.md and REVIEW.md (preserving the human's acceptance checklist). */
export function renderPacket(d: PacketData): {
  status: string;
  spec: string;
  review: string;
  planDoc?: string;
  executiveSummary?: string;
  migrated: string[];
} {
  const paths = packetPaths(d.projectRoot, d.work.id);
  const migrated = migrateLegacyPacket(paths);
  const previous = existsSync(paths.review) ? parseAcceptanceChecklist(readPacketFile(paths.review) ?? '') : [];
  const status = renderStatus(d);
  const spec = renderSpec(d);
  const review = renderReview(d, previous);
  writeFile(paths.status, status);
  writeFile(paths.spec, spec);
  writeFile(paths.review, review);
  let planDoc: string | undefined;
  let executiveSummary: string | undefined;
  if (d.plan) {
    planDoc = renderPlan(d);
    executiveSummary = renderExecutiveSummary(d);
    writeFile(paths.planDoc, planDoc);
    writeFile(paths.executiveSummary, executiveSummary);
  }
  return { status, spec, review, planDoc, executiveSummary, migrated };
}
