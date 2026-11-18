/**
 * Just enough semver to say whether an installed version satisfies a declared range. It is
 * deliberately conservative: anything it does not fully understand (tags, URLs, workspace:,
 * npm: aliases, prerelease ranges, hyphen ranges, x-ranges) returns "unchecked" — never a guess.
 */
export type Relation = 'match' | 'mismatch' | 'unchecked';

type V = [number, number, number];

const FULL = /^v?(\d+)\.(\d+)\.(\d+)$/;
const PARTIAL = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/** Components beyond 2^53 cannot be compared exactly as numbers, so they are not judged. */
function exact(parts: Array<string | undefined>): boolean {
  // npm's strict SemVer has no leading zeros ("01" is not a valid component).
  return parts.every((p) => p === undefined || (!/^0\d/.test(p) && Number.isSafeInteger(Number(p))));
}

function full(v: string): V | null {
  const m = FULL.exec(v.trim());
  return m && exact([m[1], m[2], m[3]]) ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: V, b: V): number {
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

/** One comparator like ^1.2.3, ~1.2, >=1.0.0, 2.0.0 → a test on a version, or null if not understood. */
function comparator(token: string): ((v: V) => boolean) | null {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (!m) return null;
  const op = m[1] ?? '=';
  const p = PARTIAL.exec(m[2]!.trim());
  if (!p || !exact([p[1], p[2], p[3]])) return null;
  const major = Number(p[1]);
  const hasMinor = p[2] !== undefined;
  const hasPatch = p[3] !== undefined;
  const low: V = [major, hasMinor ? Number(p[2]) : 0, hasPatch ? Number(p[3]) : 0];
  if (op === '^') {
    const high: V = major > 0 || !hasMinor ? [major + 1, 0, 0] : low[1] > 0 || !hasPatch ? [0, low[1] + 1, 0] : [0, 0, low[2] + 1];
    return (v) => cmp(v, low) >= 0 && cmp(v, high) < 0;
  }
  if (op === '~') {
    const high: V = hasMinor ? [major, low[1] + 1, 0] : [major + 1, 0, 0];
    return (v) => cmp(v, low) >= 0 && cmp(v, high) < 0;
  }
  if (!hasMinor || !hasPatch) {
    // Partial versions only make sense for ^ and ~ here.
    return null;
  }
  if (op === '>=') return (v) => cmp(v, low) >= 0;
  if (op === '<=') return (v) => cmp(v, low) <= 0;
  if (op === '>') return (v) => cmp(v, low) > 0;
  if (op === '<') return (v) => cmp(v, low) < 0;
  return (v) => cmp(v, low) === 0;
}

export function satisfies(installed: string, declared: string): Relation {
  const v = full(installed);
  const spec = declared.trim();
  if (!v || !spec) return 'unchecked'; // prerelease/build versions and empty specs are not judged
  if (spec === '*' || spec === 'x') return 'match';
  // Every arm of a union must be understood before any arm may decide: an unsupported arm could be the
  // one that matches, so one unsupported arm makes the whole range unchecked.
  const arms: Array<Array<(v: V) => boolean>> = [];
  for (const alt of spec.split('||').map((s) => s.trim())) {
    // "1.2.3 - 2.0.0" hyphen ranges and anything with letters other than a plain version (a leading v/V is fine)
    // are not judged.
    if (/\s-\s/.test(alt) || /[a-uw-zA-UW-Z:/@]/.test(alt) || /[xX*]/.test(alt)) return 'unchecked';
    const tokens = alt.replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (!tokens.length) return 'unchecked';
    const tests = tokens.map(comparator);
    if (tests.some((t) => t === null)) return 'unchecked';
    arms.push(tests as Array<(v: V) => boolean>);
  }
  return arms.some((tests) => tests.every((t) => t(v))) ? 'match' : 'mismatch';
}
