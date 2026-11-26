import type { ModelAdapter } from './types.js';

/** Pull the `## NAME` block from a skill prompt (until the next `## ` heading). */
function promptSection(prompt: string, name: string): string {
  const parts = prompt.split(`## ${name}`);
  if (parts.length < 2) return '';
  return parts[1]!.split(/\n## /)[0] ?? '';
}

function short(text: string, max = 72): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Parse `- R1: …` lines; keep continuation lines until the next R-item or a `##` / JSON boundary. */
function parseRequestItems(prompt: string): Array<{ id: string; text: string }> {
  const items: Array<{ id: string; text: string }> = [];
  let cur: { id: string; text: string } | null = null;
  const flush = () => {
    if (cur) items.push({ id: cur.id, text: cur.text.trim() });
    cur = null;
  };
  for (const line of prompt.split('\n')) {
    const start = line.match(/^- (R\d+): (.*)$/);
    if (start) {
      flush();
      cur = { id: start[1]!, text: start[2]! };
      continue;
    }
    if (!cur) continue;
    if (/^##\s/.test(line) || /^\s*\{/.test(line) || /^REQUEST ITEMS/i.test(line)) {
      flush();
      continue;
    }
    if (!line.trim()) continue;
    cur.text += `\n${line}`;
  }
  flush();
  return items;
}

/** Prefer JSON `sourceText` from the spec-writer context; fall back to `## REQUEST`. */
function requestBody(prompt: string): string {
  const jsonHit = /"sourceText"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(prompt);
  if (jsonHit) {
    try {
      return JSON.parse(`"${jsonHit[1]}"`) as string;
    } catch {
      /* ignore malformed escape sequences from truncated prompts */
    }
  }
  return promptSection(prompt, 'REQUEST').trim();
}

function requestTitle(body: string, items: Array<{ text: string }>): string {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  if (items[0]?.text) return short(items[0].text, 80);
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !/^\(No body provided\)$/i.test(l));
  return line ? short(line, 80) : 'the requested change';
}

function earsFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  if (/^(WHEN|IF|THE SYSTEM SHALL)\b/i.test(t)) return t;
  return `WHEN “${short(t, 100)}” is requested THE SYSTEM SHALL deliver that outcome in an observable way`;
}

function mockAssessment(prompt: string) {
  const requestOnly = promptSection(prompt, 'REQUEST').toLowerCase() || prompt.toLowerCase();
  const body = requestBody(prompt) || promptSection(prompt, 'REQUEST');
  const items = parseRequestItems(prompt);
  const title = requestTitle(body, items);
  const seeds = (items.length ? items.map((i) => i.text) : [title]).filter(
    (t) => t && !/^\(No body provided\)$/i.test(t),
  );
  const proposed = (seeds.length ? seeds : [title]).slice(0, 6).map((text, i) => ({
    id: `ac_${i + 1}`,
    statement: earsFrom(text),
    kind: 'behavioral' as const,
    priority: i === 0 ? ('P0' as const) : ('P1' as const),
  }));
  if (proposed.length === 1) {
    proposed.push({
      id: 'ac_2',
      statement: `IF input for “${short(title, 60)}” is invalid THEN THE SYSTEM SHALL refuse it with an error message`,
      kind: 'behavioral',
      priority: 'P1',
    });
  }
  return {
    readiness: 'needs_clarification_or_ready',
    facts: [{ text: `Request received: ${short(title, 100)}`, source: 'request' }],
    assumptions: ['Existing authentication middleware remains unchanged unless specified'],
    unknowns: requestOnly.includes('auth') ? [] : ['Who is authorized to perform this action?'],
    proposedAcceptanceCriteria: proposed,
    nonGoals: ['Unrelated refactors'],
    riskHints: requestOnly.includes('auth') || requestOnly.includes('permission') ? ['auth-permissions'] : [],
  };
}

function mockSpecification(prompt: string) {
  const rawItems = parseRequestItems(prompt);
  const body = requestBody(prompt);
  const title = requestTitle(body, rawItems);
  const usable = rawItems.filter((i) => i.text && !/^\(No body provided\)$/i.test(i.text));
  const seeds = usable.length ? usable : [{ id: 'R1', text: title }];
  const retained = seeds.slice(0, 8);

  const requirements = retained.map((item, i) => ({
    id: `FR-${String(i + 1).padStart(3, '0')}`,
    priority: i < 2 ? ('P0' as const) : ('P1' as const),
    kind: 'behavioral' as const,
    statement: earsFrom(item.text),
    status: 'proposed' as const,
  }));
  if (requirements.length === 1) {
    requirements.push({
      id: 'FR-002',
      priority: 'P1',
      kind: 'behavioral',
      statement: `IF input for “${short(title, 60)}” is invalid THEN THE SYSTEM SHALL refuse it with an error message`,
      status: 'proposed',
    });
  }

  // Only map seeds that produced a real FR — overflow items are explicit non-goals, never ghost IDs.
  const frBySeed = new Map(retained.map((s, i) => [s.id, `FR-${String(i + 1).padStart(3, '0')}`]));
  const coverageSource = rawItems.length ? rawItems : seeds;
  const requestCoverage = coverageSource.map((item) => {
    if (/^\(No body provided\)$/i.test(item.text)) {
      return { itemId: item.id, requirementIds: [] as string[], nonGoal: 'Empty request body — title used as the requirement seed' };
    }
    const fr = frBySeed.get(item.id);
    if (fr) return { itemId: item.id, requirementIds: [fr] };
    if (seeds.some((s) => s.id === item.id)) {
      return { itemId: item.id, requirementIds: [] as string[], nonGoal: 'Beyond mock FR cap (8) — review and promote if needed' };
    }
    return { itemId: item.id, requirementIds: requirements[0] ? [requirements[0].id] : [] };
  });

  const lead = seeds[0]?.text ?? title;
  return {
    summary: `Deliver “${short(title, 80)}”: ${short(seeds.map((s) => s.text).join('; '), 160)}.`,
    requirements,
    nonGoals: ['Drive-by refactors'],
    userFlow: {
      steps: [
        { from: 'User', to: 'App', message: `requests: ${short(title, 48)}` },
        { from: 'App', to: 'API', message: `handles: ${short(lead, 48)}` },
        { from: 'App', to: 'User', message: 'shows the observable result' },
      ],
    },
    testIntent: requirements.slice(0, 4).map((r) => `Cover ${r.id}`),
    requestCoverage,
  };
}

export function createMockModelAdapter(id = 'mock-default'): ModelAdapter {
  return {
    id,
    provider: 'mock',
    capabilities: {
      text: true,
      structuredOutput: true,
      toolCalling: false,
      maxContextTokens: 128000,
    },
    async run(request) {
      if (request.schemaId === 'healthcheck') {
        return {
          content: { ok: true, message: 'pong' },
          usage: { inputTokens: 1, outputTokens: 1 },
          providerRequestId: `mock_${Date.now()}`,
        };
      }
      if (request.schemaId === 'assessment' || request.skillIds.includes('core/assess-requirements')) {
        return {
          content: mockAssessment(request.prompt),
          usage: { inputTokens: 100, outputTokens: 200 },
          providerRequestId: `mock_${Date.now()}`,
        };
      }

      if (request.schemaId === 'specification' || request.skillIds.includes('core/write-specification')) {
        return {
          content: mockSpecification(request.prompt),
          usage: { inputTokens: 120, outputTokens: 260 },
          providerRequestId: `mock_${Date.now()}`,
        };
      }

      if (
        request.schemaId === 'plan' ||
        request.skillIds.includes('core/plan-change') ||
        request.skillIds.includes('core/plan-executive-summary')
      ) {
        const ids = [...request.prompt.matchAll(/^- ([A-Za-z]+[-_]\w+) \(P[012]\):/gm)].map((m) => m[1]!);
        const reqIds = ids.length ? ids : ['FR-001'];
        const steps = [
          { id: 'S1', description: 'Implement the main behaviour', requirementIds: [reqIds[0]!], files: ['src/'] },
          ...(reqIds.length > 1
            ? [{ id: 'S2', description: 'Handle the remaining requirements', requirementIds: reqIds.slice(1), files: ['src/'] }]
            : []),
          { id: `S${reqIds.length > 1 ? 3 : 2}`, description: 'Add tests', requirementIds: reqIds, files: ['test/'] },
        ];
        const fileCount = new Set(steps.flatMap((s) => s.files)).size;
        const totalTokens = 50_000 + 15_000 * steps.length + 5_000 * fileCount;
        return {
          content: {
            summary: 'Bounded implementation plan',
            architecture: 'Keep existing module boundaries; extend the touched packages only.',
            dataModel: 'no data model change',
            interfaces: 'no interface change',
            executiveSummary:
              'This change implements the approved requirements with a small, bounded set of file edits and matching tests. Scope stays inside the listed repositories.',
            diagrams: [
              {
                title: 'Change overview',
                mermaid: ['flowchart LR', '  spec[ApprovedSpec] --> plan[DetailedPlan]', '  plan --> code[CodingAgent]', '  code --> review[HumanReview]'].join(
                  '\n',
                ),
              },
            ],
            steps,
            testPlan: reqIds.map((id) => ({ requirementId: id, test: `Test for ${id}`, kind: 'unit' })),
            risks: [{ risk: 'Mock plan — no real repository analysis', mitigation: 'Review the diff carefully' }],
            estimatedComplexity: 'low',
            codingAgentTokenEstimate: {
              totalTokens,
              inputTokens: Math.round(totalTokens * 0.7),
              outputTokens: Math.round(totalTokens * 0.3),
              basis: `low base 50000 + 15000×${steps.length} steps + 5000×${fileCount} files`,
              confidence: 'estimated',
            },
          },
          usage: { inputTokens: 140, outputTokens: 220 },
          providerRequestId: `mock_${Date.now()}`,
        };
      }

      if (request.schemaId === 'review' || request.skillIds.includes('core/review-change')) {
        // Mock reviewer: one low-severity note on the first changed file (no quote), no claims.
        const files = request.prompt.match(/CHANGED FILES:\n((?: {2}\S+ .+\n?)+)/);
        const first = files?.[1]?.split('\n')[0]?.trim().split(/\s+/).slice(1).join(' ');
        return {
          content: {
            findings: first
              ? [{ severity: 'low', claim: 'Mock review: confirm this file matches the plan', file: first }]
              : [],
            claims: { dependenciesAdded: [], testFilesChanged: [] },
            coverage: (() => {
              const tests = request.prompt.match(/TEST FILES CHANGED: (.+)/)?.[1];
              if (!tests || tests === 'none') return [];
              const first = tests.split(',')[0]!.trim();
              return [...request.prompt.matchAll(/^- ([A-Za-z]+[-_]\w+) \(P[012]\):/gm)].map((m) => ({ requirementId: m[1], testFile: first }));
            })(),
            summary: 'Mock review of the diff.',
          },
          usage: { inputTokens: 150, outputTokens: 120 },
          providerRequestId: `mock_${Date.now()}`,
        };
      }

      if (request.schemaId === 'implement' || request.skillIds.includes('core/execute-code-change')) {
        return {
          content: {
            summary: 'Mock implementation guidance',
            filesTouched: ['README.md'],
            testCommands: ['pnpm test'],
            notes: [
              'Mock provider does not modify the repository; supervised/manual mode expected.',
            ],
          },
          usage: { inputTokens: 160, outputTokens: 180 },
          providerRequestId: `mock_${Date.now()}`,
        };
      }

      if (request.schemaId === 'project-brief' || request.skillIds.includes('core/draft-project-brief')) {
        // Propose one true claim (package.json exists) and one planted-false claim. Only the true one verifies.
        const section = /## SECTION\n([a-z][a-z0-9-]{0,39})/.exec(request.prompt)?.[1] ?? 'architecture';
        const commit = /## COMMIT\n([0-9a-f]{40,64})/.exec(request.prompt)?.[1] ?? '0'.repeat(40);
        const blob = /path=package\.json blob=([0-9a-f]{40,64})/.exec(request.prompt)?.[1] ?? '1'.repeat(40);
        const idBase = section.replace(/[^a-z0-9]/g, '').slice(0, 12) || 'sec';
        return {
          content: {
            claims: [
              {
                id: `mock-${idBase}-pkg`,
                section,
                statement: 'package.json is tracked',
                kind: 'exists',
                evidence: [{ path: 'package.json', commit, blob }],
                verifier: { kind: 'exists', path: 'package.json' },
              },
              {
                id: `mock-${idBase}-false`,
                section,
                statement: 'Planted false path',
                kind: 'exists',
                evidence: [{ path: 'planted-missing.ts', commit, blob: 'a'.repeat(40) }],
                verifier: { kind: 'exists', path: 'planted-missing.ts' },
              },
            ],
          },
          usage: { inputTokens: 80, outputTokens: 120 },
          providerRequestId: `mock_${Date.now()}`,
        };
      }

      return {
        content: { ok: true, echo: request.prompt.slice(0, 200) },
        usage: { inputTokens: 10, outputTokens: 10 },
        providerRequestId: `mock_${Date.now()}`,
      };
    },
  };
}
