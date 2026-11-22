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
      /** The default export (`export default …`, `export { x as default }`), named "default". Kept apart from `exports`, which the import graph reads as named exports. */
      defaultExports: ScannedExport[];
      /** How many `export * from '…'` statements the file has: they re-export names this scan does not list. */
      starReexports: number;
      /** `require()` calls found but not stated, because `require` is bound in the file and may not be the loader. */
      unconfirmed: number;
      /** Lines of the `require()` calls counted in `unconfirmed`. */
      unconfirmedAt: number[];
      /** Start lines of statements whose specifier is written with an escape or as a template literal (`'\\u0066oo'`): found, but not stated, so not silently dropped. */
      unreadableAt: number[];
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
  // Control-flow errors the binder reports that parseDiagnostics omit: a `return` outside a function, or a `break` /
  // `continue` that is not enclosed by a valid target. An explicit stack: deep ASTs must not overflow the call stack.
  type Ctx = { inFunction: boolean; loops: number; switches: number; labels: ReadonlySet<string>; loopLabels: ReadonlySet<string> };
  let illegal: { node: TS.Node; why: string } | undefined;
  const todo: Array<{ n: TS.Node; ctx: Ctx }> = [{ n: sf, ctx: { inFunction: false, loops: 0, switches: 0, labels: new Set(), loopLabels: new Set() } }];
  while (todo.length && !illegal) {
    const { n, ctx } = todo.pop()!;
    if (ts.isReturnStatement(n) && !ctx.inFunction) illegal = { node: n, why: 'a top-level return is not valid in a module' };
    else if (ts.isBreakStatement(n) || ts.isContinueStatement(n)) {
      const label = n.label?.text;
      const isContinue = ts.isContinueStatement(n);
      if (label === undefined) {
        if (isContinue ? ctx.loops === 0 : ctx.loops === 0 && ctx.switches === 0) {
          illegal = { node: n, why: `a ${isContinue ? 'continue' : 'break'} outside a ${isContinue ? 'loop' : 'loop or switch'} is not valid` };
        }
      } else if (isContinue ? !ctx.loopLabels.has(label) : !ctx.labels.has(label)) {
        illegal = { node: n, why: `a ${isContinue ? 'continue' : 'break'} to label "${label}" has no matching enclosing ${isContinue ? 'loop' : 'target'}` };
      }
    }
    if (illegal) break;
    const enterFn =
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n);
    // A class static block is its own jump boundary: it may not return, and it may not break/continue to an outer loop.
    const enterStatic = ts.isClassStaticBlockDeclaration(n);
    const isLoop = ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n);
    const isSwitch = ts.isSwitchStatement(n);
    // Nested functions and static blocks do not inherit outer loops, switches, or labels (a `break` inside `f` must
    // not see the `for` that encloses `function f() { break; }`). A static block also clears `inFunction`.
    let next: Ctx =
      enterFn || enterStatic
        ? { inFunction: enterFn, loops: 0, switches: 0, labels: new Set(), loopLabels: new Set() }
        : {
            inFunction: ctx.inFunction,
            loops: ctx.loops + (isLoop ? 1 : 0),
            switches: ctx.switches + (isSwitch ? 1 : 0),
            labels: ctx.labels,
            loopLabels: ctx.loopLabels,
          };
    if (ts.isLabeledStatement(n)) {
      if (ctx.labels.has(n.label.text)) {
        illegal = { node: n, why: `a duplicate label "${n.label.text}" is not valid` };
        break;
      }
      const labels = new Set(ctx.labels);
      labels.add(n.label.text);
      const loopLabels = new Set(ctx.loopLabels);
      // `outer: inner: for (;;)` — both labels name the loop. Follow chained labeled statements; do not descend into a block.
      let body: TS.Statement = n.statement;
      while (ts.isLabeledStatement(body)) body = body.statement;
      if (ts.isForStatement(body) || ts.isForInStatement(body) || ts.isForOfStatement(body) || ts.isWhileStatement(body) || ts.isDoStatement(body)) loopLabels.add(n.label.text);
      next = { ...next, labels, loopLabels };
    }
    const children: TS.Node[] = [];
    ts.forEachChild(n, (c) => {
      children.push(c);
    });
    for (let i = children.length - 1; i >= 0; i--) todo.push({ n: children[i]!, ctx: next });
  }
  if (illegal) return { ok: false, reason: `${illegal.why} near line ${lineAt(illegal.node.getStart(sf))}` };
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
  const defaultExports: ScannedExport[] = [];
  let starReexports = 0;
  let requireBound = false;

  /** A string literal written without escapes: its value is exactly the text between the quotes. */
  const unreadableAt: number[] = [];
  /** `from` is where the statement that holds the string starts: an escaped specifier is recorded against that line. */
  const plainString = (arg: TS.Node | undefined, from: number): TS.StringLiteral | undefined => {
    // `import(('pkg'))`, `import('pkg' as string)`: the same module name, written inside wrappers that do not change it.
    let n = arg;
    while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n))) n = n.expression;
    if (!n) return undefined;
    // `import(`pkg`)`: a template without substitutions names a module, but is not a string literal this scanner trusts.
    if (ts.isNoSubstitutionTemplateLiteral(n)) {
      unreadableAt.push(lineAt(from));
      return undefined;
    }
    // A computed specifier (`import('./' + name)`) is a statement this scanner found but cannot state: record it, do not drop it.
    if (!ts.isStringLiteral(n)) {
      unreadableAt.push(lineAt(from));
      return undefined;
    }
    if (s.slice(startOf(n) + 1, n.end - 1) === n.text) return n;
    unreadableAt.push(lineAt(from));
    return undefined;
  };
  const addImport = (kind: ImportKind, spec: TS.StringLiteral, from: number, to: number, viaCall = false) =>
    imports.push({ specifier: spec.text, kind, line: lineAt(from), statement: text(from, to), ...(viaCall ? { viaCall: true as const } : {}) });
  // `statement` is normalised by the caller, once per statement: a clause naming thousands of exports shares one.
  const addExport = (name: string, line: number, statement: string) => exports.push({ name, line, statement });
  const addDefault = (line: number, statement: string) => defaultExports.push({ name: 'default', line, statement });

  /** The identifiers a declaration name binds, through object and array patterns (an explicit stack: a pattern can nest deeply). */
  const boundNames = (name: TS.BindingName): string[] => {
    const out: string[] = [];
    const todo: TS.BindingName[] = [name];
    while (todo.length) {
      const b = todo.pop()!;
      if (ts.isIdentifier(b)) out.push(b.text);
      else for (const el of b.elements) if (ts.isBindingElement(el)) todo.push(el.name);
    }
    return out.reverse();
  };

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
      const spec = plainString(n.moduleSpecifier, startOf(n));
      if (!spec) return;
      const kind: ImportKind = !n.importClause ? 'side-effect' : n.importClause.phaseModifier === ts.SyntaxKind.TypeKeyword ? 'import-type' : 'import';
      addImport(kind, spec, startOf(n), spec.end);
      return;
    }
    if (ts.isImportEqualsDeclaration(n)) {
      if (ts.isExternalModuleReference(n.moduleReference)) {
        const spec = plainString(n.moduleReference.expression, startOf(n));
        if (spec) addImport('require', spec, startOf(n), n.moduleReference.end);
      }
      // `export import fs = require('node:fs')` and `export import x = Ns.Member` also export the alias.
      if (modifiersOf(n).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) addExport(n.name.text, lineAt(startOf(n)), text(startOf(n), n.end));
      return;
    }
    if (ts.isExportDeclaration(n)) {
      const from = startOf(n);
      const spec = plainString(n.moduleSpecifier, from);
      // An untrusted specifier withholds the import edge only: the names the statement exports are still read.
      if (spec) addImport('re-export', spec, from, spec.end);
      const clause = n.exportClause;
      if (!clause) {
        if (n.moduleSpecifier) starReexports++;
        return;
      }
      if (ts.isNamespaceExport(clause)) {
        if (clause.name.text === 'default') addDefault(lineAt(from), text(from, clause.name.end));
        else addExport(clause.name.text, lineAt(from), text(from, clause.name.end));
        return;
      }
      const line = lineAt(from);
      const statement = text(from, clause.end);
      for (const el of clause.elements) {
        if (el.name.text === 'default') addDefault(line, statement);
        else addExport(el.name.text, line, statement);
      }
      return;
    }
    if (ts.isExportAssignment(n)) {
      if (!n.isExportEquals) addDefault(lineAt(startOf(n)), text(startOf(n), n.end));
      return;
    }
    const exportKeyword = modifiersOf(n).find((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const defaultKeyword = modifiersOf(n).find((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (exportKeyword && defaultKeyword) {
      addDefault(lineAt(startOf(exportKeyword)), text(startOf(exportKeyword), defaultKeyword.end));
      return;
    }
    if (!exportKeyword) return;
    const from = startOf(exportKeyword);
    if (ts.isVariableStatement(n)) {
      // One excerpt for the whole statement, shared by every name it binds: a statement with thousands of declarations is not copied per name.
      const line = lineAt(from);
      let excerpt: string | undefined;
      const statement = (): string => (excerpt ??= text(from, n.declarationList.end));
      for (const d of n.declarationList.declarations) {
        // `export const { start: run, ...rest } = api` exports `run` and `rest`: the names the pattern binds, not its property names.
        const names = boundNames(d.name);
        if (!names.length) continue;
        for (const name of names) addExport(name, line, statement());
      }
    } else if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isEnumDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) {
      if (n.name) addExport(n.name.text, lineAt(from), text(from, n.name.end));
    } else if (ts.isModuleDeclaration(n) && ts.isIdentifier(n.name)) {
      addExport(n.name.text, lineAt(from), text(from, n.name.end));
    }
  };

  // An explicit stack, so the walk itself cannot overflow however deep the (already parsed) tree is.
  const stack: TS.Node[] = [sf];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.parent === sf) topLevel(n);
    if (bindsRequire(n)) requireBound = true;
    if (ts.isCallExpression(n)) {
      let callee: TS.Expression = n.expression;
      while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
      const arg = n.arguments[0];
      if (ts.isIdentifier(callee) && callee.text === 'require' && n.arguments.length === 1) {
        const spec = plainString(arg, startOf(n));
        if (spec) addImport('require', spec, startOf(n), n.end, true);
      } else if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = plainString(arg, startOf(n));
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
  const unconfirmedAt: number[] = [];
  const kept: ScannedImport[] = [];
  for (const { viaCall, ...imp } of imports) {
    if (viaCall && requireBound) {
      unconfirmed++;
      unconfirmedAt.push(imp.line);
    } else kept.push(imp);
  }
  return { ok: true, imports: kept, exports, defaultExports, starReexports, unconfirmed, unconfirmedAt, unreadableAt };
}
