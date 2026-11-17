import type { AcceptanceCriterion, WorkState } from '@turbine-hall/turbine-contracts';
import type { RepoFacts } from '../changeset.js';
import type { NormalizedPlan, RequestCoverage, RequestItem } from './normalize.js';
import type { TraceRow } from './trace.js';

/**
 * `turbine task analyze` — read-only consistency check across requirements, plan, diff and
 * evidence (modelled on Spec Kit's /analyze). Deterministic: no model involved.
 * CRITICAL findings block approval of the gate they belong to.
 */
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type AnalysisGate = 'requirements' | 'plan' | 'code-review';
export type AnalysisFinding = {
  id: string;
  severity: Severity;
  gate: AnalysisGate;
  category: 'ambiguity' | 'coverage' | 'consistency' | 'scope' | 'duplication';
  message: string;
  where?: string;
};

const VAGUE = /\b(fast|quick(ly)?|user[- ]friendly|intuitive|appropriate(ly)?|robust|seamless(ly)?|easy|simple|as needed|etc\.?|and\/or|properly|reasonable)\b/i;
const TESTABLE = /\b(shall|must)\b|^\s*(given|when|if|while|where)\b/i;

export function analyze(input: {
  state: WorkState;
  requirements: AcceptanceCriterion[];
  unknowns: string[];
  /** Extra repositories in scope (the project repo is implicit). */
  repos?: string[];
  /** Planned files that do not exist, with a likely intended existing file when one is found. */
  missingPlanFiles?: Array<{ file: string; suggestion?: string; dirExists: boolean }>;
  requestItems?: RequestItem[];
  requestCoverage?: RequestCoverage[];
  nonGoals?: string[];
  plan?: NormalizedPlan;
  planText?: string;
  facts: RepoFacts[];
  trace: TraceRow[];
}): AnalysisFinding[] {
  const out: AnalysisFinding[] = [];
  const add = (f: Omit<AnalysisFinding, 'id'>) => {
    const prefix = { ambiguity: 'A', coverage: 'C', consistency: 'K', scope: 'S', duplication: 'D' }[f.category];
    out.push({ id: `${prefix}${out.filter((x) => x.category === f.category).length + 1}`, ...f });
  };
  const ids = new Set(input.requirements.map((r) => r.id));

  // --- requirements
  for (const r of input.requirements) {
    if (/\[NEEDS CLARIFICATION/i.test(r.statement)) {
      add({ severity: 'CRITICAL', gate: 'requirements', category: 'ambiguity', where: r.id, message: `${r.id} is marked NEEDS CLARIFICATION — answer it before approving` });
    }
    if (!TESTABLE.test(r.statement)) {
      add({ severity: r.priority === 'P0' ? 'MEDIUM' : 'LOW', gate: 'requirements', category: 'ambiguity', where: r.id, message: `${r.id} is not written as a testable rule (use "WHEN … THE SYSTEM SHALL …" or Given/When/Then)` });
    }
    const vague = r.statement.match(VAGUE);
    if (vague) {
      add({ severity: 'MEDIUM', gate: 'requirements', category: 'ambiguity', where: r.id, message: `${r.id} uses the vague term "${vague[0]}" — say what is measurable` });
    }
  }
  const seen = new Map<string, string>();
  for (const r of input.requirements) {
    const key = r.statement.toLowerCase().replace(/\W+/g, ' ').trim();
    if (seen.has(key)) add({ severity: 'MEDIUM', gate: 'requirements', category: 'duplication', where: r.id, message: `${r.id} duplicates ${seen.get(key)}` });
    else seen.set(key, r.id);
  }
  // Every request item must be covered by a requirement, a stated non-goal, or an open question.
  if (input.requestItems?.length) {
    const cov = new Map((input.requestCoverage ?? []).map((c) => [c.itemId, c]));
    for (const item of input.requestItems) {
      const c = cov.get(item.id);
      const linked = (c?.requirementIds ?? []).filter((id) => ids.has(id));
      if (!c || (!linked.length && !c.nonGoal && !c.question)) {
        add({ severity: 'HIGH', gate: 'requirements', category: 'coverage', where: item.id, message: `Request item ${item.id} is not covered by any requirement, non-goal or question: "${item.text.slice(0, 90)}"` });
      }
      for (const rid of (c?.requirementIds ?? []).filter((id) => !ids.has(id))) {
        add({ severity: 'MEDIUM', gate: 'requirements', category: 'consistency', where: item.id, message: `${item.id} maps to unknown requirement ${rid}` });
      }
    }
  }
  if (!input.requirements.some((r) => r.priority === 'P0')) {
    add({ severity: 'HIGH', gate: 'requirements', category: 'coverage', message: 'No P0 requirement — mark what must work for acceptance' });
  }

  // --- plan
  if (input.plan && input.plan.steps.length) {
    const linked = input.plan.steps.some((s) => s.requirementIds.length > 0);
    for (const t of input.trace) {
      if (!t.planned && linked) {
        add({ severity: t.priority === 'P0' ? 'CRITICAL' : 'HIGH', gate: 'plan', category: 'coverage', where: t.requirementId, message: `${t.requirementId} (${t.priority}) has no plan step` });
      }
      if (!t.plannedTests.length) {
        add({ severity: t.priority === 'P0' ? 'HIGH' : 'MEDIUM', gate: 'plan', category: 'coverage', where: t.requirementId, message: `${t.requirementId} has no planned test` });
      }
    }
    if (!linked) {
      add({ severity: 'HIGH', gate: 'plan', category: 'consistency', message: 'Plan steps are not linked to requirement IDs, so coverage cannot be traced' });
    }
    for (const m of input.missingPlanFiles ?? []) {
      if (m.suggestion) {
        add({ severity: 'HIGH', gate: 'plan', category: 'consistency', where: m.file, message: `Planned file ${m.file} does not exist — did you mean ${m.suggestion}?` });
      } else if (!m.dirExists) {
        add({ severity: 'MEDIUM', gate: 'plan', category: 'consistency', where: m.file, message: `Planned file ${m.file} is in a folder that does not exist — check the path` });
      }
    }
    // Every repository in scope should be changed by at least one step ("<repo>:path").
    const planFiles = input.plan.steps.flatMap((s) => s.files);
    for (const repo of input.repos ?? []) {
      if (!planFiles.some((f) => f.startsWith(`${repo}:`))) {
        add({ severity: 'HIGH', gate: 'plan', category: 'scope', where: repo, message: `Repository "${repo}" is in scope but no plan step changes it — list its files as "${repo}:path/to/file"` });
      }
    }
    for (const s of input.plan.steps) {
      for (const rid of s.requirementIds.filter((x) => !ids.has(x))) {
        add({ severity: 'HIGH', gate: 'plan', category: 'consistency', where: s.id, message: `${s.id} refers to unknown requirement ${rid}` });
      }
      if (linked && !s.requirementIds.length) {
        add({ severity: 'MEDIUM', gate: 'plan', category: 'scope', where: s.id, message: `${s.id} is not linked to any requirement (possible scope creep)` });
      }
    }
  }

  // --- code vs plan
  if (input.facts.length) {
    const planText = (input.planText ?? '').toLowerCase();
    for (const f of input.facts) {
      for (const d of f.dependencies.added) {
        if (!planText.includes(d.name.toLowerCase())) {
          add({ severity: 'HIGH', gate: 'code-review', category: 'scope', where: `${f.repo}/package.json`, message: `New dependency "${d.name}" was not in the approved plan — check it before approving` });
        }
      }
    }
    const plannedFiles = (input.plan?.steps ?? []).flatMap((s) => s.files);
    if (plannedFiles.length) {
      const extra = new Set(input.repos ?? []);
      const forRepo = (repo: string) =>
        plannedFiles
          .map((p) => {
            const i = p.indexOf(':');
            const prefix = i > 0 ? p.slice(0, i) : '';
            if (prefix && extra.has(prefix)) return prefix === repo ? p.slice(i + 1) : undefined;
            return extra.has(repo) ? undefined : p;
          })
          .filter((p): p is string => !!p);
      const unplanned = input.facts.flatMap((f) =>
        f.files
          .filter((x) => !forRepo(f.repo).some((p) => x.path === p || x.path.endsWith(`/${p}`) || p.endsWith(`/${x.path}`) || (p.endsWith('/') && x.path.startsWith(p))))
          .filter((x) => !f.testFilesChanged.includes(x.path) && !/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(x.path))
          .map((x) => `${f.repo}:${x.path}`),
      );
      if (unplanned.length) {
        add({ severity: 'MEDIUM', gate: 'code-review', category: 'scope', message: `Files changed outside the plan: ${unplanned.slice(0, 8).join(', ')}${unplanned.length > 8 ? ` (+${unplanned.length - 8})` : ''}` });
      }
    }
  }
  const rank: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 50);
}
