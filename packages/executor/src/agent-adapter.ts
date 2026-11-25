/**
 * Agent CLI adapters for sandboxed-unattended execution (FR-D4).
 * Input = SPEC + PLAN + CONTEXT + knowledge index; output = commits + usage.
 * Anything in `report` is unverified prose — only `commits` and later check results are evidence (FR-D5).
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { sandboxPromptPath } from './container-runner.js';

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
      const promptPath = sandboxPromptPath(wt);
      writeFileSync(promptPath, formatImplementerPrompt(input), 'utf8');

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
      const args = [...(opts.extraArgs ?? []), '--prompt-file', promptPath];
      const result = spawnSync(bin, args, {
        cwd: wt,
        encoding: 'utf8',
        timeout: 600_000,
        env: { ...process.env, TURBINE_WORK_ID: input.workId },
      });
      if (input.signal?.aborted) {
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
