import { createRequire } from 'node:module';
import type * as TS from 'typescript';
import type { ImportKind } from '@turbine-hall/turbine-contracts';

/**
 * Reads the import and export statements of ONE JavaScript / TypeScript source text, with the TypeScript parser.
 *
 * The parser is the authority on what is code: comments, strings, template literals, regular expressions, JSX text
 * and type syntax are all read the way the language reads them, so a statement that only appears inside one of them
 * is never stated. This is built to be sure rather than complete:
 *   - when the text has ANY syntax error, or is nested too deeply to parse, NOTHING is stated for the file
 *     (`{ ok: false }`): a partial parse is never used;
 *   - static `import` / `export … from` statements and exports count only at the top level of the file;
 *   - `require('x')` counts only when `require` is not bound anywhere in the file (a parameter, variable, function
 *     or import named `require` may shadow the loader). The calls left out for that reason are counted in
 *     `unconfirmed`, never silently dropped;
 *   - only a string literal without escapes is trusted as a specifier.
 *
 * The contract is the parser's: a SYNTAX error anywhere fails the file. Errors only the type checker reports
 * (`export const x;`, a duplicate export name, a `const` without initialiser) are not detected, because they need a
 * whole-program check; the file still parses to a tree, and every statement stated from it is at the line recorded.
 * A statement that is missed is a gap the document admits to; a statement that is stated can be found at the
 * recorded line.
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
  | {
      ok: true;
      imports: ScannedImport[];
      exports: ScannedExport[];
      /** `require()` calls found but not stated, because `require` is bound in the file and may not be the loader. */
      unconfirmed: number;
      /** Statements whose specifier is a string written with an escape (`'\\u0066oo'`): found, but not stated, so not silently dropped. */
      escaped: number;
    }
  | { ok: false; reason: string };

/** The TypeScript compiler is loaded on the first scan, not when the CLI starts. */
let tsModule: typeof TS | undefined;
const loadTs = (): typeof TS => (tsModule ??= createRequire(import.meta.url)('typescript') as typeof TS);

/** Whether a file can contain JSX. TypeScript does not allow JSX in `.ts` files, where `<T>x` is a cast. */
export function jsxFile(path: string): boolean {
  return !/\.[cm]?ts$/.test(path);
}

export type ParsedSource =
  | { ok: true; ts: typeof TS; sf: TS.SourceFile; source: string; lineAt: (pos: number) => number }
  | { ok: false; reason: string };

/**
 * Parse ONE source text with the TypeScript parser. Any syntax error, or a text too deeply nested to parse, is
 * `{ ok: false }`: a partial parse is never handed on. `lineAt` maps a character offset to a 1-based line (LF, CRLF
 * and bare CR all end a line).
 */
export function parseSource(input: string, opts: { jsx: boolean } = { jsx: true }): ParsedSource {
  const ts = loadTs();
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const lineStarts = [0];
  for (let i = 0; i < s.length; i++) {
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

  let sf: TS.SourceFile;
  try {
    sf = ts.createSourceFile(opts.jsx ? 'module.tsx' : 'module.ts', s, ts.ScriptTarget.Latest, true, opts.jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  } catch (e) {
    // A stack overflow in a deeply nested file is a failure of that file, not of the run.
    if (e instanceof RangeError) return { ok: false, reason: 'the text is nested too deeply to parse' };
    throw e;
  }
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly TS.DiagnosticWithLocation[] }).parseDiagnostics;
  // Fail closed: if a TypeScript release stops exposing the syntax diagnostics, nothing is stated for any file.
  if (!Array.isArray(diagnostics)) return { ok: false, reason: 'the parser did not report its syntax diagnostics' };
  if (diagnostics.length) {
    const d = diagnostics[0]!;
    return { ok: false, reason: `${ts.flattenDiagnosticMessageText(d.messageText, ' ')} near line ${lineAt(d.start)}` };
  }
  return { ok: true, ts, sf, source: s, lineAt };
}

export function scanModule(input: string, opts: { jsx: boolean } = { jsx: true }): ModuleScan {
  const parsed = parseSource(input, opts);
  if (!parsed.ok) return parsed;
  const { ts, sf, source: s, lineAt } = parsed;

  const text = (a: number, b: number) => s.slice(a, b).replace(/\r\n?/g, '\n');
  const startOf = (n: TS.Node) => n.getStart(sf);
  const imports: Array<ScannedImport & { viaCall?: true }> = [];
  const exports: ScannedExport[] = [];
  let requireBound = false;

  /** A string literal written without escapes: its value is exactly the text between the quotes. */
  let escaped = 0;
  const plainString = (n: TS.Node | undefined): TS.StringLiteral | undefined => {
    if (!n || !ts.isStringLiteral(n)) return undefined;
    if (s.slice(startOf(n) + 1, n.end - 1) === n.text) return n;
    escaped++;
    return undefined;
  };
  const addImport = (kind: ImportKind, spec: TS.StringLiteral, from: number, to: number, viaCall = false) =>
    imports.push({ specifier: spec.text, kind, line: lineAt(from), statement: text(from, to), ...(viaCall ? { viaCall: true as const } : {}) });
  const addExport = (name: string, from: number, to: number) => exports.push({ name, line: lineAt(from), statement: text(from, to) });

  const modifiersOf = (n: TS.Node): readonly TS.Modifier[] => (ts.canHaveModifiers(n) ? (ts.getModifiers(n) ?? []) : []);

  /** Whether this node declares a binding named `require` that is not an ambient declaration of the loader itself. */
  const bindsRequire = (n: TS.Node): boolean => {
    if (!ts.isIdentifier(n) || n.text !== 'require') return false;
    const p = n.parent;
    if (!p) return false;
    const declares =
      ((ts.isParameter(p) ||
        ts.isVariableDeclaration(p) ||
        ts.isBindingElement(p) ||
        ts.isFunctionDeclaration(p) ||
        ts.isFunctionExpression(p) ||
        ts.isClassDeclaration(p) ||
        ts.isClassExpression(p) ||
        ts.isEnumDeclaration(p) ||
        ts.isModuleDeclaration(p) ||
        ts.isImportClause(p) ||
        ts.isImportSpecifier(p) ||
        ts.isNamespaceImport(p) ||
        ts.isImportEqualsDeclaration(p)) &&
        p.name === n) ||
      false;
    if (!declares) return false;
    // `declare const require: NodeRequire;` names the loader; it does not shadow it.
    if ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p)) && (ts.getCombinedModifierFlags(p) & ts.ModifierFlags.Ambient) !== 0) return false;
    return true;
  };

  const topLevel = (n: TS.Node) => {
    if (ts.isImportDeclaration(n)) {
      const spec = plainString(n.moduleSpecifier);
      if (!spec) return;
      const kind: ImportKind = !n.importClause ? 'side-effect' : n.importClause.phaseModifier === ts.SyntaxKind.TypeKeyword ? 'import-type' : 'import';
      addImport(kind, spec, startOf(n), spec.end);
      return;
    }
    if (ts.isImportEqualsDeclaration(n)) {
      if (ts.isExternalModuleReference(n.moduleReference)) {
        const spec = plainString(n.moduleReference.expression);
        if (spec) addImport('require', spec, startOf(n), n.moduleReference.end);
      }
      return;
    }
    if (ts.isExportDeclaration(n)) {
      const from = startOf(n);
      const spec = plainString(n.moduleSpecifier);
      if (n.moduleSpecifier && !spec) return;
      if (spec) addImport('re-export', spec, from, spec.end);
      const clause = n.exportClause;
      if (!clause) return;
      if (ts.isNamespaceExport(clause)) {
        addExport(clause.name.text, from, clause.name.end);
        return;
      }
      for (const el of clause.elements) if (el.name.text !== 'default') addExport(el.name.text, from, clause.end);
      return;
    }
    const exportKeyword = modifiersOf(n).find((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exportKeyword || modifiersOf(n).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return;
    const from = startOf(exportKeyword);
    if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) addExport(d.name.text, from, d.name.end);
    } else if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isEnumDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) {
      if (n.name) addExport(n.name.text, from, n.name.end);
    } else if (ts.isModuleDeclaration(n) && ts.isIdentifier(n.name)) {
      addExport(n.name.text, from, n.name.end);
    }
  };

  // An explicit stack, so the walk itself cannot overflow however deep the (already parsed) tree is.
  const stack: TS.Node[] = [sf];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.parent === sf) topLevel(n);
    if (bindsRequire(n)) requireBound = true;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const arg = n.arguments[0];
      if (ts.isIdentifier(callee) && callee.text === 'require' && n.arguments.length === 1) {
        const spec = plainString(arg);
        if (spec) addImport('require', spec, startOf(n), n.end, true);
      } else if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = plainString(arg);
        if (spec) addImport('dynamic', spec, startOf(n), n.end);
      }
    }
    const children: TS.Node[] = [];
    ts.forEachChild(n, (c) => {
      children.push(c);
    });
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }

  let unconfirmed = 0;
  const kept: ScannedImport[] = [];
  for (const { viaCall, ...imp } of imports) {
    if (viaCall && requireBound) unconfirmed++;
    else kept.push(imp);
  }
  return { ok: true, imports: kept, exports, unconfirmed, escaped };
}
