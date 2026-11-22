import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ContextBudgetSchema, DEFAULT_CONTEXT_BUDGET, err, type ContextBudget } from '@turbine-hall/turbine-contracts';

export type RoleManifest = {
  id: string;
  version: string;
  responsibility: string;
  inputs: string[];
  skills: { required: string[]; optional: string[] };
  capabilities: { required: string[]; prohibited: string[] };
  outputs: string[];
  model_policy: string;
  max_attempts: number;
  escalates_on: string[];
  /**
   * Optional size limit for the task context this role reads (files listed, characters of the list).
   * Absent means DEFAULT_CONTEXT_BUDGET.
   */
  context_budget?: ContextBudget;
  /**
   * Optional brief sections this role needs (e.g. security-reviewer → ["security"]).
   * Absent means the role does not declare a preference; the project default sections still apply.
   */
  brief_sections?: string[];
};

/** A malformed `context_budget` is an error, not a silent fallback to the default: the limit is a promise. */
function checkBudget(role: RoleManifest, file: string): RoleManifest {
  if (role.context_budget === undefined) return role;
  const parsed = ContextBudgetSchema.safeParse(role.context_budget);
  if (!parsed.success) {
    throw err('E_INVALID_CONFIG', `roles/${file}: context_budget must be {maxFiles: 1-200, maxChars: 500-100000} (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`);
  }
  return { ...role, context_budget: parsed.data };
}

function checkBriefSections(role: RoleManifest, file: string): RoleManifest {
  if (role.brief_sections === undefined) return role;
  if (!Array.isArray(role.brief_sections) || role.brief_sections.length === 0 || role.brief_sections.length > 32) {
    throw err('E_INVALID_CONFIG', `roles/${file}: brief_sections must be a non-empty array of at most 32 section names`);
  }
  for (const s of role.brief_sections) {
    if (typeof s !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(s)) {
      throw err('E_INVALID_CONFIG', `roles/${file}: brief_sections entry "${String(s)}" must be a lower-case section name`);
    }
  }
  return role;
}

export function loadRoles(rootDir: string): RoleManifest[] {
  const dir = join(rootDir, 'roles');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => checkBriefSections(checkBudget(JSON.parse(readFileSync(join(dir, f), 'utf8')) as RoleManifest, f), f));
}

/**
 * Brief sections the selected roles asked for (union), or undefined when none declare a preference.
 * Callers intersect with the project-configured section list.
 */
export function briefSectionsFor(roles: RoleManifest[]): string[] | undefined {
  const asked = new Set<string>();
  for (const r of roles) {
    for (const s of r.brief_sections ?? []) asked.add(s);
  }
  return asked.size ? [...asked].sort() : undefined;
}

export function getRole(rootDir: string, roleId: string): RoleManifest {
  const roles = loadRoles(rootDir);
  const role = roles.find((r) => r.id === roleId);
  if (!role) throw err('E_NOT_FOUND', `Role not found: ${roleId}`);
  return role;
}

/**
 * The size limit for one task's context. A task has ONE selection, shared by every role that reads it, so the
 * limit is the largest each selected reading role asks for (a role that wants more must not be starved by one
 * that wants less). Roles that do not read repository context, or declare no limit, do not count; with none
 * declaring, the default applies. `roles` lists who set the limit, so the document can say where it came from.
 */
export function contextBudgetFor(roles: RoleManifest[]): ContextBudget & { source: 'default' | 'roles'; roles: string[] } {
  const declaring = roles.filter((r) => r.inputs.includes('repository-context') && r.context_budget);
  if (!declaring.length) return { ...DEFAULT_CONTEXT_BUDGET, source: 'default', roles: [] };
  return {
    maxFiles: Math.max(...declaring.map((r) => r.context_budget!.maxFiles)),
    maxChars: Math.max(...declaring.map((r) => r.context_budget!.maxChars)),
    source: 'roles',
    roles: declaring.map((r) => r.id).sort(),
  };
}
