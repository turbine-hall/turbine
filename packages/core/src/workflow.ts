import type { WorkState } from '@turbine-hall/turbine-contracts';
import { err } from '@turbine-hall/turbine-contracts';

/** Main happy-path transitions plus allowed exception edges. */
const TRANSITIONS: Record<WorkState, WorkState[]> = {
  IMPORTED: ['ASSESSING', 'CANCELLED'],
  ASSESSING: ['REQUIREMENTS_REVIEW', 'NEEDS_CLARIFICATION', 'BLOCKED', 'FAILED', 'PAUSED_BUDGET'],
  REQUIREMENTS_REVIEW: [
    'REQUIREMENTS_APPROVED',
    'ASSESSING',
    'NEEDS_CLARIFICATION',
    'CHANGES_REQUESTED',
    'CANCELLED',
  ],
  REQUIREMENTS_APPROVED: ['PLANNING', 'ASSESSING'],
  PLANNING: ['PLAN_REVIEW', 'BLOCKED', 'FAILED', 'PAUSED_BUDGET', 'NEEDS_CLARIFICATION'],
  PLAN_REVIEW: ['PLAN_APPROVED', 'PLANNING', 'CHANGES_REQUESTED', 'CANCELLED'],
  PLAN_APPROVED: ['IMPLEMENTING', 'PLANNING'],
  IMPLEMENTING: [
    'AI_REVIEW',
    'CHANGES_REQUESTED',
    'BLOCKED',
    'FAILED',
    'PAUSED_BUDGET',
    'PAUSED_POLICY',
  ],
  AI_REVIEW: ['HUMAN_CODE_REVIEW', 'IMPLEMENTING', 'CHANGES_REQUESTED', 'FAILED'],
  HUMAN_CODE_REVIEW: ['VERIFYING', 'IMPLEMENTING', 'CHANGES_REQUESTED', 'AI_REVIEW', 'CANCELLED'],
  VERIFYING: ['HUMAN_ACCEPTANCE', 'IMPLEMENTING', 'CHANGES_REQUESTED', 'FAILED'],
  HUMAN_ACCEPTANCE: ['ACCEPTED', 'CHANGES_REQUESTED', 'VERIFYING'],
  ACCEPTED: [],
  NEEDS_CLARIFICATION: ['ASSESSING', 'CANCELLED'],
  BLOCKED: ['ASSESSING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'CANCELLED'],
  CHANGES_REQUESTED: [
    'ASSESSING',
    'PLANNING',
    'IMPLEMENTING',
    'REQUIREMENTS_REVIEW',
    'PLAN_REVIEW',
  ],
  PAUSED_BUDGET: ['ASSESSING', 'PLANNING', 'IMPLEMENTING', 'CANCELLED'],
  PAUSED_POLICY: ['IMPLEMENTING', 'CANCELLED'],
  CANCELLED: [],
  FAILED: ['ASSESSING', 'PLANNING', 'IMPLEMENTING', 'CANCELLED'],
};

export function canTransition(from: WorkState, to: WorkState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: WorkState, to: WorkState): void {
  if (!canTransition(from, to)) {
    throw err(
      'E_INVALID_TRANSITION',
      `Invalid transition ${from} → ${to}`,
      { from, to, allowed: TRANSITIONS[from] },
    );
  }
}

export function listTransitions(from: WorkState): WorkState[] {
  return [...(TRANSITIONS[from] ?? [])];
}

export const MAIN_PATH: WorkState[] = [
  'IMPORTED',
  'ASSESSING',
  'REQUIREMENTS_REVIEW',
  'REQUIREMENTS_APPROVED',
  'PLANNING',
  'PLAN_REVIEW',
  'PLAN_APPROVED',
  'IMPLEMENTING',
  'AI_REVIEW',
  'HUMAN_CODE_REVIEW',
  'VERIFYING',
  'HUMAN_ACCEPTANCE',
  'ACCEPTED',
];
