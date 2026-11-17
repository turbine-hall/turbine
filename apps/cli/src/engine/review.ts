import type { WorkPackage } from '@turbine-hall/turbine-contracts';
import type { RepoFacts } from './changeset.js';

/**
 * Diff-grounded AI review with deterministic triage (modelled on BMad's review lenses +
 * triage and Superpowers' "check the agent's claims against the diff").
 *
 * The model proposes findings; the engine keeps only findings it can tie to the actual
 * change (a changed file, and quoted code that really is in the diff). Structured claims
 * the model makes about the change (dependencies added, tests added) are checked against
 * git facts. The review is advisory: it never approves or changes the task's state.
 */
export type Lens = 'spec-compliance' | 'tests' | 'security';

export const LENS_INSTRUCTIONS: Record<Lens, string> = {
  'spec-compliance':
    'LENS: spec compliance. Check each acceptance criterion against the diff. Report criteria that are not implemented, implemented differently, or scope the spec did not ask for.',
  tests:
    'LENS: tests. Check whether the change is covered by tests in the diff. Report untested behaviour that the acceptance criteria require, and tests that do not test what they claim.',
  security:
    'LENS: security. Check the diff for injection, unsafe parsing of untrusted input (uploads, files), missing authorization, secrets, and risky new dependencies.',
};

/** Lenses follow the selected roles: code-reviewer → spec + tests; security-reviewer → security. */
export function selectLenses(work: WorkPackage, _facts: RepoFacts[]): Lens[] {
  const lenses: Lens[] = ['spec-compliance', 'tests'];
  if (work.selectedRoles.some((r) => r.id === 'security-reviewer')) lenses.push('security');
  return lenses;
}

export const REVIEW_OUTPUT_CONTRACT = [
  'Return JSON: {"findings":[{"severity":"high|medium|low","claim":"...","file":"path as shown in CHANGED FILES","line":123,"quote":"exact code copied from the diff"}],',
  '"claims":{"dependenciesAdded":["names you believe this change adds"],"testFilesChanged":["test files you believe changed"]},',
  '"coverage":[{"requirementId":"FR-001","testFile":"path of a CHANGED test file that tests it"}],',
  '"summary":"two sentences max"}.',
  'coverage: only for test files listed under TEST FILES CHANGED; omit requirements no changed test covers.',
  'Every finding MUST cite a file from CHANGED FILES and SHOULD quote the exact code from the diff.',
  'Findings without a changed file, or with a quote that is not in the diff, are discarded automatically.',
  'Zero findings is a valid answer. Do not restate the plan; review the code.',
].join(' ');

export function factsBlock(facts: RepoFacts[]): string {
  return facts
    .map((f) =>
      [
        `REPO ${f.repo} (${f.baseCommit.slice(0, 8)}..${f.headCommit.slice(0, 8)}, +${f.insertions}/-${f.deletions})`,
        'CHANGED FILES:',
        ...f.files.map((x) => `  ${x.status} ${x.path}`),
        `DEPENDENCIES ADDED: ${f.dependencies.added.map((d) => d.name).join(', ') || 'none'}`,
        `DEPENDENCIES CHANGED: ${f.dependencies.changed.map((d) => `${d.name} ${d.from}->${d.to}`).join(', ') || 'none'}`,
        `TEST FILES CHANGED: ${f.testFilesChanged.join(', ') || 'none'}`,
      ].join('\n'),
    )
    .join('\n\n');
}

export type Finding = {
  id: string;
  lens: Lens;
  severity: 'high' | 'medium' | 'low';
  claim: string;
  file: string;
  repo?: string;
  line?: number;
  quote?: string;
};
export type DiscardedFinding = { lens: Lens; claim: string; file?: string; reason: string };
export type ClaimMismatch = { claim: string; reason: string };

function changedPathIndex(facts: RepoFacts[]): Array<{ repo: string; path: string }> {
  return facts.flatMap((f) => f.files.filter((x) => x.status !== 'D').map((x) => ({ repo: f.repo, path: x.path })));
}

function matchFile(cited: string, index: Array<{ repo: string; path: string }>) {
  const c = cited.replace(/^[ab]\//, '').replace(/^\.\//, '').trim();
  const [maybeRepo, ...rest] = c.split(':');
  return (
    index.find((x) => x.path === c) ??
    (rest.length ? index.find((x) => x.repo === maybeRepo && x.path === rest.join(':')) : undefined) ??
    index.find((x) => c.endsWith(`/${x.path}`) || x.path.endsWith(`/${c}`))
  );
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim();

/** Lines added or kept in the diff (without +/- markers), whitespace-normalised. */
function diffCorpus(diffText: string): string {
  return norm(
    diffText
      .split('\n')
      .filter((l) => !l.startsWith('+++') && !l.startsWith('---') && !l.startsWith('@@') && !l.startsWith('diff '))
      .map((l) => (l.startsWith('+') || l.startsWith('-') || l.startsWith(' ') ? l.slice(1) : l))
      .join('\n'),
  );
}

export function triage(input: {
  lens: Lens;
  raw: unknown;
  facts: RepoFacts[];
  diffText: string;
  startIndex: number;
}): { findings: Finding[]; discarded: DiscardedFinding[] } {
  const index = changedPathIndex(input.facts);
  const corpus = diffCorpus(input.diffText);
  const list = Array.isArray((input.raw as { findings?: unknown })?.findings)
    ? ((input.raw as { findings: unknown[] }).findings)
    : [];
  const findings: Finding[] = [];
  const discarded: DiscardedFinding[] = [];
  let n = input.startIndex;
  for (const item of list) {
    const f = (typeof item === 'object' && item ? item : { claim: String(item) }) as Record<string, unknown>;
    const claim = String(f.claim ?? f.description ?? f.fact ?? '').trim();
    const file = typeof f.file === 'string' ? f.file : undefined;
    if (!claim) continue;
    if (!file) {
      discarded.push({ lens: input.lens, claim, reason: 'no changed file cited' });
      continue;
    }
    const hit = matchFile(file, index);
    if (!hit) {
      discarded.push({ lens: input.lens, claim, file, reason: 'cited file is not part of this change' });
      continue;
    }
    const quote = typeof f.quote === 'string' && f.quote.trim() ? f.quote : undefined;
    if (quote && !corpus.includes(norm(quote))) {
      discarded.push({ lens: input.lens, claim, file, reason: 'quoted code does not appear in the diff' });
      continue;
    }
    const sev = String(f.severity ?? 'medium').toLowerCase();
    findings.push({
      id: `F${++n}`,
      lens: input.lens,
      severity: sev === 'high' || sev === 'critical' ? 'high' : sev === 'low' ? 'low' : 'medium',
      claim,
      file: hit.path,
      repo: hit.repo,
      line: Number.isFinite(Number(f.line)) && Number(f.line) > 0 ? Number(f.line) : undefined,
      quote,
    });
  }
  return { findings, discarded };
}

/** Compare structured claims the model made with what git says actually changed. */
export function crossCheckClaims(raw: unknown, facts: RepoFacts[]): ClaimMismatch[] {
  const claims = ((raw as { claims?: Record<string, unknown> })?.claims ?? {}) as Record<string, unknown>;
  const out: ClaimMismatch[] = [];
  const realDeps = new Set(facts.flatMap((f) => [...f.dependencies.added, ...f.dependencies.changed].map((d) => d.name)));
  for (const d of Array.isArray(claims.dependenciesAdded) ? claims.dependenciesAdded : []) {
    const name = String(d).trim();
    if (name && !realDeps.has(name)) {
      out.push({ claim: `adds dependency "${name}"`, reason: 'no package.json in this change adds or changes it' });
    }
  }
  const realTests = new Set(facts.flatMap((f) => f.testFilesChanged));
  const claimedTests = claims.testFilesChanged;
  if (claimedTests === true && realTests.size === 0) {
    out.push({ claim: 'tests were added/changed', reason: 'no test files changed in this diff' });
  }
  for (const t of Array.isArray(claimedTests) ? claimedTests : []) {
    const p = String(t).trim();
    if (p && ![...realTests].some((x) => x === p || x.endsWith(`/${p}`) || p.endsWith(`/${x}`))) {
      out.push({ claim: `test file "${p}" changed`, reason: 'not among the changed test files' });
    }
  }
  return out;
}

export type CoverageLink = { requirementId: string; testFile: string; repo: string };

/** Keep only coverage links whose test file really changed and whose requirement exists. */
export function validateCoverage(
  raw: unknown,
  facts: RepoFacts[],
  requirementIds: string[],
): { links: CoverageLink[]; rejected: DiscardedFinding[] } {
  const list = Array.isArray((raw as { coverage?: unknown })?.coverage) ? (raw as { coverage: unknown[] }).coverage : [];
  const tests = facts.flatMap((f) => f.testFilesChanged.map((p) => ({ repo: f.repo, path: p })));
  const links: CoverageLink[] = [];
  const rejected: DiscardedFinding[] = [];
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    const req = String(o.requirementId ?? '').trim();
    const file = String(o.testFile ?? '').trim().replace(/^[ab]\//, '');
    if (!req || !file) continue;
    if (!requirementIds.includes(req)) {
      rejected.push({ lens: 'tests', claim: `${file} tests ${req}`, file, reason: 'unknown requirement id' });
      continue;
    }
    const hit = tests.find((t) => t.path === file || t.path.endsWith(`/${file}`) || file.endsWith(`/${t.path}`));
    if (!hit) {
      rejected.push({ lens: 'tests', claim: `${file} tests ${req}`, file, reason: 'test file not changed in this diff' });
      continue;
    }
    if (!links.some((l) => l.requirementId === req && l.testFile === hit.path)) {
      links.push({ requirementId: req, testFile: hit.path, repo: hit.repo });
    }
  }
  return { links, rejected };
}

export type ReviewResult = {
  changeSetId: string;
  lenses: Lens[];
  findings: Finding[];
  discarded: DiscardedFinding[];
  claimMismatches: ClaimMismatch[];
  summaries: Array<{ lens: Lens; summary: string }>;
  truncatedRepos: string[];
  /** Requirement → test links proposed by the tests lens and verified against changed test files. */
  coverage?: CoverageLink[];
  disposition: 'no-blocking-findings' | 'needs-attention';
};

export function disposition(findings: Finding[], mismatches: ClaimMismatch[]): ReviewResult['disposition'] {
  return findings.some((f) => f.severity === 'high') || mismatches.length > 0 ? 'needs-attention' : 'no-blocking-findings';
}
