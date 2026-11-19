/**
 * Glob matching without recursion or regular expressions, for patterns that come from the repository (tsconfig
 * `include`/`exclude`, CODEOWNERS). The work is bounded by (pattern segments x path segments x segment length).
 */

/** `*` and `?` inside one path segment, matched without recursion or regular expressions (linear in the text for one star). */
export function segmentMatches(pat: string, s: string): boolean {
  let p = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    if (p < pat.length && (pat[p] === '?' || pat[p] === s[i])) {
      p++;
      i++;
    } else if (p < pat.length && pat[p] === '*') {
      star = p++;
      mark = i;
    } else if (star >= 0) {
      p = star + 1;
      i = ++mark;
    } else return false;
  }
  while (p < pat.length && pat[p] === '*') p++;
  return p === pat.length;
}

/**
 * `out[n]` is true when the pattern matches exactly the first `n` path segments. A `**` segment consumes any number of
 * segments. The pattern positions are advanced together, one path segment at a time: no recursion, and the work is
 * (pattern segments × path segments).
 */
export function prefixMatches(pat: string[], path: string[]): boolean[] {
  const closure = (states: Set<number>): Set<number> => {
    for (const i of [...states]) for (let j = i; pat[j] === '**'; j++) states.add(j + 1);
    return states;
  };
  let states = closure(new Set([0]));
  const out: boolean[] = [];
  for (let k = 0; k <= path.length; k++) {
    out.push(states.has(pat.length));
    if (k === path.length) break;
    const next = new Set<number>();
    for (const i of states) {
      if (i >= pat.length) continue;
      if (pat[i] === '**') next.add(i);
      else if (segmentMatches(pat[i]!, path[k]!)) next.add(i + 1);
    }
    states = closure(next);
  }
  return out;
}
