import type { RiskProfile, SelectedRole, WorkPackage, WorkType } from '@turbine-hall/turbine-contracts';

/**
 * Adaptive Role Selection Policy (framework §6).
 *
 * The profile is the MAXIMUM of: deterministic hard triggers, the model's recommendation,
 * a human-set minimum, and observed evidence (failed checks, new dependencies). Nothing in
 * here can lower a profile someone else raised — downgrades are disabled in v0.1.
 */
export type RoleSelectionResult = {
  profile: RiskProfile;
  roles: SelectedRole[];
  omitted: Array<{ id: string; reason: string }>;
  hardTriggers: string[];
  softTriggers: string[];
  explanation: string;
  /** Which input decided the profile. */
  profileSource: 'rules' | 'model' | 'human-minimum' | 'observed' | 'default';
};

const ALL_ROLES = [
  'requirements-analyst', 'spec-writer', 'project-manager', 'architect', 'ux-designer',
  'frontend-developer', 'backend-developer', 'database-engineer', 'unit-tester',
  'code-quality-checker', 'code-reviewer', 'test-case-sqa', 'api-sqa', 'e2e-sqa',
  'security-reviewer', 'release-engineer', 'task-decomposer',
] as const;

const RANK: Record<RiskProfile, number> = { lightweight: 0, standard: 1, comprehensive: 2 };
export const maxProfile = (...p: Array<RiskProfile | undefined>): RiskProfile =>
  p.filter((x): x is RiskProfile => !!x).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'lightweight' as RiskProfile);

/**
 * Hard triggers force the comprehensive profile (framework §6.3 mandatory overrides, plus
 * untrusted file parsing). Word boundaries avoid matches inside other words ("build" ≠ "ui").
 */
export const HARD_TRIGGERS: Record<string, RegExp> = {
  'auth-permissions': /\b(auth|authn|authz|authentication|authori[sz]ation|authori[sz]ed|permissions?|sessions?|rbac|oauth|sso|login|logout|sign[- ]?in|roles?|access control)\b/i,
  'data-migration': /\b(migrat(e|ion|ions|ing)|schema change|drop table|alter table|delete from|backfill)\b/i,
  payments: /\b(payments?|billing|invoices?|refunds?|checkout (page|flow|process)|stripe|financial)\b/i,
  'sensitive-data': /\b(secrets?|pii|personal data|passwords?|api[- ]?keys?|credentials?|tokens?|gdpr)\b/i,
  'file-upload': /\b(uploads?|uploaded|uploading|attach(es|ed|ing|ments?)?|multipart|file input|(add|import|attach) (a |an |the )?(doc|document|docx|pdf|word|excel|file|spreadsheet|csv|xlsx)( files?)?|doc(ument)? files?|spreadsheets?|xlsx|docx|pdf parsing|parse (pdf|csv|xlsx|docx?|files?))\b/i,
};

/** Soft triggers add specialists without forcing comprehensive. */
export const SOFT_TRIGGERS: Record<string, RegExp> = {
  'untrusted-input': /\b(webhooks?|third[- ]party api|external api|scrap(e|ing)|user[- ]supplied|untrusted|deseriali[sz]|eval)\b/i,
  'data-deletion': /\b(delet(e|es|ed|ing|ion)|remove records?|purge|hard delete|soft delete)\b/i,
  'new-dependency': /\b(new (npm )?(dependency|dependencies|package|library)|add(ing)? (the )?(package|library|dependency))\b/i,
};

function textBlob(work: WorkPackage, extra = ''): string {
  return [work.title, work.objective, work.why ?? '', ...work.acceptanceCriteria.map((c) => c.statement), ...work.constraints, ...work.unknowns, extra].join('\n');
}

export function detectHardRiskTriggers(work: WorkPackage, extraContext = ''): string[] {
  const text = textBlob(work, extraContext);
  return Object.entries(HARD_TRIGGERS).filter(([, re]) => re.test(text)).map(([k]) => k);
}

export function detectSoftTriggers(work: WorkPackage, extraContext = ''): string[] {
  const text = textBlob(work, extraContext);
  return Object.entries(SOFT_TRIGGERS).filter(([, re]) => re.test(text)).map(([k]) => k);
}

function baseRolesForType(type: WorkType): string[] {
  switch (type) {
    case 'bug':
      return ['requirements-analyst', 'code-quality-checker', 'code-reviewer'];
    case 'migration':
      return ['requirements-analyst', 'spec-writer', 'database-engineer', 'backend-developer', 'code-reviewer', 'test-case-sqa'];
    case 'investigation':
      return ['requirements-analyst', 'architect'];
    case 'maintenance':
      return ['requirements-analyst', 'code-quality-checker', 'code-reviewer'];
    default:
      return ['requirements-analyst', 'spec-writer', 'project-manager', 'code-quality-checker', 'code-reviewer', 'test-case-sqa'];
  }
}

const SURFACES: Record<string, RegExp> = {
  frontend: /\b(frontend|front[- ]end|ui|ux|react|next\.?js|vue|svelte|css|tailwind|buttons?|pages?|components?|forms?|modals?|screens?|inbox|dashboard|navigat\w*)\b/i,
  backend: /\b(api|endpoints?|backend|back[- ]end|services?|server|controllers?|routes?|graphql|rest)\b/i,
  database: /\b(database|db|sql|schema|migrations?|tables?|prisma|orm|indexes)\b/i,
};

function detectSurfaces(work: WorkPackage, extraContext = ''): string[] {
  const text = textBlob(work, extraContext);
  const s = Object.entries(SURFACES).filter(([, re]) => re.test(text)).map(([k]) => k);
  return s.length ? s : ['backend'];
}

export function selectRoles(input: {
  work: WorkPackage;
  extraContext?: string;
  failedChecks?: string[];
  /** Human-set minimum (can only raise). */
  forceProfile?: RiskProfile;
  /** Model's recommended profile from assessment (can only raise). */
  modelProfile?: RiskProfile;
  /** Risk hints from the model, e.g. "file-upload"; known ones are treated like triggers. */
  modelHints?: string[];
  /** Observed facts, e.g. dependencies added by the change. */
  observed?: { dependenciesAdded?: string[] };
}): RoleSelectionResult {
  const hints = (input.modelHints ?? []).map((h) => h.toLowerCase());
  const hardTriggers = [...new Set([...detectHardRiskTriggers(input.work, input.extraContext), ...hints.filter((h) => h in HARD_TRIGGERS)])];
  const softTriggers = [...new Set([...detectSoftTriggers(input.work, input.extraContext), ...hints.filter((h) => h in SOFT_TRIGGERS)])];
  if (input.observed?.dependenciesAdded?.length && !softTriggers.includes('new-dependency')) softTriggers.push('new-dependency');
  const surfaces = detectSurfaces(input.work, input.extraContext);

  // Rules-based profile
  let rulesProfile: RiskProfile = 'standard';
  if (hardTriggers.length) rulesProfile = 'comprehensive';
  else if (
    (input.work.type === 'bug' || input.work.type === 'maintenance') &&
    surfaces.length === 1 &&
    input.work.acceptanceCriteria.length <= 2 &&
    !softTriggers.length
  ) {
    rulesProfile = 'lightweight';
  }
  const observedProfile: RiskProfile | undefined =
    (input.failedChecks?.length ?? 0) > 0 || softTriggers.includes('new-dependency') ? 'standard' : undefined;
  const profile = maxProfile(rulesProfile, input.modelProfile, input.forceProfile, observedProfile);
  const profileSource: RoleSelectionResult['profileSource'] =
    profile === rulesProfile && (hardTriggers.length || profile !== 'standard')
      ? 'rules'
      : profile === input.forceProfile
        ? 'human-minimum'
        : profile === input.modelProfile
          ? 'model'
          : profile === observedProfile
            ? 'observed'
            : profile === rulesProfile
              ? 'rules'
              : 'default';

  const why = new Map<string, string>();
  const add = (id: string, reason: string) => {
    if (!why.has(id)) why.set(id, reason);
  };
  for (const r of baseRolesForType(input.work.type)) add(r, `baseline for ${input.work.type}`);
  if (surfaces.includes('frontend')) add('frontend-developer', 'frontend surface');
  if (surfaces.includes('backend')) add('backend-developer', 'backend surface');
  if (surfaces.includes('database')) add('database-engineer', 'database surface');
  if (surfaces.includes('frontend') && profile !== 'lightweight') add('ux-designer', 'user-facing change');
  if (surfaces.includes('backend') && profile !== 'lightweight') add('api-sqa', 'API change');

  if (profile === 'comprehensive') {
    add('architect', 'comprehensive profile');
    add('security-reviewer', 'comprehensive profile');
    add('test-case-sqa', 'comprehensive profile');
  }
  if (hardTriggers.includes('auth-permissions')) {
    add('security-reviewer', 'auth/permissions change');
    add('api-sqa', 'auth boundaries need API tests');
  }
  if (hardTriggers.includes('data-migration')) {
    add('database-engineer', 'data migration');
    add('architect', 'data migration');
  }
  if (hardTriggers.includes('payments')) add('security-reviewer', 'payments');
  if (hardTriggers.includes('sensitive-data')) add('security-reviewer', 'sensitive data');
  if (hardTriggers.includes('file-upload')) {
    add('security-reviewer', 'parses untrusted uploaded files');
    add('test-case-sqa', 'file inputs need negative/boundary cases');
  }
  if (softTriggers.includes('untrusted-input')) add('security-reviewer', 'untrusted input');
  if (softTriggers.includes('data-deletion')) add('test-case-sqa', 'deletion needs negative cases (confirm, permissions, undo)');
  if (softTriggers.includes('new-dependency')) add('security-reviewer', `new dependency${input.observed?.dependenciesAdded?.length ? `: ${input.observed.dependenciesAdded.join(', ')}` : ''}`);

  for (const fail of input.failedChecks ?? []) {
    const f = fail.toLowerCase();
    if (/\bsecurity|audit\b/.test(f)) add('security-reviewer', `failed check: ${fail}`);
    if (/\bapi\b/.test(f)) add('api-sqa', `failed check: ${fail}`);
    if (/\b(e2e|ui)\b/.test(f)) add('e2e-sqa', `failed check: ${fail}`);
    if (/\b(schema|migration)\b/.test(f)) add('database-engineer', `failed check: ${fail}`);
    if (/\b(test|unit)\b/.test(f)) add('unit-tester', `failed check: ${fail}`);
  }
  if (input.work.type !== 'investigation') add('code-quality-checker', 'deterministic checks');
  // Always selected: runs automatically before execute to open small PRs per subtask.
  add('task-decomposer', 'pre-execution decomposition');

  // Lightweight: drop optional specialists, but never anything a trigger asked for.
  if (profile === 'lightweight') {
    for (const id of ['ux-designer', 'api-sqa', 'project-manager', 'spec-writer']) {
      if (why.get(id)?.startsWith('baseline') || why.get(id)?.includes('surface') || why.get(id)?.startsWith('user-facing') || why.get(id)?.startsWith('API change')) why.delete(id);
    }
  }

  const roles: SelectedRole[] = [...why.entries()].map(([id, reason]) => ({
    id,
    version: '0.1.0',
    why: `${reason} (profile=${profile})`,
    mode: id === 'code-quality-checker' ? 'tool' : 'ai',
  }));
  const omitted = ALL_ROLES.filter((id) => !why.has(id)).map((id) => ({
    id,
    reason: `not required: profile=${profile}, surfaces=${surfaces.join('+')}${hardTriggers.length ? `, triggers=${hardTriggers.join('+')}` : ''}`,
  }));
  return {
    profile,
    roles,
    omitted,
    hardTriggers,
    softTriggers,
    profileSource,
    explanation: `ARSP: ${roles.length} roles at ${profile} (decided by ${profileSource}; hard triggers: ${hardTriggers.join(', ') || 'none'}; soft: ${softTriggers.join(', ') || 'none'}).`,
  };
}
