import type { AcceptanceCriterion } from '@turbine-hall/turbine-contracts';
import type { RepoFacts } from '../changeset.js';
import type { CoverageLink } from '../review.js';
import type { NormalizedPlan } from './normalize.js';

/**
 * Requirement traceability, computed deterministically (modelled on BMad TEA's
 * FULL / PARTIAL / NONE):
 *  - before code: does a plan step and a planned test exist for the requirement?
 *  - after code:  FULL    = a changed test file is linked to it (verified) AND all checks passed
 *                 PARTIAL = planned or touched, but no verified test link or checks not passing
 *                 NONE    = no plan step covers it
 */
export type TraceStatus = 'FULL' | 'PARTIAL' | 'NONE';
export type TraceRow = {
  requirementId: string;
  priority: string;
  statement: string;
  steps: string[];
  plannedTests: string[];
  files: string[];
  tests: string[];
  checks: 'passed' | 'failed' | 'not-run';
  planned: boolean;
  status?: TraceStatus;
};

const matches = (changed: string, planned: string) =>
  changed === planned || changed.endsWith(`/${planned}`) || planned.endsWith(`/${changed}`) ||
  (planned.endsWith('/') && changed.startsWith(planned));

export function computeTrace(input: {
  requirements: AcceptanceCriterion[];
  plan?: NormalizedPlan;
  facts: RepoFacts[];
  coverage: CoverageLink[];
  checks: 'passed' | 'failed' | 'not-run';
  implemented: boolean;
}): TraceRow[] {
  const changed = input.facts.flatMap((f) => f.files.filter((x) => x.status !== 'D').map((x) => ({ repo: f.repo, path: x.path })));
  const primary = input.facts[0]?.repo;
  return input.requirements.map((r) => {
    const steps = (input.plan?.steps ?? []).filter((s) => s.requirementIds.includes(r.id));
    const plannedTests = (input.plan?.testPlan ?? []).filter((t) => t.requirementId === r.id).map((t) => t.test);
    const plannedFiles = steps.flatMap((s) => s.files);
    // "backend:src/x.ts" belongs to repo "backend"; unprefixed paths belong to the project repo.
    const hits = (c: { repo: string; path: string }) =>
      plannedFiles.some((p) => {
        const m = p.match(/^([a-z0-9][a-z0-9-]*):(.+)$/i);
        if (m && input.facts.some((f) => f.repo === m[1])) return c.repo === m[1] && matches(c.path, m[2]!);
        return (c.repo === primary || input.facts.length === 1) && matches(c.path, p);
      });
    const files = changed.filter(hits).map((c) => (c.repo === primary ? c.path : `${c.repo}:${c.path}`));
    const tests = input.coverage.filter((c) => c.requirementId === r.id).map((c) => c.testFile);
    const planned = steps.length > 0;
    let status: TraceStatus | undefined;
    if (input.implemented) {
      status = !planned && tests.length === 0 ? 'NONE' : tests.length > 0 && input.checks === 'passed' ? 'FULL' : 'PARTIAL';
    }
    return {
      requirementId: r.id,
      priority: r.priority ?? 'P1',
      statement: r.statement,
      steps: steps.map((s) => s.id),
      plannedTests,
      files,
      tests,
      checks: input.checks,
      planned,
      status,
    };
  });
}
