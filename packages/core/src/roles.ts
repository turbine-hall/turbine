import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { err } from '@turbine-hall/turbine-contracts';

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
};

export function loadRoles(rootDir: string): RoleManifest[] {
  const dir = join(rootDir, 'roles');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as RoleManifest);
}

export function getRole(rootDir: string, roleId: string): RoleManifest {
  const roles = loadRoles(rootDir);
  const role = roles.find((r) => r.id === roleId);
  if (!role) throw err('E_NOT_FOUND', `Role not found: ${roleId}`);
  return role;
}
