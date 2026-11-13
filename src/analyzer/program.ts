/**
 * TypeScript/JavaScript adapter: program loading, function index and callee
 * resolution. Read-only: source files are parsed, never executed.
 */
import ts from "typescript";
import * as path from "node:path";
import { KNOWN_MODULES, PURE_GLOBALS, PURE_METHODS, matchRule, normalizeModule, normalizePath, type ApiRule } from "./catalog";

export interface FnInfo {
  key: string; // `${file}#${symbol}`
  file: string;
  symbol: string;
  node: ts.SignatureDeclaration & { body?: ts.Node };
  name: string;
  exported: boolean;
  /** inline callbacks (passed directly as call arguments) are analysed as part of their parent */
  inlineParent?: FnInfo;
  params: ts.ParameterDeclaration[];
}

export type Value =
  | { v: "fn"; fn: FnInfo }
  | { v: "object"; node: ts.ObjectLiteralExpression }
  | { v: "array"; node: ts.ArrayLiteralExpression }
  | { v: "external"; module: string; path: string[] }
  | { v: "global"; name: string; path: string[] }
  | { v: "dynamic"; reason: string }
  | { v: "candidates"; obj: ts.ObjectLiteralExpression; selector: ts.Expression }
  | { v: "class"; decl: ts.ClassDeclaration }
  | { v: "instance"; decl: ts.ClassDeclaration }
  | { v: "unknown"; reason: string };

export type CallTarget =
  | { t: "internal"; fn: FnInfo }
  | { t: "dispatch"; fns: { key: string; fn: FnInfo }[]; selector: ts.Expression; obj: ts.ObjectLiteralExpression }
  | { t: "api"; rule: ApiRule; module?: string; path: string[] }
  | { t: "external"; module: string; path: string[]; known: boolean }
  | { t: "pure"; name: string }
  | { t: "dynamic"; reason: string }
  | { t: "unresolved"; reason: string };

export class ProgramIndex {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly files: ts.SourceFile[];
  readonly fns: FnInfo[] = [];
  readonly fnByNode = new Map<ts.Node, FnInfo>();
  private valueCache = new Map<ts.Node, Value>();

  constructor(readonly root: string, absFiles: string[]) {
    this.program = ts.createProgram(absFiles, {
      allowJs: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      types: [],
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    });
    this.checker = this.program.getTypeChecker();
    const wanted = new Set(absFiles.map((f) => path.resolve(f)));
    this.files = this.program
      .getSourceFiles()
      .filter((sf) => wanted.has(path.resolve(sf.fileName)))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
    for (const sf of this.files) this.indexFunctions(sf);
  }

  rel(fileName: string): string {
    return path.relative(this.root, fileName).split(path.sep).join("/");
  }

  isOwnFile(sf: ts.SourceFile): boolean {
    return this.files.includes(sf);
  }

  // ---------------------------------------------------------------- functions
  private indexFunctions(sf: ts.SourceFile) {
    const used = new Map<string, number>();
    const visit = (node: ts.Node, enclosing?: FnInfo) => {
      let next = enclosing;
      if (isFunctionWithBody(node)) {
        const inline = isInlineCallback(node);
        let symbol = symbolPathOf(node);
        if (inline && enclosing) symbol = `${enclosing.symbol}/<callback@${lineOf(sf, node)}>`;
        const n = used.get(symbol) ?? 0;
        used.set(symbol, n + 1);
        if (n > 0) symbol = `${symbol}~${n}`;
        const fn: FnInfo = {
          key: `${this.rel(sf.fileName)}#${symbol}`,
          file: this.rel(sf.fileName),
          symbol,
          node: node as FnInfo["node"],
          name: symbol.split(/[./]/).pop() ?? symbol,
          exported: isExported(node),
          inlineParent: inline ? enclosing : undefined,
          params: [...(node as ts.SignatureDeclaration).parameters],
        };
        this.fns.push(fn);
        this.fnByNode.set(node, fn);
        next = fn;
      }
      ts.forEachChild(node, (c) => visit(c, next));
    };
    visit(sf);
  }

  /** The non-inline function that owns the code at `node`. */
  ownerFn(node: ts.Node): FnInfo | undefined {
    let cur: ts.Node | undefined = node;
    while (cur) {
      const fn = this.fnByNode.get(cur);
      if (fn) return rootFn(fn);
      cur = cur.parent;
    }
    return undefined;
  }

  /** Visit nodes belonging to fn's own body (including inline callbacks, excluding nested named functions). */
  forEachOwn(fn: FnInfo, cb: (n: ts.Node) => void) {
    const body = fn.node.body;
    if (!body) return;
    const walk = (n: ts.Node) => {
      const nested = this.fnByNode.get(n);
      if (nested && nested !== fn && !nested.inlineParent) return;
      cb(n);
      ts.forEachChild(n, walk);
    };
    walk(body);
  }

  // ---------------------------------------------------------------- symbols
  symbolOf(node: ts.Node): ts.Symbol | undefined {
    let s: ts.Symbol | undefined;
    if (ts.isShorthandPropertyAssignment(node)) s = this.checker.getShorthandAssignmentValueSymbol(node);
    else s = this.checker.getSymbolAtLocation(node);
    return s;
  }

  /** Follow import aliases to the declaration inside analysed files when possible. */
  declOf(id: ts.Node): { decl?: ts.Declaration; importInfo?: { module: string; imported: string } } {
    const sym = this.symbolOf(id);
    if (!sym) return {};
    const d = sym.declarations?.[0];
    if (sym.flags & ts.SymbolFlags.Alias && d) {
      const imp = importOf(d);
      if (imp) {
        if (imp.module.startsWith(".")) {
          try {
            const target = this.checker.getAliasedSymbol(sym);
            const td = target?.declarations?.[0];
            if (td && this.isOwnFile(td.getSourceFile())) return { decl: td };
          } catch {
            /* fallthrough */
          }
          return { importInfo: imp };
        }
        return { importInfo: { ...imp, module: normalizeModule(imp.module) } };
      }
    }
    return { decl: d };
  }

  // ---------------------------------------------------------------- values
  valueOf(expr: ts.Expression, depth = 0): Value {
    const cached = this.valueCache.get(expr);
    if (cached) return cached;
    const v = depth > 12 ? { v: "unknown" as const, reason: "resolution depth exceeded" } : this.computeValue(expr, depth);
    this.valueCache.set(expr, v);
    return v;
  }

  private computeValue(expr: ts.Expression, depth: number): Value {
    const e = skipOuter(expr);
    if (ts.isIdentifier(e)) {
      const { decl, importInfo } = this.declOf(e);
      if (importInfo) {
        const p = importInfo.imported === "*" ? [] : [importInfo.imported];
        const n = normalizePath(importInfo.module, p);
        return { v: "external", module: n.module, path: n.path };
      }
      if (!decl) return { v: "unknown", reason: `unresolved identifier ${e.text}` };
      const sf = decl.getSourceFile();
      if (!this.isOwnFile(sf)) {
        if (sf.isDeclarationFile) return { v: "global", name: e.text, path: [] };
        return { v: "unknown", reason: `declared outside analysed files: ${e.text}` };
      }
      return this.valueOfDecl(decl, depth);
    }
    if (isFunctionWithBody(e)) {
      const fn = this.fnByNode.get(e);
      return fn ? { v: "fn", fn } : { v: "unknown", reason: "unindexed function" };
    }
    if (ts.isObjectLiteralExpression(e)) return { v: "object", node: e };
    if (ts.isArrayLiteralExpression(e)) return { v: "array", node: e };
    if (ts.isNewExpression(e)) {
      const base = this.valueOf(e.expression, depth + 1);
      if (base.v === "external" || base.v === "global") return { ...base, path: [...base.path, "new"] };
      if (base.v === "class") return { v: "instance", decl: base.decl };
      return { v: "unknown", reason: "constructed value of unknown class" };
    }
    if (ts.isCallExpression(e)) {
      if (e.expression.kind === ts.SyntaxKind.ImportKeyword) return { v: "dynamic", reason: "module loaded with dynamic import()" };
      const base = this.valueOf(e.expression, depth + 1);
      if (base.v === "external" && base.module === "node:util" && base.path.join(".") === "promisify" && e.arguments[0]) {
        return this.valueOf(e.arguments[0], depth + 1);
      }
      if (base.v === "external" || base.v === "global") return { ...base, path: [...base.path, "()"] };
      if (base.v === "dynamic") return base;
      return { v: "unknown", reason: "value returned by a call" };
    }
    if (ts.isPropertyAccessExpression(e) || (ts.isElementAccessExpression(e) && isStringLit(e.argumentExpression))) {
      const name = ts.isPropertyAccessExpression(e) ? e.name.text : (e.argumentExpression as ts.StringLiteral).text;
      const base = this.valueOf(e.expression, depth + 1);
      if (base.v === "object") {
        const prop = findProp(base.node, name);
        if (prop) return this.valueOfDecl(prop, depth + 1);
      }
      if (base.v === "external" || base.v === "global") return { ...base, path: [...base.path, name] };
      if (base.v === "dynamic") return { v: "dynamic", reason: `member '${name}' of a dynamically loaded value` };
      // method on a local class instance or other typed value
      const sym = ts.isPropertyAccessExpression(e) ? this.checker.getSymbolAtLocation(e.name) : undefined;
      const d = sym?.declarations?.[0];
      if (d && this.isOwnFile(d.getSourceFile())) return this.valueOfDecl(d, depth + 1);
      return { v: "unknown", reason: `member '${name}' of unresolved value` };
    }
    if (ts.isElementAccessExpression(e)) {
      const base = this.valueOf(e.expression, depth + 1);
      if (base.v === "object") return { v: "candidates", obj: base.node, selector: e.argumentExpression };
      if (base.v === "dynamic") return base;
      return { v: "dynamic", reason: `computed member call on a value that cannot be resolved statically (${shortText(e.expression, 30)}[…])` };
    }
    return { v: "unknown", reason: `unsupported expression ${ts.SyntaxKind[e.kind]}` };
  }

  valueOfDecl(decl: ts.Declaration, depth: number): Value {
    if (isFunctionWithBody(decl)) {
      const fn = this.fnByNode.get(decl);
      if (fn) return { v: "fn", fn };
    }
    if (ts.isVariableDeclaration(decl)) {
      if (decl.initializer) return this.valueOf(decl.initializer, depth + 1);
      return { v: "unknown", reason: "uninitialised variable" };
    }
    if (ts.isPropertyAssignment(decl)) return this.valueOf(decl.initializer, depth + 1);
    if (ts.isShorthandPropertyAssignment(decl)) return this.valueOf(decl.name, depth + 1);
    if (ts.isClassDeclaration(decl)) return { v: "class", decl };
    if (ts.isPropertyDeclaration(decl) && decl.initializer) return this.valueOf(decl.initializer, depth + 1);
    if (ts.isParameter(decl)) return { v: "unknown", reason: "function parameter (value supplied by caller)" };
    if (ts.isBindingElement(decl)) return { v: "unknown", reason: "destructured binding" };
    return { v: "unknown", reason: `unsupported declaration ${ts.SyntaxKind[decl.kind]}` };
  }

  // ---------------------------------------------------------------- calls
  callTarget(call: ts.CallExpression): CallTarget {
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return { t: "dynamic", reason: "dynamic import() of a runtime-computed module" };
    const callee = skipOuter(call.expression);
    if (ts.isIdentifier(callee) && (callee.text === "eval" || callee.text === "Function")) return { t: "dynamic", reason: "eval / Function constructor" };
    const v = this.valueOf(callee);
    switch (v.v) {
      case "fn":
        return { t: "internal", fn: v.fn };
      case "candidates": {
        const fns: { key: string; fn: FnInfo }[] = [];
        for (const p of v.obj.properties) {
          const key = p.name ? propName(p.name) : undefined;
          if (!key) continue;
          const pv = this.valueOfDecl(p as ts.Declaration, 1);
          if (pv.v === "fn") fns.push({ key, fn: pv.fn });
        }
        if (fns.length) return { t: "dispatch", fns, selector: v.selector, obj: v.obj };
        return { t: "unresolved", reason: "computed member call on object without function members" };
      }
      case "external": {
        const rule = matchRule(v.module, undefined, v.path);
        if (rule) return { t: "api", rule, module: v.module, path: v.path };
        return { t: "external", module: v.module, path: v.path, known: KNOWN_MODULES.has(v.module) || v.module.startsWith("node:") };
      }
      case "global": {
        const rule = matchRule(undefined, v.name, v.path);
        if (rule) return { t: "api", rule, path: v.path };
        if (PURE_GLOBALS.has(v.name) || v.path.length > 0 || /^[a-z]/.test(v.name)) return { t: "pure", name: [v.name, ...v.path].join(".") };
        return { t: "pure", name: v.name };
      }
      case "dynamic":
        return { t: "dynamic", reason: v.reason };
      case "unknown": {
        if (ts.isPropertyAccessExpression(callee) && PURE_METHODS.has(callee.name.text)) return { t: "pure", name: `.${callee.name.text}` };
        let root: ts.Expression = callee;
        while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
        if (ts.isIdentifier(root) && (PURE_GLOBALS.has(root.text) || root.text === "process")) return { t: "pure", name: shortText(callee, 40) };
        return { t: "unresolved", reason: v.reason };
      }
      default:
        return { t: "unresolved", reason: `callee is ${v.v}` };
    }
  }
}

// ---------------------------------------------------------------- helpers
export function isFunctionWithBody(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return (
    (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n)) &&
    !!(n as ts.FunctionLikeDeclaration).body
  );
}

function isInlineCallback(n: ts.Node): boolean {
  const p = n.parent;
  return !!p && (ts.isCallExpression(p) || ts.isNewExpression(p)) && !!p.arguments?.includes(n as ts.Expression);
}

function rootFn(fn: FnInfo): FnInfo {
  let f = fn;
  while (f.inlineParent) f = f.inlineParent;
  return f;
}

function isExported(n: ts.Node): boolean {
  let cur: ts.Node | undefined = n;
  while (cur && !ts.isSourceFile(cur)) {
    const mods = ts.canHaveModifiers(cur) ? ts.getModifiers(cur) : undefined;
    if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
    if (ts.isVariableStatement(cur) || ts.isFunctionDeclaration(cur) || ts.isClassDeclaration(cur)) {
      return !!(ts.getModifiers(cur) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    }
    cur = cur.parent;
  }
  return false;
}

export function symbolPathOf(node: ts.Node): string {
  const parts: string[] = [];
  let cur: ts.Node | undefined = node;
  while (cur && !ts.isSourceFile(cur)) {
    let name: string | undefined;
    if ((ts.isFunctionDeclaration(cur) || ts.isClassDeclaration(cur)) && cur.name) name = cur.name.text;
    else if ((ts.isMethodDeclaration(cur) || ts.isPropertyAssignment(cur) || ts.isPropertyDeclaration(cur)) && cur.name) name = propName(cur.name);
    else if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) name = cur.name.text;
    else if (ts.isConstructorDeclaration(cur)) name = "constructor";
    else if (ts.isObjectLiteralExpression(cur) && ts.isArrayLiteralExpression(cur.parent)) {
      const np = findProp(cur, "name");
      const label = np && ts.isPropertyAssignment(np) && isStringLit(np.initializer) ? np.initializer.text : String(cur.parent.elements.indexOf(cur));
      name = `[${label}]`;
    }
    if (name) parts.unshift(name);
    cur = cur.parent;
  }
  return parts.join(".").replace(/\.\[/g, "[") || "<anonymous>";
}

export function propName(n: ts.PropertyName | ts.Node): string | undefined {
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier(n)) return n.text;
  return undefined;
}

export function findProp(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find((p) => p.name && propName(p.name) === name);
}

export function isStringLit(n: ts.Node | undefined): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
}

export function skipOuter(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isSatisfiesExpression(cur)) {
      cur = cur.expression;
    } else return cur;
  }
}

function importOf(d: ts.Declaration): { module: string; imported: string } | undefined {
  if (ts.isImportSpecifier(d)) {
    const decl = d.parent.parent.parent;
    return { module: (decl.moduleSpecifier as ts.StringLiteral).text, imported: (d.propertyName ?? d.name).text };
  }
  if (ts.isImportClause(d)) return { module: (d.parent.moduleSpecifier as ts.StringLiteral).text, imported: "default" };
  if (ts.isNamespaceImport(d)) return { module: (d.parent.parent.moduleSpecifier as ts.StringLiteral).text, imported: "*" };
  return undefined;
}

export function lineOf(sf: ts.SourceFile, n: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
}

export function endLineOf(sf: ts.SourceFile, n: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
}

export function shortText(n: ts.Node, max = 80): string {
  const t = n.getText().replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
