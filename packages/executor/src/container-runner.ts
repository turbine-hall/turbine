/**
 * Live Docker/Podman phase runner for sandboxed-unattended (Part D follow-up).
 * Mounts the task worktree (+ linked-worktree Git admin dir); per-phase network scopes;
 * injectable spawn for tests.
 */
import { err } from '@turbine-hall/turbine-contracts';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  defaultSandboxHooks,
  detectContainerRuntime,
  PHASE_NETWORK,
  PHASE_TERMINATION_GRACE_MS,
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
  /** Container name passed to `run --name` so abort can `kill` the daemon container. */
  containerName?: string;
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
  /** False when abort could not confirm the daemon container stopped. */
  workloadStopped?: boolean;
};

export type RunContainerFn = (req: ContainerRunRequest) => Promise<ContainerRunOutcome>;

export type BindMount = { host: string; dest: string; mode: 'rw' | 'ro' };

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
  /** Bounded deadline for the in-container egress / allow-network probes (ms). */
  probeTimeoutMs?: number;
};

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const PROBE_URL = 'https://example.com/';

/** Build network argv for a phase. Returns enforced=false when allow-list scopes cannot be configured. */
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

/** Assert allow-list network policy knobs are configured before starting a sandboxed run. */
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

/**
 * Resolve linked-worktree Git layout (common dir + per-worktree admin dir).
 * Mounts are selective: objects/refs/worktree admin (+ config/HEAD read-only). Hooks are never mounted.
 */
export function resolveLinkedGitLayout(worktreePath: string): {
  commonDir: string;
  worktreeGitDir: string;
} | undefined {
  const gitPath = join(worktreePath, '.git');
  if (!existsSync(gitPath)) return undefined;
  let st;
  try {
    st = lstatSync(gitPath);
  } catch {
    return undefined;
  }
  if (st.isDirectory()) return undefined; // ordinary repo — already under the worktree mount
  if (!st.isFile()) return undefined;
  let raw: string;
  try {
    raw = readFileSync(gitPath, 'utf8');
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)\s*$/m.exec(raw);
  if (!match?.[1]) return undefined;
  const worktreeGitDir = resolve(dirname(gitPath), match[1].trim());
  let commonDir = resolve(worktreeGitDir, '..', '..');
  const commonDirFile = join(worktreeGitDir, 'commondir');
  if (existsSync(commonDirFile)) {
    try {
      commonDir = resolve(worktreeGitDir, readFileSync(commonDirFile, 'utf8').trim());
    } catch {
      // keep default
    }
  }
  if (!existsSync(commonDir)) {
    throw err(
      'E_UNSAFE_EXECUTION',
      `linked worktree Git common dir is missing (${commonDir}); cannot mount Git admin data`,
    );
  }
  return { commonDir, worktreeGitDir };
}

/**
 * Bind mounts so linked Git worktrees can run `git` inside the container.
 * @param writeable when false (setup/checks), objects/refs/admin are read-only.
 */
export function resolveLinkedGitMounts(worktreePath: string, writeable = true): BindMount[] {
  const layout = resolveLinkedGitLayout(worktreePath);
  if (!layout) return [];
  const { commonDir, worktreeGitDir } = layout;
  const mode = writeable ? 'rw' : 'ro';
  const mounts: BindMount[] = [
    { host: join(commonDir, 'objects'), dest: join(commonDir, 'objects'), mode },
    { host: join(commonDir, 'refs'), dest: join(commonDir, 'refs'), mode },
    { host: worktreeGitDir, dest: worktreeGitDir, mode },
  ];
  // Read-only shared metadata — never mount hooks/.
  for (const leaf of ['config', 'HEAD', 'packed-refs', 'info'] as const) {
    const p = join(commonDir, leaf);
    if (existsSync(p)) mounts.push({ host: p, dest: p, mode: 'ro' });
  }
  return mounts;
}

/** Parse `-v` / `--volume` host paths from container argv (host side only). */
export function parseBindHostsFromArgv(argv: string[]): string[] {
  const hosts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-v' || a === '--volume') {
      const spec = argv[i + 1];
      if (!spec) continue;
      // host:container[:opts] — host may be absolute; take first segment before unescaped ':'
      const host = spec.split(':')[0] ?? '';
      if (host) hosts.push(host);
      i += 1;
    }
  }
  return hosts;
}

/**
 * Refuse argv that would bind a forbidden path. Skips the home directory entry so a
 * descendant worktree under $HOME is allowed (matches planSandboxMounts).
 */
export function findForbiddenBindInArgv(
  argv: string[],
  forbiddenMounts: string[],
  home?: string,
): string | undefined {
  const homeCanon = home ? resolve(home) : '';
  const hosts = parseBindHostsFromArgv(argv);
  for (const host of hosts) {
    const hostResolved = resolve(host);
    for (const f of forbiddenMounts) {
      if (homeCanon && resolve(f) === homeCanon) continue;
      const forb = resolve(f);
      if (hostResolved === forb || hostResolved.startsWith(`${forb}/`) || forb.startsWith(`${hostResolved}/`)) {
        return f;
      }
    }
  }
  return undefined;
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
  extraMounts?: BindMount[];
  containerName?: string;
}): { argv: string[]; enforced: boolean; reason?: string; containerName: string } {
  const net = phaseNetworkArgs(input.network, {
    allowNetwork: input.allowNetwork,
    registries: input.registries,
    modelProxyUrl: input.modelProxyUrl,
  });
  const containerName = input.containerName ?? `turbine-sbx-${randomBytes(8).toString('hex')}`;
  if (!net.enforced) return { argv: [], enforced: false, reason: net.reason, containerName };
  const argv = ['run', '--rm', '--name', containerName, ...net.args, '-v', `${input.worktreePath}:${input.worktreePath}:rw`];
  for (const m of input.extraMounts ?? []) {
    argv.push('-v', `${m.host}:${m.dest}:${m.mode}`);
  }
  argv.push('-w', input.worktreePath, input.image, ...input.command);
  return { argv, enforced: true, containerName };
}

/** Kill + remove a named container. Returns true only when inspect confirms it is gone. */
export function stopContainer(runtime: ContainerRuntime, name: string): boolean {
  try {
    spawnSync(runtime, ['kill', name], { encoding: 'utf8', timeout: 15_000 });
  } catch {
    // continue to rm / inspect
  }
  try {
    spawnSync(runtime, ['rm', '-f', name], { encoding: 'utf8', timeout: 15_000 });
  } catch {
    // continue to inspect
  }
  try {
    const inspect = spawnSync(runtime, ['inspect', '-f', '{{.State.Running}}', name], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    // Missing container → status non-zero → confirmed stopped.
    if (inspect.status !== 0) return true;
    const running = (inspect.stdout ?? '').trim();
    return running !== 'true';
  } catch {
    return false;
  }
}

export function defaultRunContainer(req: ContainerRunRequest): Promise<ContainerRunOutcome> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(req.runtime, req.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let outputOverflow = false;
    let killed = false;
    let workloadStopped = true;
    const onAbort = () => {
      killed = true;
      if (req.containerName) {
        workloadStopped = stopContainer(req.runtime, req.containerName);
      }
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
      void (async () => {
        // If abort could not confirm daemon stop, delay settlement past the state-machine
        // grace window so ownership stays blocked (workloadStopped=false).
        if (killed && !workloadStopped) {
          await new Promise((r) => setTimeout(r, PHASE_TERMINATION_GRACE_MS + 250));
          if (req.containerName) {
            workloadStopped = stopContainer(req.runtime, req.containerName);
          }
        }
        resolvePromise({
          exitCode: code,
          stdout,
          stderr,
          outputBytes,
          outputOverflow,
          killed,
          workloadStopped: killed ? workloadStopped : true,
        });
      })();
    });
  });
}

const EGRESS_PROBE_SCRIPT = (url: string) =>
  `fetch(${JSON.stringify(url)}).then(()=>process.exit(0)).catch((e)=>{const c=e&&e.cause&&e.cause.code||e&&e.code;if(c==='ECONNREFUSED'||c==='ENETUNREACH'||c==='ENOTFOUND'||c==='EAI_AGAIN')process.exit(2);process.exit(1);})`;

async function runBoundedProbe(input: {
  runtime: ContainerRuntime;
  image: string;
  worktreePath: string;
  network: PhaseNetwork;
  allowNetwork?: string;
  registries: string[];
  modelProxyUrl?: string;
  extraMounts?: BindMount[];
  runContainer?: RunContainerFn;
  timeoutMs: number;
  /** When true, strip proxy env so we test the network itself (not the proxy). */
  stripProxy?: boolean;
}): Promise<'blocked' | 'open' | 'inconclusive'> {
  const netOpts = {
    allowNetwork: input.allowNetwork,
    registries: input.registries,
    modelProxyUrl: input.stripProxy ? undefined : input.modelProxyUrl,
  };
  // For stripProxy verification of allowNetwork, force registries-shaped args without proxy.
  const network: PhaseNetwork = input.stripProxy ? 'registries' : input.network;
  const built = buildContainerArgv({
    runtime: input.runtime,
    image: input.image,
    worktreePath: input.worktreePath,
    network,
    allowNetwork: netOpts.allowNetwork,
    registries: netOpts.registries.length ? netOpts.registries : input.registries.length ? input.registries : ['registry.npmjs.org'],
    modelProxyUrl: netOpts.modelProxyUrl,
    extraMounts: input.extraMounts,
    command: ['node', '-e', EGRESS_PROBE_SCRIPT(PROBE_URL)],
  });
  if (!built.enforced) return 'inconclusive';
  const run = input.runContainer ?? defaultRunContainer;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), input.timeoutMs);
  try {
    const out = await run({
      runtime: input.runtime,
      args: built.argv,
      containerName: built.containerName,
      signal: ac.signal,
      maxOutputBytes: 64_000,
    });
    if (out.killed || ac.signal.aborted) return 'inconclusive';
    if (out.exitCode === 2) return 'blocked';
    if (out.exitCode === 0) return 'open';
    return 'inconclusive';
  } catch {
    return 'inconclusive';
  } finally {
    clearTimeout(timer);
  }
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
  timeoutMs?: number;
  extraMounts?: BindMount[];
}): Promise<boolean> {
  const outcome = await runBoundedProbe({
    runtime: input.runtime,
    image: input.image,
    worktreePath: input.worktreePath,
    network: 'none',
    registries: [],
    extraMounts: input.extraMounts,
    runContainer: input.runContainer,
    timeoutMs: input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  });
  return outcome !== 'blocked';
}

/**
 * Verify the named allow-network blocks direct egress to a non-allow-listed host.
 * Open or inconclusive → caller must refuse (fail closed).
 */
export async function allowNetworkEgressProbeSucceeds(input: {
  runtime: ContainerRuntime;
  image: string;
  worktreePath: string;
  allowNetwork: string;
  registries: string[];
  runContainer?: RunContainerFn;
  timeoutMs?: number;
  extraMounts?: BindMount[];
}): Promise<boolean> {
  const outcome = await runBoundedProbe({
    runtime: input.runtime,
    image: input.image,
    worktreePath: input.worktreePath,
    network: 'registries',
    allowNetwork: input.allowNetwork,
    registries: input.registries,
    extraMounts: input.extraMounts,
    runContainer: input.runContainer,
    timeoutMs: input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    stripProxy: true,
  });
  return outcome !== 'blocked';
}

/**
 * Build live container hooks. Runs in-container egress probes under `--network none` and
 * under `sandboxAllowNetwork` (direct egress must be blocked). Fail-closed on open/inconclusive.
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
  const extraMounts = resolveLinkedGitMounts(mount.worktreePath);
  for (const m of extraMounts) {
    const hit = findForbiddenBindInArgv(
      ['-v', `${m.host}:${m.dest}:${m.mode}`],
      mount.forbiddenMounts,
      opts.home ?? process.env.HOME,
    );
    if (hit) {
      throw err('E_UNSAFE_EXECUTION', `Git admin mount overlaps forbidden path ${hit}`);
    }
  }
  const timeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const noneOpen = await containerEgressProbeSucceeds({
    runtime,
    image: opts.image,
    worktreePath: mount.worktreePath,
    runContainer: opts.runContainer,
    timeoutMs,
    extraMounts,
  });
  if (noneOpen) {
    // Still bind hooks that report open egress so preflightSandbox refuses; keep fail-closed.
    return createContainerSandboxHooksWithProbe({
      ...opts,
      runtime,
      mount,
      extraMounts,
      egressOpen: true,
    });
  }
  if (!opts.allowNetwork) {
    throw err('E_UNSAFE_EXECUTION', 'sandboxAllowNetwork is unset after network policy assert');
  }
  const allowOpen = await allowNetworkEgressProbeSucceeds({
    runtime,
    image: opts.image,
    worktreePath: mount.worktreePath,
    allowNetwork: opts.allowNetwork,
    registries: opts.registries,
    runContainer: opts.runContainer,
    timeoutMs,
    extraMounts,
  });
  if (allowOpen) {
    throw err(
      'E_UNSAFE_EXECUTION',
      `sandboxed-unattended allow-network "${opts.allowNetwork}" does not block non-allow-listed egress (or probe inconclusive). Refusing to start (no unsandboxed fallback).`,
    );
  }
  return createContainerSandboxHooksWithProbe({
    ...opts,
    runtime,
    mount,
    extraMounts,
    egressOpen: false,
  });
}

/** Sync constructor when egress outcome is already known (tests). */
export function createContainerSandboxHooksWithProbe(
  opts: ContainerSandboxOptions & {
    runtime: ContainerRuntime;
    mount: SandboxMountPlan;
    egressOpen: boolean;
    extraMounts?: BindMount[];
  },
): SandboxHooks {
  const run = opts.runContainer ?? defaultRunContainer;
  const { runtime, mount } = opts;
  const home = opts.home ?? process.env.HOME;

  const shellCommands = (commands: string[]): string[] => {
    if (!commands.length) return ['node', '-e', 'process.exit(0)'];
    // set -e: each line's nonzero status stops the script (avoids `a && b; true` masking).
    return ['sh', '-c', ['set -e', ...commands].join('\n')];
  };

  return {
    detectRuntime: () => runtime,
    egressProbeSucceeds: () => opts.egressOpen,
    runPhase: async (phase: SandboxPhase, ctx: PhaseContext): Promise<PhaseResult> => {
      if (ctx.signal.aborted) {
        return { ok: false, report: `${phase} aborted (wall-clock)`, outputBytes: 0 };
      }
      const network = PHASE_NETWORK[phase];
      const gitWriteable = phase === 'implement' || phase === 'fix' || phase === 'commit';
      const extraMounts = opts.extraMounts ?? resolveLinkedGitMounts(mount.worktreePath, gitWriteable);
      let command: string[];
      if (phase === 'setup') {
        command = shellCommands(opts.setupCommands ?? []);
      } else if (phase === 'checks') {
        command = shellCommands(opts.checkCommands ?? []);
      } else if (phase === 'commit') {
        // Prompt must not dirty the tree; remove it before the cleanliness check.
        cleanupSandboxPrompt(mount.worktreePath);
        command = [
          'sh',
          '-c',
          'set -e\ngit status --porcelain\ntest -z "$(git status --porcelain)"',
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
        extraMounts,
      });
      if (!built.enforced) {
        return {
          ok: false,
          report: `${phase}: ${built.reason ?? 'network policy not enforceable'}`,
          outputBytes: 64,
        };
      }
      const forbidden = findForbiddenBindInArgv(built.argv, mount.forbiddenMounts, home);
      if (forbidden) {
        return {
          ok: false,
          report: `${phase}: refused — forbidden mount would be included (${forbidden})`,
          outputBytes: 64,
        };
      }
      try {
        const outcome = await run({
          runtime,
          args: built.argv,
          containerName: built.containerName,
          signal: ctx.signal,
          maxOutputBytes: ctx.remainingOutputBytes,
        });
        const report = [outcome.stdout, outcome.stderr].filter(Boolean).join('\n').slice(0, 8_000);
        const stopped = outcome.workloadStopped !== false;
        return {
          ok: outcome.exitCode === 0 && !outcome.killed && !outcome.outputOverflow && stopped,
          report:
            outcome.killed && !stopped
              ? `${phase}: aborted but container termination not confirmed`
              : report || `${phase} exit ${outcome.exitCode}`,
          outputBytes: outcome.outputBytes,
          outputOverflow: outcome.outputOverflow,
        };
      } finally {
        if (phase === 'implement' || phase === 'fix') {
          cleanupSandboxPrompt(mount.worktreePath);
        }
      }
    },
  };
}

/** Prompt path written inside the worktree for agent CLIs (never outside the mount). */
export function sandboxPromptPath(worktreePath: string): string {
  return join(worktreePath, '.turbine-sandbox-prompt.md');
}

const PROMPT_EXCLUDE_LINE = '.turbine-sandbox-prompt.md';

/** True when path or any ancestor is a symlink (reject before writing metadata). */
function pathHasSymlinkComponent(target: string): boolean {
  let cur = resolve(target);
  for (;;) {
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      // missing component — keep walking parents
    }
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/** Ensure the sandbox prompt is listed in the common (or plain) info/exclude file. */
export function ensureSandboxPromptExcluded(worktreePath: string): void {
  const gitPath = join(worktreePath, '.git');
  if (!existsSync(gitPath)) return;
  let excludePath: string;
  try {
    const st = lstatSync(gitPath);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      excludePath = join(gitPath, 'info', 'exclude');
    } else if (st.isFile()) {
      const layout = resolveLinkedGitLayout(worktreePath);
      if (!layout) return;
      // Linked worktrees read exclude from the common Git directory.
      excludePath = join(layout.commonDir, 'info', 'exclude');
    } else {
      return;
    }
  } catch {
    return;
  }
  if (pathHasSymlinkComponent(excludePath)) return;
  try {
    if (existsSync(excludePath) && lstatSync(excludePath).isSymbolicLink()) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    if (pathHasSymlinkComponent(excludePath)) return;
    let existing = '';
    if (existsSync(excludePath)) {
      if (lstatSync(excludePath).isSymbolicLink()) return;
      existing = readFileSync(excludePath, 'utf8');
    }
    if (existing.split(/\r?\n/).includes(PROMPT_EXCLUDE_LINE)) return;
    const tmp = `${excludePath}.${process.pid}.tmp`;
    if (existsSync(tmp)) unlinkSync(tmp);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      writeSync(
        fd,
        `${existing}${existing.endsWith('\n') || !existing ? '' : '\n'}${PROMPT_EXCLUDE_LINE}\n`,
      );
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, excludePath);
  } catch {
    // Best-effort; cleanupSandboxPrompt still removes the file.
  }
}

/**
 * Write the implementer prompt without following a pre-existing symlink (O_NOFOLLOW / unlink+EXCL).
 */
export function writeSandboxPrompt(worktreePath: string, body: string): string {
  const dest = sandboxPromptPath(worktreePath);
  ensureSandboxPromptExcluded(worktreePath);
  try {
    const st = lstatSync(dest);
    if (st.isSymbolicLink() || st.isFile()) unlinkSync(dest);
  } catch {
    // ENOENT
  }
  const tmp = join(worktreePath, `.turbine-sandbox-prompt.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, dest);
  return dest;
}

/** Remove the sandbox prompt if present (does not follow symlinks for the unlink target name). */
export function cleanupSandboxPrompt(worktreePath: string): void {
  const dest = sandboxPromptPath(worktreePath);
  try {
    const st = lstatSync(dest);
    if (st.isSymbolicLink() || st.isFile()) unlinkSync(dest);
  } catch {
    // ignore
  }
}

/**
 * Provider-specific non-interactive CLI argv. Prompt is read from the worktree file inside the container.
 * Claude Code: `claude -p` with prompt text; Codex: `codex exec` with prompt text.
 */
export function agentCliCommand(id: 'claude-code' | 'codex', promptPath: string): string[] {
  if (id === 'claude-code') {
    return ['sh', '-c', 'claude -p "$(cat -- "$1")"', 'turbine-claude', promptPath];
  }
  return ['sh', '-c', 'codex exec "$(cat -- "$1")"', 'turbine-codex', promptPath];
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
    command: ['node', '-e', EGRESS_PROBE_SCRIPT(PROBE_URL)],
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
