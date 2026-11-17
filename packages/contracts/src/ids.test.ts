import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash, createId } from './ids.js';

describe('ids', () => {
  it('creates prefixed ids', () => {
    const id = createId('work');
    expect(id.startsWith('work_')).toBe(true);
    expect(id.length).toBeGreaterThan(10);
  });

  it('hashes canonically regardless of key order', () => {
    const a = contentHash({ b: 1, a: 2 });
    const b = contentHash({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a.startsWith('sha256:')).toBe(true);
  });

  it('canonicalJson sorts nested keys', () => {
    expect(canonicalJson({ z: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"z":1}',
    );
  });
});
