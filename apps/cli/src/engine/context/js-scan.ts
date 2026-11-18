import type { ImportKind } from '@turbine-hall/turbine-contracts';

/**
 * Reads the import and export statements of ONE JavaScript / TypeScript source text.
 *
 * This is a tokenizer, not a parser, and it is built to be sure rather than complete:
 *   - comments, string literals, template literals and regex literals are skipped as units, so an
 *     `import` that only appears inside one of them is never read;
 *   - static `import` / `export … from` statements count only at brace depth 0 and at the start of a
 *     statement (so JSX text or an `export` inside `declare module { … }` is not mistaken for one);
 *   - when the text cannot be tokenised exactly (an unterminated string, comment, template or regex),
 *     NOTHING is stated for the file: the result is `{ ok: false }`.
 * A statement that is missed is a gap the document admits to; a statement that is stated is one that
 * can be found at the recorded line.
 */

export type ScannedImport = {
  specifier: string;
  kind: ImportKind;
  /** 1-based line of the first character of the statement. */
  line: number;
  /** Exact source text, with line ends normalised to LF. */
  statement: string;
};

export type ScannedExport = {
  name: string;
  line: number;
  statement: string;
};

export type ModuleScan =
  | { ok: true; imports: ScannedImport[]; exports: ScannedExport[] }
  | { ok: false; reason: string };

type Tok = {
  /** w: word (identifier, keyword, number); p: one punctuation character; s: string literal; x: template / regex literal. */
  t: 'w' | 'p' | 's' | 'x';
  v: string;
  start: number;
  end: number;
  /** A line break lies between the previous token and this one (always true for the first token). */
  nl: boolean;
  /** A string literal whose value contains an escape: its value is not trusted. */
  escaped?: boolean;
};

class ScanError extends Error {}

/** Words after which a `/` starts a regular expression rather than dividing. */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const WORD = /[A-Za-z0-9_$\u0080-\uffff]/;

export function scanModule(input: string): ModuleScan {
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const n = s.length;
  const tokens: Tok[] = [];

  const lineStarts = [0];
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 10) lineStarts.push(i + 1);
    else if (c === 13) {
      if (s.charCodeAt(i + 1) === 10) i++;
      lineStarts.push(i + 1);
    }
  }
  const lineAt = (pos: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const fail = (what: string, at: number): never => {
    throw new ScanError(`${what} near line ${lineAt(at)}`);
  };

  const skipString = (i: number): { end: number; escaped: boolean } => {
    const q = s[i]!;
    let j = i + 1;
    let escaped = false;
    while (j < n) {
      const ch = s[j]!;
      if (ch === '\\') {
        escaped = true;
        j += 2;
        continue;
      }
      if (ch === q) return { end: j + 1, escaped };
      if (ch === '\n' || ch === '\r') fail('unterminated string', i);
      j++;
    }
    return fail('unterminated string', i);
  };

  const skipRegex = (i: number): number => {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const ch = s[j]!;
      if (ch === '\n' || ch === '\r') fail('unterminated regular expression', i);
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        j++;
        while (j < n && WORD.test(s[j]!)) j++; // flags
        return j;
      }
      j++;
    }
    return fail('unterminated regular expression', i);
  };

  // `lex` reads code from `i`. In a template expression it stops after the `}` that closes it.
  const lex = (start: number, inTemplate: boolean, out: Tok[] | null): number => {
    let i = start;
    let depth = 0;
    let prev: Tok | undefined;
    let prev2: Tok | undefined;
    let lastEnd = -1;

    const push = (t: Tok['t'], v: string, a: number, b: number, extra: Partial<Tok> = {}) => {
      const tok: Tok = { t, v, start: a, end: b, nl: lastEnd < 0 || /[\n\r]/.test(s.slice(lastEnd, a)), ...extra };
      lastEnd = b;
      prev2 = prev;
      prev = tok;
      out?.push(tok);
    };

    const regexAllowed = (): boolean => {
      if (!prev) return true;
      if (prev.t === 'w') return REGEX_AFTER_WORD.has(prev.v);
      if (prev.t === 's' || prev.t === 'x') return false;
      if (prev.v === ')' || prev.v === ']') return false;
      // `a++ / 2`: a postfix operator ends an expression.
      if ((prev.v === '+' || prev.v === '-') && prev2 && prev2.v === prev.v && prev2.end === prev.start) return false;
      return true;
    };

    while (i < n) {
      const c = s[i]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\u2028' || c === '\u2029') {
        i++;
        continue;
      }
      if (c === '/' && s[i + 1] === '/') {
        while (i < n && s[i] !== '\n' && s[i] !== '\r') i++;
        continue;
      }
      if (c === '/' && s[i + 1] === '*') {
        const close = s.indexOf('*/', i + 2);
        if (close < 0) fail('unterminated comment', i);
        i = close + 2;
        continue;
      }
      if (c === "'" || c === '"') {
        const { end, escaped } = skipString(i);
        push('s', s.slice(i + 1, end - 1), i, end, escaped ? { escaped: true } : {});
        i = end;
        continue;
      }
      if (c === '`') {
        const end = skipTemplate(i);
        push('x', '`', i, end);
        i = end;
        continue;
      }
      if (c === '/') {
        if (regexAllowed()) {
          const end = skipRegex(i);
          push('x', '/', i, end);
          i = end;
        } else {
          push('p', '/', i, i + 1);
          i++;
        }
        continue;
      }
      if (c === '{') {
        depth++;
        push('p', c, i, i + 1);
        i++;
        continue;
      }
      if (c === '}') {
        if (inTemplate && depth === 0) return i + 1;
        depth--;
        push('p', c, i, i + 1);
        i++;
        continue;
      }
      if (WORD.test(c)) {
        let j = i + 1;
        while (j < n && WORD.test(s[j]!)) j++;
        push('w', s.slice(i, j), i, j);
        i = j;
        continue;
      }
      push('p', c, i, i + 1);
      i++;
    }
    if (inTemplate) fail('unterminated template expression', start);
    return i;
  };

  const skipTemplate = (i: number): number => {
    let j = i + 1;
    while (j < n) {
      const ch = s[j]!;
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '`') return j + 1;
      if (ch === '$' && s[j + 1] === '{') {
        j = lex(j + 2, true, null);
        continue;
      }
      j++;
    }
    return fail('unterminated template literal', i);
  };

  try {
    const first = s.startsWith('#!') ? s.search(/[\n\r]/) : 0;
    lex(first < 0 ? n : first, false, tokens);
  } catch (e) {
    if (e instanceof ScanError) return { ok: false, reason: e.message };
    throw e;
  }

  // brace depth BEFORE each token (type-level and JSX braces are balanced, so depth 0 is "top level")
  const depthBefore: number[] = [];
  let d = 0;
  for (const t of tokens) {
    depthBefore.push(d);
    if (t.t === 'p' && t.v === '{') d++;
    else if (t.t === 'p' && t.v === '}') d--;
  }

  const text = (a: number, b: number) => s.slice(a, b).replace(/\r\n?/g, '\n');
  const imports: ScannedImport[] = [];
  const exports: ScannedExport[] = [];
  const at = (i: number): Tok | undefined => tokens[i];
  const isWord = (t: Tok | undefined, v?: string): boolean => !!t && t.t === 'w' && (v === undefined || t.v === v);
  const isP = (t: Tok | undefined, v: string): boolean => !!t && t.t === 'p' && t.v === v;
  const isStr = (t: Tok | undefined): boolean => !!t && t.t === 's' && !t.escaped;
  /** The token if it is a word, else undefined (narrows for the callers that need the token). */
  const wordOf = (t: Tok | undefined): Tok | undefined => (t && t.t === 'w' ? t : undefined);
  const stmtStart = (i: number) => depthBefore[i] === 0 && (i === 0 || tokens[i]!.nl || isP(tokens[i - 1], ';') || isP(tokens[i - 1], '}'));

  const addImport = (kind: ImportKind, spec: Tok, from: Tok, to: Tok) =>
    imports.push({ specifier: spec.v, kind, line: lineAt(from.start), statement: text(from.start, to.end) });
  const addExport = (name: string, from: Tok, to: Tok) => exports.push({ name, line: lineAt(from.start), statement: text(from.start, to.end) });

  const MAX_CLAUSE = 5000;
  for (let i = 0; i < tokens.length; i++) {
    const k = tokens[i]!;
    if (k.t !== 'w') continue;
    const prev = at(i - 1);
    if (isP(prev, '.')) continue; // a property such as `obj.import`

    if (k.v === 'require' && isP(at(i + 1), '(') && isStr(at(i + 2)) && isP(at(i + 3), ')')) {
      addImport('require', at(i + 2)!, k, at(i + 3)!);
      continue;
    }

    if (k.v === 'import') {
      const a = at(i + 1);
      if (!a) continue;
      if (isP(a, '(')) {
        if (isStr(at(i + 2)) && isP(at(i + 3), ')')) addImport('dynamic', at(i + 2)!, k, at(i + 3)!);
        continue;
      }
      if (isP(a, '.') || !stmtStart(i)) continue;
      if (isStr(a)) {
        addImport('side-effect', a, k, a);
        continue;
      }
      let j = i + 1;
      let typeOnly = false;
      if (isWord(at(j), 'type')) {
        const b = at(j + 1);
        if (isP(b, '{') || isP(b, '*') || (b !== undefined && b.t === 'w' && b.v !== 'from')) {
          typeOnly = true;
          j++;
        }
      }
      for (let steps = 0; j < tokens.length && steps < MAX_CLAUSE; j++, steps++) {
        const x = tokens[j]!;
        if (isWord(x, 'from') && isStr(at(j + 1))) {
          addImport(typeOnly ? 'import-type' : 'import', at(j + 1)!, k, at(j + 1)!);
          break;
        }
        if (x.t === 'w' || isP(x, ',') || isP(x, '*') || isP(x, '{') || isP(x, '}')) continue;
        // `import x = require('y')`
        if (isP(x, '=') && isWord(at(j - 1)) && isWord(at(j + 1), 'require') && isP(at(j + 2), '(') && isStr(at(j + 3)) && isP(at(j + 4), ')')) {
          addImport('require', at(j + 3)!, k, at(j + 4)!);
        }
        break;
      }
      continue;
    }

    if (k.v === 'export' && stmtStart(i)) {
      let j = i + 1;
      const a = at(j);
      if (!a) continue;
      if (isP(a, '*')) {
        j++;
        let alias: Tok | undefined;
        if (isWord(at(j), 'as') && isWord(at(j + 1))) {
          alias = at(j + 1);
          j += 2;
        }
        if (isWord(at(j), 'from') && isStr(at(j + 1))) {
          addImport('re-export', at(j + 1)!, k, at(j + 1)!);
          if (alias) addExport(alias.v, k, alias);
        }
        continue;
      }
      if (isWord(a, 'type') && isP(at(j + 1), '{')) j++;
      if (isP(at(j), '{')) {
        // export { a, b as c } [from 'x']
        const names: string[] = [];
        let m = j + 1;
        let group: Tok[] = [];
        const flush = () => {
          const g = group[0]?.v === 'type' && group.length > 1 && group[1]!.v !== 'as' ? group.slice(1) : group;
          const name = g.length >= 3 && g[1]!.v === 'as' ? g[2]!.v : g[0]?.v;
          if (name && name !== 'default') names.push(name);
          group = [];
        };
        for (let steps = 0; m < tokens.length && !isP(at(m), '}') && steps < MAX_CLAUSE; m++, steps++) {
          const x = tokens[m]!;
          if (isP(x, ',')) flush();
          else if (x.t === 'w') group.push(x);
          else break;
        }
        if (!isP(at(m), '}')) continue;
        flush();
        const close = at(m)!;
        let last = close;
        if (isWord(at(m + 1), 'from') && isStr(at(m + 2))) {
          last = at(m + 2)!;
          addImport('re-export', last, k, last);
        }
        for (const name of names) addExport(name, k, close);
        continue;
      }
      while (isWord(at(j), 'declare') || isWord(at(j), 'abstract') || isWord(at(j), 'async')) j++;
      const w = wordOf(at(j));
      if (!w || w.v === 'default') continue;
      if (w.v === 'function' || w.v === 'class') {
        let nm = at(j + 1);
        if (isP(nm, '*')) nm = at(j + 2);
        const name = wordOf(nm);
        if (name && name.v !== 'extends' && name.v !== 'implements') addExport(name.v, k, name);
      } else if (w.v === 'const' || w.v === 'let' || w.v === 'var') {
        let nm = at(j + 1);
        if (w.v === 'const' && isWord(nm, 'enum')) nm = at(j + 2);
        const name = wordOf(nm);
        if (name) addExport(name.v, k, name);
      } else if (w.v === 'enum' || w.v === 'interface' || w.v === 'namespace') {
        const name = wordOf(at(j + 1));
        if (name) addExport(name.v, k, name);
      } else if (w.v === 'type') {
        const name = wordOf(at(j + 1));
        if (name && (isP(at(j + 2), '=') || isP(at(j + 2), '<'))) addExport(name.v, k, name);
      }
    }
  }
  return { ok: true, imports, exports };
}
