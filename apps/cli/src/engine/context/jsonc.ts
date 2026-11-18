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

export function parseJsonc(input: string): Jsonc {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
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

  const positions = new Map<string, LineRange>();
  const keyOf = (path: Array<string | number>) => path.map(String).join('\u0000');
  let i = 0;

  const fail = (msg: string): never => {
    throw new SyntaxError(`${msg} at line ${lineOf(Math.min(i, text.length))}`);
  };
  const skip = () => {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
      else if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
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
      if (text[i] === '\n') fail('Unterminated string');
      i++;
    }
    if (text[i] !== '"') fail('Unterminated string');
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (path: Array<string | number>): unknown => {
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
        const v = value(child);
        obj[key] = v;
        positions.set(keyOf(child), { start: lineOf(keyStart), end: lineOf(i - 1) });
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
        positions.set(keyOf(child), { start: lineOf(itemStart), end: lineOf(i - 1) });
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== ']') fail('Expected "," or "]"');
      }
    }
    if (c === '"') return string();
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 40));
    if (!m) return fail('Unexpected token');
    i += m[0].length;
    return JSON.parse(m[0]);
  };

  const root = value([]);
  skip();
  if (i < text.length) fail('Unexpected content after the JSON value');
  return { value: root, lines: (path) => positions.get(keyOf(path)) };
}
