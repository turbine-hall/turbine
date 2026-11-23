import type { ModelAdapter } from './types.js';

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
        // Decide only from the request itself, not the skill text around it.
        const requestOnly = (request.prompt.split('## REQUEST')[1] ?? request.prompt).split('\n## ')[0]!.toLowerCase();
        return {
          content: {
            readiness: 'needs_clarification_or_ready',
            facts: [{ text: 'Request received and normalized', source: 'request' }],
            assumptions: ['Existing authentication middleware remains unchanged unless specified'],
            unknowns: requestOnly.includes('auth')
              ? []
              : ['Who is authorized to perform this action?'],
            proposedAcceptanceCriteria: [
              {
                id: 'ac_1',
                statement: 'The described behavior is observable via API or UI as specified',
                kind: 'behavioral',
              },
              {
                id: 'ac_2',
                statement: 'Unauthorized callers receive an appropriate error response',
                kind: 'behavioral',
              },
            ],
            nonGoals: ['Unrelated refactors'],
            riskHints: requestOnly.includes('auth') || requestOnly.includes('permission')
              ? ['auth-permissions']
              : [],
          },
          usage: { inputTokens: 100, outputTokens: 200 },
          providerRequestId: `mock_${Date.now()}`,
        };
      }

      if (request.schemaId === 'specification' || request.skillIds.includes('core/write-specification')) {
        return {
          content: {
            summary: 'Users get the requested behaviour; invalid input is refused.',
            requirements: [
              {
                id: 'FR-001',
                priority: 'P0',
                kind: 'behavioral',
                statement: 'WHEN a user performs the requested action THE SYSTEM SHALL complete it and show the result',
                status: 'proposed',
              },
              {
                id: 'FR-002',
                priority: 'P1',
                kind: 'behavioral',
                statement: 'IF the input is invalid THEN THE SYSTEM SHALL refuse it with an error message',
                status: 'proposed',
              },
            ],
            nonGoals: ['Drive-by refactors'],
            userFlow: {
              steps: [
                { from: 'User', to: 'App', message: 'requests the action' },
                { from: 'App', to: 'API', message: 'checks permission and performs it' },
                { from: 'App', to: 'User', message: 'shows the result' },
              ],
            },
            testIntent: ['Unit tests for core logic', 'Negative test for unauthorised access'],
            requestCoverage: [...request.prompt.matchAll(/^- (R\d+): /gm)].map((m) => ({ itemId: m[1], requirementIds: ['FR-001'] })),
          },
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
