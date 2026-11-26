import {
  closeSync,
  constants,
  existsSync,
  linkSync,
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

/** Minimum lease so at least one renewal can fire before expiry. */
export const MIN_FLEET_LEASE_MS = 750;

export type FleetLockBody = {
  owner: string;
  workId: string;
  runId: string;
  pid: number;
  claimedAt: string;
  expiresAt: string;
  leaseMs: number;
};

type FenceBody = {
  owner: string;
  pid: number;
  at: string;
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

function fleetLockFencePath(projectRoot: string, workId: string): string {
  return `${fleetLockPath(projectRoot, workId)}.fence`;
}

function ensureLocksDir(projectRoot: string): void {
  mkdirSync(fleetLocksDir(projectRoot), { recursive: true });
}

function assertLeaseMs(leaseMs: number): void {
  if (!(leaseMs >= MIN_FLEET_LEASE_MS) || !Number.isFinite(leaseMs)) {
    throw err('E_INVALID_CONFIG', `fleet leaseMs must be a finite number >= ${MIN_FLEET_LEASE_MS}`);
  }
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
  if (!raw.trim()) {
    // Writer may still be publishing via tmp→link; treat as busy, not corrupt.
    return undefined;
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

/** Write complete metadata to a temp file, then publish with link (never replaces an existing claim). */
function publishLockExclusive(path: string, body: FleetLockBody): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  try {
    writeSync(fd, `${JSON.stringify(body, null, 2)}\n`);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw e;
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw e;
  }
  try {
    unlinkSync(tmp);
  } catch {
    /* best-effort */
  }
}

function writeLockReplace(path: string, body: FleetLockBody): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  try {
    writeSync(fd, `${JSON.stringify(body, null, 2)}\n`);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw e;
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readFence(projectRoot: string, workId: string): FenceBody | undefined {
  const fence = fleetLockFencePath(projectRoot, workId);
  if (!existsSync(fence)) return undefined;
  try {
    const raw = readFileSync(fence, 'utf8');
    const parsed = JSON.parse(raw) as FenceBody;
    if (typeof parsed.owner !== 'string' || typeof parsed.pid !== 'number' || typeof parsed.at !== 'string') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function tryAcquireFence(projectRoot: string, workId: string, owner: string): boolean {
  const fence = fleetLockFencePath(projectRoot, workId);
  const body: FenceBody = { owner, pid: process.pid, at: new Date().toISOString() };
  const writeFence = () => {
    const fd = openSync(fence, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    try {
      writeSync(fd, `${JSON.stringify(body)}\n`);
    } catch (e) {
      try {
        unlinkSync(fence);
      } catch {
        /* best-effort */
      }
      throw e;
    } finally {
      closeSync(fd);
    }
  };
  try {
    writeFence();
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err('E_UNSAFE_EXECUTION', `fleet lock fence failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  // Recover only when the recorded holder pid is gone on this host (local CLI).
  const existing = readFence(projectRoot, workId);
  if (existing && !pidAlive(existing.pid)) {
    try {
      unlinkSync(fence);
    } catch {
      return false;
    }
    try {
      writeFence();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function releaseFence(projectRoot: string, workId: string): void {
  const fence = fleetLockFencePath(projectRoot, workId);
  try {
    unlinkSync(fence);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err('E_UNSAFE_EXECUTION', `fleet lock fence unlink failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }
}

export type AcquireFleetLockResult =
  | { ok: true; lock: FleetLockBody; reclaimed?: boolean }
  | { ok: false; reason: string };

/**
 * Claim a task for a fleet run. Reclaims only after the lease expires (logged by the caller).
 * Never removes a lock without re-reading the owner (rule 8); reclaim/release share a fence.
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
  assertLeaseMs(leaseMs);
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
    publishLockExclusive(path, body);
    return { ok: true, lock: body };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err('E_UNSAFE_EXECUTION', `fleet lock create failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  const existing = readFleetLock(input.projectRoot, input.workId);
  if (!existing) {
    return { ok: false, reason: 'lock busy or disappeared during contend; retry' };
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

  if (!tryAcquireFence(input.projectRoot, input.workId, owner)) {
    return { ok: false, reason: 'reclaim fence held; retry' };
  }
  try {
    const again = readFleetLock(input.projectRoot, input.workId);
    if (!again || again.owner !== existing.owner) {
      return { ok: false, reason: 'lock owner changed during reclaim; retry' };
    }
    const exp2 = Date.parse(again.expiresAt);
    if (!Number.isFinite(exp2) || now().getTime() < exp2) {
      return { ok: false, reason: 'lock no longer expired during reclaim; retry' };
    }
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err('E_UNSAFE_EXECUTION', `fleet lock reclaim unlink failed: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    try {
      publishLockExclusive(path, body);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: false, reason: 'reclaim lost race; retry' };
      }
      throw err('E_UNSAFE_EXECUTION', `fleet lock reclaim create failed: ${(e as Error).message.split('\n')[0]}`);
    }
    const verify = readFleetLock(input.projectRoot, input.workId);
    if (!verify || verify.owner !== owner) {
      return { ok: false, reason: 'reclaim lost race; retry' };
    }
    return { ok: true, lock: body, reclaimed: true };
  } finally {
    releaseFence(input.projectRoot, input.workId);
  }
}

export type RenewFleetLockResult =
  | { ok: true; lock: FleetLockBody }
  | { ok: false; reason: string; busy?: boolean };

/** Extend expiresAt while still owning the lock (keeps a long step exclusive). */
export function renewFleetLock(input: {
  projectRoot: string;
  workId: string;
  owner: string;
  leaseMs: number;
  now?: () => Date;
}): RenewFleetLockResult {
  const now = input.now ?? (() => new Date());
  assertLeaseMs(input.leaseMs);
  if (!tryAcquireFence(input.projectRoot, input.workId, input.owner)) {
    return { ok: false, reason: 'renew fence held; retry', busy: true };
  }
  try {
    const current = readFleetLock(input.projectRoot, input.workId);
    if (!current || current.owner !== input.owner) {
      return { ok: false, reason: 'lost ownership before renew' };
    }
    const at = now();
    const body: FleetLockBody = {
      ...current,
      expiresAt: new Date(at.getTime() + input.leaseMs).toISOString(),
      leaseMs: input.leaseMs,
    };
    writeLockReplace(fleetLockPath(input.projectRoot, input.workId), body);
    const verify = readFleetLock(input.projectRoot, input.workId);
    if (!verify || verify.owner !== input.owner) {
      return { ok: false, reason: 'lost ownership after renew' };
    }
    return { ok: true, lock: verify };
  } finally {
    releaseFence(input.projectRoot, input.workId);
  }
}

/** Remove the lock only if we still own it (fenced with reclaim — rule 8). */
export function releaseFleetLock(input: {
  projectRoot: string;
  workId: string;
  owner: string;
}): { released: boolean; reason?: string } {
  const path = fleetLockPath(input.projectRoot, input.workId);
  if (!existsSync(path)) return { released: true };
  if (!tryAcquireFence(input.projectRoot, input.workId, input.owner)) {
    return { released: false, reason: 'release fence held; retry' };
  }
  try {
    const current = readFleetLock(input.projectRoot, input.workId);
    if (!current) return { released: true };
    if (current.owner !== input.owner) {
      return { released: false, reason: `owner is ${current.owner}, not ${input.owner}` };
    }
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { released: true };
      throw err('E_UNSAFE_EXECUTION', `fleet lock unlink failed: ${(e as Error).message.split('\n')[0]}`);
    }
    return { released: true };
  } finally {
    releaseFence(input.projectRoot, input.workId);
  }
}

/** List work ids that currently have a lock file (may include expired). */
export function listFleetLockedWorkIds(projectRoot: string): string[] {
  const dir = fleetLocksDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.lock'))
    .map((n) => n.slice(0, -'.lock'.length));
}
