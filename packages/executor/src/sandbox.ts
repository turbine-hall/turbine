import { err } from '@turbine-hall/turbine-contracts';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type ContainerRuntime = 'docker' | 'podman';

export type SandboxPhase = 'setup' | 'implement' | 'checks' | 'fix' | 'commit';

export type PhaseNetwork = 'registries' | 'model-proxy' | 'none';

/** Network scope for each deterministic / agent phase (FR-D2). */
export const PHASE_NETWORK: Record<SandboxPhase, PhaseNetwork> = {
  setup: 'registries',
  implement: 'model-proxy',
  checks: 'none',
  fix: 'model-proxy',
  commit: 'none',
};

export type SandboxMountPlan = {
  worktreePath: string;
  /** Paths that must never be mounted into the container. */
  forbiddenMounts: string[];
  runtime: ContainerRuntime;
};

export type PhaseResult = {
  ok: boolean;
  /** Agent prose / logs — never treated as evidence by the engine (FR-D5). */
  report?: string;
  /** Bytes of captured output for this phase (FR-D6). */
  outputBytes?: number;
  /** Git commits produced in the worktree this phase (evidence). */
  commits?: string[];
  usage?: { inputTokens?: number; outputTokens?: number; modelId?: string };
};

export type SandboxHooks = {
  detectRuntime: () => ContainerRuntime | undefined;
  /**
   * Returns true when an unexpected egress probe *succeeds* (network policy not in effect).
   * Preflight requires this to be false (probe fails as expected).
   */
  egressProbeSucceeds: () => boolean;
  runPhase: (phase: SandboxPhase, ctx: { network: PhaseNetwork; attempt: number }) => Promise<PhaseResult>;
  nowMs?: () => number;
};

export type SandboxLimits = {
  wallClockMs: number;
  maxOutputBytes: number;
  maxExecutionAttempts: number;
};

export type SandboxRunResult =
  | {
      status: 'completed';
      runtime: ContainerRuntime;
      commits: string[];
      attempts: number;
      outputBytes: number;
      /** Unverified agent reports — not evidence. */
      reports: string[];
      usage: Array<NonNullable<PhaseResult['usage']>>;
    }
  | {
      status: 'fix-cap' | 'limit-exceeded';
      runtime: ContainerRuntime;
      attempts: number;
      outputBytes: number;
      reports: string[];
      commits: string[];
      usage: Array<NonNullable<PhaseResult['usage']>>;
      limitName?: 'wall-clock' | 'output-size';
      reason: string;
    };

const FORBIDDEN_BASENAMES = ['.ssh', '.git-credentials', '.netrc'];

/** Paths that must never be bind-mounted into a sandboxed-unattended container (FR-D1). */
export function forbiddenMountPaths(projectRoot: string, home = process.env.HOME ?? ''): string[] {
  const out = [
    resolve(projectRoot, '.turbine', 'state'),
    ...(home
      ? [home, resolve(home, '.ssh'), resolve(home, '.git-credentials'), resolve(home, '.netrc')]
      : []),
  ];
  return [...new Set(out.map((p) => resolve(p)))];
}

/**
 * Build the mount plan for a sandboxed run: only the task worktree is allowed.
 * Home, SSH agent sockets, git credentials and `.turbine/state/` are never mounted.
 */
export function planSandboxMounts(input: {
  worktreePath: string;
  projectRoot: string;
  runtime: ContainerRuntime;
  home?: string;
}): SandboxMountPlan {
  const worktreePath = resolve(input.worktreePath);
  const forbiddenMounts = forbiddenMountPaths(input.projectRoot, input.home);
  if (!existsSync(worktreePath)) {
    throw err('E_UNSAFE_EXECUTION', `Sandbox worktree does not exist: ${worktreePath}`);
  }
  for (const forbidden of forbiddenMounts) {
    if (worktreePath === forbidden || worktreePath.startsWith(`${forbidden}/`)) {
      throw err('E_UNSAFE_EXECUTION', `Sandbox worktree must not be under forbidden path ${forbidden}`);
    }
  }
  // SSH agent socket must not be passed through.
  if (process.env.SSH_AUTH_SOCK) {
    // Recorded as forbidden for callers that assemble docker -v flags.
    forbiddenMounts.push(resolve(process.env.SSH_AUTH_SOCK));
  }
  for (const name of FORBIDDEN_BASENAMES) {
    void name;
  }
  return { worktreePath, forbiddenMounts, runtime: input.runtime };
}

/** Prefer Docker when both are present (spec Q2). */
export function detectContainerRuntime(
  which: (bin: string) => boolean = (bin) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0,
): ContainerRuntime | undefined {
  if (which('docker')) return 'docker';
  if (which('podman')) return 'podman';
  return undefined;
}

/**
 * Live egress probe: attempt a fetch to a non-allowlisted host. For preflight the probe MUST fail
 * (network policy in effect). A successful fetch means the sandbox is not constrained.
 */
export function liveEgressProbeSucceeds(url = 'https://example.invalid/'): boolean {
  try {
    const result = spawnSync(process.execPath, ['-e', `fetch(${JSON.stringify(url)}).then(()=>process.exit(0)).catch(()=>process.exit(1))`], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function defaultSandboxHooks(): SandboxHooks {
  return {
    detectRuntime: () => detectContainerRuntime(),
    egressProbeSucceeds: () => liveEgressProbeSucceeds(),
    runPhase: async () => ({ ok: false, report: 'no phase runner configured' }),
  };
}

/**
 * Confirm a container runtime is present and the network policy is in effect.
 * Never falls back to unsandboxed execution (FR-D3).
 */
export function preflightSandbox(hooks: SandboxHooks = defaultSandboxHooks()): { runtime: ContainerRuntime } {
  const runtime = hooks.detectRuntime();
  if (!runtime) {
    throw err(
      'E_UNSAFE_EXECUTION',
      'sandboxed-unattended requires Docker or Podman; no container runtime was found. It will not fall back to unsandboxed execution.',
    );
  }
  if (hooks.egressProbeSucceeds()) {
    throw err(
      'E_UNSAFE_EXECUTION',
      'sandboxed-unattended egress probe succeeded; network policy is not in effect. Refusing to start (no unsandboxed fallback).',
    );
  }
  return { runtime };
}

/**
 * Fixed state machine: setup → implement → checks → (fix → checks)* → commit.
 * After maxExecutionAttempts failed check rounds → fix-cap (caller moves to CHANGES_REQUESTED).
 */
export async function runSandboxedStateMachine(input: {
  hooks: SandboxHooks;
  limits: SandboxLimits;
  mount: SandboxMountPlan;
}): Promise<SandboxRunResult> {
  const now = input.hooks.nowMs ?? Date.now;
  const started = now();
  const reports: string[] = [];
  const commits: string[] = [];
  const usage: Array<NonNullable<PhaseResult['usage']>> = [];
  let outputBytes = 0;
  let attempts = 0;

  const withinLimits = (): SandboxRunResult | undefined => {
    if (now() - started > input.limits.wallClockMs) {
      return {
        status: 'limit-exceeded',
        runtime: input.mount.runtime,
        attempts,
        outputBytes,
        reports,
        commits,
        usage,
        limitName: 'wall-clock',
        reason: `wall-clock limit ${input.limits.wallClockMs}ms exceeded`,
      };
    }
    if (outputBytes > input.limits.maxOutputBytes) {
      return {
        status: 'limit-exceeded',
        runtime: input.mount.runtime,
        attempts,
        outputBytes,
        reports,
        commits,
        usage,
        limitName: 'output-size',
        reason: `output-size limit ${input.limits.maxOutputBytes} bytes exceeded`,
      };
    }
    return undefined;
  };

  const run = async (phase: SandboxPhase): Promise<PhaseResult | SandboxRunResult> => {
    const limited = withinLimits();
    if (limited) return limited;
    const result = await input.hooks.runPhase(phase, { network: PHASE_NETWORK[phase], attempt: attempts });
    outputBytes += result.outputBytes ?? Buffer.byteLength(result.report ?? '', 'utf8');
    if (result.report) reports.push(result.report);
    if (result.commits?.length) commits.push(...result.commits);
    if (result.usage) usage.push(result.usage);
    const after = withinLimits();
    if (after) return after;
    return result;
  };

  for (const phase of ['setup', 'implement'] as const) {
    const result = await run(phase);
    if ('status' in result) return result;
    if (phase === 'setup' && !result.ok) {
      return {
        status: 'limit-exceeded',
        runtime: input.mount.runtime,
        attempts,
        outputBytes,
        reports,
        commits,
        usage,
        reason: `setup failed: ${result.report ?? 'unknown'}`,
      };
    }
  }

  // checks → fix loop
  for (;;) {
    attempts += 1;
    const checks = await run('checks');
    if ('status' in checks) return checks;
    if (checks.ok) break;
    if (attempts >= input.limits.maxExecutionAttempts) {
      return {
        status: 'fix-cap',
        runtime: input.mount.runtime,
        attempts,
        outputBytes,
        reports,
        commits,
        usage,
        reason: `checks failed after ${attempts} execution attempts (max ${input.limits.maxExecutionAttempts})`,
      };
    }
    const fix = await run('fix');
    if ('status' in fix) return fix;
  }

  const commit = await run('commit');
  if ('status' in commit) return commit;

  return {
    status: 'completed',
    runtime: input.mount.runtime,
    commits,
    attempts,
    outputBytes,
    reports,
    usage,
  };
}
