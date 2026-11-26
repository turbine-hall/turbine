import type { AcceptanceCriterion, RequirementPriority } from '@turbine-hall/turbine-contracts';

/**
 * Model output is untrusted and varies between providers. These normalizers turn whatever
 * came back (new structured shapes or older free-form ones) into the fixed shapes the
 * packet renderer, traceability and analysis rely on.
 */

export type PlanStep = { id: string; description: string; requirementIds: string[]; files: string[] };
export type PlannedTest = { requirementId: string; test: string; kind: string };
export type PlanRisk = { risk: string; mitigation?: string };
export type PlanDiagram = { title: string; mermaid: string };
export type CodingAgentTokenEstimate = {
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  basis: string;
  confidence: 'estimated';
};
export type NormalizedPlan = {
  summary: string;
  architecture?: string;
  dataModel?: string;
  interfaces?: string;
  executiveSummary?: string;
  diagrams: PlanDiagram[];
  steps: PlanStep[];
  testPlan: PlannedTest[];
  risks: PlanRisk[];
  complexity?: string;
  codingAgentTokenEstimate?: CodingAgentTokenEstimate;
};

export type Fact = { text: string; source: string };
export type NormalizedAssessment = {
  facts: Fact[];
  assumptions: string[];
  questions: Array<{ text: string; why?: string }>;
};

export type FlowStep = { from: string; to: string; message: string };
export type RequestItem = { id: string; text: string };
export type RequestCoverage = { itemId: string; requirementIds: string[]; nonGoal?: string; question?: string };
export type NormalizedSpec = {
  summary: string;
  requirements: AcceptanceCriterion[];
  nonGoals: string[];
  userFlow: FlowStep[];
  requestItems: RequestItem[];
  requestCoverage: RequestCoverage[];
};

const EMPTY_REQUEST_BODY = /^\(No body provided\)$/i;

/**
 * Number every bullet / numbered line of the request (R1…Rn) so the spec writer must account
 * for each one, and analysis can flag anything silently dropped.
 * Continuation lines (constraints under a bullet) stay on the same item until the next bullet
 * or a markdown heading. Falls back to sentences, then the `# Title` heading.
 */
export function extractRequestItems(text: string): RequestItem[] {
  const items: RequestItem[] = [];
  const push = (raw: string) => {
    const t = raw.replace(/[*_`]/g, '').trim();
    if (t.length > 3 && !EMPTY_REQUEST_BODY.test(t)) items.push({ id: `R${items.length + 1}`, text: raw.trim() });
  };

  let current: string | null = null;
  const flush = () => {
    if (current != null) {
      push(current);
      current = null;
    }
  };
  for (const line of text.split('\n')) {
    const bullet = line.match(/^\s*(?:[*\-•]|\d+[.)])\s+(.+?)\s*$/);
    if (bullet) {
      flush();
      current = bullet[1]!.trimEnd();
      continue;
    }
    if (current == null) continue;
    // Heading ends the open list item (new section / title).
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      flush();
      continue;
    }
    if (!line.trim()) continue;
    current += `\n${line.trimEnd()}`;
  }
  flush();

  if (!items.length) {
    for (const sentence of text
      .replace(/^#.*$/gm, '')
      .split(/(?<=[.!?])\s+/)
      .map((x) => x.trim())
      .filter((x) => x.length > 12)) {
      push(sentence);
    }
  }
  if (!items.length) {
    const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (title) push(title);
  }
  return items.slice(0, 40);
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function normalizePriority(v: unknown, fallback: RequirementPriority = 'P1'): RequirementPriority {
  const s = str(v).toUpperCase();
  if (s === 'P0' || s === 'MUST' || s === 'CRITICAL' || s === 'HIGH') return 'P0';
  if (s === 'P2' || s === 'COULD' || s === 'LOW' || s === 'NICE') return 'P2';
  if (s === 'P1' || s === 'SHOULD' || s === 'MEDIUM') return 'P1';
  return fallback;
}

function normalizeKind(kind: unknown): AcceptanceCriterion['kind'] {
  const value = str(kind || 'behavioral').toLowerCase();
  if (value === 'behavioral' || value === 'technical' || value === 'nonfunctional') return value;
  if (/(tech|dependency|build|install|package|version)/.test(value)) return 'technical';
  if (/(non[-_ ]?func|performance|security|reliability)/.test(value)) return 'nonfunctional';
  return 'behavioral';
}

/** Requirements: keep given ids; new ids are FR-001…; default priority P1 (first item P0 if none given). */
export function normalizeRequirements(raw: unknown): AcceptanceCriterion[] {
  const items = arr(raw)
    .map((c, i) => {
      const o = (typeof c === 'object' && c ? c : { statement: c }) as Record<string, unknown>;
      const statement = str(o.statement ?? o.text ?? o.description ?? o.requirement);
      if (!statement) return null;
      return {
        id: str(o.id) || `FR-${String(i + 1).padStart(3, '0')}`,
        statement,
        kind: normalizeKind(o.kind),
        status: (o.status === 'confirmed' ? 'confirmed' : 'proposed') as AcceptanceCriterion['status'],
        priority: o.priority ? normalizePriority(o.priority) : undefined,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
  const anyPriority = items.some((c) => c.priority);
  return items.map((c, i) => ({ ...c, priority: c.priority ?? (anyPriority ? 'P1' : i === 0 ? 'P0' : 'P1') }));
}

export function normalizePlan(raw: unknown): NormalizedPlan {
  const o = (raw ?? {}) as Record<string, unknown>;
  const steps = arr(o.steps).map((s, i): PlanStep => {
    if (typeof s === 'string') return { id: `S${i + 1}`, description: s, requirementIds: [], files: [] };
    const x = (s ?? {}) as Record<string, unknown>;
    return {
      id: str(x.id) || `S${i + 1}`,
      description: str(x.description ?? x.step ?? x.text ?? x.title),
      requirementIds: arr(x.requirementIds ?? x.requirements ?? x.covers).map(str).filter(Boolean),
      files: arr(x.files ?? x.paths).map(str).filter(Boolean),
    };
  });
  const testPlan = arr(o.testPlan ?? o.tests).flatMap((t): PlannedTest[] => {
    if (typeof t === 'string') return [{ requirementId: '', test: t, kind: 'unit' }];
    const x = (t ?? {}) as Record<string, unknown>;
    const ids = arr(x.requirementIds).map(str).filter(Boolean);
    const one = str(x.requirementId ?? x.requirement);
    const test = str(x.test ?? x.description ?? x.name);
    const kind = str(x.kind ?? x.type) || 'unit';
    return (ids.length ? ids : [one]).map((requirementId) => ({ requirementId, test, kind }));
  });
  const risks = arr(o.risks).map((r): PlanRisk => {
    if (typeof r === 'string') return { risk: r };
    const x = (r ?? {}) as Record<string, unknown>;
    return { risk: str(x.risk ?? x.text ?? x.description), mitigation: str(x.mitigation) || undefined };
  });
  const diagrams = arr(o.diagrams)
    .map((d): PlanDiagram | null => {
      if (typeof d === 'string') {
        const mermaid = d.trim();
        if (!mermaid) return null;
        return { title: 'Change overview', mermaid };
      }
      const x = (d ?? {}) as Record<string, unknown>;
      const mermaid = str(x.mermaid ?? x.diagram ?? x.body);
      if (!mermaid) return null;
      return { title: str(x.title) || 'Change overview', mermaid };
    })
    .filter((d): d is PlanDiagram => d !== null);

  let codingAgentTokenEstimate: CodingAgentTokenEstimate | undefined;
  const rawEst = o.codingAgentTokenEstimate ?? o.tokenEstimate;
  if (rawEst && typeof rawEst === 'object') {
    const e = rawEst as Record<string, unknown>;
    const total = Number(e.totalTokens ?? e.total);
    const basis = str(e.basis ?? e.reason);
    if (Number.isFinite(total) && total > 0 && basis) {
      const inputTokens = Number(e.inputTokens ?? e.input);
      const outputTokens = Number(e.outputTokens ?? e.output);
      codingAgentTokenEstimate = {
        totalTokens: Math.round(total),
        inputTokens: Number.isFinite(inputTokens) && inputTokens > 0 ? Math.round(inputTokens) : undefined,
        outputTokens: Number.isFinite(outputTokens) && outputTokens > 0 ? Math.round(outputTokens) : undefined,
        basis,
        confidence: 'estimated',
      };
    }
  }

  return {
    summary: str(o.summary),
    architecture: str(o.architecture) || undefined,
    dataModel: str(o.dataModel ?? o.data_model ?? o.database) || undefined,
    interfaces: str(o.interfaces ?? o.apis) || undefined,
    executiveSummary: str(o.executiveSummary ?? o.executive_summary) || undefined,
    diagrams,
    steps: steps.filter((s) => s.description),
    testPlan: testPlan.filter((t) => t.test),
    risks: risks.filter((r) => r.risk),
    complexity: str(o.estimatedComplexity ?? o.complexity) || undefined,
    codingAgentTokenEstimate,
  };
}

export function normalizeAssessment(raw: unknown): NormalizedAssessment {
  const o = (raw ?? {}) as Record<string, unknown>;
  const facts = arr(o.facts).map((f): Fact => {
    if (typeof f === 'string') return { text: f, source: 'request' };
    const x = (f ?? {}) as Record<string, unknown>;
    return { text: str(x.text ?? x.fact), source: str(x.source) || 'request' };
  });
  return {
    facts: facts.filter((f) => f.text),
    assumptions: arr(o.assumptions).map((a) => (typeof a === 'string' ? a : str((a as Record<string, unknown>)?.text))).filter(Boolean),
    questions: arr(o.unknowns ?? o.questions).map((q) =>
      typeof q === 'string' ? { text: q } : { text: str((q as Record<string, unknown>)?.text), why: str((q as Record<string, unknown>)?.why) || undefined },
    ),
  };
}

export function normalizeSpec(raw: unknown, fallbackRequirements: AcceptanceCriterion[]): NormalizedSpec {
  const o = (raw ?? {}) as Record<string, unknown>;
  const reqs = normalizeRequirements(o.requirements ?? o.acceptanceCriteria);
  const flow = (o.userFlow ?? {}) as Record<string, unknown>;
  const steps = arr(flow.steps ?? o.userFlow).map((s) => {
    const x = (s ?? {}) as Record<string, unknown>;
    return { from: str(x.from), to: str(x.to), message: str(x.message ?? x.action) };
  });
  const requestItems = arr(o.requestItems)
    .map((x) => ({ id: str((x as Record<string, unknown>)?.id), text: str((x as Record<string, unknown>)?.text) }))
    .filter((x) => x.id && x.text);
  const requestCoverage = arr(o.requestCoverage).map((x): RequestCoverage => {
    const c = (x ?? {}) as Record<string, unknown>;
    return {
      itemId: str(c.itemId ?? c.item ?? c.id),
      requirementIds: arr(c.requirementIds ?? c.requirements).map(str).filter(Boolean),
      nonGoal: str(c.nonGoal) || undefined,
      question: str(c.question) || undefined,
    };
  }).filter((c) => c.itemId);
  return {
    summary: str(o.summary),
    requirements: reqs.length ? reqs : fallbackRequirements,
    nonGoals: arr(o.nonGoals).map(str).filter(Boolean),
    userFlow: steps.filter((s) => s.from && s.to && s.message),
    requestItems,
    requestCoverage,
  };
}
