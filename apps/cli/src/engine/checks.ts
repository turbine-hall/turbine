import { spawnSync } from 'node:child_process';
import type { Evidence } from '@turbine-hall/turbine-contracts';

export type CheckKind = Evidence['kind'];

/** Classify a check command so evidence can be matched to obligations. */
export function inferCheckKind(command: string): CheckKind {
  const c = command.toLowerCase();
  if (/\b(eslint|lint|biome|prettier --check|stylelint)\b/.test(c)) return 'lint';
  if (/\b(tsc|typecheck|type-check|types)\b/.test(c)) return 'typecheck';
  if (/\b(e2e|playwright|cypress)\b/.test(c)) return 'e2e';
  if (/\b(test|vitest|jest|mocha|pytest|go test)\b/.test(c)) return 'unit';
  if (/\b(build|compile)\b/.test(c)) return 'build';
  return 'other';
}

export type CheckRun = {
  repo: string;
  command: string;
  kind: CheckKind;
  phase: 'setup' | 'check';
  exitCode: number;
  passed: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  error?: string;
};

/**
 * Run one command without a shell (no pipes, globbing or env expansion), in `cwd`.
 * Output is kept as a tail so logs stay small but show the failure.
 */
export function runCommand(input: {
  repo: string;
  command: string;
  cwd: string;
  phase: 'setup' | 'check';
  timeoutMs: number;
}): CheckRun {
  const parts = input.command.split(/\s+/).filter(Boolean);
  const started = Date.now();
  const r = spawnSync(parts[0] ?? '', parts.slice(1), {
    cwd: input.cwd,
    encoding: 'utf8',
    shell: false,
    timeout: input.timeoutMs,
    env: { ...process.env, CI: process.env.CI ?? '1' },
    maxBuffer: 50 * 1024 * 1024,
  });
  const exitCode = r.status ?? 1;
  const error = r.error
    ? r.error.message
    : r.signal
      ? `terminated by ${r.signal}${r.signal === 'SIGTERM' ? ' (timeout?)' : ''}`
      : undefined;
  return {
    repo: input.repo,
    command: input.command,
    kind: input.phase === 'setup' ? 'other' : inferCheckKind(input.command),
    phase: input.phase,
    exitCode,
    passed: exitCode === 0 && !error,
    durationMs: Date.now() - started,
    stdoutTail: (r.stdout ?? '').slice(-8000),
    stderrTail: (r.stderr ?? '').slice(-8000),
    error,
  };
}

/** Evidence identity for a check: the same command in the same repo. */
export function checkLabel(repo: string, command: string): string {
  return `${repo}: ${command}`;
}
