import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { err } from '@turbine-hall/turbine-contracts';

/** Default lease for a fleet claim (10 minutes). */
export const DEFAULT_FLEET_LEASE_MS = 10 * 60 * 1000;

export type FleetLockBody = {
  owner: string;
  workId: string;
  runId: string;
  pid: number;
  claimedAt: string;
  expiresAt: string;
  leaseMs: number;
};

export function fleetLocksDir(projectRoot: string): string {
  return join(projectRoot, '.turbine', 'fleet', 'locks');
}

export function fleetLockPath(projectRoot: string, workId: string): string {
  if (!workId || workId.includes('..') || workId.includes('/') || workId.includes('\\')) {
    throw err('E_INVALID_CONFIG', `fleet lock work id is not path-safe: ${workId}`);
  }
  return join(fleetLocksDir(projectRoot), `${workId}.lock`);
}

function ensureLocksDir(projectRoot: string): void {
  mkdirSync(fleetLocksDir(projectRoot), { recursive: true });
}

export function readFleetLock(projectRoot: string, workId: string): FleetLockBody | undefined {
  const path = fleetLockPath(projectRoot, workId);
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw err(
      'E_UNSAFE_EXECUTION',
      `fleet lock unreadable at ${path}: ${(e as Error).message.split('\n')[0]}`,
    );
  }
  try {
    const parsed = JSON.parse(raw) as FleetLockBody;
    if (
      typeof parsed.owner !== 'string' ||
      typeof parsed.workId !== 'string' ||
      typeof parsed.runId !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.claimedAt !== 'string' ||
      typeof parsed.expiresAt !== 'string' ||
      typeof parsed.leaseMs !== 'number'
    ) {
      throw new Error('missing required fields');
    }
    return parsed;
  } catch (e) {
    throw err(
      'E_UNSAFE_EXECUTION',
      `fleet lock corrupt at ${path}: ${(e as Error).message.split('\n')[0]}`,
    );
  }
}

function writeLockAtomic(path: string, body: FleetLockBody): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  try {
    writeSync(fd, `${JSON.stringify(body, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export type AcquireFleetLockResult =
  | { ok: true; lock: FleetLockBody; reclaimed?: boolean }
  | { ok: false; reason: string };

/**
 * Claim a task for a fleet run. Reclaims only after the lease expires (logged by the caller).
 * Never removes a lock without re-reading the owner (rule 8).
 */
export function acquireFleetLock(input: {
  projectRoot: string;
  workId: string;
  runId: string;
  leaseMs?: number;
  now?: () => Date;
}): AcquireFleetLockResult {
  ensureLocksDir(input.projectRoot);
  const now = input.now ?? (() => new Date());
  const leaseMs = input.leaseMs ?? DEFAULT_FLEET_LEASE_MS;
  if (!(leaseMs > 0) || !Number.isFinite(leaseMs)) {
    throw err('E_INVALID_CONFIG', 'fleet leaseMs must be a positive finite number');
  }
  const path = fleetLockPath(input.projectRoot, input.workId);
  const owner = `fleet:${input.runId}:${input.workId}`;
  const at = now();
  const body: FleetLockBody = {
    owner,
    workId: input.workId,
    runId: input.runId,
    pid: process.pid,
    claimedAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + leaseMs).toISOString(),
    leaseMs,
  };

  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    try {
      writeSync(fd, `${JSON.stringify(body, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    return { ok: true, lock: body };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err('E_UNSAFE_EXECUTION', `fleet lock create failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  const existing = readFleetLock(input.projectRoot, input.workId);
  if (!existing) {
    // Released between EEXIST and read — retry once via recursive call would loop; treat as busy.
    return { ok: false, reason: 'lock disappeared during contend; retry' };
  }
  if (existing.owner === owner) {
    return { ok: true, lock: existing };
  }
  const expires = Date.parse(existing.expiresAt);
  if (!Number.isFinite(expires)) {
    throw err('E_UNSAFE_EXECUTION', `fleet lock has unreadable expiresAt for ${input.workId}`);
  }
  if (now().getTime() < expires) {
    return { ok: false, reason: `held by ${existing.owner} until ${existing.expiresAt}` };
  }

  // Lease expired: re-read owner immediately before taking over (rule 8).
  const again = readFleetLock(input.projectRoot, input.workId);
  if (!again || again.owner !== existing.owner) {
    return { ok: false, reason: 'lock owner changed during reclaim; retry' };
  }
  writeLockAtomic(path, body);
  const verify = readFleetLock(input.projectRoot, input.workId);
  if (!verify || verify.owner !== owner) {
    return { ok: false, reason: 'reclaim lost race; retry' };
  }
  return { ok: true, lock: body, reclaimed: true };
}

/** Remove the lock only if we still own it (re-read immediately before unlink). */
export function releaseFleetLock(input: {
  projectRoot: string;
  workId: string;
  owner: string;
}): { released: boolean; reason?: string } {
  const path = fleetLockPath(input.projectRoot, input.workId);
  if (!existsSync(path)) return { released: true };
  const current = readFleetLock(input.projectRoot, input.workId);
  if (!current) return { released: true };
  if (current.owner !== input.owner) {
    return { released: false, reason: `owner is ${current.owner}, not ${input.owner}` };
  }
  // Re-read once more immediately before remove (rule 8).
  const again = readFleetLock(input.projectRoot, input.workId);
  if (!again || again.owner !== input.owner) {
    return { released: false, reason: 'owner changed before unlink' };
  }
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { released: true };
    throw err('E_UNSAFE_EXECUTION', `fleet lock unlink failed: ${(e as Error).message.split('\n')[0]}`);
  }
  return { released: true };
}

/** List work ids that currently have a lock file (may include expired). */
export function listFleetLockedWorkIds(projectRoot: string): string[] {
  const dir = fleetLocksDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.lock'))
    .map((n) => n.slice(0, -'.lock'.length));
}
