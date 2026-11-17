import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { err } from '@turbine-hall/turbine-contracts';

export type FrameworkManifest = {
  id: string;
  version: string;
  name: string;
  stages: string[];
  humanGates: string[];
  checksum?: string;
};

export function loadFramework(rootDir: string, id: string, version: string): FrameworkManifest {
  const path = join(rootDir, 'frameworks', id, version, 'framework.json');
  if (!existsSync(path)) {
    throw err('E_NOT_FOUND', `Framework not found: ${id}@${version} (${path})`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as FrameworkManifest;
  if (raw.id !== id || raw.version !== version) {
    throw err('E_INVALID_CONFIG', 'Framework manifest id/version mismatch');
  }
  if (!raw.stages?.length) {
    throw err('E_INVALID_CONFIG', 'Framework missing stages');
  }
  return raw;
}

export function listFrameworks(rootDir: string): Array<{ id: string; version: string; path: string }> {
  const base = join(rootDir, 'frameworks');
  if (!existsSync(base)) return [];
  // Simple known pin for v0.5
  const pin = join(base, 'turbine', '0.5.0', 'framework.json');
  if (!existsSync(pin)) return [];
  return [{ id: 'turbine', version: '0.5.0', path: pin }];
}
