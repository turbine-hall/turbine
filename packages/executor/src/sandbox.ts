import { err } from '@turbine-hall/turbine-contracts';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';

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

export type PhaseContext = {
  network: PhaseNetwork;
  attempt: number;
  /** Abort when the wall-clock deadline expires; hooks must stop the phase process/container. */
  signal: AbortSignal;
  /** Remaining stdout/stderr budget for this phase; hooks must stop capture when exhausted. */
  remainingOutputBytes: number;
};

export type SandboxHooks = {
  detectRuntime: () => ContainerRuntime | undefined;
  /**
   * Returns true when an unexpected egress probe *succeeds* (network policy not in effect)
   * or when the probe outcome is unknown. Preflight refuses unless this is false
   * (probe failed as expected under policy).
   */
  egressProbeSucceeds: () => boolean;
  runPhase: (phase: SandboxPhase, ctx: PhaseContext) => Promise<PhaseResult>;
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
      status: 'fix-cap' | 'limit-exceeded' | 'phase-failed';
      runtime: ContainerRuntime;
      attempts: number;
      outputBytes: number;
      reports: string[];
      commits: string[];
      usage: Array<NonNullable<PhaseResult['usage']>>;
      limitName?: 'wall-clock' | 'output-size';
      reason: string;
    };

/** Credential / state paths that must never be the worktree or lie under it as a mount root. */
const FORBIDDEN_LEAF_NAMES = ['.ssh', '.git-credentials', '.netrc'] as const;

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

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Build the mount plan for a sandboxed run: only the task worktree is allowed.
 * Home itself, SSH agent sockets, git credentials and `.turbine/state/` are never mounted.
 * An isolated worktree that merely lives under `$HOME` is allowed (home is not mounted).
 */
export function planSandboxMounts(input: {
  worktreePath: string;
  projectRoot: string;
  runtime: ContainerRuntime;
  home?: string;
}): SandboxMountPlan {
  const lexicalWorktree = resolve(input.worktreePath);
  if (!existsSync(lexicalWorktree)) {
    throw err('E_UNSAFE_EXECUTION', `Sandbox worktree does not exist: ${lexicalWorktree}`);
  }
  // Canonicalize so a symlink cannot hide a credential path.
  let worktreePath: string;
  try {
    worktreePath = realpathSync(lexicalWorktree);
  } catch (e) {
    throw err('E_UNSAFE_EXECUTION', `Sandbox worktree is unreadable: ${(e as Error).message.split('\n')[0]}`);
  }
  const home = input.home ?? process.env.HOME ?? '';
  const homeResolved = home ? resolve(home) : '';
  const forbiddenMounts = forbiddenMountPaths(input.projectRoot, input.home);
  if (process.env.SSH_AUTH_SOCK) {
    forbiddenMounts.push(resolve(process.env.SSH_AUTH_SOCK));
  }
  const canonicalForbidden = forbiddenMounts.map((p) => {
    try {
      return existsSync(p) ? realpathSync(p) : resolve(p);
    } catch {
      return resolve(p);
    }
  });
  // Mounting home itself is forbidden; a descendant worktree under home is fine.
  if (homeResolved && worktreePath === (existsSync(homeResolved) ? realpathSync(homeResolved) : homeResolved)) {
    throw err('E_UNSAFE_EXECUTION', 'Sandbox worktree must not be the home directory');
  }

  for (const forbidden of canonicalForbidden) {
    const homeCanon = homeResolved && existsSync(homeResolved) ? realpathSync(homeResolved) : homeResolved;
    if (homeCanon && forbidden === homeCanon) continue;
    if (pathsOverlap(worktreePath, forbidden)) {
      throw err('E_UNSAFE_EXECUTION', `Sandbox worktree overlaps forbidden path ${forbidden}`);
    }
  }

  for (const leaf of FORBIDDEN_LEAF_NAMES) {
    if (basename(worktreePath) === leaf) {
      throw err('E_UNSAFE_EXECUTION', `Sandbox worktree must not be ${leaf}`);
    }
  }

  return { worktreePath, forbiddenMounts: [...new Set(canonicalForbidden)], runtime: input.runtime };
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
 * Live egress probe: fetch a host that policy must block.
 * Exit 0 = open (probe "succeeds" → refuse). Exit 2 = confirmed refusal (ECONNREFUSED/ENETUNREACH).
 * Any other outcome is inconclusive and treated as open so preflight fails closed.
 * Default URL is a real public endpoint (not `.invalid`, which always fails DNS and never proves policy).
 */
export function liveEgressProbeSucceeds(url = 'https://example.com/'): boolean {
  const script = `
    fetch(${JSON.stringify(url)}).then(() => process.exit(0)).catch((e) => {
      const code = e && e.cause && e.cause.code || e && e.code;
      if (code === 'ECONNREFUSED' || code === 'ENETUNREACH') process.exit(2);
      process.exit(1);
    });
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5_000 });
    if (result.error || result.status === null) return true;
    if (result.status === 2) return false; // confirmed blocked
    return true; // open (0) or inconclusive (1, …)
  } catch {
    return true;
  }
}

export function defaultSandboxHooks(): SandboxHooks {
  return {
    detectRuntime: () => detectContainerRuntime(),
    // Host-network probe is not proof of container policy. Until a container egress probe is
    // injected, treat egress as unverified (succeeds=true → preflight refuses).
    egressProbeSucceeds: () => true,
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
      'sandboxed-unattended egress probe succeeded or was inconclusive; network policy is not proven. Refusing to start (no unsandboxed fallback).',
    );
  }
  return { runtime };
}

function phaseFailed(
  mount: SandboxMountPlan,
  attempts: number,
  outputBytes: number,
  reports: string[],
  commits: string[],
  usage: Array<NonNullable<PhaseResult['usage']>>,
  reason: string,
): SandboxRunResult {
  return {
    status: 'phase-failed',
    runtime: mount.runtime,
    attempts,
    outputBytes,
    reports,
    commits,
    usage,
    reason,
  };
}

/**
 * Fixed state machine: setup → implement → checks → (fix → checks)* → commit.
 * After maxExecutionAttempts failed check rounds → fix-cap (caller moves to CHANGES_REQUESTED).
 * Wall-clock expiry aborts the active phase via AbortSignal (hooks must stop the process/container).
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
    const remainingMs = Math.max(1, input.limits.wallClockMs - (now() - started));
    const remainingOutputBytes = Math.max(0, input.limits.maxOutputBytes - outputBytes);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    let phasePromise: Promise<PhaseResult> | undefined;
    let result: PhaseResult;
    try {
      phasePromise = Promise.resolve(
        input.hooks.runPhase(phase, {
          network: PHASE_NETWORK[phase],
          attempt: attempts,
          signal: controller.signal,
          remainingOutputBytes,
        }),
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('sandbox wall-clock exceeded'), { code: 'SANDBOX_DEADLINE' })),
          { once: true },
        );
      });
      result = await Promise.race([phasePromise, timeoutPromise]);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'SANDBOX_DEADLINE' || controller.signal.aborted) {
        if (phasePromise) await phasePromise.catch(() => undefined);
        return {
          status: 'limit-exceeded',
          runtime: input.mount.runtime,
          attempts,
          outputBytes,
          reports,
          commits,
          usage,
          limitName: 'wall-clock',
          reason: `wall-clock limit ${input.limits.wallClockMs}ms exceeded during ${phase}`,
        };
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    const phaseBytes = result.outputBytes ?? Buffer.byteLength(result.report ?? '', 'utf8');
    if (phaseBytes > remainingOutputBytes) {
      outputBytes += phaseBytes;
      if (result.report) reports.push(result.report);
      if (result.commits?.length) commits.push(...result.commits);
      if (result.usage) usage.push(result.usage);
      return {
        status: 'limit-exceeded',
        runtime: input.mount.runtime,
        attempts,
        outputBytes,
        reports,
        commits,
        usage,
        limitName: 'output-size',
        reason: `output-size limit ${input.limits.maxOutputBytes} bytes exceeded during ${phase}`,
      };
    }
    outputBytes += phaseBytes;
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
    if (!result.ok) {
      return phaseFailed(
        input.mount,
        attempts,
        outputBytes,
        reports,
        commits,
        usage,
        `${phase} failed: ${result.report ?? 'unknown'}`,
      );
    }
  }

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
    if (!fix.ok) {
      return phaseFailed(
        input.mount,
        attempts,
        outputBytes,
        reports,
        commits,
        usage,
        `fix failed: ${fix.report ?? 'unknown'}`,
      );
    }
  }

  const commit = await run('commit');
  if ('status' in commit) return commit;
  if (!commit.ok) {
    return phaseFailed(
      input.mount,
      attempts,
      outputBytes,
      reports,
      commits,
      usage,
      `commit failed: ${commit.report ?? 'unknown'}`,
    );
  }

  // Re-run checks against the committed tree so completion evidence matches the committed content.
  const postCommitChecks = await run('checks');
  if ('status' in postCommitChecks) return postCommitChecks;
  if (!postCommitChecks.ok) {
    return phaseFailed(
      input.mount,
      attempts,
      outputBytes,
      reports,
      commits,
      usage,
      `post-commit checks failed: ${postCommitChecks.report ?? 'unknown'}`,
    );
  }

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
