import { createId, err } from '@turbine-hall/turbine-contracts';
import type { ModelAdapter } from '@turbine-hall/turbine-models';
import { runSkill, type SkillManifest } from '@turbine-hall/turbine-skills';

export type ExecutionMode = 'manual-supervised' | 'isolated-worktree' | 'sandboxed-unattended';

export {
  detectContainerRuntime,
  defaultSandboxHooks,
  forbiddenMountPaths,
  liveEgressProbeSucceeds,
  planSandboxMounts,
  PHASE_NETWORK,
  PHASE_TERMINATION_GRACE_MS,
  preflightSandbox,
  runSandboxedStateMachine,
  type ContainerRuntime,
  type PhaseContext,
  type PhaseNetwork,
  type PhaseResult,
  type SandboxEvidenceSnapshot,
  type SandboxHooks,
  type SandboxLimits,
  type SandboxMountPlan,
  type SandboxPhase,
  type SandboxRunResult,
} from './sandbox.js';

export {
  createFixtureImplementer,
  formatImplementerPrompt,
  type AgentImplementer,
  type ImplementerInput,
  type ImplementerResult,
} from './agent-adapter.js';

/**
 * Supervised execution: the engine prepares worktrees and an execution brief; a human or a
 * supervised agent writes the code. This function only produces optional model guidance.
 *
 * Nothing is written into the worktree here — an untracked handoff file would make the
 * worktree permanently "dirty" and hide real uncommitted work. The brief lives in the task
 * packet (04-EXECUTION_BRIEF.md).
 *
 * Worktree isolation is NOT a security sandbox. Unattended execution requires OS/container
 * isolation (`sandboxed-unattended`).
 */
export async function prepareExecutionGuidance(input: {
  workId: string;
  roleId: string;
  /** Grants resolved from the role manifest and project policy. */
  grantedCapabilities: string[];
  allowNetwork: boolean;
  planText: string;
  specText: string;
  model?: ModelAdapter;
  implementSkill?: SkillManifest;
}): Promise<{ modelNotes?: unknown }> {
  if (input.allowNetwork) {
    throw err(
      'E_UNSAFE_EXECUTION',
      'Networked autonomous execution is disabled outside sandboxed-unattended. Use manual-supervised mode or sandboxed-unattended.',
    );
  }
  if (!input.model || !input.implementSkill) return {};
  const result = await runSkill({
    skill: input.implementSkill,
    model: input.model,
    workId: input.workId,
    roleId: input.roleId,
    context: `SPEC:\n${input.specText}\n\nPLAN:\n${input.planText}`,
    schemaId: 'implement',
    maxOutputTokens: 4000,
    grantedCapabilities: input.grantedCapabilities,
  });
  return { modelNotes: result.content };
}

export function recordManualImplementation(input: {
  workId: string;
  commitSha: string;
  summary: string;
}): { id: string; commitSha: string; summary: string } {
  return {
    id: createId('impl'),
    commitSha: input.commitSha,
    summary: input.summary,
  };
}
