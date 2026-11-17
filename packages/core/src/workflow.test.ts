import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, MAIN_PATH } from './workflow.js';
import { selectRoles } from './arsp.js';
import type { WorkPackage } from '@turbine-hall/turbine-contracts';

describe('workflow', () => {
  it('allows main path steps', () => {
    for (let i = 0; i < MAIN_PATH.length - 1; i += 1) {
      expect(canTransition(MAIN_PATH[i]!, MAIN_PATH[i + 1]!)).toBe(true);
    }
  });

  it('blocks invalid transitions', () => {
    expect(() => assertTransition('IMPORTED', 'ACCEPTED')).toThrow(/E_INVALID_TRANSITION|Invalid/);
  });
});

describe('arsp', () => {
  const base: WorkPackage = {
    id: 'work_1',
    frameworkId: 'turbine',
    frameworkVersion: '0.5.0',
    type: 'feature',
    title: 'Add leave approval endpoint',
    objective: 'Managers can approve leave via API',
    sourceRefs: [],
    acceptanceCriteria: [],
    constraints: [],
    nonGoals: [],
    unknowns: [],
    assumptions: [],
    risk: { profile: 'standard', reasons: [] },
    selectedRoles: [],
    currentState: 'IMPORTED',
    currentRevision: 1,
    aliases: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('escalates auth work to comprehensive with security-reviewer', () => {
    const result = selectRoles({
      work: {
        ...base,
        title: 'Fix auth permission check on leave approval',
        objective: 'Ensure RBAC permissions for leave approvals',
      },
    });
    expect(result.profile).toBe('comprehensive');
    expect(result.roles.some((r) => r.id === 'security-reviewer')).toBe(true);
    expect(result.hardTriggers).toContain('auth-permissions');
  });

  it('keeps localized bug lightweight without security role', () => {
    const result = selectRoles({
      work: {
        ...base,
        type: 'bug',
        title: 'Fix typo in log message',
        objective: 'Correct a log string',
        acceptanceCriteria: [
          { id: 'ac1', statement: 'Log text updated', kind: 'technical', status: 'confirmed' },
        ],
      },
    });
    expect(result.profile).toBe('lightweight');
    expect(result.roles.some((r) => r.id === 'security-reviewer')).toBe(false);
  });
});
