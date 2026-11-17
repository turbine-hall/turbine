import { createHash, randomBytes } from 'node:crypto';

/** ULID-like sortable ID (Crockford base32, timestamp + randomness). */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(now: number, len: number): string {
  let str = '';
  for (let i = len; i > 0; i -= 1) {
    const mod = now % 32;
    str = ENCODING[mod] + str;
    now = Math.floor(now / 32);
  }
  return str;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let str = '';
  for (let i = 0; i < len; i += 1) {
    str += ENCODING[(bytes[i] ?? 0) % 32];
  }
  return str;
}

export function createId(prefix?: string): string {
  const id = encodeTime(Date.now(), 10) + encodeRandom(16);
  return prefix ? `${prefix}_${id}` : id;
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Canonical JSON for hashing: sorted keys, no whitespace ambiguity. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}

export function contentHash(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}

export function contentHashText(text: string): string {
  return `sha256:${sha256(text)}`;
}
