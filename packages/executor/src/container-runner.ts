/**
 * Live Docker/Podman phase runner for sandboxed-unattended (Part D follow-up).
 * Mounts only the planned worktree; per-phase network scopes; injectable spawn for tests.
 */
import { err } from '@turbine-hall/turbine-contracts';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultSandboxHooks,
  detectContainerRuntime,
  PHASE_NETWORK,
  planSandboxMounts,
  type ContainerRuntime,
  type PhaseContext,
  type PhaseNetwork,
  type PhaseResult,
  type SandboxHooks,
  type SandboxMountPlan,
  type SandboxPhase,
} from './sandbox.js';

export type ContainerRunRequest = {
  runtime: ContainerRuntime;
  args: string[];
  signal?: AbortSignal;
  /** Soft cap on captured stdout+stderr; overflow sets outputOverflow. */
  maxOutputBytes: number;
};

export type ContainerRunOutcome = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputBytes: number;
  outputOverflow: boolean;
  killed: boolean;
};

export type RunContainerFn = (req: ContainerRunRequest) => Promise<ContainerRunOutcome>;

export type ContainerSandboxOptions = {
  worktreePath: string;
  projectRoot: string;
  image: string;
  registries: string[];
  modelProxyUrl?: string;
  /** Docker/Podman network for registries/model-proxy; required for those scopes to be enforceable. */
  allowNetwork?: string;
  runtime?: ContainerRuntime;
  home?: string;
  runContainer?: RunContainerFn;
  /** Commands for setup / checks phases (from project quality.*). */
  setupCommands?: string[];
  checkCommands?: string[];
  /** Optional: run implementer CLI inside the container for implement/fix. */
  agentCommand?: (phase: 'implement' | 'fix', ctx: PhaseContext) => string[];
};

/** Build network argv for a phase. Returns enforced=false when allow-list scopes cannot be proven. */
export function phaseNetworkArgs(
  network: PhaseNetwork,
  opts: { allowNetwork?: string; registries: string[]; modelProxyUrl?: string },
): { args: string[]; enforced: boolean; reason?: string } {
  if (network === 'none') {
    return { args: ['--network', 'none'], enforced: true };
  }
  if (!opts.allowNetwork) {
    return {
      args: [],
      enforced: false,
      reason: 'sandboxAllowNetwork is unset; registries/model-proxy scopes are not enforceable',
    };
  }
  if (network === 'registries' && opts.registries.length === 0) {
    return {
      args: [],
      enforced: false,
      reason: 'sandboxRegistries is empty; registries scope cannot be allow-listed',
    };
  }
  if (network === 'model-proxy' && !opts.modelProxyUrl) {
    return {
      args: [],
      enforced: false,
      reason: 'sandboxModelProxyUrl is unset; model-proxy scope cannot be allow-listed',
    };
  }
  const args = ['--network', opts.allowNetwork];
  if (network === 'model-proxy' && opts.modelProxyUrl) {
    args.push('-e', `HTTPS_PROXY=${opts.modelProxyUrl}`, '-e', `HTTP_PROXY=${opts.modelProxyUrl}`);
  }
  if (network === 'registries' && opts.registries.length) {
    args.push('-e', `TURBINE_SANDBOX_REGISTRIES=${opts.registries.join(',')}`);
  }
  return { args, enforced: true };
}

/** Assert allow-list network policy is configured before starting a sandboxed run. */
export function assertSandboxNetworkPolicyReady(opts: {
  registries: string[];
  modelProxyUrl?: string;
  allowNetwork?: string;
}): void {
  for (const network of ['registries', 'model-proxy'] as const) {
    const { enforced, reason } = phaseNetworkArgs(network, opts);
    if (!enforced) {
      throw err(
        'E_UNSAFE_EXECUTION',
        `sandboxed-unattended network policy not enforceable (${reason}). Refusing to start (no unsandboxed fallback).`,
      );
    }
  }
}

export function buildContainerArgv(input: {
  runtime: ContainerRuntime;
  image: string;
  worktreePath: string;
  network: PhaseNetwork;
  allowNetwork?: string;
  registries: string[];
  modelProxyUrl?: string;
  command: string[];
}): { argv: string[]; enforced: boolean; reason?: string } {
  const net = phaseNetworkArgs(input.network, {
    allowNetwork: input.allowNetwork,
    registries: input.registries,
    modelProxyUrl: input.modelProxyUrl,
  });
  if (!net.enforced) return { argv: [], enforced: false, reason: net.reason };
  // Worktree-only bind mount; never pass HOME/SSH/credentials/.turbine/state.
  const argv = [
    'run',
    '--rm',
    ...net.args,
    '-v',
    `${input.worktreePath}:${input.worktreePath}:rw`,
    '-w',
    input.worktreePath,
    input.image,
    ...input.command,
  ];
  return { argv, enforced: true };
}

export function defaultRunContainer(req: ContainerRunRequest): Promise<ContainerRunOutcome> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(req.runtime, req.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let outputOverflow = false;
    let killed = false;
    const onAbort = () => {
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    };
    if (req.signal) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }
    const take = (chunk: Buffer, dest: 'out' | 'err') => {
      const n = chunk.byteLength;
      if (outputBytes >= req.maxOutputBytes) {
        outputOverflow = true;
        return;
      }
      const room = req.maxOutputBytes - outputBytes;
      const slice = n > room ? chunk.subarray(0, room) : chunk;
      outputBytes += slice.byteLength;
      const text = slice.toString('utf8');
      if (dest === 'out') stdout += text;
      else stderr += text;
      if (n > room) outputOverflow = true;
    };
    child.stdout?.on('data', (c: Buffer) => take(c, 'out'));
    child.stderr?.on('data', (c: Buffer) => take(c, 'err'));
    child.on('error', (e) => {
      req.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      req.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        outputBytes,
        outputOverflow,
        killed,
      });
    });
  });
}

/**
 * In-container egress probe under `--network none`.
 * Returns true when unexpected egress succeeds or the outcome is unknown (preflight must refuse).
 */
export async function containerEgressProbeSucceeds(input: {
  runtime: ContainerRuntime;
  image: string;
  worktreePath: string;
  runContainer?: RunContainerFn;
  probeUrl?: string;
}): Promise<boolean> {
  const url = input.probeUrl ?? 'https://example.com/';
  const built = buildContainerArgv({
    runtime: input.runtime,
    image: input.image,
    worktreePath: input.worktreePath,
    network: 'none',
    registries: [],
    command: [
      'node',
      '-e',
      `fetch(${JSON.stringify(url)}).then(()=>process.exit(0)).catch((e)=>{const c=e&&e.cause&&e.cause.code||e&&e.code;if(c==='ECONNREFUSED'||c==='ENETUNREACH'||c==='ENOTFOUND'||c==='EAI_AGAIN')process.exit(2);process.exit(1);})`,
    ],
  });
  if (!built.enforced) return true;
  const run = input.runContainer ?? defaultRunContainer;
  try {
    const out = await run({
      runtime: input.runtime,
      args: built.argv,
      maxOutputBytes: 64_000,
    });
    if (out.exitCode === 2) return false; // confirmed blocked
    return true; // open (0) or inconclusive
  } catch {
    return true;
  }
}

/**
 * Build live container hooks. Runs an in-container egress probe under `--network none` first.
 * Callers that inject `runContainer` should prefer {@link createContainerSandboxHooksWithProbe}
 * after computing egress themselves, or pass `egressProbeSucceeds` override via wrapping.
 */
export async function createContainerSandboxHooks(opts: ContainerSandboxOptions): Promise<SandboxHooks> {
  assertSandboxNetworkPolicyReady({
    registries: opts.registries,
    modelProxyUrl: opts.modelProxyUrl,
    allowNetwork: opts.allowNetwork,
  });
  const runtime = opts.runtime ?? detectContainerRuntime();
  if (!runtime) {
    return {
      ...defaultSandboxHooks(),
      detectRuntime: () => undefined,
      egressProbeSucceeds: () => true,
    };
  }
  if (!existsSync(opts.worktreePath)) {
    throw err('E_UNSAFE_EXECUTION', `sandbox worktree does not exist: ${opts.worktreePath}`);
  }
  const mount: SandboxMountPlan = planSandboxMounts({
    worktreePath: opts.worktreePath,
    projectRoot: opts.projectRoot,
    runtime,
    home: opts.home,
  });
  const egressOpen = await containerEgressProbeSucceeds({
    runtime,
    image: opts.image,
    worktreePath: mount.worktreePath,
    runContainer: opts.runContainer,
  });
  return createContainerSandboxHooksWithProbe({ ...opts, runtime, mount, egressOpen });
}

/** Sync constructor when egress outcome is already known (tests). */
export function createContainerSandboxHooksWithProbe(
  opts: ContainerSandboxOptions & {
    runtime: ContainerRuntime;
    mount: SandboxMountPlan;
    egressOpen: boolean;
  },
): SandboxHooks {
  const run = opts.runContainer ?? defaultRunContainer;
  const { runtime, mount } = opts;

  const shellCommands = (commands: string[]): string[] => {
    if (!commands.length) return ['node', '-e', 'process.exit(0)'];
    return ['sh', '-c', commands.join(' && ')];
  };

  return {
    detectRuntime: () => runtime,
    egressProbeSucceeds: () => opts.egressOpen,
    runPhase: async (phase: SandboxPhase, ctx: PhaseContext): Promise<PhaseResult> => {
      if (ctx.signal.aborted) {
        return { ok: false, report: `${phase} aborted (wall-clock)`, outputBytes: 0 };
      }
      const network = PHASE_NETWORK[phase];
      let command: string[];
      if (phase === 'setup') {
        command = shellCommands(opts.setupCommands ?? []);
      } else if (phase === 'checks') {
        command = shellCommands(opts.checkCommands ?? []);
      } else if (phase === 'commit') {
        command = [
          'sh',
          '-c',
          'git status --porcelain && test -z "$(git status --porcelain)"',
        ];
      } else if (phase === 'implement' || phase === 'fix') {
        if (!opts.agentCommand) {
          return {
            ok: false,
            report: `${phase}: no agentCommand bound for container runner`,
            outputBytes: 48,
          };
        }
        command = opts.agentCommand(phase, ctx);
      } else {
        command = ['node', '-e', 'process.exit(0)'];
      }

      const built = buildContainerArgv({
        runtime,
        image: opts.image,
        worktreePath: mount.worktreePath,
        network,
        allowNetwork: opts.allowNetwork,
        registries: opts.registries,
        modelProxyUrl: opts.modelProxyUrl,
        command,
      });
      if (!built.enforced) {
        return {
          ok: false,
          report: `${phase}: ${built.reason ?? 'network policy not enforceable'}`,
          outputBytes: 64,
        };
      }
      // Never mount forbidden paths — argv must only bind the worktree.
      for (const f of mount.forbiddenMounts) {
        if (built.argv.some((a) => a === f || a.startsWith(`${f}:`) || a.includes(`:${f}`))) {
          return {
            ok: false,
            report: `${phase}: refused — forbidden mount would be included (${f})`,
            outputBytes: 64,
          };
        }
      }
      const outcome = await run({
        runtime,
        args: built.argv,
        signal: ctx.signal,
        maxOutputBytes: ctx.remainingOutputBytes,
      });
      const report = [outcome.stdout, outcome.stderr].filter(Boolean).join('\n').slice(0, 8_000);
      return {
        ok: outcome.exitCode === 0 && !outcome.killed && !outcome.outputOverflow,
        report: report || `${phase} exit ${outcome.exitCode}`,
        outputBytes: outcome.outputBytes,
        outputOverflow: outcome.outputOverflow,
      };
    },
  };
}

/** Prompt path written inside the worktree for agent CLIs (never outside the mount). */
export function sandboxPromptPath(worktreePath: string): string {
  return join(worktreePath, '.turbine-sandbox-prompt.md');
}

/** Optional sync probe helper for diagnostics (prefer async {@link containerEgressProbeSucceeds}). */
export function containerEgressProbeSucceedsSync(input: {
  runtime: ContainerRuntime;
  image: string;
  worktreePath: string;
}): boolean {
  const built = buildContainerArgv({
    runtime: input.runtime,
    image: input.image,
    worktreePath: input.worktreePath,
    network: 'none',
    registries: [],
    command: [
      'node',
      '-e',
      `fetch("https://example.com/").then(()=>process.exit(0)).catch((e)=>{const c=e&&e.cause&&e.cause.code||e&&e.code;if(c==='ECONNREFUSED'||c==='ENETUNREACH'||c==='ENOTFOUND'||c==='EAI_AGAIN')process.exit(2);process.exit(1);})`,
    ],
  });
  if (!built.enforced) return true;
  try {
    const result = spawnSync(input.runtime, built.argv, { encoding: 'utf8', timeout: 30_000 });
    if (result.error || result.status === null) return true;
    if (result.status === 2) return false;
    return true;
  } catch {
    return true;
  }
}
