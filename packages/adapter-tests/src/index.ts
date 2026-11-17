import { spawnSync } from 'node:child_process';
import { err } from '@turbine-hall/turbine-contracts';
import type { Capability, ToolAdapter } from '@turbine-hall/turbine-tools';

export type TestRunResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export function createTestsAdapter(input: {
  allowlist: string[];
  cwd: string;
}): ToolAdapter {
  const allow = new Set(input.allowlist);

  return {
    id: 'tests',
    capabilities: ['tests.run'] as Capability[],
    async healthCheck() {
      return { ok: true, details: `allowlist=${[...allow].join(',') || '(empty)'}` };
    },
    async invoke({ capability, arguments: args }) {
      if (capability !== 'tests.run') {
        throw err('E_MISSING_CAPABILITY', `Tests adapter does not support ${capability}`);
      }
      const command = String(args.command ?? '');
      if (!command) throw err('E_UNSAFE_EXECUTION', 'No test command provided');
      if (allow.size > 0 && !allow.has(command)) {
        throw err(
          'E_UNSAFE_EXECUTION',
          `Command not allowlisted: ${command}. Configure quality.checks first.`,
        );
      }

      // Parse simple commands without shell:true
      const parts = command.split(/\s+/).filter(Boolean);
      const bin = parts[0];
      if (!bin) throw err('E_UNSAFE_EXECUTION', 'Empty command');
      const started = Date.now();
      const result = spawnSync(bin, parts.slice(1), {
        cwd: String(args.cwd ?? input.cwd),
        encoding: 'utf8',
        shell: false,
        timeout: Number(args.timeoutMs ?? 120_000),
        env: { ...process.env, ...(args.env as Record<string, string> | undefined) },
      });
      const out: TestRunResult = {
        command,
        exitCode: result.status ?? 1,
        stdout: (result.stdout ?? '').toString().slice(0, 200_000),
        stderr: (result.stderr ?? '').toString().slice(0, 200_000),
        durationMs: Date.now() - started,
      };
      return { data: out };
    },
  };
}
