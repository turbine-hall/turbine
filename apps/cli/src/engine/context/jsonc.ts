/**
 * Small JSON parser that also tolerates comments and trailing commas (tsconfig, .eslintrc.json)
 * and records the line range of every object member, so a fact can cite the exact lines it
 * was read from.
 */
export type LineRange = { start: number; end: number };

export type Jsonc = {
  value: unknown;
  /** Lines of the member at this key path, e.g. ["scripts", "build"]. */
  lines(path: Array<string | number>): LineRange | undefined;
};

const MAX_DEPTH = 128;

/** The text may be valid JSON, but this reader will not go further: the answer is "not decided", not "invalid". */
export class JsoncLimitError extends SyntaxError {
  constructor(
    message: string,
    readonly limit: 'depth' | 'number',
  ) {
    super(message);
    this.name = 'JsoncLimitError';
  }
}
const TOKEN = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/** A number token whose value a double cannot hold exactly. Only produced under `exactNumbers`. */
export class InexactNumber {
  constructor(readonly text: string) {}
}

export type JsoncOptions = {
  /**
   * A number the reader would round (an integer beyond 2^53, or a token with more than 15 significant digits) is
   * read as an `InexactNumber` carrying its text, not as a rounded `number`. Off by default (every existing reader
   * gets a `number`); the claim verifiers turn it on so a rounded value is never taken as the digits written.
   */
  exactNumbers?: boolean;
};

/** Significant digits of a JSON number token: the mantissa digits without leading or trailing zeros. */
function significantDigits(token: string): number {
  const mantissa = token.replace(/^-/, '').replace(/[eE].*$/, '').replace('.', '');
  return mantissa.replace(/^0+/, '').replace(/0+$/, '').length;
}

export function parseJsonc(input: string, opts: JsoncOptions = {}): Jsonc {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  // LF, CRLF and bare CR all end a line; CRLF counts once.
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  // Positions live in a trie, so paths share their prefixes instead of each member storing a copy
  // of its whole path. Map keys keep strings and numbers apart ("0" is not 0).
  type Node = { range?: LineRange; kids?: Map<string | number, Node> };
  const trie: Node = {};
  const setPosition = (path: Array<string | number>, range: LineRange) => {
    let n = trie;
    for (const k of path) {
      n.kids ??= new Map();
      let c = n.kids.get(k);
      if (!c) n.kids.set(k, (c = {}));
      n = c;
    }
    n.range = range;
  };
  const getPosition = (path: Array<string | number>): LineRange | undefined => {
    let n: Node | undefined = trie;
    for (const k of path) {
      n = n?.kids?.get(k);
      if (!n) return undefined;
    }
    return n?.range;
  };
  const deletePosition = (path: Array<string | number>) => {
    if (!path.length) return;
    let n: Node | undefined = trie;
    for (const k of path.slice(0, -1)) {
      n = n.kids?.get(k);
      if (!n) return;
    }
    n?.kids?.delete(path[path.length - 1]!);
  };
  let i = 0;

  const fail = (msg: string, limit?: 'depth' | 'number'): never => {
    const message = `${msg} at line ${lineOf(Math.min(i, text.length))}`;
    throw limit ? new JsoncLimitError(message, limit) : new SyntaxError(message);
  };
  const skip = () => {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
      else if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail('Unterminated comment');
        i = end + 2;
      } else return;
    }
  };
  const string = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++;
      if (text[i] === '\n' || text[i] === '\r') fail('Unterminated string');
      i++;
    }
    if (text[i] !== '"') fail('Unterminated string');
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (path: Array<string | number>): unknown => {
    if (path.length > MAX_DEPTH) fail('Nested too deeply', 'depth');
    skip();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        skip();
        if (text[i] === '}') {
          i++;
          return obj;
        }
        if (text[i] !== '"') fail('Expected a property name');
        const keyStart = i;
        const key = string();
        skip();
        if (text[i] !== ':') fail('Expected ":"');
        i++;
        const child = [...path, key];
        // A duplicate member replaces the earlier one, so the earlier value's positions (and its children's) go.
        deletePosition(child);
        const v = value(child);
        // defineProperty: a member named "__proto__" must be an own property, never the prototype.
        Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
        setPosition(child, { start: lineOf(keyStart), end: lineOf(i - 1) });
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== '}') fail('Expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        skip();
        if (text[i] === ']') {
          i++;
          return arr;
        }
        const itemStart = i;
        const child = [...path, arr.length];
        arr.push(value(child));
        setPosition(child, { start: lineOf(itemStart), end: lineOf(i - 1) });
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== ']') fail('Expected "," or "]"');
      }
    }
    if (c === '"') return string();
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(text);
    if (!m) return fail('Unexpected token');
    i += m[0].length;
    const n: unknown = JSON.parse(m[0]);
    // 1e400 parses to Infinity, which is not a JSON value a manifest can meaningfully state: refuse it
    if (typeof n === 'number' && !Number.isFinite(n)) return fail('Number out of range', 'number');
    // A double holds any decimal of up to 15 significant digits, and any safe integer, exactly. Anything else may be rounded.
    if (opts.exactNumbers && typeof n === 'number' && !(/^-?\d+$/.test(m[0]) ? Number.isSafeInteger(n) : significantDigits(m[0]) <= 15)) return new InexactNumber(m[0]);
    return n;
  };

  const root = value([]);
  skip();
  if (i < text.length) fail('Unexpected content after the JSON value');
  return { value: root, lines: getPosition };
}
