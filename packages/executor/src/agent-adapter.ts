/**
 * Agent CLI adapters for sandboxed-unattended execution (FR-D4).
 * Input = SPEC + PLAN + CONTEXT + knowledge index; output = commits + usage.
 * Anything in `report` is unverified prose — only `commits` and later check results are evidence (FR-D5).
 */

export type ImplementerInput = {
  workId: string;
  spec: string;
  plan: string;
  context: string;
  knowledge: string;
};

export type ImplementerResult = {
  /** Git commit SHAs produced in the worktree (evidence). */
  commits: string[];
  usage?: { inputTokens?: number; outputTokens?: number; modelId?: string; provider?: string };
  /** Unverified agent narrative — must not be treated as evidence. */
  report?: string;
  ok: boolean;
};

export type AgentImplementer = {
  id: 'claude-code' | 'codex' | 'fixture';
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
