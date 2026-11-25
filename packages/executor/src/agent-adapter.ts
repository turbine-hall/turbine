/**
 * Agent CLI adapters for sandboxed-unattended execution (FR-D4).
 * Input = SPEC + PLAN + CONTEXT + knowledge index; output = commits + usage.
 * Anything in `report` is unverified prose — only `commits` and later check results are evidence (FR-D5).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  agentCliCommand,
  cleanupSandboxPrompt,
  sandboxPromptPath,
  writeSandboxPrompt,
} from './container-runner.js';

export type ImplementerInput = {
  workId: string;
  spec: string;
  plan: string;
  context: string;
  knowledge: string;
  /** Wall-clock cancellation from the sandbox state machine; adapters must stop and await termination. */
  signal?: AbortSignal;
  /** Task worktree (container-mounted). Required for live CLI adapters. */
  worktreePath?: string;
  /** Observe commits after the CLI exits (host git against the worktree). */
  listCommits?: () => string[];
};

export type ImplementerResult = {
  /** Git commit SHAs produced in the worktree (evidence). */
  commits: string[];
  usage?: { inputTokens?: number; outputTokens?: number; modelId?: string; provider?: string };
  /** Unverified agent narrative — must not be treated as evidence. */
  report?: string;
  ok: boolean;
};

export type AgentImplementerId = 'fixture' | 'claude-code' | 'codex';

export type AgentImplementer = {
  id: AgentImplementerId;
  run: (input: ImplementerInput) => Promise<ImplementerResult>;
};

/** Fixture implementer for tests: records the prompt bundle and optionally "commits". */
export function createFixtureImplementer(opts: {
  commits?: string[];
  ok?: boolean;
  report?: string;
  usage?: ImplementerResult['usage'];
  onRun?: (input: ImplementerInput) => void;
} = {}): AgentImplementer {
  return {
    id: 'fixture',
    async run(input) {
      if (input.signal?.aborted) {
        return { ok: false, commits: [], report: 'fixture aborted before start' };
      }
      opts.onRun?.(input);
      return {
        ok: opts.ok ?? true,
        commits: opts.commits ?? [],
        report: opts.report ?? 'fixture implementer finished (unverified)',
        usage: opts.usage ?? { inputTokens: 10, outputTokens: 5, modelId: 'fixture', provider: 'fixture' },
      };
    },
  };
}

/**
 * Build the single adapter prompt bundle. Callers must not treat the adapter's report as evidence.
 */
export function formatImplementerPrompt(input: ImplementerInput): string {
  return [
    '## SPEC',
    input.spec,
    '',
    '## PLAN',
    input.plan,
    '',
    '## CONTEXT',
    input.context,
    '',
    '## KNOWLEDGE',
    input.knowledge,
  ].join('\n');
}

export type CliImplementerOpts = {
  /** Binary name or absolute path; tests inject a stub script on PATH. */
  bin?: string;
  extraArgs?: string[];
  provider: 'anthropic' | 'openai';
  modelId?: string;
  /**
   * When set, the adapter does not spawn on the host — it only writes the prompt file and
   * returns commits from `listCommits`. The container runner must invoke `bin` itself.
   */
  containerDelegated?: boolean;
};

function runAsyncCli(input: {
  bin: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): Promise<{ status: number | null; stdout: string; stderr: string; killed: boolean }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(input.bin, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // New process group so abort can signal the whole tree (shell + CLI descendants).
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const onAbort = () => {
      killed = true;
      const pid = child.pid;
      try {
        if (pid && process.platform !== 'win32') {
          process.kill(-pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    };
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (e) => {
      input.signal?.removeEventListener('abort', onAbort);
      resolve({ status: null, stdout, stderr: `${stderr}\n${e.message}`.trim(), killed });
    });
    child.on('close', (code) => {
      input.signal?.removeEventListener('abort', onAbort);
      resolve({ status: code, stdout, stderr, killed });
    });
  });
}

function createCliImplementer(
  id: 'claude-code' | 'codex',
  opts: CliImplementerOpts,
): AgentImplementer {
  const bin = opts.bin ?? (id === 'claude-code' ? 'claude' : 'codex');
  return {
    id,
    async run(input) {
      if (input.signal?.aborted) {
        return { ok: false, commits: [], report: `${id} aborted before start` };
      }
      const wt = input.worktreePath;
      if (!wt) {
        return { ok: false, commits: [], report: `${id} requires worktreePath` };
      }
      const promptPath = writeSandboxPrompt(wt, formatImplementerPrompt(input));

      if (opts.containerDelegated) {
        const commits = input.listCommits?.() ?? [];
        return {
          ok: true,
          commits,
          report: `${id} prompt written for container runner (unverified)`,
          usage: { modelId: opts.modelId ?? id, provider: opts.provider },
        };
      }

      // Host spawn is only for stub/integration tests that intentionally run outside Docker.
      // Use provider-shaped argv unless a custom bin/extraArgs override is supplied for stubs.
      let argv: string[];
      if (opts.bin || opts.extraArgs) {
        argv = [...(opts.extraArgs ?? []), '--prompt-file', promptPath];
      } else {
        // agentCliCommand returns [sh, -c, script, name, promptPath] — for host we spawn sh directly.
        const full = agentCliCommand(id, promptPath);
        // Replace default binary name inside the shell script when tests inject PATH stubs via opts.bin —
        // handled above. Live host path uses the stock CLI shape.
        argv = full.slice(1); // drop 'sh'; we'll spawn sh
        const result = await runAsyncCli({
          bin: full[0]!,
          args: argv,
          cwd: wt,
          signal: input.signal,
          env: { ...process.env, TURBINE_WORK_ID: input.workId },
        });
        cleanupSandboxPrompt(wt);
        if (input.signal?.aborted || result.killed) {
          return { ok: false, commits: [], report: `${id} aborted during run` };
        }
        const commits = input.listCommits?.() ?? [];
        const report = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 8_000);
        return {
          ok: result.status === 0,
          commits,
          report: report || `${id} exit ${result.status}`,
          usage: { modelId: opts.modelId ?? id, provider: opts.provider },
        };
      }

      const result = await runAsyncCli({
        bin,
        args: argv,
        cwd: wt,
        signal: input.signal,
        env: { ...process.env, TURBINE_WORK_ID: input.workId },
      });
      cleanupSandboxPrompt(wt);
      if (input.signal?.aborted || result.killed) {
        return { ok: false, commits: [], report: `${id} aborted during run` };
      }
      const commits = input.listCommits?.() ?? [];
      const report = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 8_000);
      return {
        ok: result.status === 0,
        commits,
        report: report || `${id} exit ${result.status}`,
        usage: {
          modelId: opts.modelId ?? id,
          provider: opts.provider,
        },
      };
    },
  };
}

export function createClaudeCodeImplementer(opts: Omit<CliImplementerOpts, 'provider'> = {}): AgentImplementer {
  return createCliImplementer('claude-code', { ...opts, provider: 'anthropic' });
}

export function createCodexImplementer(opts: Omit<CliImplementerOpts, 'provider'> = {}): AgentImplementer {
  return createCliImplementer('codex', { ...opts, provider: 'openai' });
}

export function createImplementerFromConfig(
  id: 'claude-code' | 'codex',
  opts: Omit<CliImplementerOpts, 'provider'> = {},
): AgentImplementer {
  return id === 'claude-code' ? createClaudeCodeImplementer(opts) : createCodexImplementer(opts);
}

export { sandboxPromptPath, cleanupSandboxPrompt, writeSandboxPrompt, agentCliCommand };
