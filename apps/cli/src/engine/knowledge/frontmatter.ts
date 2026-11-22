import { parseDocument, isMap, isSeq, Scalar } from 'yaml';
import { MAX_BUNDLE_YAML_DEPTH } from './paths.js';

export type SplitFrontmatter =
  | { ok: true; raw: string; data: Record<string, unknown>; body: string; bodyStartLine: number }
  | { ok: false; reason: string; body: string };

/**
 * Split an OKF markdown file into YAML frontmatter and body.
 * Bounded depth; duplicate keys and custom tags are refused.
 * CR-only line endings are accepted (normalised for the YAML block).
 */
export function splitFrontmatter(text: string, maxDepth = MAX_BUNDLE_YAML_DEPTH): SplitFrontmatter {
  // Drop one leading UTF-8 BOM so BOM+`---` still parses (matches upstream validate.py).
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Normalise CR-only to LF for line splitting; keep content otherwise.
  const normalised =
    withoutBom.includes('\r') && !withoutBom.includes('\n')
      ? withoutBom.replace(/\r/g, '\n')
      : withoutBom.replace(/\r\n/g, '\n');
  const lines = normalised.split('\n');
  if (!lines.length || lines[0] !== '---') {
    return { ok: false, reason: 'frontmatter is absent (file must start with ---)', body: normalised };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return { ok: false, reason: 'the closing --- line is missing', body: '' };
  const raw = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  try {
    const doc = parseDocument(raw, {
      strict: true,
      uniqueKeys: true,
      schema: 'core',
      version: '1.2',
    });
    if (doc.errors.length) {
      return { ok: false, reason: `invalid YAML (${doc.errors[0]!.message})`, body };
    }
    if (doc.warnings.some((w) => /unknown tag|unresolved tag/i.test(w.message))) {
      return { ok: false, reason: 'YAML custom tags are not allowed (OKF §4)', body };
    }
    if (!isMap(doc.contents) && doc.contents != null) {
      return { ok: false, reason: 'frontmatter is not a YAML mapping', body };
    }
    if (doc.contents == null) {
      return { ok: true, raw, data: {}, body, bodyStartLine: end + 2 };
    }
    assertYamlDepth(doc.contents, maxDepth, 0);
    const data = doc.toJS({ mapAsMap: false }) as Record<string, unknown>;
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      return { ok: true, raw, data, body, bodyStartLine: end + 2 };
    }
    return { ok: false, reason: 'frontmatter is not a YAML mapping', body };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), body };
  }
}

function assertYamlDepth(node: unknown, max: number, depth: number): void {
  if (depth > max) throw new Error(`YAML nesting exceeds ${max} levels`);
  if (isMap(node)) {
    for (const item of node.items) {
      assertYamlDepth(item.value, max, depth + 1);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) assertYamlDepth(item, max, depth + 1);
  } else if (node instanceof Scalar) {
    // leaf
  }
}

/** Quote string scalars that look like numbers/booleans when writing YAML (OKF §4 / YAML 1.2 core). */
export function shouldQuoteOkfString(value: string): boolean {
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(value)) return true;
  // integers (decimal, hex, octal), floats (incl. leading +, .5, 1.), special floats
  if (/^[+-]?(0x[0-9a-fA-F]+|0o[0-7]+|\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value)) return true;
  if (/^[+-]?\.(inf|Inf|INF|nan|NaN|NAN)$/.test(value)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return true;
  return false;
}
