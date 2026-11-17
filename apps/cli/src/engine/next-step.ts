import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkPackage, WorkState } from '@turbine-hall/turbine-contracts';
import { packetPaths } from './packet.js';

export type NextStep = {
  workId: string;
  state: WorkState;
  summary: string;
  who: 'human' | 'agent' | 'either';
  /** Single primary instruction */
  doNow: string;
  /** Exact shell commands from project root */
  commands: string[];
  /** Files to open/edit */
  openFiles: string[];
  /** Where code changes belong (if any) */
  worktreePath?: string;
  branch?: string;
  /** Clarifies main checkout vs worktree */
  important: string[];
  /** Short script for Cursor/agents */
  agentPlaybook: string[];
};

function worktreePathFor(projectRoot: string, workId: string): string {
  return join(projectRoot, '.turbine', 'worktrees', workId);
}

function branchFor(workId: string): string {
  return `turbine/${workId}`;
}

/**
 * Always answer: what should happen next, who does it, exact commands.
 */
export function computeNextStep(input: {
  projectRoot: string;
  work: WorkPackage;
  defaultBaseBranch?: string;
}): NextStep {
  const step = computeNextStepRaw(input);
  // Several legacy stage names now map to the same document; list each file once.
  return { ...step, openFiles: [...new Set(step.openFiles)] };
}

function computeNextStepRaw(input: {
  projectRoot: string;
  work: WorkPackage;
  defaultBaseBranch?: string;
}): NextStep {
  const { projectRoot, work } = input;
  const base = input.defaultBaseBranch ?? 'staging';
  const paths = packetPaths(projectRoot, work.id);
  const wt = worktreePathFor(projectRoot, work.id);
  const branch = branchFor(work.id);
  const sync = `turbine task sync ${work.id}`;
  const next = `turbine task next ${work.id}`;
  const approve = `turbine task approve ${work.id}`;
  const humanOnly = [
    `AGENT: do NOT run "${approve}" or "turbine task reject" — only the human runs them, in their own terminal.`,
    'AGENT: editing a Decision section in markdown has no effect; do not try.',
    'Summarise what the human is approving, then stop and wait.',
  ];
  const commonImportant = [
    `Main project folder (${projectRoot}) is NOT automatically updated by Turbine.`,
    'Code changes belong in the worktree/branch until you merge a PR.',
    `Human approvals happen only via: ${approve} (interactive, in your own terminal)`,
    `When unsure, run: ${next}`,
  ];

  const baseStep = {
    workId: work.id,
    state: work.currentState,
    commands: [] as string[],
    openFiles: [] as string[],
    important: [...commonImportant],
    agentPlaybook: [] as string[],
  };

  switch (work.currentState) {
    case 'IMPORTED':
    case 'ASSESSING':
      return {
        ...baseStep,
        summary: 'Assess the request against the real project.',
        who: 'either',
        doNow: `Run assess (or sync), then open STATUS.md.`,
        commands: [sync, next],
        openFiles: [paths.status, paths.request],
        agentPlaybook: [
          'Run turbine task sync <id> (or assess).',
          'Read SPEC.md → Context: ✅ items are verified facts, 🟡 are assumptions.',
          'If REQUIREMENTS_REVIEW, ask the human to read SPEC.md and run turbine task approve.',
        ],
      };

    case 'NEEDS_CLARIFICATION':
      return {
        ...baseStep,
        summary: 'Human must answer blocking unknowns in requirements.',
        who: 'human',
        doNow: `Answer the open questions in SPEC.md (append "→ Answer: …") and run sync. Then the human runs: ${approve}`,
        commands: [sync, next],
        openFiles: [paths.requirements, paths.status],
        agentPlaybook: [
          'Do NOT invent answers to product unknowns.',
          'You may propose answers in the markdown and run sync; that creates a new revision.',
          ...humanOnly,
        ],
      };

    case 'REQUIREMENTS_REVIEW':
      return {
        ...baseStep,
        summary: 'Human approves requirements.',
        who: 'human',
        doNow: `Read SPEC.md (requirements, questions, context), then in your own terminal run: ${approve}`,
        commands: [approve, next],
        openFiles: [paths.requirements, paths.status],
        agentPlaybook: ['Show the human the requirements summary and any assumptions.', ...humanOnly],
      };

    case 'REQUIREMENTS_APPROVED':
    case 'PLANNING':
      return {
        ...baseStep,
        summary: 'Generate the implementation plan.',
        who: 'either',
        doNow: 'Run sync to create the plan (in SPEC.md).',
        commands: [sync, next],
        openFiles: [paths.status],
        agentPlaybook: ['Run turbine task sync <id>.', 'Then ask the human to review SPEC.md → Plan.'],
      };

    case 'PLAN_REVIEW':
      return {
        ...baseStep,
        summary: 'Human approves the plan.',
        who: 'human',
        doNow: `Read SPEC.md → Plan (and fix CRITICAL items from turbine task analyze), then in your own terminal run: ${approve}`,
        commands: [approve, next],
        openFiles: [paths.plan, paths.status],
        agentPlaybook: ['Present plan steps briefly.', ...humanOnly],
      };

    case 'PLAN_APPROVED':
      return {
        ...baseStep,
        summary: 'Create supervised worktree handoff.',
        who: 'either',
        doNow: 'Run sync (execute). Then implement ONLY in the worktree listed in STATUS.md.',
        commands: [sync, next],
        openFiles: [paths.status],
        worktreePath: wt,
        branch,
        important: [
          ...commonImportant,
          `After execute, open ${paths.executionBrief} and cd into the worktree — not the main checkout.`,
        ],
        agentPlaybook: [
          'Run turbine task sync <id> (execute).',
          'Read SPEC.md → Requirements and Plan; follow the plan steps and file list.',
          'Make all code changes in the worktree path.',
          'Commit on the turbine/* branch in the worktree.',
          'Tell human: main folder is still old until PR merge.',
        ],
      };

    case 'IMPLEMENTING':
    case 'CHANGES_REQUESTED':
      return {
        ...baseStep,
        summary: 'Write and commit the code in the worktree; sync captures the commit.',
        who: 'agent',
        doNow: existsSync(wt)
          ? `Work in worktree ${wt} on ${branch}. Commit there. Then sync.`
          : 'Run sync to (re)create worktree, then implement there.',
        commands: existsSync(wt)
          ? [`cd "${wt}"`, 'git status', 'git log -1 --oneline', `cd "${projectRoot}"`, sync, next]
          : [sync, next],
        openFiles: [paths.executionBrief, paths.status].filter((p) => existsSync(p)),
        worktreePath: existsSync(wt) ? wt : undefined,
        branch,
        agentPlaybook: [
          'Never commit on staging/main for this task.',
          'Implement + typecheck in worktree.',
          'Commit on turbine/* branch.',
          'Return to project root and turbine task sync <id>.',
        ],
      };

    case 'AI_REVIEW':
      return {
        ...baseStep,
        summary: 'Run the AI review against the actual diff.',
        who: 'either',
        doNow: 'Run sync to run the AI review (REVIEW.md → 3).',
        commands: [sync, next],
        openFiles: [paths.changeReport, paths.status].filter((p) => existsSync(p)),
        worktreePath: existsSync(wt) ? wt : undefined,
        branch,
        agentPlaybook: ['Run turbine task sync <id>.', 'Then ask the human to review REVIEW.md and run turbine task approve.'],
      };

    case 'HUMAN_CODE_REVIEW':
      return {
        ...baseStep,
        summary: 'Human code-review decision.',
        who: 'human',
        doNow: `Review the diff and REVIEW.md sections 1–3, then in your own terminal run: ${approve}`,
        commands: [
          existsSync(wt) ? `cd "${wt}" && git log -1 --oneline && git diff ${base}...HEAD --stat` : 'true',
          `cd "${projectRoot}"`,
          approve,
          next,
        ],
        openFiles: [paths.review, paths.changeReport, paths.status].filter((p) => existsSync(p)),
        worktreePath: existsSync(wt) ? wt : undefined,
        branch,
        agentPlaybook: [
          'Summarise REVIEW.md → 1. What changed and any 🔴/🟠 findings.',
          ...humanOnly,
        ],
      };

    case 'VERIFYING':
      return {
        ...baseStep,
        summary: 'Record verification evidence.',
        who: 'either',
        doNow: 'Run sync (verify).',
        commands: [sync, next],
        openFiles: [paths.status],
        agentPlaybook: ['Run turbine task sync <id>.', 'Then remind the human to tick each P0 in REVIEW.md → 5. Acceptance.'],
      };

    case 'HUMAN_ACCEPTANCE':
      return {
        ...baseStep,
        summary: 'Human final acceptance (still not merged).',
        who: 'human',
        doNow: `Try the change, tick each P0 in REVIEW.md → 5. Acceptance with what you observed, then in your own terminal run: ${approve}`,
        commands: [approve, next],
        openFiles: [paths.acceptance, paths.verify, paths.status].filter((p) => existsSync(p)),
        agentPlaybook: [
          'Remind: ACCEPTED ≠ merged to staging.',
          'After accept, next step is open PR.',
          ...humanOnly,
        ],
      };

    case 'ACCEPTED':
      return {
        ...baseStep,
        summary: 'Turbine work is accepted. Merge into the real branch via PR.',
        who: 'human',
        doNow: `Open a PR from ${branch} → ${base}, merge it, then pull ${base} in your main folder.`,
        commands: [
          `gh pr create --base ${base} --head ${branch} --title "<title>" --body "Turbine work ${work.id} ACCEPTED"`,
          `git checkout ${base} && git pull`,
          'npm install   # or pnpm/yarn as used by the project',
          next,
        ],
        openFiles: [paths.acceptance, paths.status].filter((p) => existsSync(p)),
        worktreePath: existsSync(wt) ? wt : undefined,
        branch,
        important: [
          'ACCEPTED means the task packet is closed — not that staging/main has the change.',
          `Your main folder stays outdated until you merge ${branch} and pull.`,
          'Optional: remove the worktree after merge with git worktree remove …',
        ],
        agentPlaybook: [
          'Offer to run gh pr create for the human.',
          'Do not claim the main checkout is updated until pull after merge.',
          'After merge: git checkout base && git pull in the main project folder.',
        ],
      };

    default:
      return {
        ...baseStep,
        summary: `State ${work.currentState} — see STATUS.md.`,
        who: 'either',
        doNow: `Open STATUS.md and run ${next}.`,
        commands: [next, `turbine task explain ${work.id}`],
        openFiles: [paths.status],
        agentPlaybook: ['Read STATUS.md.', 'Follow doNow from turbine task next.'],
      };
  }
}
