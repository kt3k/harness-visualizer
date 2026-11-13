/**
 * Harness analyzer (TypeScript/JavaScript adapter).
 *
 * Pipeline: classify calls -> relevance -> tools -> agents -> taint ->
 * projected CFG per function -> context assembly -> state edges -> gating
 * (dominance) -> external events -> prompt rules -> coverage.
 *
 * Static analysis only. Harness code is parsed, never executed.
 */
import ts from "typescript";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  IR_VERSION,
  type Authority,
  type ContextLayer,
  type CoverageReport,
  type EdgeKind,
  type Evidence,
  type EvidenceBasis,
  type HarnessIR,
  type IREdge,
  type IRNode,
  type NodeKind,
  type RedactionLevel,
  type SourceRef,
} from "../core/ir";
import { redact, redactPromptBody } from "../core/redact";
import type { ApiRule } from "./catalog";
import { ProgramIndex, endLineOf, findProp, isStringLit, lineOf, propName, shortText, skipOuter, type CallTarget, type FnInfo } from "./program";
import { canonical, extractRules, keywords, numbersIn, overlap, ruleKeywords } from "./prompts";

export const ANALYZER_VERSION = "0.1.0";

/** Hash of the analyzer's own source, so cached IRs are invalidated when the analyzer changes. */
export const ANALYZER_FINGERPRINT: string = (() => {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const files = [...fs.readdirSync(here).map((f) => path.join(here, f)), path.join(here, "..", "core", "ir.ts"), path.join(here, "..", "core", "redact.ts")]
      .filter((f) => f.endsWith(".ts") && fs.existsSync(f))
      .sort();
    return createHash("sha256").update(files.map((f) => fs.readFileSync(f, "utf8")).join("\0")).digest("hex").slice(0, 16);
  } catch {
    return "unknown";
  }
})();

export interface HarnessConfig {
  id: string;
  name: string;
  description?: string;
  synthetic: boolean;
  version?: string;
  include: string[];
  baseline?: string;
  repository?: { url: string; ref: string; pathPrefix: string };
}

export interface AnalyzeOptions {
  redaction?: RedactionLevel;
}

type CallCls =
  | "model"
  | "model-transport"
  | "effect"
  | "state-read"
  | "state-write"
  | "approval"
  | "approval-named"
  | "internal"
  | "dispatch"
  | "state-push"
  | "pure"
  | "external-known"
  | "external-unknown"
  | "dynamic"
  | "unresolved";

interface CallInfo {
  call: ts.CallExpression;
  owner?: FnInfo;
  target: CallTarget;
  cls: CallCls;
  rule?: ApiRule;
  id?: string;
  storeId?: string;
  wrapper?: FnInfo; // for model calls through a wrapper
  transportCall?: ts.CallExpression;
}

interface Pred {
  ir: string; // IR node id (or '@entry')
  g: string; // node id in the function graph
  label?: string;
  attrs?: Record<string, unknown>;
}

interface FnGraph {
  fn: FnInfo;
  succ: Map<string, { to: string; label?: string; back?: boolean }[]>;
  gToIr: Map<string, string>;
  entries: string[];
  exits: Pred[];
}

interface ToolDef {
  id: string;
  name: string;
  description?: string;
  obj: ts.ObjectLiteralExpression;
  toolSetId?: string;
  varDecl?: ts.VariableDeclaration;
  handler?: FnInfo;
  handlerVia?: string;
}

const APPROVAL_NAME = /(approv|confirm|askHuman|askUser|requestHuman)/i;
const WEBHOOK_NAME = /^(on[A-Z]\w*|handle\w*(Webhook|Event|Callback)|\w*Webhook)$/;
const REJECT_TEXT = /\b(error|deny|denied|reject|rejected|not allowed|forbid|forbidden|invalid|refus|unknown tool|cannot|could not|failed|exceeded|maximum)\b/i;
const BUDGET_TEXT = /(max|limit|budget|depth|timeout|deadline|retries|retry|attempt|turns?\b|steps?\b|elapsed|startedAt)/i;
const CANCEL_TEXT = /(abort|cancel|signal)/i;
const AUTHZ_TEXT = /(deny|denied|allow|permission|authori[sz]|policy|approv|read-only|forbid|mode|host)/i;
const STORE_NAME = /(memory|notes|state|history|session|cache|journal)/i;
const PROMPT_NAME = /(prompt|instruction|system)/i;
const GENERIC = new Set(["run", "file", "files", "input", "tool", "tools", "error", "value", "text", "result", "data", "name", "kind", "reason", "type", "message", "string", "length", "return", "user", "true", "false", "null", "use", "reply"]);

export function loadHarnessConfig(dir: string): HarnessConfig {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "harness.json"), "utf8"));
  return { include: ["src/**/*.ts"], synthetic: false, ...cfg };
}

function globToRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function discoverFiles(dir: string, include: string[]): string[] {
  const res = include.map(globToRe);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const rel = path.relative(dir, p).split(path.sep).join("/");
        if (res.some((r) => r.test(rel))) out.push(rel);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

export function analyzeHarness(dir: string, opts: AnalyzeOptions = {}): HarnessIR {
  return new Analysis(path.resolve(dir), loadHarnessConfig(dir), opts.redaction ?? "standard").run();
}

class Analysis {
  idx!: ProgramIndex;
  files: string[] = [];
  nodes = new Map<string, IRNode>();
  edges = new Map<string, IREdge>();
  calls = new Map<ts.CallExpression, CallInfo>();
  relevant = new Set<FnInfo>();
  policyFns = new Set<FnInfo>();
  agents = new Set<FnInfo>();
  wrappers = new Map<FnInfo, ts.CallExpression>();
  container = new Map<FnInfo, string>();
  tools: ToolDef[] = [];
  toolSets = new Map<string, { id: string; name: string; decl: ts.VariableDeclaration; tools: ToolDef[] }>();
  stateBySymbol = new Map<ts.Symbol, string>();
  callNodeId = new Map<ts.CallExpression, string>();
  graphs = new Map<FnInfo, FnGraph>();
  counters = new Map<string, number>();
  varTaint = new Map<FnInfo, Map<ts.Symbol, Set<string>>>();
  paramTaint = new Map<FnInfo, Set<string>[]>();
  returnTaint = new Map<FnInfo, Set<string>>();
  /** per-property return taint for functions that only return object literals */
  returnPropTaint = new Map<FnInfo, Map<string, Set<string>>>();
  varPropTaint = new Map<ts.Symbol, Map<string, Set<string>>>();
  modelTools = new Map<ts.CallExpression, string[]>();
  eventIdByFn = new Map<FnInfo, string>();
  unresolved: CoverageReport["unresolved"] = [];
  gaps: string[] = [];
  harnessId: string;

  constructor(
    readonly root: string,
    readonly cfg: HarnessConfig,
    readonly redaction: RedactionLevel,
  ) {
    this.harnessId = "harness";
  }

  // ======================================================================
  run(): HarnessIR {
    this.files = discoverFiles(this.root, this.cfg.include);
    const codeFiles = this.files.filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !f.endsWith(".d.ts"));
    this.idx = new ProgramIndex(
      this.root,
      codeFiles.map((f) => path.join(this.root, f)),
    );

    this.addNode({
      id: this.harnessId,
      kind: "Harness",
      label: this.cfg.name,
      summary: this.cfg.description,
      sourceRefs: [{ file: "harness.json", startLine: 1, endLine: 1, role: "config" }],
      evidence: [ev("static", "config", "Harness declared in harness.json")],
    });

    this.classifyCalls();
    this.detectStores();
    this.detectWrappers();
    this.computeRelevance();
    this.collectTools();
    this.detectAgents();
    this.createContainers();
    this.assignCallIds();
    this.computeTaint();
    this.resolveModelTools();
    for (const fn of this.idx.fns) if (this.relevant.has(fn) && !fn.inlineParent) this.walkFunction(fn);
    this.placeOrphanCallNodes();
    this.resolveContexts();
    this.linkStores();
    this.computeEntriesAndEvents();
    this.computeGates();
    this.markSubagents();
    this.computeContainerPorts();
    this.extractPromptRules();
    return this.finish();
  }

  // ====================================================================== helpers
  next(key: string): number {
    const n = this.counters.get(key) ?? 0;
    this.counters.set(key, n + 1);
    return n;
  }

  ref(n: ts.Node, symbol?: string, role: SourceRef["role"] = "code"): SourceRef {
    const sf = n.getSourceFile();
    const first = n.getText(sf).split("\n")[0].trim();
    return {
      file: this.idx.rel(sf.fileName),
      startLine: lineOf(sf, n),
      endLine: endLineOf(sf, n),
      symbol,
      role,
      snippet: redact(first.length > 140 ? `${first.slice(0, 139)}…` : first),
    };
  }

  addNode(p: Partial<IRNode> & { id: string; kind: NodeKind; label: string }): IRNode {
    const existing = this.nodes.get(p.id);
    if (existing) return existing;
    const evidence = p.evidence ?? [];
    const basis: EvidenceBasis = p.assurance?.basis ?? weakest(evidence.map((e) => e.basis));
    const node: IRNode = {
      id: p.id,
      kind: p.kind,
      label: redact(p.label),
      parent: p.parent ?? (p.kind === "Harness" ? undefined : this.harnessId),
      summary: p.summary,
      authority: p.authority,
      sourceRefs: p.sourceRefs ?? [],
      evidence,
      assurance: { basis, ...(p.assurance?.enforcement ? { enforcement: p.assurance.enforcement } : {}) },
      uncertainties: p.uncertainties ?? [],
      attrs: p.attrs ?? {},
    };
    if (node.kind === "Harness") delete node.parent;
    this.nodes.set(node.id, node);
    return node;
  }

  addEdge(kind: EdgeKind, from: string, to: string, p: { label?: string; condition?: string; evidence?: Evidence[]; attrs?: Record<string, unknown> } = {}): IREdge | undefined {
    if (from === to && kind !== "transition" && kind !== "invokes") return undefined;
    const key = `${kind}|${from}|${to}|${p.label ?? ""}`;
    const existing = this.edges.get(key);
    if (existing) {
      existing.attrs.count = ((existing.attrs.count as number) ?? 1) + 1;
      return existing;
    }
    const e: IREdge = {
      id: `${kind}:${from}->${to}${p.label ? `#${p.label}` : ""}`,
      kind,
      from,
      to,
      label: p.label ? redact(p.label) : undefined,
      condition: p.condition ? redact(p.condition) : undefined,
      evidence: p.evidence ?? [],
      attrs: p.attrs ?? {},
    };
    this.edges.set(key, e);
    return e;
  }

  fnContainer(fn: FnInfo): string {
    const root = fn.inlineParent ? this.rootOf(fn) : fn;
    return this.container.get(root) ?? this.harnessId;
  }

  rootOf(fn: FnInfo): FnInfo {
    let f = fn;
    while (f.inlineParent) f = f.inlineParent;
    return f;
  }

  ownCalls(fn: FnInfo): CallInfo[] {
    const out: CallInfo[] = [];
    this.idx.forEachOwn(fn, (n) => {
      if (ts.isCallExpression(n)) {
        const ci = this.calls.get(n);
        if (ci) out.push(ci);
      }
    });
    return out;
  }

  isInteresting(ci: CallInfo): boolean {
    switch (ci.cls) {
      case "model":
      case "model-transport":
      case "effect":
      case "state-read":
      case "state-write":
      case "approval":
      case "approval-named":
      case "dispatch":
      case "state-push":
      case "dynamic":
      case "external-unknown":
        return true;
      case "internal":
        return ci.target.t === "internal" && this.relevant.has(ci.target.fn);
      default:
        return false;
    }
  }

  // ====================================================================== 1. calls
  classifyCalls() {
    for (const sf of this.idx.files) {
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n)) {
          const owner = this.idx.ownerFn(n);
          const target = this.idx.callTarget(n);
          const ci: CallInfo = { call: n, owner, target, cls: "unresolved" };
          switch (target.t) {
            case "internal":
              ci.cls = "internal";
              break;
            case "dispatch":
              ci.cls = "dispatch";
              break;
            case "api":
              ci.rule = target.rule;
              ci.cls = target.rule.cls === "model" ? "model" : target.rule.cls === "approval" ? "approval" : target.rule.cls === "db" ? this.sqlClass(n) : target.rule.cls === "pure" ? "pure" : "effect";
              break;
            case "external":
              ci.cls = target.known ? "external-known" : "external-unknown";
              break;
            case "pure":
              ci.cls = "pure";
              break;
            case "dynamic":
              ci.cls = "dynamic";
              break;
            case "unresolved":
              ci.cls = "unresolved";
              break;
          }
          this.calls.set(n, ci);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }

  sqlClass(call: ts.CallExpression): CallCls {
    const sql = call.arguments[0] && isStringLit(call.arguments[0]) ? call.arguments[0].text : "";
    return /^\s*(select|with)\b/i.test(sql) ? "state-read" : "state-write";
  }

  // ====================================================================== 2. stores
  detectStores() {
    // durable file stores: fs read & write on the same path key, or a memory-like name
    const byKey = new Map<string, { reads: CallInfo[]; writes: CallInfo[]; named: boolean; label: string; decl?: ts.Node }>();
    for (const ci of this.calls.values()) {
      if (ci.cls !== "effect" || !ci.rule?.fsOp || !ci.owner) continue;
      const k = this.pathKey(ci.call.arguments[0]);
      if (!k) continue;
      const e = byKey.get(k.key) ?? { reads: [], writes: [], named: k.named, label: k.label, decl: k.decl };
      (ci.rule.fsOp === "read" ? e.reads : e.writes).push(ci);
      byKey.set(k.key, e);
    }
    for (const [key, e] of byKey) {
      if (!((e.reads.length && e.writes.length) || e.named)) continue;
      const id = `state:file:${key}`;
      this.addNode({
        id,
        kind: "State",
        label: `file store ${e.label}`,
        summary: "Durable file used as agent state/memory (read and/or written by the harness).",
        sourceRefs: e.decl ? [this.ref(e.decl)] : [],
        evidence: [
          ev("static", "ast:fs-path", `fs operations share the path key ${e.label}`),
          ...(e.named && !(e.reads.length && e.writes.length) ? [ev("inferred", "heuristic:name-pattern", "path name suggests a memory/state store")] : []),
        ],
        attrs: { persistence: "durable", medium: "file", locator: e.label },
      });
      for (const ci of [...e.reads, ...e.writes]) {
        ci.cls = ci.rule!.fsOp === "read" ? "state-read" : "state-write";
        ci.storeId = id;
      }
    }
    // database tables
    for (const ci of this.calls.values()) {
      if ((ci.cls === "state-read" || ci.cls === "state-write") && ci.rule?.cls === "db") {
        const sql = ci.call.arguments[0] && isStringLit(ci.call.arguments[0]) ? ci.call.arguments[0].text : undefined;
        const table = sql ? /\b(?:from|into|update)\s+([A-Za-z_][\w.]*)/i.exec(sql)?.[1] : undefined;
        const id = `state:db:${table ?? "unknown"}`;
        this.addNode({
          id,
          kind: "State",
          label: `db table ${table ?? "(unknown)"}`,
          summary: "Database table accessed by the harness.",
          sourceRefs: [this.ref(ci.call)],
          evidence: [ev(table ? "static" : "unknown", "ast:sql-literal", table ? `SQL literal references table ${table}` : "SQL is not a literal; table unknown")],
          attrs: { persistence: "external-db", medium: "postgres", locator: table ?? "?" },
          uncertainties: table ? [] : ["SQL statement is not a string literal"],
        });
        ci.storeId = id;
      }
    }
  }

  pathKey(arg: ts.Expression | undefined): { key: string; label: string; named: boolean; decl?: ts.Node } | undefined {
    if (!arg) return undefined;
    const e = skipOuter(arg);
    if (isStringLit(e)) return { key: e.text, label: e.text, named: STORE_NAME.test(e.text) };
    if (ts.isIdentifier(e)) {
      const { decl } = this.idx.declOf(e);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && isStringLit(decl.initializer)) {
        return { key: decl.initializer.text, label: `${e.text} = "${decl.initializer.text}"`, named: STORE_NAME.test(e.text) || STORE_NAME.test(decl.initializer.text), decl };
      }
    }
    return undefined;
  }

  // ====================================================================== 3. wrappers
  detectWrappers() {
    for (const ci of this.calls.values()) {
      if (ci.cls !== "model" || !ci.owner) continue;
      const fn = ci.owner;
      const arg = ci.call.arguments[0] && skipOuter(ci.call.arguments[0]);
      if (!arg || !ts.isObjectLiteralExpression(arg)) continue;
      const usesParam = arg.properties.some((p) => {
        const expr = ts.isSpreadAssignment(p) ? p.expression : ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : undefined;
        if (!expr) return false;
        let hit = false;
        const visit = (n: ts.Node) => {
          if (ts.isIdentifier(n)) {
            const { decl } = this.idx.declOf(n);
            if (decl && ts.isParameter(decl) && fn.params.includes(decl)) hit = true;
          }
          ts.forEachChild(n, visit);
        };
        visit(expr);
        return hit;
      });
      if (!usesParam) continue;
      const callers = [...this.calls.values()].filter((c) => c.cls === "internal" && c.target.t === "internal" && c.target.fn === fn);
      if (!callers.length) continue;
      this.wrappers.set(fn, ci.call);
      ci.cls = "model-transport";
      for (const c of callers) {
        c.cls = "model";
        c.rule = ci.rule;
        c.wrapper = fn;
        c.transportCall = ci.call;
      }
    }
  }

  // ====================================================================== 4. relevance
  computeRelevance() {
    // state pushes need conversation stores, which need model calls
    this.detectConversationStores();
    for (const ci of this.calls.values()) {
      if (ci.cls === "pure" && ts.isPropertyAccessExpression(ci.call.expression) && ["push", "unshift", "splice"].includes(ci.call.expression.name.text)) {
        const recv = skipOuter(ci.call.expression.expression);
        if (ts.isIdentifier(recv)) {
          const sym = this.idx.symbolOf(recv);
          if (sym && this.stateBySymbol.has(sym)) {
            ci.cls = "state-push";
            ci.storeId = this.stateBySymbol.get(sym);
          }
        }
      }
    }
    const roots = (fn: FnInfo) => this.rootOf(fn);
    for (const ci of this.calls.values()) if (ci.owner && this.isInteresting(ci)) this.relevant.add(roots(ci.owner));
    // policy functions: internal calls used in branch conditions, or assert-style helpers that throw
    for (const ci of this.calls.values()) {
      if (ci.cls !== "internal" || ci.target.t !== "internal" || !ci.owner) continue;
      if (this.usedInCondition(ci.call) || this.throwsConditionally(ci.target.fn)) {
        this.policyFns.add(ci.target.fn);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const ci of this.calls.values()) {
        if (!ci.owner) continue;
        const owner = roots(ci.owner);
        if (this.relevant.has(owner)) continue;
        const callees = ci.target.t === "internal" ? [ci.target.fn] : ci.target.t === "dispatch" ? ci.target.fns.map((f) => f.fn) : [];
        if (callees.some((f) => this.relevant.has(f))) {
          this.relevant.add(owner);
          changed = true;
        }
      }
    }
    // a policy fn is only shown when its caller is relevant
    for (const p of this.policyFns) {
      const callerRelevant = [...this.calls.values()].some((c) => c.target.t === "internal" && c.target.fn === p && c.owner && this.relevant.has(roots(c.owner)));
      if (callerRelevant) this.relevant.add(p);
    }
    // approval by name (asynchronous queues etc.)
    for (const ci of this.calls.values()) {
      if (ci.cls === "internal" && ci.target.t === "internal" && APPROVAL_NAME.test(ci.target.fn.name)) {
        const hasCatalogApproval = this.ownCalls(ci.target.fn).some((c) => c.cls === "approval");
        if (!hasCatalogApproval) ci.cls = "approval-named";
      }
    }
  }

  throwsConditionally(fn: FnInfo): boolean {
    let found = false;
    this.idx.forEachOwn(fn, (n) => {
      if (ts.isThrowStatement(n)) {
        let p: ts.Node | undefined = n.parent;
        while (p && p !== fn.node) {
          if (ts.isIfStatement(p)) found = true;
          p = p.parent;
        }
      }
    });
    return found;
  }

  usedInCondition(call: ts.CallExpression): boolean {
    let cur: ts.Node = call;
    while (cur.parent && !ts.isBlock(cur.parent) && !ts.isSourceFile(cur.parent)) {
      const p: ts.Node = cur.parent;
      if ((ts.isIfStatement(p) && p.expression === cur) || (ts.isSwitchStatement(p) && p.expression === cur) || (ts.isConditionalExpression(p) && p.condition === cur)) return true;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
        const sym = this.idx.symbolOf(p.name);
        const owner = this.idx.ownerFn(p);
        if (!sym || !owner) return false;
        let used = false;
        this.idx.forEachOwn(owner, (n) => {
          if ((ts.isIfStatement(n) || ts.isSwitchStatement(n)) && !used) {
            const visit = (x: ts.Node) => {
              if (ts.isIdentifier(x) && this.idx.symbolOf(x) === sym) used = true;
              ts.forEachChild(x, visit);
            };
            visit(n.expression);
          }
        });
        return used;
      }
      if (ts.isStatement(p)) return false;
      cur = p;
    }
    return false;
  }

  detectConversationStores() {
    for (const ci of this.calls.values()) {
      if (ci.cls !== "model" || !ci.owner) continue;
      const req = this.requestObject(ci);
      if (!req) continue;
      const m = findProp(req, "messages");
      const expr = m && (ts.isPropertyAssignment(m) ? m.initializer : ts.isShorthandPropertyAssignment(m) ? m.name : undefined);
      if (!expr || !m) continue;
      const e = skipOuter(expr);
      if (!ts.isIdentifier(e)) continue;
      const sym = ts.isShorthandPropertyAssignment(m) ? this.idx.symbolOf(m) : this.idx.symbolOf(e);
      const decl = sym?.declarations?.[0];
      if (!sym || !decl || !ts.isVariableDeclaration(decl)) continue;
      if (this.stateBySymbol.has(sym)) continue;
      const owner = this.idx.ownerFn(decl);
      const id = `state:${owner?.key ?? this.idx.rel(decl.getSourceFile().fileName)}/${e.text}`;
      this.stateBySymbol.set(sym, id);
      this.addNode({
        id,
        kind: "State",
        label: `conversation ${owner ? `${owner.symbol}.` : ""}${e.text}`,
        summary: "In-process conversation history passed to model calls. Lost when the run ends.",
        sourceRefs: [this.ref(decl, owner?.symbol)],
        evidence: [ev("static", "ast:messages-slot", `variable passed as 'messages' to a model call`)],
        attrs: { persistence: "ephemeral", medium: "process memory", scope: "per run", locator: e.text },
      });
    }
  }

  requestObject(ci: CallInfo): ts.ObjectLiteralExpression | undefined {
    const a = ci.call.arguments[0] && skipOuter(ci.call.arguments[0]);
    return a && ts.isObjectLiteralExpression(a) ? a : undefined;
  }

  // ====================================================================== 5. tools
  collectTools() {
    const defs: ToolDef[] = [];
    for (const sf of this.idx.files) {
      const visit = (n: ts.Node) => {
        if (ts.isObjectLiteralExpression(n)) {
          const name = toolName(n);
          const isInnerFunction = ts.isPropertyAssignment(n.parent) && propName(n.parent.name) === "function" && ts.isObjectLiteralExpression(n.parent.parent) && !!toolName(n.parent.parent);
          if (name && !isInnerFunction) {
            const arr = ts.isArrayLiteralExpression(n.parent) ? n.parent : undefined;
            const decl = arr && ts.isVariableDeclaration(arr.parent) ? arr.parent : ts.isVariableDeclaration(n.parent) ? n.parent : undefined;
            const descProp = findProp(n, "description") ?? (findInner(n) && findProp(findInner(n)!, "description"));
            const description = descProp && ts.isPropertyAssignment(descProp) && isStringLit(descProp.initializer) ? descProp.initializer.text : undefined;
            defs.push({ id: "", name, description, obj: n, varDecl: decl });
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    for (const d of defs) {
      const file = this.idx.rel(d.obj.getSourceFile().fileName);
      if (d.varDecl && ts.isIdentifier(d.varDecl.name) && d.varDecl.initializer && ts.isArrayLiteralExpression(d.varDecl.initializer)) {
        const setName = d.varDecl.name.text;
        const setId = `toolset:${file}#${setName}`;
        let set = this.toolSets.get(setId);
        if (!set) {
          set = { id: setId, name: setName, decl: d.varDecl, tools: [] };
          this.toolSets.set(setId, set);
        }
        d.toolSetId = setId;
        d.id = `tool:${file}#${setName}.${d.name}`;
        set.tools.push(d);
      } else {
        const v = d.varDecl && ts.isIdentifier(d.varDecl.name) ? d.varDecl.name.text : `L${lineOf(d.obj.getSourceFile(), d.obj)}`;
        d.id = `tool:${file}#${v}`;
      }
      // handler on the definition object
      for (const hp of ["run", "execute", "handler", "invoke", "call", "fn"]) {
        const p = findProp(d.obj, hp);
        if (p) {
          const v = this.idx.valueOfDecl(p as ts.Declaration, 0);
          if (v.v === "fn") {
            d.handler = v.fn;
            d.handlerVia = `property '${hp}' of the tool definition`;
          }
        }
      }
      this.tools.push(d);
    }
    // handler maps: object literals whose keys match a tool set
    for (const sf of this.idx.files) {
      const visit = (n: ts.Node) => {
        if (ts.isObjectLiteralExpression(n) && !toolName(n)) {
          const keys = n.properties.map((p) => (p.name ? propName(p.name) : undefined)).filter((k): k is string => !!k);
          const scored = [...this.toolSets.values()]
            .map((set) => ({ set, hits: keys.filter((k) => set.tools.some((t) => t.name === k)).length }))
            .filter((x) => x.hits >= Math.max(1, Math.ceil(x.set.tools.length / 2)))
            .sort((a, b) => b.hits - a.hits || b.set.tools.length - a.set.tools.length);
          for (const { set } of scored.slice(0, 1)) {
            {
              for (const p of n.properties) {
                const k = p.name ? propName(p.name) : undefined;
                const t = set.tools.find((x) => x.name === k);
                if (!t || t.handler) continue;
                const v = this.idx.valueOfDecl(p as ts.Declaration, 0);
                if (v.v === "fn") {
                  t.handler = v.fn;
                  t.handlerVia = `handler map ${symbolNameOf(n)}`;
                }
              }
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    for (const set of this.toolSets.values()) {
      this.addNode({
        id: set.id,
        kind: "ToolSet",
        label: `tool set ${set.name}`,
        summary: `${set.tools.length} tool definitions that can be offered to a model.`,
        sourceRefs: [this.ref(set.decl, set.name)],
        evidence: [ev("static", "ast:tool-definitions", "array of tool definition objects (name + schema)")],
        attrs: { tools: set.tools.map((t) => t.name) },
      });
    }
    for (const t of this.tools) {
      const handlerCount = this.tools.filter((x) => x.handler && x.handler === t.handler).length;
      this.addNode({
        id: t.id,
        kind: "Tool",
        label: `tool ${t.name}`,
        parent: t.toolSetId ?? this.harnessId,
        summary: t.description,
        authority: "model",
        sourceRefs: [this.ref(t.obj), ...(t.handler ? [this.ref(t.handler.node, t.handler.symbol)] : [])],
        evidence: [
          ev("static", "ast:tool-definition", `tool definition object with name '${t.name}'`),
          ...(t.handler ? [ev("static", "checker:symbol", `handler resolved via ${t.handlerVia}`)] : []),
        ],
        attrs: { name: t.name, description: t.description, handler: t.handler?.key, handlerVia: t.handlerVia, schema: shortText(t.obj, 300) },
        uncertainties: [],
      });
      if (t.handler && handlerCount === 1 && !this.container.has(t.handler)) this.container.set(t.handler, t.id);
    }
  }

  // ====================================================================== 6. agents
  detectAgents() {
    for (const fn of this.relevant) {
      let isAgent = false;
      this.idx.forEachOwn(fn, (n) => {
        if (isAgent || !isLoop(n)) return;
        const visit = (x: ts.Node) => {
          if (ts.isCallExpression(x) && this.calls.get(x)?.cls === "model") isAgent = true;
          const nested = this.idx.fnByNode.get(x);
          if (nested && !nested.inlineParent) return;
          ts.forEachChild(x, visit);
        };
        visit((n as ts.IterationStatement).statement);
      });
      if (isAgent) this.agents.add(fn);
    }
  }

  createContainers() {
    for (const fn of this.idx.fns) {
      if (!this.relevant.has(fn) || fn.inlineParent) continue;
      if (this.container.has(fn)) {
        const tool = this.nodes.get(this.container.get(fn)!);
        if (tool) tool.attrs.handlerFn = fn.symbol;
        continue;
      }
      const isAgent = this.agents.has(fn);
      const id = `${isAgent ? "agent" : "proc"}:${fn.key}`;
      const role = isAgent ? "agent" : this.wrappers.has(fn) ? "model-transport" : this.policyFns.has(fn) ? "policy" : "procedure";
      this.addNode({
        id,
        kind: isAgent ? "Agent" : "Procedure",
        label: isAgent ? `agent ${fn.symbol}` : `${fn.symbol}()`,
        summary: isAgent
          ? "Function containing a loop that calls a model (agent loop)."
          : role === "model-transport"
            ? "Model-call wrapper: forwards caller-supplied context to the SDK. Model calls are attributed to its call sites."
            : role === "policy"
              ? "Predicate/policy function whose result decides a branch."
              : "Procedure on a path to model calls, effects or state.",
        sourceRefs: [this.ref(fn.node, fn.symbol)],
        evidence: [ev("static", "ast:function", isAgent ? "loop containing a model call" : `function classified as ${role}`)],
        attrs: { role, fn: fn.key, exported: fn.exported },
      });
      this.container.set(fn, id);
    }
  }

  assignCallIds() {
    for (const fn of this.idx.fns) {
      if (fn.inlineParent || !this.relevant.has(fn)) continue;
      this.idx.forEachOwn(fn, (n) => {
        if (!ts.isCallExpression(n)) return;
        const ci = this.calls.get(n);
        if (!ci) return;
        const kind = callNodeKind(ci);
        if (!kind) return;
        ci.id = `${kind.toLowerCase()}:${fn.key}/${this.next(`${fn.key}|${kind}`)}`;
      });
    }
  }

  // ====================================================================== 7. taint
  computeTaint() {
    for (const fn of this.idx.fns) {
      if (WEBHOOK_NAME.test(fn.name) && fn.exported && !fn.inlineParent) {
        const id = `event:${fn.key}`;
        this.eventIdByFn.set(fn, id);
        this.paramTaint.set(
          fn,
          fn.params.map(() => new Set([`external:${id}`])),
        );
      }
    }
    // tool handler params are model-controlled
    for (const t of this.tools) {
      if (t.handler) {
        const pt = this.paramTaint.get(t.handler) ?? t.handler.params.map(() => new Set<string>());
        pt.forEach((s) => s.add(`model:${t.id}`));
        this.paramTaint.set(t.handler, pt);
      }
    }
    for (let round = 0; round < 4; round++) {
      for (const fn of this.idx.fns) this.computeVarTaint(fn);
      for (const fn of this.idx.fns) {
        this.returnTaint.set(fn, this.computeReturnTaint(fn));
        const pt = this.computeReturnPropTaint(fn);
        if (pt) this.returnPropTaint.set(fn, pt);
      }
      for (const ci of this.calls.values()) {
        if (!ci.owner) continue;
        const callees = ci.target.t === "internal" ? [ci.target.fn] : ci.target.t === "dispatch" ? ci.target.fns.map((f) => f.fn) : [];
        for (const callee of callees) {
          const pt = this.paramTaint.get(callee) ?? callee.params.map(() => new Set<string>());
          ci.call.arguments.forEach((a, i) => {
            if (!pt[i]) return;
            for (const s of this.expand(this.exprTaint(a, ci.owner!), ci.owner!)) pt[i].add(s);
          });
          this.paramTaint.set(callee, pt);
        }
      }
    }
  }

  computeVarTaint(fn: FnInfo) {
    if (fn.inlineParent) return;
    const map = this.varTaint.get(fn) ?? new Map<ts.Symbol, Set<string>>();
    this.varTaint.set(fn, map);
    const bind = (name: ts.BindingName, t: Set<string>) => {
      if (!t.size) return;
      if (ts.isIdentifier(name)) {
        const sym = this.idx.symbolOf(name);
        if (!sym) return;
        const s = map.get(sym) ?? new Set();
        t.forEach((x) => s.add(x));
        map.set(sym, s);
      } else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bind(el.name, t);
    };
    this.idx.forEachOwn(fn, (n) => {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
        const init = skipOuter(n.initializer);
        const ci = ts.isCallExpression(init) ? this.calls.get(init) : undefined;
        const pt = ci?.target.t === "internal" ? this.returnPropTaint.get(ci.target.fn) : undefined;
        const sym = this.idx.symbolOf(n.name);
        if (pt && sym && ci?.target.t === "internal") {
          const callee = ci.target.fn;
          const mapped = new Map<string, Set<string>>();
          for (const [k, v] of pt) {
            const m = new Set<string>();
            for (const x of v) {
              const pm = /^param:(.*):(\d+)$/.exec(x);
              if (pm && pm[1] === callee.key) {
                const a = (init as ts.CallExpression).arguments[Number(pm[2])];
                if (a) this.exprTaint(a, fn).forEach((y) => m.add(y));
              } else m.add(x);
            }
            mapped.set(k, m);
          }
          this.varPropTaint.set(sym, mapped);
        }
      }
      if (ts.isVariableDeclaration(n) && n.initializer) bind(n.name, this.exprTaint(n.initializer, fn));
      else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) bind(n.left, this.exprTaint(n.right, fn));
      else if (ts.isForOfStatement(n) && ts.isVariableDeclarationList(n.initializer)) {
        const t = this.exprTaint(n.expression, fn);
        for (const d of n.initializer.declarations) bind(d.name, t);
      } else if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isCallExpression(n.parent) && ts.isPropertyAccessExpression(n.parent.expression)) {
        const t = this.exprTaint(n.parent.expression.expression, fn);
        if (n.parameters[0]) bind(n.parameters[0].name, t);
      }
    });
  }

  exprTaint(e: ts.Node, fn: FnInfo): Set<string> {
    const out = new Set<string>();
    const owner = this.rootOf(fn);
    const visit = (n: ts.Node) => {
      const nested = this.idx.fnByNode.get(n);
      if (nested && !nested.inlineParent) return;
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
        const psym = this.idx.symbolOf(n.expression);
        const pt = psym && this.varPropTaint.get(psym);
        if (pt) {
          pt.get(n.name.text)?.forEach((x) => out.add(x));
          return;
        }
      }
      if (ts.isIdentifier(n)) {
        const sym = this.idx.symbolOf(n);
        if (sym) {
          for (const m of [this.varTaint.get(fn), this.varTaint.get(owner)]) m?.get(sym)?.forEach((x) => out.add(x));
          const d = sym.declarations?.[0];
          if (d && ts.isParameter(d)) {
            const pf = this.idx.fnByNode.get(d.parent);
            if (pf && !pf.inlineParent) out.add(`param:${pf.key}:${pf.params.indexOf(d)}`);
          }
        }
      }
      if (ts.isShorthandPropertyAssignment(n)) {
        const sym = this.idx.symbolOf(n);
        if (sym) for (const m of [this.varTaint.get(fn), this.varTaint.get(owner)]) m?.get(sym)?.forEach((x) => out.add(x));
      }
      if (ts.isCallExpression(n)) {
        const ci = this.calls.get(n);
        if (ci?.cls === "model") {
          // the output of a model call is model-controlled; its inputs do not flow into it as taint
          out.add(`model:${ci.id ?? "?"}`);
          return;
        }
        if (ci?.cls === "approval" || ci?.cls === "approval-named") out.add(`human:${ci.id ?? "?"}`);
        const callees = ci?.target.t === "internal" ? [ci.target.fn] : ci?.target.t === "dispatch" ? ci.target.fns.map((f) => f.fn) : [];
        if (ci) {
          for (const callee of callees) {
            for (const s of this.returnTaint.get(callee) ?? []) {
              const m = /^param:(.*):(\d+)$/.exec(s);
              if (m && m[1] === callee.key) {
                const a = n.arguments[Number(m[2])];
                if (a) this.exprTaint(a, fn).forEach((x) => out.add(x));
              } else out.add(s);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(e);
    return out;
  }

  computeReturnTaint(fn: FnInfo): Set<string> {
    const out = new Set<string>();
    if (fn.inlineParent) return out;
    const body = fn.node.body;
    if (!body) return out;
    if (!ts.isBlock(body)) return this.exprTaint(body, fn);
    this.idx.forEachOwn(fn, (n) => {
      if (ts.isReturnStatement(n) && n.expression && this.nearestFn(n) === fn.node) this.exprTaint(n.expression, fn).forEach((x) => out.add(x));
    });
    return out;
  }

  computeReturnPropTaint(fn: FnInfo): Map<string, Set<string>> | undefined {
    if (fn.inlineParent) return undefined;
    const rets = returnExprs(fn).map((r) => skipOuter(r));
    if (!rets.length || !rets.every((r) => ts.isObjectLiteralExpression(r))) return undefined;
    const out = new Map<string, Set<string>>();
    for (const r of rets as ts.ObjectLiteralExpression[]) {
      for (const p of r.properties) {
        const k = p.name ? propName(p.name) : undefined;
        if (!k) return undefined;
        const v = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p : undefined;
        if (!v) return undefined;
        const s = out.get(k) ?? new Set<string>();
        this.exprTaint(v, fn).forEach((x) => s.add(x));
        out.set(k, s);
      }
    }
    return out;
  }

  nearestFn(n: ts.Node): ts.Node | undefined {
    let cur = n.parent;
    while (cur && !this.idx.fnByNode.has(cur)) cur = cur.parent;
    return cur;
  }

  expand(src: Set<string>, _fn: FnInfo, depth = 0): Set<string> {
    const out = new Set<string>();
    for (const s of src) {
      const m = /^param:(.*):(\d+)$/.exec(s);
      if (!m) {
        out.add(s);
        continue;
      }
      if (depth > 6) continue;
      const callee = this.idx.fns.find((f) => f.key === m[1]);
      const pt = callee ? this.paramTaint.get(callee)?.[Number(m[2])] : undefined;
      if (pt) for (const x of this.expand(pt, callee!, depth + 1)) out.add(x);
    }
    return out;
  }

  taintOf(e: ts.Node, fn: FnInfo): Set<string> {
    return this.expand(this.exprTaint(e, fn), fn);
  }

  // ====================================================================== tools offered per model call
  resolveModelTools() {
    for (const ci of this.calls.values()) {
      if (ci.cls !== "model") continue;
      const req = this.requestObject(ci);
      const p = req && findProp(req, "tools");
      const expr = p && (ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : undefined);
      this.modelTools.set(ci.call, expr ? this.toolsOf(expr, 0) : []);
    }
  }

  toolsOf(expr: ts.Expression, depth: number): string[] {
    if (depth > 6) return [];
    const e = skipOuter(expr);
    if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap((x) => (ts.isSpreadElement(x) ? this.toolsOf(x.expression, depth + 1) : this.toolsOf(x, depth + 1)));
    if (ts.isObjectLiteralExpression(e)) {
      const t = this.tools.find((x) => x.obj === e);
      return t ? [t.id] : [];
    }
    if (ts.isIdentifier(e)) {
      const { decl } = this.idx.declOf(e);
      if (decl && ts.isVariableDeclaration(decl)) {
        const set = [...this.toolSets.values()].find((s) => s.decl === decl);
        if (set) return set.tools.map((t) => t.id);
        const single = this.tools.find((t) => t.varDecl === decl);
        if (single) return [single.id];
        if (decl.initializer) return this.toolsOf(decl.initializer, depth + 1);
      }
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) return this.toolsOf(e.expression.expression, depth + 1);
    return [];
  }

  toolByName(name: string, sources: Set<string>): ToolDef | undefined {
    for (const s of sources) {
      const m = /^model:(.*)$/.exec(s);
      if (!m) continue;
      const ci = [...this.calls.values()].find((c) => c.id === m[1]);
      const offered = ci ? this.modelTools.get(ci.call) ?? [] : [];
      const t = this.tools.find((x) => offered.includes(x.id) && x.name === name);
      if (t) return t;
    }
    return this.tools.find((x) => x.name === name);
  }

  // ====================================================================== 8. projected CFG
  walkFunction(fn: FnInfo) {
    const w = new Walker(this, fn);
    w.run();
    this.graphs.set(fn, w.graph);
  }

  placeOrphanCallNodes() {
    for (const ci of this.calls.values()) {
      if (!ci.id || this.callNodeId.has(ci.call) || !ci.owner) continue;
      const node = this.createCallNode(ci, this.fnContainer(ci.owner), this.rootOf(ci.owner));
      if (node) node.uncertainties.push("control-flow position not determined (call outside a supported statement form)");
    }
  }

  createCallNode(ci: CallInfo, parent: string, fn: FnInfo): IRNode | undefined {
    const kind = callNodeKind(ci);
    if (!kind || !ci.id) return undefined;
    const call = ci.call;
    const symbol = fn.symbol;
    const base = { id: ci.id, kind, parent, sourceRefs: [this.ref(call, symbol)] };
    let node: IRNode;
    switch (ci.cls) {
      case "model": {
        const req = this.requestObject(ci);
        const modelProp = req && findProp(req, "model");
        const transportReq = ci.transportCall?.arguments[0] && skipOuter(ci.transportCall.arguments[0]);
        const tModel = transportReq && ts.isObjectLiteralExpression(transportReq) ? findProp(transportReq, "model") : undefined;
        const model = this.constText((modelProp as ts.PropertyAssignment | undefined)?.initializer ?? (tModel as ts.PropertyAssignment | undefined)?.initializer);
        node = this.addNode({
          ...base,
          label: `model call ${ci.rule?.provider ?? ""} ${ci.rule?.api ?? ""}`.replace(/\s+/g, " ").trim(),
          authority: "model",
          summary: "LLM invocation. Output is nondeterministic; downstream handling is listed in outputHandling.",
          evidence: [
            ev("static", "catalog:model-api", `callee resolves to ${ci.rule?.id}`, this.ref(ci.transportCall ?? call)),
            ...(ci.wrapper ? [ev("static", "checker:symbol", `called through wrapper ${ci.wrapper.symbol}(); context taken from this call site`)] : []),
          ],
          attrs: {
            provider: ci.rule?.provider,
            api: ci.rule?.api,
            model,
            context: [],
            toolsOffered: (this.modelTools.get(call) ?? []).map((id) => this.tools.find((t) => t.id === id)?.name),
            transport: ci.transportCall ? this.ref(ci.transportCall) : undefined,
            outputHandling: [],
          },
        });
        if (ci.wrapper) this.addEdge("invokes", node.id, this.container.get(ci.wrapper) ?? this.harnessId, { label: "transport", evidence: [ev("static", "checker:symbol", "model call wrapper")] });
        break;
      }
      case "effect": {
        const rule = ci.rule!;
        const taint = this.taintOf(call, fn);
        const argTaint = call.arguments.map((a) => this.taintOf(a, fn));
        const modelArgs = call.arguments.filter((_a, i) => [...argTaint[i]].some((s) => s.startsWith("model:"))).map((a) => shortText(a, 50));
        node = this.addNode({
          ...base,
          label: `${rule.api}(${call.arguments[0] ? shortText(call.arguments[0], 30) : ""})`,
          authority: "code",
          summary: `Side effect (${rule.category}).`,
          evidence: [ev("static", "catalog:effect-api", `callee resolves to ${rule.id}`)],
          attrs: {
            category: rule.category,
            describe: rule.describe,
            irreversible: rule.irreversible ?? "unknown",
            api: rule.api,
            target: this.effectTarget(ci, fn),
            args: call.arguments.map((a) => redact(shortText(a, 60))),
            modelControlledArgs: modelArgs,
            gatedBy: [],
            dependsOnModel: [...taint].some((s) => s.startsWith("model:")),
          },
        });
        break;
      }
      case "state-read":
      case "state-write": {
        const rule = ci.rule!;
        const isRead = ci.cls === "state-read";
        const sql = call.arguments[0] && isStringLit(call.arguments[0]) ? call.arguments[0].text : undefined;
        node = this.addNode({
          ...base,
          label: `${isRead ? "read" : "write"} ${this.nodes.get(ci.storeId ?? "")?.attrs.locator ?? "store"}`,
          authority: "code",
          summary: isRead ? "Reads persisted state." : "Writes persisted state (also an external side effect).",
          evidence: [ev("static", "catalog:state-api", `callee resolves to ${rule.id}${sql ? `; SQL: ${sql.slice(0, 60)}` : ""}`)],
          attrs: {
            store: ci.storeId,
            api: rule.api,
            sql: sql ? redact(sql) : undefined,
            effectCategory: isRead ? undefined : rule.cls === "db" ? "db.write" : rule.category,
            irreversible: isRead ? false : rule.cls === "db" ? "unknown" : rule.irreversible ?? "unknown",
            gatedBy: [],
          },
        });
        break;
      }
      case "approval":
      case "approval-named": {
        const named = ci.cls === "approval-named";
        node = this.addNode({
          ...base,
          label: named ? `human approval via ${shortText(call.expression, 40)}()` : `human input ${ci.rule?.api}`,
          authority: "human",
          summary: named ? "Asynchronous/indirect human approval request (classified by name)." : "Blocks for a human answer.",
          evidence: named
            ? [ev("static", "checker:symbol", `calls ${shortText(call.expression, 40)}`), ev("inferred", "heuristic:name-pattern", "function name suggests a human approval step")]
            : [ev("static", "catalog:human-input", `callee resolves to ${ci.rule?.id}`)],
          attrs: { mode: named ? "indirect" : "blocking", api: named ? shortText(call.expression, 40) : ci.rule?.api },
        });
        break;
      }
      case "state-push": {
        const arg = call.arguments[0] && skipOuter(call.arguments[0]);
        let content = "value";
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const role = findProp(arg, "role");
          const c = findProp(arg, "content");
          const roleText = role && ts.isPropertyAssignment(role) && isStringLit(role.initializer) ? role.initializer.text : undefined;
          const cText = c && (ts.isPropertyAssignment(c) ? shortText(c.initializer, 50) : ts.isShorthandPropertyAssignment(c) ? c.name.text : "");
          const ctaint = c && ts.isPropertyAssignment(c) ? this.taintOf(c.initializer, fn) : new Set<string>();
          content = `${roleText ?? "?"}: ${cText}${[...ctaint].some((s) => s.startsWith("model:")) ? " (model output)" : ""}`;
        } else if (arg) content = shortText(arg, 50);
        node = this.addNode({
          ...base,
          label: `append to ${this.nodes.get(ci.storeId!)?.attrs.locator ?? "conversation"}`,
          authority: "code",
          summary: "Appends to the in-process conversation history (enters later model calls).",
          evidence: [ev("static", "ast:array-push", "push() on a variable passed as messages to a model call")],
          attrs: { store: ci.storeId, op: "append", content: redact(content) },
        });
        break;
      }
      case "model-transport": {
        node = this.addNode({
          ...base,
          label: `SDK ${ci.rule?.api} (transport)`,
          authority: "code",
          summary: "SDK call inside a model-call wrapper. The model call itself is attributed to each call site of the wrapper.",
          evidence: [ev("static", "catalog:model-api", `callee resolves to ${ci.rule?.id}; request built from wrapper parameters`)],
          attrs: { role: "transport", api: ci.rule?.api },
        });
        break;
      }
      case "dynamic":
      case "external-unknown": {
        const reason = ci.target.t === "dynamic" ? ci.target.reason : ci.target.t === "external" ? `call into uncatalogued module '${ci.target.module}' (${ci.target.path.join(".")})` : "unknown";
        node = this.addNode({
          ...base,
          label: `unknown: ${shortText(call.expression, 40)}`,
          authority: "unknown",
          summary: "Behavior cannot be determined statically.",
          evidence: [ev("unknown", "ast:unresolved-call", reason)],
          attrs: { reason },
          uncertainties: [reason],
        });
        this.unresolved.push({ file: base.sourceRefs[0].file, line: base.sourceRefs[0].startLine, expr: redact(shortText(call, 60)), reason, nodeId: ci.id });
        break;
      }
      default:
        return undefined;
    }
    this.callNodeId.set(call, node.id);
    return node;
  }

  effectTarget(ci: CallInfo, fn: FnInfo): string | undefined {
    const a0 = ci.call.arguments[0] && skipOuter(ci.call.arguments[0]);
    if (ci.rule?.id === "fetch" && a0) {
      const text = ts.isTemplateExpression(a0) ? a0.head.text : isStringLit(a0) ? a0.text : undefined;
      const host = text ? /^https?:\/\/([^/?#]+)/.exec(text)?.[1] : undefined;
      if (host) return host;
      const t = this.taintOf(a0, fn);
      return [...t].some((s) => s.startsWith("model:")) ? "model-supplied URL" : "runtime-computed URL";
    }
    return ci.rule?.target;
  }

  constText(e: ts.Expression | undefined, depth = 0): string | undefined {
    if (!e || depth > 5) return undefined;
    const x = skipOuter(e);
    if (isStringLit(x)) return x.text;
    if (ts.isNumericLiteral(x)) return x.text;
    if (ts.isIdentifier(x)) {
      const { decl } = this.idx.declOf(x);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return this.constText(decl.initializer, depth + 1);
    }
    return undefined;
  }

  constNumber(e: ts.Expression | undefined, depth = 0): number | undefined {
    if (!e || depth > 5) return undefined;
    const x = skipOuter(e);
    if (ts.isNumericLiteral(x)) return Number(x.text.replace(/_/g, ""));
    if (ts.isIdentifier(x)) {
      const { decl } = this.idx.declOf(x);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return this.constNumber(decl.initializer, depth + 1);
    }
    if (ts.isBinaryExpression(x)) {
      const l = this.constNumber(x.left, depth + 1);
      const r = this.constNumber(x.right, depth + 1);
      if (l === undefined || r === undefined) return undefined;
      switch (x.operatorToken.kind) {
        case ts.SyntaxKind.AsteriskToken:
          return l * r;
        case ts.SyntaxKind.PlusToken:
          return l + r;
        case ts.SyntaxKind.MinusToken:
          return l - r;
        case ts.SyntaxKind.SlashToken:
          return l / r;
      }
    }
    return undefined;
  }

  /** Named numeric constants referenced in an expression. */
  constantsIn(e: ts.Node): Record<string, number> {
    const out: Record<string, number> = {};
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && /^[A-Z][A-Z0-9_]+$/.test(n.text)) {
        const v = this.constNumber(n);
        if (v !== undefined) out[n.text] = v;
      }
      ts.forEachChild(n, visit);
    };
    visit(e);
    return out;
  }

  // ====================================================================== 9. context assembly
  resolveContexts() {
    for (const ci of this.calls.values()) {
      if (ci.cls !== "model" || !ci.id || !ci.owner) continue;
      const node = this.nodes.get(ci.id);
      if (!node) continue;
      const fn = this.rootOf(ci.owner);
      const req = this.requestObject(ci);
      const layers: ContextLayer[] = [];
      const push = (slot: string, pieces: Piece[]) => {
        for (const p of pieces) layers.push({ order: layers.length, slot, kind: p.kind, expr: redact(p.expr), ref: p.ref, transforms: p.transforms, certainty: p.certainty });
      };
      if (!req) {
        push("request", [{ kind: "unknown", expr: ci.call.arguments[0] ? shortText(ci.call.arguments[0], 60) : "(no arguments)", transforms: [], certainty: "unresolved" }]);
      } else {
        const slots = ["system", "messages", "input", "tools", "tool_choice", "response_format"];
        for (const slot of slots) {
          const p = findProp(req, slot);
          if (!p) continue;
          const expr = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? (p as unknown as ts.Expression) : undefined;
          if (!expr) continue;
          if (slot === "tools") {
            const ids = this.modelTools.get(ci.call) ?? [];
            push("tools", [{ kind: "tool-definitions", expr: shortText(expr, 60), transforms: ts.isCallExpression(skipOuter(expr)) ? ["filtered/mapped at runtime"] : [], certainty: ids.length ? "resolved" : "unresolved" }]);
            continue;
          }
          if (slot === "tool_choice" || slot === "response_format") {
            node.attrs[slot === "tool_choice" ? "toolChoice" : "structuredOutput"] = shortText(expr, 80);
            if (slot === "tool_choice") {
              for (const tid of this.modelTools.get(ci.call) ?? []) {
                const t = this.nodes.get(tid);
                if (t && expr.getText().includes(String(t.attrs.name))) {
                  t.attrs.structuredOutput = true;
                  t.summary = `${t.summary ?? ""} Forced via tool_choice: used as a structured-output schema, not executed.`.trim();
                }
              }
            }
            continue;
          }
          push(slot, this.pieces(expr, fn, new Map(), 0, [], slot));
        }
        for (const p of req.properties) if (ts.isSpreadAssignment(p)) push("spread", this.pieces(p.expression, fn, new Map(), 0, [], "spread"));
      }
      node.attrs.context = layers;
      for (const l of layers) {
        if (l.ref && this.nodes.has(l.ref)) {
          this.addEdge("context", l.ref, ci.id, {
            label: l.slot,
            evidence: [ev(l.certainty === "resolved" ? "static" : "inferred", "dataflow:context-assembly", `${l.kind} enters '${l.slot}' via ${l.expr}${l.transforms.length ? ` [${l.transforms.join(", ")}]` : ""}`)],
            attrs: { slot: l.slot, transforms: l.transforms, certainty: l.certainty },
          });
        }
        if (l.certainty === "unresolved") {
          node.uncertainties.push(`context slot '${l.slot}' partly unresolved: ${l.expr}`);
          const r = node.sourceRefs[0];
          this.unresolved.push({ file: r.file, line: r.startLine, expr: l.expr, reason: `unresolved context layer in '${l.slot}'`, nodeId: ci.id });
        }
      }
      const ids = this.modelTools.get(ci.call) ?? [];
      const bySet = new Map<string, string[]>();
      for (const id of ids) {
        const t = this.tools.find((x) => x.id === id)!;
        bySet.set(t.toolSetId ?? t.id, [...(bySet.get(t.toolSetId ?? t.id) ?? []), id]);
      }
      for (const [setOrTool, members] of bySet) {
        const set = this.toolSets.get(setOrTool);
        const whole = set && set.tools.length === members.length;
        for (const target of whole ? [setOrTool] : members) {
          this.addEdge("offers", target, ci.id, { label: "tools", evidence: [ev("static", "dataflow:tools-slot", "tool definitions passed in the 'tools' slot")] });
        }
      }
    }
  }

  pieces(expr: ts.Expression, scope: FnInfo, binds: Map<ts.Symbol, { expr: ts.Expression; scope: FnInfo }>, depth: number, tf: string[], slot: string, nameHint?: string): Piece[] {
    const e = ts.isShorthandPropertyAssignment(expr) ? expr : skipOuter(expr);
    const unknown = (reason: string): Piece[] => [{ kind: "unknown", expr: `${shortText(e, 50)} (${reason})`, transforms: tf, certainty: "unresolved" }];
    if (depth > 20) return unknown("depth limit");
    if (isStringLit(e)) return [this.promptOrLiteral(e, e.text, slot, nameHint, tf)];
    if (ts.isTemplateExpression(e)) {
      const text = e.head.text + e.templateSpans.map((s) => `\${…}${s.literal.text}`).join("");
      return [this.promptOrLiteral(e, text, slot, nameHint, tf), ...e.templateSpans.flatMap((s) => this.pieces(s.expression, scope, binds, depth + 1, tf, slot))];
    }
    if (ts.isIdentifier(e) || ts.isShorthandPropertyAssignment(e)) {
      const id = ts.isShorthandPropertyAssignment(e) ? e.name : e;
      const sym = this.idx.symbolOf(e);
      if (sym && binds.has(sym)) {
        const b = binds.get(sym)!;
        return this.pieces(b.expr, b.scope, new Map(), depth + 1, tf, slot);
      }
      if (sym && this.stateBySymbol.has(sym)) {
        const stateId = this.stateBySymbol.get(sym)!;
        const out: Piece[] = [{ kind: "conversation", ref: stateId, expr: id.text, transforms: [...tf, ...this.stateTransforms(sym)], certainty: "resolved" }];
        const decl = sym.declarations?.[0];
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isArrayLiteralExpression(skipOuter(decl.initializer))) {
          out.push(...this.pieces(decl.initializer, this.idx.ownerFn(decl) ?? scope, new Map(), depth + 1, ["initial conversation seed"], slot));
        }
        return out;
      }
      const { decl, importInfo } = ts.isShorthandPropertyAssignment(e) ? { decl: sym?.declarations?.[0], importInfo: undefined } : this.idx.declOf(id);
      if (importInfo) return unknown(`imported from ${importInfo.module}`);
      if (!decl) return unknown("unresolved identifier");
      if (ts.isParameter(decl)) {
        const pf = this.idx.fnByNode.get(decl.parent);
        if (!pf) return unknown("parameter");
        const i = pf.params.indexOf(decl);
        if (pf.inlineParent && ts.isCallExpression(pf.node.parent) && ts.isPropertyAccessExpression(pf.node.parent.expression) && i === 0) {
          return this.pieces(pf.node.parent.expression.expression, this.rootOf(pf), binds, depth + 1, [...tf, `[element via .${pf.node.parent.expression.name.text}()]`], slot);
        }
        const sites = [...this.calls.values()].filter((c) => c.owner && (c.target.t === "internal" && c.target.fn === pf));
        if (!sites.length) {
          const isEntry = pf.exported;
          return [{ kind: isEntry ? "input" : "parameter", expr: isEntry ? `${id.text} (input to entry point ${pf.symbol}())` : `${id.text} (parameter of ${pf.symbol}; no analysed callers)`, transforms: tf, certainty: isEntry ? "resolved" : "unresolved" }];
        }
        return sites.flatMap((c) =>
          c.call.arguments[i] ? this.pieces(c.call.arguments[i], this.rootOf(c.owner!), new Map(), depth + 1, [...tf, `via parameter ${id.text} of ${pf.symbol}()`], slot) : [],
        );
      }
      if (ts.isVariableDeclaration(decl) && !decl.initializer && ts.isVariableDeclarationList(decl.parent) && ts.isForOfStatement(decl.parent.parent)) {
        return this.pieces(decl.parent.parent.expression, this.idx.ownerFn(decl) ?? scope, binds, depth + 1, [...tf, "[loop element]"], slot);
      }
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        return this.pieces(decl.initializer, this.idx.ownerFn(decl) ?? scope, binds, depth + 1, tf, slot, ts.isIdentifier(decl.name) ? decl.name.text : undefined);
      }
      if (ts.isBindingElement(decl)) return unknown("destructured value");
      return unknown("unsupported declaration");
    }
    if (ts.isCallExpression(e)) {
      const ci = this.calls.get(e);
      if (ci) {
        if (ci.cls === "state-read") {
          const nid = this.callNodeId.get(e);
          return [{ kind: "memory", ref: nid, expr: shortText(e, 50), transforms: tf, certainty: nid ? "resolved" : "partial" }];
        }
        if (ci.cls === "model") {
          return [{ kind: "model-output", ref: this.callNodeId.get(e), expr: shortText(e, 50), transforms: tf, certainty: "resolved" }];
        }
        if (ci.cls === "effect" && ci.rule?.fsOp === "read") {
          const a0 = e.arguments[0] && skipOuter(e.arguments[0]);
          const p = a0 && (isStringLit(a0) ? a0.text : undefined);
          if (p) return [this.promptFromFile(p, e, nameHint, tf)];
          return [{ kind: "unknown", expr: `${shortText(e, 50)} (file contents, path not a literal)`, ref: this.callNodeId.get(e), transforms: tf, certainty: "unresolved" }];
        }
        if (ci.target.t === "internal" && this.agents.has(ci.target.fn)) {
          return [{ kind: "model-output", ref: this.container.get(ci.target.fn), expr: `result of ${ci.target.fn.symbol}()`, transforms: [...tf, "agent result"], certainty: "resolved" }];
        }
        if (ci.target.t === "internal") {
          const callee = ci.target.fn;
          const rets = returnExprs(callee);
          if (!rets.length) return unknown(`${callee.symbol}() has no return expression`);
          const nb = new Map<ts.Symbol, { expr: ts.Expression; scope: FnInfo }>();
          callee.params.forEach((p, i) => {
            const s = ts.isIdentifier(p.name) ? this.idx.symbolOf(p.name) : undefined;
            if (s && e.arguments[i]) nb.set(s, { expr: e.arguments[i], scope });
          });
          return rets.flatMap((r) => this.pieces(r, callee, nb, depth + 1, [...tf, `${callee.symbol}()`], slot));
        }
      }
      if (ts.isPropertyAccessExpression(e.expression)) {
        const m = e.expression.name.text;
        const recv = e.expression.expression;
        if (ts.isIdentifier(recv) && recv.text === "Promise") return e.arguments.flatMap((a) => this.pieces(a, scope, binds, depth + 1, [...tf, `Promise.${m}`], slot));
        if (ts.isIdentifier(recv) && recv.text === "JSON") return e.arguments[0] ? this.pieces(e.arguments[0], scope, binds, depth + 1, [...tf, `JSON.${m}`], slot) : [];
        return this.pieces(recv, scope, binds, depth + 1, [...tf, `.${m}(${e.arguments.map((a) => shortText(a, 12)).join(", ")})`], slot);
      }
      return unknown("call result");
    }
    if (ts.isPropertyAccessExpression(e)) return this.pieces(e.expression, scope, binds, depth + 1, [...tf, `.${e.name.text}`], slot);
    if (ts.isElementAccessExpression(e)) return this.pieces(e.expression, scope, binds, depth + 1, [...tf, `[${shortText(e.argumentExpression, 10)}]`], slot);
    if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap((x) => this.pieces(ts.isSpreadElement(x) ? x.expression : x, scope, binds, depth + 1, tf, slot));
    if (ts.isObjectLiteralExpression(e)) {
      const role = findProp(e, "role");
      const roleText = role && ts.isPropertyAssignment(role) && isStringLit(role.initializer) ? role.initializer.text : undefined;
      const content = findProp(e, "content") ?? findProp(e, "text");
      const out: Piece[] = [];
      for (const p of e.properties) if (ts.isSpreadAssignment(p)) out.push(...this.pieces(p.expression, scope, binds, depth + 1, tf, slot));
      if (content) {
        const ce = ts.isPropertyAssignment(content) ? content.initializer : ts.isShorthandPropertyAssignment(content) ? (content as unknown as ts.Expression) : undefined;
        if (ce) out.push(...this.pieces(ce, scope, binds, depth + 1, roleText ? [...tf, `role=${roleText}`] : tf, roleText === "system" ? "system" : slot));
      }
      return out.length ? out : [{ kind: "literal", expr: shortText(e, 50), transforms: tf, certainty: "resolved" }];
    }
    if (ts.isSpreadElement(e)) return this.pieces(e.expression, scope, binds, depth + 1, tf, slot);
    if (ts.isConditionalExpression(e))
      return [...this.pieces(e.whenTrue, scope, binds, depth + 1, [...tf, "conditional"], slot), ...this.pieces(e.whenFalse, scope, binds, depth + 1, [...tf, "conditional"], slot)];
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.PlusToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken))
      return [...this.pieces(e.left, scope, binds, depth + 1, tf, slot), ...this.pieces(e.right, scope, binds, depth + 1, tf, slot)];
    return unknown("unsupported expression");
  }

  stateTransforms(sym: ts.Symbol): string[] {
    const decl = sym.declarations?.[0];
    const owner = decl && this.idx.ownerFn(decl);
    if (!owner) return [];
    const out: string[] = [];
    this.idx.forEachOwn(owner, (n) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && this.idx.symbolOf(n.left) === sym) {
        const r = skipOuter(n.right);
        const ci = ts.isCallExpression(r) ? this.calls.get(r) : undefined;
        if (ci?.target.t === "internal") {
          const callee = ci.target.fn;
          const summarizer = this.ownCalls(callee).find((c) => c.cls === "model");
          out.push(`replaced by ${callee.symbol}()${summarizer?.id ? ` — may summarize older turns with ${summarizer.id}` : ""}`);
        } else out.push(`reassigned: ${shortText(n.right, 40)}`);
      }
    });
    return out;
  }

  promptOrLiteral(n: ts.Node, text: string, slot: string, nameHint: string | undefined, tf: string[]): Piece {
    const staticLen = text.replace(/\$\{…\}/g, "").trim().length;
    const isPrompt = (nameHint && PROMPT_NAME.test(nameHint)) || (slot === "system" && staticLen >= 30) || staticLen >= 120;
    if (!isPrompt) return { kind: "literal", expr: JSON.stringify(text.length > 60 ? `${text.slice(0, 59)}…` : text), transforms: tf, certainty: "resolved" };
    const sf = n.getSourceFile();
    const file = this.idx.rel(sf.fileName);
    const id = nameHint ? `prompt:${file}#${nameHint}` : `prompt:${file}@L${lineOf(sf, n)}`;
    this.addNode({
      id,
      kind: "Prompt",
      label: nameHint ? `prompt ${nameHint}` : `inline prompt (${file}:${lineOf(sf, n)})`,
      summary: "Prompt text. Instructions in it are advisory to the model; they are not enforced by code.",
      sourceRefs: [this.ref(n, nameHint, "prompt")],
      evidence: [ev("static", "ast:string-literal", "prompt text is a literal in source")],
      assurance: { basis: "static", enforcement: "advisory" },
      attrs: { origin: nameHint ? "const" : "inline", text: redactPromptBody(text, this.redaction), chars: text.length, startLine: lineOf(sf, n), file, hasInterpolation: text.includes("${…}") },
    });
    return { kind: "prompt", ref: id, expr: nameHint ?? JSON.stringify(text.slice(0, 40)), transforms: tf, certainty: "resolved" };
  }

  promptFromFile(rel: string, call: ts.Node, nameHint: string | undefined, tf: string[]): Piece {
    const abs = path.join(this.root, rel);
    const id = `prompt:${rel}`;
    if (!fs.existsSync(abs)) {
      return { kind: "unknown", expr: `${rel} (file not found relative to harness root)`, transforms: tf, certainty: "unresolved" };
    }
    const text = fs.readFileSync(abs, "utf8");
    this.addNode({
      id,
      kind: "Prompt",
      label: `prompt file ${rel}`,
      summary: "Prompt loaded from a file. Instructions in it are advisory to the model.",
      sourceRefs: [{ file: rel, startLine: 1, endLine: text.split("\n").length, role: "prompt" }, this.ref(call, nameHint)],
      evidence: [ev("static", "ast:file-read-literal", `read via ${shortText(call, 50)}`), ev("inferred", "assumption:cwd", "path resolved relative to the harness root (process working directory assumed)")],
      assurance: { basis: "static", enforcement: "advisory" },
      attrs: { origin: "file", text: redactPromptBody(text, this.redaction), chars: text.length, startLine: 1, file: rel, loadedAs: nameHint },
      uncertainties: ["runtime working directory assumed to be the harness root"],
    });
    return { kind: "prompt", ref: id, expr: nameHint ?? rel, transforms: tf, certainty: "resolved" };
  }

  // ====================================================================== 10. stores
  linkStores() {
    for (const ci of this.calls.values()) {
      const nid = this.callNodeId.get(ci.call);
      if (!nid || !ci.storeId) continue;
      if (ci.cls === "state-read") this.addEdge("reads", ci.storeId, nid, { evidence: [ev("static", "catalog:state-api", "read of store")] });
      if (ci.cls === "state-write" || ci.cls === "state-push") this.addEdge("writes", nid, ci.storeId, { evidence: [ev("static", "catalog:state-api", "write to store")] });
    }
  }

  // ====================================================================== 11. entries & events
  computeEntriesAndEvents() {
    const called = new Set<FnInfo>();
    for (const ci of this.calls.values()) {
      if (!ci.owner) continue;
      if (ci.target.t === "internal") called.add(ci.target.fn);
      if (ci.target.t === "dispatch") ci.target.fns.forEach((f) => called.add(f.fn));
    }
    for (const t of this.tools) if (t.handler) called.add(t.handler);
    for (const fn of this.idx.fns) {
      if (fn.inlineParent || !this.relevant.has(fn) || called.has(fn) || this.policyFns.has(fn)) continue;
      const container = this.container.get(fn);
      if (!container) continue;
      const webhook = this.eventIdByFn.get(fn);
      const id = webhook ?? `event:entry:${fn.key}`;
      const params = fn.params.map((p) => p.name.getText()).join(", ");
      this.addNode({
        id,
        kind: "ExternalEvent",
        label: webhook ? `webhook ${fn.symbol}(${params})` : `entry ${fn.symbol}(${params})`,
        authority: "external",
        summary: webhook
          ? "Externally triggered handler (classified by name). Its parameters are treated as externally controlled."
          : "Entry point: exported function not called by analysed code; invoked by an external caller.",
        sourceRefs: [this.ref(fn.node, fn.symbol)],
        evidence: webhook ? [ev("static", "ast:exported-fn", "exported function"), ev("inferred", "heuristic:name-pattern", "name suggests an event/webhook handler")] : [ev("static", "callgraph:no-callers", "exported and not called by analysed code")],
        attrs: { trigger: webhook ? "webhook" : "entry", fn: fn.key },
      });
      this.addEdge("transition", id, container, { label: "invoke", evidence: [ev("static", "callgraph:entry", "external invocation")] });
      this.graphs.get(fn)?.entries.length;
    }
    // causal hypothesis: indirect approval request -> webhook that reads the same store
    for (const ci of this.calls.values()) {
      if (ci.cls !== "approval-named" || ci.target.t !== "internal") continue;
      const appr = this.callNodeId.get(ci.call);
      const written = this.ownCalls(ci.target.fn).filter((c) => c.cls === "state-write").map((c) => c.storeId);
      for (const [fn, evId] of this.eventIdByFn) {
        const reads = this.ownCalls(fn).filter((c) => c.cls === "state-read" && written.includes(c.storeId));
        if (appr && reads.length) {
          this.addEdge("causal-hypothesis", appr, evId, {
            label: "decision may arrive via",
            evidence: [ev("inferred", "heuristic:shared-store", `${ci.target.fn.symbol}() writes ${reads[0].storeId} which ${fn.symbol}() reads`)],
            attrs: { store: reads[0].storeId },
          });
        }
      }
    }
  }

  // ====================================================================== 12. gates (dominance)
  /** Guards that throw and dominate every normal exit of their function: calling it asserts the check. */
  assertGuards = new Map<string, string[]>();

  computeAssertGuards() {
    for (const g of this.graphs.values()) {
      const c = this.container.get(g.fn);
      if (!c) continue;
      const guards = [...g.gToIr.values()].filter((id) => {
        const n = this.nodes.get(id);
        return n && (n.kind === "Guard" || n.kind === "Authorization") && n.attrs.rejectExit === "throw";
      });
      if (!guards.length) continue;
      const dom = this.dominators(g);
      const normalExits = g.exits.filter((p) => p.label !== "throw").map((p) => p.g);
      const asserting = [...new Set(guards)].filter((gid) => normalExits.length > 0 && normalExits.every((x) => x === gid || dom.get(x)?.has(gid)));
      if (asserting.length) {
        this.assertGuards.set(c, asserting);
        const n = this.nodes.get(c);
        if (n) n.attrs.asserts = asserting;
      }
    }
  }

  dominators(g: FnGraph): Map<string, Set<string>> {
    const nodes = new Set<string>(["@entry"]);
    for (const [k, v] of g.succ) {
      nodes.add(k);
      v.forEach((x) => nodes.add(x.to));
    }
    const preds = new Map<string, string[]>();
    for (const [k, v] of g.succ) for (const x of v) preds.set(x.to, [...(preds.get(x.to) ?? []), k]);
    const all = [...nodes];
    const dom = new Map<string, Set<string>>();
    for (const n of all) dom.set(n, n === "@entry" ? new Set(["@entry"]) : new Set(all));
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of all) {
        if (n === "@entry") continue;
        const ps = preds.get(n) ?? [];
        let inter: Set<string> | undefined;
        for (const p of ps) {
          const d = dom.get(p)!;
          inter = inter ? new Set([...inter].filter((x) => d.has(x))) : new Set(d);
        }
        const next = ps.length ? new Set([...(inter ?? []), n]) : new Set([n]);
        const cur = dom.get(n)!;
        if (next.size !== cur.size || [...next].some((x) => !cur.has(x))) {
          dom.set(n, next);
          changed = true;
        }
      }
    }
    return dom;
  }

  computeGates() {
    this.computeAssertGuards();
    const intra = new Map<string, Map<string, string[]>>(); // fnKey -> gnode -> gates
    for (const g of this.graphs.values()) intra.set(g.fn.key, this.intraGates(g));
    // call sites of each container: [fnGraph, gnode]
    const sites = new Map<string, { fn: FnInfo; g: string }[]>();
    for (const g of this.graphs.values()) {
      for (const [gid, irId] of g.gToIr) {
        if (gid === irId) continue;
        sites.set(irId, [...(sites.get(irId) ?? []), { fn: g.fn, g: gid }]);
      }
    }
    const routesOf = (fn: FnInfo, gnode: string, depth: number, seen: Set<string>): { via: string[]; gates: string[] }[] => {
      const own = intra.get(fn.key)?.get(gnode) ?? [];
      const c = this.container.get(fn);
      if (!c || depth > 6 || seen.has(c)) return [{ via: [fn.symbol], gates: own }];
      const callers = sites.get(c) ?? [];
      if (!callers.length) return [{ via: [fn.symbol], gates: own }];
      const out: { via: string[]; gates: string[] }[] = [];
      for (const s of callers) {
        for (const r of routesOf(s.fn, s.g, depth + 1, new Set([...seen, c]))) {
          out.push({ via: [...r.via, fn.symbol], gates: [...new Set([...r.gates, ...own])] });
          if (out.length > 12) return out;
        }
      }
      return out;
    };
    for (const g of this.graphs.values()) {
      for (const [gid, irId] of g.gToIr) {
        if (gid !== irId) continue;
        const n = this.nodes.get(irId);
        if (!n || !(n.kind === "Effect" || (n.kind === "MemoryWrite" && n.attrs.effectCategory) || n.kind === "ToolRequest")) continue;
        const routes = routesOf(g.fn, gid, 0, new Set());
        const all = [...new Set(routes.flatMap((r) => r.gates))];
        n.attrs.gatedBy = all;
        n.attrs.routes = routes;
        const enforcing = (id: string) => {
          const k = this.nodes.get(id);
          return !!k && (k.kind === "Authorization" || k.kind === "Guard" || (k.kind === "Decision" && k.authority !== "model"));
        };
        n.attrs.ungatedRoute = routes.some((r) => !r.gates.some(enforcing));
        for (const gate of all) {
          const allRoutes = routes.every((r) => r.gates.includes(gate));
          this.addEdge("gates", gate, irId, {
            label: allRoutes ? "on every analysed route" : "on some routes",
            evidence: [ev("static", "cfg:dominance", `${gate} dominates ${irId} ${allRoutes ? "on every analysed call route" : "only on some call routes"} and has a branch that avoids it`)],
            attrs: { allRoutes },
          });
        }
      }
    }
  }

  intraGates(g: FnGraph): Map<string, string[]> {
    const dom = this.dominators(g);
    const all = [...dom.keys()];
    const reach = (from: string, target: string): boolean => {
      const seen = new Set<string>();
      const stack = [from];
      while (stack.length) {
        const x = stack.pop()!;
        if (x === target) return true;
        if (seen.has(x)) continue;
        seen.add(x);
        for (const s of g.succ.get(x) ?? []) if (!s.back) stack.push(s.to);
      }
      return false;
    };
    const out = new Map<string, string[]>();
    for (const n of all) {
      const gates: string[] = [];
      for (const d of dom.get(n) ?? []) {
        if (d === n || d === "@entry") continue;
        const asserted = d !== g.gToIr.get(d) ? this.assertGuards.get(g.gToIr.get(d) ?? "") : undefined;
        if (asserted) {
          gates.push(...asserted);
          continue;
        }
        const k = this.nodes.get(g.gToIr.get(d) ?? d);
        if (!k || !(k.kind === "Guard" || k.kind === "Authorization" || (k.kind === "Decision" && k.authority !== "model"))) continue;
        const succ = g.succ.get(d) ?? [];
        if (succ.some((s) => s.back || !reach(s.to, n))) gates.push(k.id);
      }
      out.set(n, [...new Set(gates)]);
    }
    return out;
  }

  // ====================================================================== 13. subagents
  markSubagents() {
    const succ = new Map<string, string[]>();
    for (const e of this.edges.values()) {
      if (e.kind !== "invokes" && e.kind !== "dispatches") continue;
      const from = this.containerOf(e.from);
      succ.set(from, [...(succ.get(from) ?? []), e.to]);
    }
    for (const fn of this.agents) {
      const aid = this.container.get(fn)!;
      const reached = new Set<string>();
      const stack = [...(succ.get(aid) ?? [])];
      while (stack.length) {
        const x = stack.pop()!;
        const c = this.containerOf(x);
        if (reached.has(c)) continue;
        reached.add(c);
        stack.push(...(succ.get(c) ?? []));
      }
      for (const other of this.agents) {
        const oid = this.container.get(other)!;
        if (!reached.has(oid)) continue;
        const n = this.nodes.get(oid)!;
        if (other === fn) {
          n.attrs.recursive = true;
          n.summary = `${n.summary} Recursive: can invoke itself (through tools).`;
        } else {
          n.attrs.role = "subagent";
          n.attrs.invokedBy = [...new Set([...((n.attrs.invokedBy as string[]) ?? []), aid])];
        }
      }
    }
    for (const fn of this.agents) {
      const n = this.nodes.get(this.container.get(fn)!)!;
      if (n.attrs.role !== "subagent") n.attrs.role = "agent";
      if (n.attrs.role === "subagent") n.label = n.label.replace(/^agent /, "subagent ");
      n.attrs.modelCalls = this.descendants(n.id).filter((d) => this.nodes.get(d)?.kind === "ModelCall");
      n.attrs.terminations = this.descendants(n.id).filter((d) => this.nodes.get(d)?.kind === "Termination");
    }
  }

  containerOf(id: string): string {
    let cur = this.nodes.get(id);
    while (cur && !["Agent", "Procedure", "Tool", "Harness"].includes(cur.kind)) cur = cur.parent ? this.nodes.get(cur.parent) : undefined;
    return cur?.id ?? id;
  }

  descendants(id: string): string[] {
    const out: string[] = [];
    for (const n of this.nodes.values()) {
      let p = n.parent;
      while (p) {
        if (p === id) {
          out.push(n.id);
          break;
        }
        p = this.nodes.get(p)?.parent;
      }
    }
    return out;
  }

  computeContainerPorts() {
    const isInside = (id: string, c: string) => {
      let p = this.nodes.get(id)?.parent;
      while (p) {
        if (p === c) return true;
        p = this.nodes.get(p)?.parent;
      }
      return false;
    };
    for (const n of this.nodes.values()) {
      if (!["Agent", "Procedure", "Tool", "Loop"].includes(n.kind)) continue;
      const entries = new Set<string>((n.attrs.entryIds as string[]) ?? []);
      const exits = new Set<string>((n.attrs.exitIds as string[]) ?? []);
      for (const e of this.edges.values()) {
        if (e.kind !== "transition") continue;
        // returns from (and calls into) procedures are not entries/exits of the enclosing container
        const fromIsCallee = !!this.nodes.get(e.from) && ["Agent", "Procedure", "Tool"].includes(this.nodes.get(e.from)!.kind) && !isInside(e.from, n.id) && (e.label === "return" || e.label === "throws" || e.label?.startsWith("join"));
        const toIsCallee = !!this.nodes.get(e.to) && ["Agent", "Procedure", "Tool"].includes(this.nodes.get(e.to)!.kind) && !isInside(e.to, n.id);
        // inline tool handlers are shown under their Tool but belong to this function: their fall-through is not an entry
        const fromInlineTool = n.kind !== "Tool" && fnKeyOf(e.from) !== undefined && fnKeyOf(e.from) === fnKeyOf(e.to) && !!this.toolAncestor(e.from);
        if (isInside(e.to, n.id) && !isInside(e.from, n.id) && e.from !== n.id && !fromIsCallee && !fromInlineTool) entries.add(e.to);
        if (isInside(e.from, n.id) && !isInside(e.to, n.id) && e.to !== n.id && !toIsCallee) exits.add(e.from);
      }
      n.attrs.entryIds = [...entries].filter((x) => this.nodes.has(x));
      n.attrs.exitIds = [...exits].filter((x) => this.nodes.has(x));
    }
  }

  // ====================================================================== 14. prompt rules
  extractPromptRules() {
    const gates = [...this.nodes.values()].filter((n) => n.kind === "Guard" || n.kind === "Authorization" || n.kind === "HumanApproval" || (n.kind === "Decision" && n.authority === "code"));
    const gateKw = new Map<string, Set<string>>();
    const gateToolKw = new Map<string, Set<string>>();
    for (const g of gates) {
      const tool = this.toolAncestor(g.id);
      const gated = [...this.edges.values()].filter((e) => e.kind === "gates" && e.from === g.id).map((e) => this.nodes.get(e.to));
      const localGated = gated.filter((x) => x && this.containerOf(x.id) === this.containerOf(g.id));
      const cond = String(g.attrs.condition ?? g.label).replace(/\.(test|has|includes|startsWith|endsWith|match|indexOf|trim|split)\(/g, "(");
      const own = [cond, String(g.attrs.rejectText ?? ""), String(g.attrs.outcomeText ?? "")].join(" ");
      gateKw.set(g.id, keywords(own));
      const ctx = keywords([String(tool?.attrs.name ?? ""), ...localGated.map((x) => `${x?.label} ${x?.attrs.category ?? ""}`), ...this.callersContext(g.id)].join(" "));
      gateToolKw.set(g.id, ctx);
    }
    for (const p of [...this.nodes.values()].filter((n) => n.kind === "Prompt")) {
      if (this.redaction === "strict") continue;
      const text = String(p.attrs.text ?? "");
      const rules = extractRules(text);
      rules.forEach((r, i) => {
        const id = `rule:${p.id.replace(/^prompt:/, "")}/${i}`;
        const kw = ruleKeywords(r.text);
        for (const gk of GENERIC) kw.delete(gk);
        const budgetRule = BUDGET_TEXT.test(r.text);
        const matches = gates
          .filter((g) => budgetRule || !["budget", "cancellation"].includes(String(g.attrs.purpose)))
          .map((g) => {
            const root = canonical;
            const own = [...new Set(overlap(kw, gateKw.get(g.id)!).map(root))];
            const ctxRaw = [...new Set(overlap(kw, gateToolKw.get(g.id)!).map(root))];
            const ctx = ctxRaw.filter((h) => !own.includes(h));
            const bonus = g.kind === "Authorization" && ctxRaw.length > 0 ? 1 : 0;
            return { g, hits: [...own, ...ctx], own: own.length, score: 2 * own.length + ctx.length + bonus };
          })
          .filter((m) => m.own >= 1 && m.score >= 3)
          .sort((a, b) => b.hits.length - a.hits.length || a.g.id.localeCompare(b.g.id))
          .slice(0, 3);
        const toolHits = this.tools
          .map((t) => ({ t, hits: overlap(kw, keywords(`${t.name} ${t.description ?? ""}`)) }))
          .filter((m) => m.hits.some((h) => m.t.name.includes(h) || h.includes(m.t.name.split("_")[0])) && m.hits.length >= 1)
          .slice(0, 4);
        const ruleNums = numbersIn(r.text);
        const mismatches: string[] = [];
        const mismatchBy = new Set<string>();
        for (const m of matches) {
          const consts = (m.g.attrs.constants ?? {}) as Record<string, number>;
          const vals = Object.values(consts);
          if (ruleNums.length && vals.length && !ruleNums.some((x) => vals.some((v) => v === x || v === x * 100))) {
            mismatchBy.add(m.g.id);
            mismatches.push(`rule mentions ${ruleNums.join(", ")}; ${m.g.id} compares against ${Object.entries(consts).map(([k, v]) => `${k} = ${v}`).join(", ")} (check units and thresholds)`);
          }
        }
        const rejecting = matches.some((m) => m.g.kind === "Guard" || m.g.kind === "Authorization");
        const status = matches.length ? (mismatches.length ? "possible-mismatch" : rejecting ? "possibly-enforced" : "related-check") : "prompt-only";
        const line = Number(p.attrs.startLine ?? 1) + r.lineOffset;
        this.addNode({
          id,
          kind: "PromptRule",
          parent: p.id,
          label: r.text.length > 70 ? `${r.text.slice(0, 69)}…` : r.text,
          summary:
            status === "prompt-only"
              ? "Advisory instruction. No code guard with matching terms was found — treat as NOT enforced."
              : status === "possible-mismatch"
                ? "Advisory instruction. A related code guard exists but its threshold appears to differ."
                : status === "related-check"
                  ? "Advisory instruction. A related code decision/approval exists, but no rejecting guard was matched (inferred)."
                : "Advisory instruction. A code guard with overlapping terms exists (inferred correspondence, verify).",
          authority: "model",
          sourceRefs: [{ file: String(p.attrs.file), startLine: line, endLine: line, role: "prompt", snippet: r.text.slice(0, 140) }],
          evidence: [
            ev("static", "text:rule-pattern", `sentence in prompt matches an instruction pattern (${r.polarity})`),
            ...matches.map((m) => ev("inferred", "heuristic:keyword-overlap", `shares terms {${m.hits.join(", ")}} with ${m.g.id}`, m.g.sourceRefs[0], Math.min(0.9, 0.3 + 0.1 * m.hits.length))),
          ],
          assurance: { basis: "static", enforcement: "advisory" },
          attrs: { text: r.text, polarity: r.polarity, status, matchedGuards: matches.map((m) => m.g.id), mismatches, relatedTools: toolHits.map((t) => t.t.id), file: p.attrs.file, line },
          uncertainties: [
            ...(status === "prompt-only" ? ["No matching code guard found. Absence of a match is not proof that no enforcement exists elsewhere."] : ["Correspondence is keyword-based; confirm the guard actually implements this rule."]),
            ...mismatches,
          ],
        });
        for (const m of matches) {
          this.addEdge("corresponds", id, m.g.id, {
            label: mismatchBy.has(m.g.id) ? "related (threshold differs?)" : m.g.kind === "Guard" || m.g.kind === "Authorization" ? "possibly enforced by" : "related check",
            evidence: [ev("inferred", "heuristic:keyword-overlap", `shared terms: ${m.hits.join(", ")}`, undefined, Math.min(0.9, 0.3 + 0.1 * m.hits.length))],
            attrs: { hits: m.hits },
          });
        }
        for (const t of toolHits) {
          this.addEdge("corresponds", id, t.t.id, { label: "mentions tool", evidence: [ev("inferred", "heuristic:keyword-overlap", `shared terms: ${t.hits.join(", ")}`)], attrs: { hits: t.hits } });
        }
      });
    }
  }

  /** Text describing what a guard protects: tools/effects of the functions that call an asserting procedure. */
  callersContext(guardId: string): string[] {
    const out: string[] = [];
    for (const [c, guards] of this.assertGuards) {
      if (!guards.includes(guardId)) continue;
      const procNode = this.nodes.get(c);
      if (procNode) out.push(procNode.label);
      for (const e of this.edges.values()) {
        if (e.kind === "gates" && e.from === guardId) {
          const t = this.toolAncestor(e.to);
          const n = this.nodes.get(e.to);
          out.push(`${t?.attrs.name ?? ""} ${n?.attrs.category ?? ""} ${n?.label ?? ""}`);
        }
      }
    }
    return out;
  }

  toolAncestor(id: string): IRNode | undefined {
    let cur = this.nodes.get(id);
    while (cur) {
      if (cur.kind === "Tool") return cur;
      cur = cur.parent ? this.nodes.get(cur.parent) : undefined;
    }
    return undefined;
  }

  // ====================================================================== 15. coverage & output
  finish(): HarnessIR {
    // model output handling
    for (const n of this.nodes.values()) {
      if (n.kind !== "Decision" && n.kind !== "ToolRequest" && n.kind !== "Guard" && n.kind !== "Authorization") continue;
      const direct =
        n.kind === "ToolRequest" ||
        (n.kind === "Decision" && n.authority === "model") ||
        ((n.kind === "Guard" || n.kind === "Authorization") && n.attrs.purpose === "output-validation");
      if (!direct) continue;
      for (const src of (n.attrs.taintSources as string[]) ?? []) {
        const m = /^model:(.*)$/.exec(src);
        if (!m) continue;
        const mc = this.nodes.get(m[1]);
        if (!mc) continue;
        if (n.kind === "Decision" && this.containerOf(n.id) !== this.containerOf(mc.id) && !this.isInside(n.id, this.containerOf(mc.id))) continue;
        if (mc.kind === "ModelCall") {
          (mc.attrs.outputHandling as { nodeId: string; condition: string }[]).push({ nodeId: n.id, condition: String(n.attrs.condition ?? n.label) });
          this.addEdge("interprets", mc.id, n.id, { label: "output read by", evidence: [ev("static", "dataflow:taint", `condition is data-dependent on the output of ${mc.id}`)] });
        }
      }
    }

    const nodes = [...this.nodes.values()];
    const edges = [...this.edges.values()];
    const linked = new Set<string>();
    for (const e of edges) linked.add(e.from), linked.add(e.to);
    for (const n of nodes) for (const k of ["entryIds", "exitIds"]) for (const x of (n.attrs[k] as string[]) ?? []) linked.add(x);
    const unlinked = nodes.filter((n) => !["Harness", "Agent", "Loop", "Procedure", "ToolSet", "Tool", "Prompt", "State", "PromptRule"].includes(n.kind) && !linked.has(n.id)).map((n) => n.id);
    const byClass: Record<string, number> = {};
    let total = 0;
    for (const ci of this.calls.values()) {
      total++;
      const k = ci.owner ? ci.cls : `module-init:${ci.cls}`;
      byClass[k] = (byClass[k] ?? 0) + 1;
      if (ci.owner && ci.cls === "unresolved" && this.relevant.has(this.rootOf(ci.owner))) {
        const r = this.ref(ci.call);
        this.unresolved.push({ file: r.file, line: r.startLine, expr: redact(shortText(ci.call, 60)), reason: ci.target.t === "unresolved" ? ci.target.reason : "unresolved" });
      }
    }
    for (const t of this.tools) {
      const dispatched = edges.some((e) => e.kind === "dispatches" && e.to === t.id) || edges.some((e) => e.kind === "transition" && this.isInside(e.to, t.id));
      if (!t.handler && !dispatched && !this.nodes.get(t.id)?.attrs.structuredOutput) {
        const n = this.nodes.get(t.id)!;
        n.uncertainties.push("No handler or dispatch site found for this tool definition.");
        this.unresolved.push({ file: n.sourceRefs[0].file, line: n.sourceRefs[0].startLine, expr: t.name, reason: "tool definition without resolved handler", nodeId: t.id });
      }
    }
    const referencedPrompts = new Set(nodes.filter((n) => n.kind === "Prompt").map((n) => n.attrs.file));
    for (const f of this.files.filter((f) => f.endsWith(".md"))) {
      if (!referencedPrompts.has(f)) this.gaps.push(`Prompt file ${f} is not linked to any model call.`);
    }
    const sharedProcs = nodes.filter((n) => n.kind === "Procedure" && edges.filter((e) => e.kind === "transition" && e.to === n.id && e.label === "call").length > 1);
    if (sharedProcs.length) this.gaps.push(`Context-insensitive call graph: ${sharedProcs.length} procedure(s) have several call sites; paths through them are merged (over-approximation).`);
    const extUnknown = [...this.calls.values()].filter((c) => c.cls === "external-unknown");
    if (extUnknown.length) this.gaps.push(`${extUnknown.length} call(s) into uncatalogued external modules are reported as Unknown.`);
    if (!nodes.some((n) => n.kind === "ModelCall"))
      this.gaps.push("No model invocation site was recognised. The harness may use an uncatalogued SDK or wrapper (extend src/analyzer/catalog.ts), or this code is not an agent harness.");
    this.gaps.push("Module-initialisation code (top-level statements) is not part of the control graph; only used for value resolution.");
    this.gaps.push("Exceptions are modelled only for try/catch within a function; cross-function exception flow is approximated by 'throws' edges from call sites inside try blocks.");

    const fileInfos = this.files.map((f) => {
      const buf = fs.readFileSync(path.join(this.root, f));
      return { path: f, sha256: sha256(buf), lines: buf.toString("utf8").split("\n").length };
    });
    const coverage: CoverageReport = {
      filesAnalyzed: fileInfos,
      filesSkipped: [],
      callSites: { total, byClass: Object.fromEntries(Object.entries(byClass).sort()) },
      unresolved: dedupeUnresolved(this.unresolved),
      unlinkedNodes: unlinked,
      sourceLinkCoverage: {
        nodesWithSource: nodes.filter((n) => n.sourceRefs.length > 0).length,
        nodes: nodes.length,
        edgesWithEvidenceRef: edges.filter((e) => e.evidence.length > 0).length,
        edges: edges.length,
      },
      gaps: this.gaps,
    };
    const inputsHash = sha256(JSON.stringify({ v: ANALYZER_VERSION, fp: ANALYZER_FINGERPRINT, cfg: this.cfg, files: fileInfos.map((f) => [f.path, f.sha256]), redaction: this.redaction }));
    return {
      irVersion: IR_VERSION,
      harness: { id: this.cfg.id, name: this.cfg.name, description: this.cfg.description, synthetic: this.cfg.synthetic, version: this.cfg.version, baseline: this.cfg.baseline, repository: this.cfg.repository },
      analysis: { analyzer: "harness-visualizer/ts-adapter", analyzerVersion: ANALYZER_VERSION, adapter: "typescript", inputsHash, redaction: this.redaction },
      nodes,
      edges,
      coverage,
    };
  }

  isInside(id: string, c: string): boolean {
    let p = this.nodes.get(id)?.parent;
    while (p) {
      if (p === c) return true;
      p = this.nodes.get(p)?.parent;
    }
    return false;
  }
}

interface Piece {
  kind: ContextLayer["kind"] | "model-output";
  ref?: string;
  expr: string;
  transforms: string[];
  certainty: ContextLayer["certainty"];
}

// ========================================================================== Walker
interface Frame {
  kind: "loop" | "switch";
  junction?: string;
  breaks: Pred[];
  continues: Pred[];
}

class Walker {
  preds: Pred[] = [];
  parents: string[] = [];
  frames: Frame[] = [];
  trys: { throwers: Pred[] }[] = [];
  graph: FnGraph;
  isTerminal: boolean;
  lastStmt?: ts.Statement;

  constructor(
    readonly a: Analysis,
    readonly fn: FnInfo,
  ) {
    this.graph = { fn, succ: new Map(), gToIr: new Map(), entries: [], exits: [] };
    this.isTerminal = a.agents.has(fn) || (fn.exported && !this.hasCallers());
  }

  hasCallers(): boolean {
    for (const ci of this.a.calls.values()) {
      if (!ci.owner) continue;
      if (ci.target.t === "internal" && ci.target.fn === this.fn) return true;
      if (ci.target.t === "dispatch" && ci.target.fns.some((f) => f.fn === this.fn)) return true;
    }
    return this.a.tools.some((t) => t.handler === this.fn);
  }

  get parent(): string {
    return this.parents[this.parents.length - 1];
  }

  run() {
    const container = this.a.container.get(this.fn)!;
    this.parents.push(container);
    this.preds = [{ ir: "@entry", g: "@entry" }];
    const body = this.fn.node.body!;
    if (ts.isBlock(body)) {
      this.lastStmt = body.statements[body.statements.length - 1];
      for (const s of body.statements) this.stmt(s);
    } else {
      this.expr(body as ts.Expression);
    }
    if (this.preds.length) {
      if (this.isTerminal && this.a.agents.has(this.fn)) {
        this.emitNew("Termination", "completed (end of function)", body, { reason: "fell through end of function", kind: "return" }, "code");
        this.graph.exits.push(...this.preds);
      } else this.graph.exits.push(...this.preds);
    }
    const node = this.a.nodes.get(container)!;
    node.attrs.entryIds = [...new Set([...(((node.attrs.entryIds as string[]) ?? [])), ...this.graph.entries])];
    node.attrs.exitIds = [...new Set([...(((node.attrs.exitIds as string[]) ?? [])), ...this.graph.exits.map((p) => p.ir).filter((x) => x !== "@entry")])];
  }

  // ---------------------------------------------------------------- emission
  link(p: Pred, toIr: string, toG: string) {
    if (p.ir === "@entry") this.graph.entries.push(toIr);
    else this.a.addEdge("transition", p.ir, toIr, { label: p.label, attrs: p.attrs ?? {}, evidence: [ev("static", "cfg:projection", "possible static succession")] });
    const list = this.graph.succ.get(p.g) ?? [];
    list.push({ to: toG, label: p.label, back: !!p.attrs?.backEdge });
    this.graph.succ.set(p.g, list);
    this.graph.gToIr.set(toG, toIr);
    if (p.g !== "@entry") this.graph.gToIr.set(p.g, p.ir);
  }

  emit(id: string) {
    for (const p of this.preds) this.link(p, id, id);
    this.graph.gToIr.set(id, id);
    this.preds = [{ ir: id, g: id }];
    const t = this.trys[this.trys.length - 1];
    const k = this.a.nodes.get(id)?.kind;
    if (t && (k === "ModelCall" || k === "Effect" || k === "Unknown" || k === "ToolRequest" || k === "MemoryWrite" || k === "MemoryRead" || (k === "Junction" && this.a.nodes.get(id)?.attrs.role === "transport"))) t.throwers.push({ ir: id, g: id, label: "throws" });
  }

  emitNew(kind: NodeKind, label: string, at: ts.Node, attrs: Record<string, unknown>, authority: Authority, extra: Partial<IRNode> = {}): string {
    const id = `${kind.toLowerCase()}:${this.fn.key}/${this.a.next(`${this.fn.key}|${kind}`)}`;
    this.a.addNode({
      id,
      kind,
      label,
      parent: this.parent,
      authority,
      sourceRefs: [this.a.ref(at, this.fn.symbol)],
      evidence: extra.evidence ?? [ev("static", "cfg:projection", `${kind} at ${shortText(at, 40)}`)],
      attrs,
      summary: extra.summary,
      uncertainties: extra.uncertainties,
      assurance: extra.assurance,
    });
    this.emit(id);
    return id;
  }

  callContainer(containerId: string, at: ts.Node, label = "call") {
    const g = `${containerId}@${at.getStart()}`;
    for (const p of this.preds) this.link({ ...p, label: p.label ?? label }, containerId, g);
    this.preds = [{ ir: containerId, g, label: "return" }];
    const t = this.trys[this.trys.length - 1];
    if (t) t.throwers.push({ ir: containerId, g, label: "throws" });
    const r = this.a.ref(at);
    const e = this.a.addEdge("invokes", this.a.container.get(this.fn)!, containerId, { evidence: [ev("static", "checker:symbol", `call at ${r.file}:${r.startLine}`)] });
    if (e) {
      const sites = (e.attrs.sites as { file: string; line: number }[] | undefined) ?? [];
      if (!sites.some((x) => x.file === r.file && x.line === r.startLine)) sites.push({ file: r.file, line: r.startLine });
      e.attrs.sites = sites;
    }
  }

  // ---------------------------------------------------------------- statements
  stmt(s: ts.Statement): void {
    if (ts.isBlock(s)) return s.statements.forEach((x) => this.stmt(x));
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) if (d.initializer) this.expr(d.initializer);
      return;
    }
    if (ts.isExpressionStatement(s)) return this.expr(s.expression);
    if (ts.isReturnStatement(s)) {
      if (s.expression) this.expr(s.expression);
      return this.exitStmt(s, "return");
    }
    if (ts.isThrowStatement(s)) {
      this.expr(s.expression);
      return this.exitStmt(s, "throw");
    }
    if (ts.isIfStatement(s)) return this.ifStmt(s);
    if (ts.isSwitchStatement(s)) return this.switchStmt(s);
    if (isLoop(s)) return this.loop(s as ts.IterationStatement);
    if (ts.isTryStatement(s)) return this.tryStmt(s);
    if (ts.isBreakStatement(s)) {
      const f = this.frames[this.frames.length - 1];
      if (f) f.breaks.push(...this.preds);
      this.preds = [];
      return;
    }
    if (ts.isContinueStatement(s)) {
      const f = [...this.frames].reverse().find((x) => x.kind === "loop");
      if (f) f.continues.push(...this.preds);
      this.preds = [];
      return;
    }
    if (ts.isLabeledStatement(s)) return this.stmt(s.statement);
  }

  exitStmt(s: ts.ReturnStatement | ts.ThrowStatement, kind: "return" | "throw") {
    const expr = s.expression;
    if (kind === "throw" && this.trys.length) {
      this.trys[this.trys.length - 1].throwers.push(...this.preds.map((p) => ({ ...p, label: p.label ?? "throw" })));
      this.preds = [];
      return;
    }
    if (this.isTerminal) {
      const reason = expr ? terminationReason(expr) : kind;
      this.emitNew(
        "Termination",
        kind === "throw" ? `error: ${reason}` : `return: ${reason}`,
        s,
        { reason, kind: kind === "throw" ? "error" : "return", expr: expr ? redact(shortText(expr, 80)) : undefined },
        "code",
      );
      this.graph.exits.push(...this.preds);
      this.preds = [];
      return;
    }
    const isLast = s === this.lastStmt;
    if (!isLast) {
      const text = expr ? shortText(expr, 50) : "";
      this.emitNew("Junction", kind === "throw" ? `throw ${text}` : `return ${text}`, s, { role: "exit", exit: kind }, "code");
    }
    this.graph.exits.push(...this.preds.map((p) => ({ ...p, label: p.label ?? kind })));
    this.preds = [];
  }

  // ---------------------------------------------------------------- expressions
  expr(e: ts.Node) {
    const order: (ts.CallExpression | { parallel: ts.CallExpression } | { assign: ts.BinaryExpression })[] = [];
    const collect = (n: ts.Node) => {
      const nested = this.a.idx.fnByNode.get(n);
      if (nested && !nested.inlineParent) return;
      if (ts.isCallExpression(n)) {
        const pe = n.expression;
        if (ts.isPropertyAccessExpression(pe) && ts.isIdentifier(pe.expression) && pe.expression.text === "Promise" && ["all", "allSettled", "race", "any"].includes(pe.name.text)) {
          order.push({ parallel: n });
          return;
        }
        collect(n.expression);
        n.arguments.forEach(collect);
        order.push(n);
        return;
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
        collect(n.right);
        const sym = this.a.idx.symbolOf(n.left);
        if (sym && this.a.stateBySymbol.has(sym)) order.push({ assign: n });
        return;
      }
      ts.forEachChild(n, collect);
    };
    collect(e);
    for (const item of order) {
      if ("parallel" in item) this.parallel(item.parallel);
      else if ("assign" in item) {
        const sym = this.a.idx.symbolOf(item.assign.left)!;
        const store = this.a.stateBySymbol.get(sym)!;
        const id = this.emitNew("MemoryWrite", `replace ${(item.assign.left as ts.Identifier).text}`, item.assign, { store, op: "replace", content: redact(shortText(item.assign.right, 50)) }, "code", {
          evidence: [ev("static", "ast:assignment", "conversation variable reassigned")],
        });
        this.a.addEdge("writes", id, store, { evidence: [ev("static", "ast:assignment", "reassignment of conversation")] });
      } else this.call(item);
    }
  }

  call(c: ts.CallExpression) {
    const ci = this.a.calls.get(c);
    if (!ci) return;
    if (ci.cls === "internal") {
      if (ci.target.t === "internal" && this.a.relevant.has(ci.target.fn)) this.callContainer(this.a.fnContainer(ci.target.fn), c);
      return;
    }
    if (ci.cls === "dispatch" && ci.target.t === "dispatch") return this.dispatch(ci, c);
    if (!ci.id) return;
    const node = this.a.createCallNode(ci, this.parent, this.fn);
    if (!node) return;
    this.emit(node.id);
    if (ci.cls === "approval-named" && ci.target.t === "internal" && this.a.relevant.has(ci.target.fn)) this.callContainer(this.a.fnContainer(ci.target.fn), c);
  }

  dispatch(ci: CallInfo, c: ts.CallExpression) {
    if (ci.target.t !== "dispatch") return;
    const selTaint = this.a.taintOf(ci.target.selector, this.fn);
    const modelSelected = [...selTaint].some((s) => s.startsWith("model:"));
    const id = this.emitNew(
      "ToolRequest",
      `dispatch ${shortText(ci.target.selector, 30)} → handler map`,
      c,
      {
        selector: shortText(ci.target.selector, 60),
        mechanism: "handler-map",
        candidates: ci.target.fns.map((f) => f.key),
        taintSources: [...selTaint],
        modelSelected,
      },
      modelSelected ? "model" : "code",
      {
        summary: modelSelected
          ? "The model chooses which handler runs (selector is derived from model output). Execution happens in the dispatched tool."
          : "Computed dispatch over a handler map.",
        evidence: [ev("static", "checker:object-literal", `computed member call over object literal with ${ci.target.fns.length} function members`), ...(modelSelected ? [ev("static", "dataflow:taint", "selector derived from model output")] : [])],
      },
    );
    const out: Pred[] = [];
    const saved = this.preds;
    for (const f of ci.target.fns) {
      const tool = this.a.toolByName(f.key, selTaint);
      const target = tool && this.a.tools.find((t) => t.id === tool.id)?.handler === f.fn ? tool.id : this.a.fnContainer(f.fn);
      if (!this.a.relevant.has(f.fn) && !this.a.nodes.has(target)) continue;
      this.a.addEdge("dispatches", id, target, { label: f.key, evidence: [ev("static", "checker:object-literal", `handler map key '${f.key}'`)], attrs: { modelSelected } });
      this.preds = saved.map((p) => ({ ...p, label: `tool = ${f.key}` }));
      this.callContainer(target, c, `tool = ${f.key}`);
      out.push(...this.preds);
    }
    this.preds = out.length ? out : saved;
  }

  parallel(c: ts.CallExpression) {
    const combinator = (c.expression as ts.PropertyAccessExpression).name.text;
    const inner: ts.CallExpression[] = [];
    const collect = (n: ts.Node) => {
      const nested = this.a.idx.fnByNode.get(n);
      if (nested && !nested.inlineParent) return;
      if (ts.isCallExpression(n)) {
        n.arguments.forEach(collect);
        collect(n.expression);
        const ci = this.a.calls.get(n);
        if (ci && this.a.isInteresting(ci)) inner.push(n);
        return;
      }
      ts.forEachChild(n, collect);
    };
    c.arguments.forEach(collect);
    const saved = this.preds;
    const out: Pred[] = [];
    for (const call of inner) {
      this.preds = saved.map((p) => ({ ...p, label: `fork (Promise.${combinator})`, attrs: { mode: "parallel", combinator } }));
      this.call(call);
      out.push(...this.preds.map((p) => ({ ...p, label: `join (Promise.${combinator})`, attrs: { mode: "parallel", combinator } })));
      const ci = this.a.calls.get(call);
      if (ci?.target.t === "internal") {
        const e = this.a.addEdge("invokes", this.a.container.get(this.fn)!, this.a.fnContainer(ci.target.fn));
        if (e) e.attrs.mode = "parallel";
      }
    }
    this.preds = inner.length ? out : saved;
  }

  // ---------------------------------------------------------------- branches
  branchInfo(s: ts.Statement | undefined) {
    if (!s) return { interesting: false, exits: undefined as string | undefined, errorish: false, text: "" };
    let interesting = false;
    const visit = (n: ts.Node) => {
      const nested = this.a.idx.fnByNode.get(n);
      if (nested && !nested.inlineParent) return;
      if (ts.isCallExpression(n)) {
        const ci = this.a.calls.get(n);
        if (ci && this.a.isInteresting(ci) && ci.cls !== "state-push") interesting = true;
      }
      if (isLoop(n)) {
        // loops containing interesting calls count
      }
      ts.forEachChild(n, visit);
    };
    visit(s);
    const text = s.getText();
    return { interesting, exits: exitKind(s), errorish: REJECT_TEXT.test(text), text };
  }

  ifStmt(s: ts.IfStatement) {
    this.expr(s.expression);
    if (this.toolDispatchIf(s)) return;
    const cond = shortText(s.expression, 240);
    const then = this.branchInfo(s.thenStatement);
    const els = this.branchInfo(s.elseStatement);
    const cls = this.classifyCondition(s.expression);
    const budget = BUDGET_TEXT.test(cond) && /[^=]>|^>/.test(cond.replace(/=>/g, ""));
    const reject =
      !then.interesting &&
      (then.exits === "throw" ||
        (!!then.exits && then.errorish) ||
        (!!then.exits && budget && !cls.selection.has("model")) ||
        (!then.exits && then.errorish && !!s.elseStatement && els.interesting));
    const needNode = reject || cls.taint.size > 0 || then.interesting || els.interesting || !!then.exits || !!els.exits;
    if (!needNode) {
      const saved = this.preds;
      this.stmt(s.thenStatement);
      const a = this.preds;
      this.preds = saved;
      if (s.elseStatement) this.stmt(s.elseStatement);
      this.preds = [...a, ...this.preds];
      return;
    }
    const constants = this.a.constantsIn(s.expression);
    let id: string;
    if (reject) {
      const purpose = CANCEL_TEXT.test(cond)
        ? "cancellation"
        : budget || Object.keys(constants).some((k) => BUDGET_TEXT.test(k))
          ? "budget"
          : AUTHZ_TEXT.test(cond) || AUTHZ_TEXT.test(then.text)
            ? "authorization"
            : [...cls.taint].some((t) => t.startsWith("model:")) && !this.isHandlerFn() && ![...this.a.exprTaint(s.expression, this.fn)].some((t) => t.startsWith("param:"))
              ? "output-validation"
              : [...cls.taint].some((t) => t.startsWith("model:"))
                ? "input-validation"
                : "validation";
      const kind: NodeKind = purpose === "authorization" ? "Authorization" : "Guard";
      const authority: Authority = cls.kinds.has("human") ? "human" : cls.kinds.has("external") ? "external" : "code";
      const rejectText = rejectionText(s.thenStatement) ?? literalsIn(s.thenStatement);
      id = this.emitNew(kind, `${kind === "Authorization" ? "authz" : "guard"}: ${cond}`, s.expression, { condition: cond, purpose, rejectText, rejectExit: then.exits ?? "value", constants, taintSources: [...cls.taint], validatesModelInput: cls.taint.size > 0 && [...cls.taint].some((t) => t.startsWith("model:")) }, authority, {
        summary: `Code-enforced ${purpose} check. If the condition holds, the ${then.exits ?? "branch"} path rejects.`,
        assurance: { basis: "static", enforcement: "enforced" },
        evidence: [
          ev("static", "cfg:rejecting-branch", `branch ${then.exits === "throw" ? "throws" : then.exits ? `${then.exits}s` : "sets an error result"} without reaching interesting operations`),
          ev(BUDGET_TEXT.test(cond) || CANCEL_TEXT.test(cond) || AUTHZ_TEXT.test(cond) ? "inferred" : "static", "heuristic:purpose", `purpose classified as ${purpose}`),
        ],
      });
    } else {
      const policy = this.a.policyFns.has(this.fn) && !this.a.agents.has(this.fn) && !this.a.ownCalls(this.fn).some((c) => this.a.isInteresting(c));
      const authority: Authority = cls.selection.has("model") && !policy ? "model" : cls.selection.has("human") ? "human" : cls.selection.has("external") ? "external" : "code";
      id = this.emitNew("Decision", `${authority === "model" ? "model-determined" : "branch"}: ${cond}`, s.expression, { condition: cond, outcomeText: literalsIn(s.thenStatement), constants, taintSources: [...cls.taint], validatesModelInput: authority === "code" && [...cls.taint].some((t) => t.startsWith("model:")) }, authority, {
        summary:
          authority === "model"
            ? "Branch selected by model output (the condition compares model output against fixed options)."
            : authority === "code"
              ? [...cls.taint].some((t) => t.startsWith("model:"))
                ? "Code decision on model-supplied data (threshold / predicate defined in code)."
                : "Deterministic branch."
              : `Branch decided by ${authority} input.`,
        evidence: [ev("static", "dataflow:taint", cls.taint.size ? `condition depends on ${[...cls.taint].join(", ")}` : "condition does not depend on model output")],
      });
    }
    this.preds = [{ ir: id, g: id, label: reject ? `reject: ${cond}` : `if ${cond}` }];
    this.stmt(s.thenStatement);
    const thenOut = this.preds;
    this.preds = [{ ir: id, g: id, label: reject ? "pass" : "else" }];
    if (s.elseStatement) this.stmt(s.elseStatement);
    this.preds = [...thenOut, ...this.preds];
  }

  isHandlerFn(): boolean {
    return this.a.tools.some((t) => t.handler === this.fn);
  }

  classifyCondition(e: ts.Expression): { taint: Set<string>; kinds: Set<string>; selection: Set<string> } {
    const taint = this.a.taintOf(e, this.fn);
    const kinds = new Set([...taint].map((t) => t.split(":")[0]));
    const selection = new Set<string>();
    const kindOf = (n: ts.Node) => new Set([...this.a.taintOf(n, this.fn)].map((t) => t.split(":")[0]));
    const visit = (n: ts.Node, truthy: boolean) => {
      if (ts.isParenthesizedExpression(n)) return visit(n.expression, truthy);
      if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) return visit(n.operand, true);
      if (ts.isBinaryExpression(n)) {
        const op = n.operatorToken.kind;
        if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
          visit(n.left, true);
          visit(n.right, true);
          return;
        }
        if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(op)) {
          const lit = (x: ts.Node) => isStringLit(x) || ts.isNumericLiteral(x) || x.kind === ts.SyntaxKind.NullKeyword || x.kind === ts.SyntaxKind.TrueKeyword || x.kind === ts.SyntaxKind.FalseKeyword || (ts.isIdentifier(x) && x.text === "undefined");
          if (lit(n.right) && !ts.isTypeOfExpression(n.left)) kindOf(n.left).forEach((k) => selection.add(k));
          else if (lit(n.left) && !ts.isTypeOfExpression(n.right)) kindOf(n.right).forEach((k) => selection.add(k));
        }
        return;
      }
      if (truthy && (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))) kindOf(n).forEach((k) => selection.add(k));
    };
    visit(e, true);
    return { taint, kinds, selection };
  }

  toolDispatchIf(s: ts.IfStatement): boolean {
    const chain: { lit: string; stmt: ts.Statement; cond: ts.Expression }[] = [];
    let cur: ts.Statement | undefined = s;
    let finalElse: ts.Statement | undefined;
    let taint = new Set<string>();
    while (cur && ts.isIfStatement(cur)) {
      const m = this.toolNameComparison(cur.expression);
      if (!m) break;
      taint = new Set([...taint, ...m.taint]);
      chain.push({ lit: m.lit, stmt: cur.thenStatement, cond: cur.expression });
      cur = cur.elseStatement;
    }
    if (!chain.length) return false;
    if (cur && ts.isIfStatement(cur)) return false; // mixed chain: not a pure dispatch
    finalElse = cur;
    const id = this.emitNew(
      "ToolRequest",
      `dispatch on tool name (${chain.map((c) => c.lit).join(" | ")})`,
      s.expression,
      { selector: shortText(s.expression, 60), mechanism: "if-chain", candidates: chain.map((c) => c.lit), taintSources: [...taint], modelSelected: true },
      "model",
      {
        summary: "The model chooses which branch runs by naming a tool. Each branch is the tool's inline handler.",
        evidence: [ev("static", "dataflow:taint", "compares a model-derived name against tool names")],
      },
    );
    const out: Pred[] = [];
    for (const c of chain) {
      const tool = this.a.toolByName(c.lit, taint);
      this.preds = [{ ir: id, g: id, label: `tool = ${c.lit}` }];
      if (tool) {
        this.a.addEdge("dispatches", id, tool.id, { label: c.lit, evidence: [ev("static", "ast:if-chain", `branch for tool '${c.lit}'`)], attrs: { modelSelected: true } });
        this.parents.push(tool.id);
      }
      const before = this.preds;
      this.stmt(c.stmt);
      if (this.preds === before) {
        // empty handler: still route through the tool container
      }
      if (tool) this.parents.pop();
      out.push(...this.preds);
    }
    this.preds = [{ ir: id, g: id, label: finalElse ? "other tool name" : "no matching tool" }];
    if (finalElse) this.stmt(finalElse);
    this.preds = [...out, ...this.preds];
    return true;
  }

  toolNameComparison(e: ts.Expression): { lit: string; taint: Set<string> } | undefined {
    const names = new Set(this.a.tools.map((t) => t.name));
    let found: { lit: string; taint: Set<string> } | undefined;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)) {
        const [lit, other] = isStringLit(n.right) ? [n.right, n.left] : isStringLit(n.left) ? [n.left, n.right] : [undefined, undefined];
        if (lit && other && names.has(lit.text)) {
          const t = this.a.taintOf(other, this.fn);
          if ([...t].some((x) => x.startsWith("model:"))) found = { lit: lit.text, taint: t };
        }
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        visit(n.left);
        visit(n.right);
      }
    };
    visit(e);
    return found;
  }

  switchStmt(s: ts.SwitchStatement) {
    this.expr(s.expression);
    const cond = shortText(s.expression, 60);
    const taint = this.a.taintOf(s.expression, this.fn);
    const model = [...taint].some((t) => t.startsWith("model:"));
    const labels = s.caseBlock.clauses.filter(ts.isCaseClause).map((c) => (isStringLit(c.expression) ? c.expression.text : shortText(c.expression, 20)));
    const toolNames = new Set(this.a.tools.map((t) => t.name));
    const isDispatch = model && labels.filter((l) => toolNames.has(l)).length >= Math.max(1, Math.ceil(labels.length / 2));
    let id: string;
    if (isDispatch) {
      id = this.emitNew("ToolRequest", `dispatch switch(${cond})`, s.expression, { selector: cond, mechanism: "switch", candidates: labels, taintSources: [...taint], modelSelected: true }, "model", {
        summary: "The model chooses which case runs by naming a tool. Each case is the tool's inline handler.",
        evidence: [ev("static", "dataflow:taint", "switch over a model-derived tool name")],
      });
    } else {
      const cls = this.classifyCondition(s.expression);
      const authority: Authority = model ? "model" : cls.kinds.has("human") ? "human" : cls.kinds.has("external") ? "external" : "code";
      id = this.emitNew("Decision", `${authority === "model" ? "model-determined" : "branch"}: switch(${cond})`, s.expression, { condition: `switch(${cond})`, cases: labels, taintSources: [...taint] }, authority, {
        summary: authority === "model" ? "Branch selected by model output: each case is one option the model can produce." : "Deterministic multi-way branch.",
        evidence: [ev("static", "dataflow:taint", taint.size ? `discriminant depends on ${[...taint].join(", ")}` : "discriminant does not depend on model output")],
      });
    }
    const frame: Frame = { kind: "switch", breaks: [], continues: [] };
    this.frames.push(frame);
    let fall: Pred[] = [];
    let hasDefault = false;
    for (const clause of s.caseBlock.clauses) {
      const lab = ts.isCaseClause(clause) ? (isStringLit(clause.expression) ? clause.expression.text : shortText(clause.expression, 20)) : "default";
      if (!ts.isCaseClause(clause)) hasDefault = true;
      this.preds = [...fall, { ir: id, g: id, label: isDispatch ? `tool = ${lab}` : ts.isCaseClause(clause) ? `case ${lab}` : "default" }];
      const tool = isDispatch && ts.isCaseClause(clause) ? this.a.toolByName(lab, taint) : undefined;
      if (tool) {
        this.a.addEdge("dispatches", id, tool.id, { label: lab, evidence: [ev("static", "ast:switch-case", `case for tool '${lab}'`)], attrs: { modelSelected: true } });
        this.parents.push(tool.id);
      }
      for (const st of clause.statements) this.stmt(st);
      if (tool) this.parents.pop();
      fall = this.preds;
    }
    this.frames.pop();
    this.preds = [...fall, ...frame.breaks, ...(hasDefault ? [] : [{ ir: id, g: id, label: "no case matched" }])];
  }

  // ---------------------------------------------------------------- loops
  loop(s: ts.IterationStatement) {
    let interesting = false;
    const visit = (n: ts.Node) => {
      const nested = this.a.idx.fnByNode.get(n);
      if (nested && !nested.inlineParent) return;
      if (ts.isCallExpression(n)) {
        const ci = this.a.calls.get(n);
        if (ci && this.a.isInteresting(ci)) interesting = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(s);
    if (ts.isForStatement(s) && s.initializer) {
      if (ts.isVariableDeclarationList(s.initializer)) s.initializer.declarations.forEach((d) => d.initializer && this.expr(d.initializer));
      else this.expr(s.initializer);
    }
    if (ts.isForOfStatement(s) || ts.isForInStatement(s)) this.expr(s.expression);
    if (!interesting) {
      // plain loop: walk body once, allow re-entry approximately
      const frame: Frame = { kind: "loop", breaks: [], continues: [] };
      this.frames.push(frame);
      const saved = this.preds;
      this.stmt(s.statement);
      this.frames.pop();
      this.preds = [...saved, ...this.preds, ...frame.breaks, ...frame.continues];
      return;
    }
    const cond = ts.isForStatement(s) ? (s.condition ? shortText(s.condition, 60) : "") : ts.isWhileStatement(s) || ts.isDoStatement(s) ? shortText(s.expression, 60) : ts.isForOfStatement(s) ? `${shortText(s.initializer, 30)} of ${shortText(s.expression, 40)}` : shortText(s, 40);
    const infinite = (ts.isForStatement(s) && !s.condition) || ((ts.isWhileStatement(s) || ts.isDoStatement(s)) && s.expression.kind === ts.SyntaxKind.TrueKeyword);
    let hasModel = false;
    let hasTry = false;
    const v2 = (n: ts.Node) => {
      const nested = this.a.idx.fnByNode.get(n);
      if (nested && !nested.inlineParent) return;
      if (ts.isCallExpression(n) && this.a.calls.get(n)?.cls === "model") hasModel = true;
      if (ts.isCallExpression(n) && this.a.calls.get(n)?.cls === "model-transport") hasModel = true;
      if (ts.isTryStatement(n)) hasTry = true;
      if (isLoop(n) && n !== s) return;
      ts.forEachChild(n, v2);
    };
    v2(s.statement);
    const counterName = ts.isForStatement(s) && s.initializer && ts.isVariableDeclarationList(s.initializer) ? s.initializer.declarations[0]?.name.getText() : "";
    const loopType = hasTry && /attempt|retr|tries/i.test(`${counterName} ${cond}`) ? "retry" : hasModel ? (this.a.wrappers.has(this.fn) ? "retry" : "agent") : ts.isForOfStatement(s) ? "iteration" : "loop";
    const constants = infinite ? {} : this.a.constantsIn(ts.isForStatement(s) ? s.condition ?? s : ts.isWhileStatement(s) || ts.isDoStatement(s) || ts.isForOfStatement(s) || ts.isForInStatement(s) ? s.expression : s);
    const loopId = `loop:${this.fn.key}/${this.a.next(`${this.fn.key}|Loop`)}`;
    this.a.addNode({
      id: loopId,
      kind: "Loop",
      label: `${loopType} loop${cond ? ` (${cond})` : " (unbounded header)"}`,
      parent: this.parent,
      authority: "code",
      summary:
        loopType === "agent"
          ? "Agent loop: each iteration calls a model and acts on its output."
          : loopType === "retry"
            ? "Retry loop around a failing operation."
            : "Iteration over a collection.",
      sourceRefs: [this.a.ref(s, this.fn.symbol)],
      evidence: [ev("static", "ast:loop", `${ts.SyntaxKind[s.kind]} containing ${hasModel ? "a model call" : "interesting operations"}`), ...(loopType === "retry" ? [ev("inferred", "heuristic:retry-pattern", "loop with try/catch and an attempt counter")] : [])],
      attrs: { loopType, condition: cond, infinite, constants, counter: counterName || undefined },
      uncertainties: infinite ? ["Loop header has no bound; termination depends on exits inside the body."] : [],
    });
    this.parents.push(loopId);
    const jid = `junction:${loopId}`;
    this.a.addNode({
      id: jid,
      kind: "Junction",
      label: infinite ? "loop head (∞)" : `loop head: ${cond}`,
      parent: loopId,
      authority: "code",
      sourceRefs: [this.a.ref(ts.isForStatement(s) ? s.condition ?? s : ts.isWhileStatement(s) || ts.isDoStatement(s) ? s.expression : ts.isForOfStatement(s) || ts.isForInStatement(s) ? s.expression : s, this.fn.symbol)],
      evidence: [ev("static", "cfg:loop-head", "control location at the start of each iteration")],
      attrs: { role: "loop-head", condition: cond, constants },
    });
    this.preds = this.preds.map((p) => ({ ...p, label: p.label ?? "enter" }));
    this.emit(jid);
    const frame: Frame = { kind: "loop", junction: jid, breaks: [], continues: [] };
    this.frames.push(frame);
    this.preds = [{ ir: jid, g: jid, label: cond && !infinite ? `iterate while ${cond}` : "iterate" }];
    this.stmt(s.statement);
    this.frames.pop();
    for (const p of this.preds) this.link({ ...p, label: "next iteration", attrs: { backEdge: true } }, jid, jid);
    for (const p of frame.continues) this.link({ ...p, label: p.label ?? "next iteration", attrs: { backEdge: true } }, jid, jid);
    this.parents.pop();
    this.preds = [...(infinite ? [] : [{ ir: jid, g: jid, label: ts.isForOfStatement(s) ? "exit: iteration complete" : `exit: !(${cond})`, attrs: { budget: constants } }]), ...frame.breaks];
  }

  tryStmt(s: ts.TryStatement) {
    const frame = { throwers: [] as Pred[] };
    const atStart = this.preds;
    this.trys.push(frame);
    this.stmt(s.tryBlock);
    this.trys.pop();
    const tryOut = this.preds;
    let catchOut: Pred[] = [];
    if (s.catchClause) {
      this.preds = frame.throwers.length ? frame.throwers.map((p) => ({ ...p, label: p.label ?? "throws" })) : atStart.map((p) => ({ ...p, label: "throws (any call in try block)" }));
      this.stmt(s.catchClause.block);
      catchOut = this.preds;
    } else if (this.trys.length) this.trys[this.trys.length - 1].throwers.push(...frame.throwers);
    this.preds = [...tryOut, ...catchOut];
    if (s.finallyBlock) this.stmt(s.finallyBlock);
  }
}

// ========================================================================== small helpers
function ev(basis: EvidenceBasis, method: string, claim: string, ref?: SourceRef, confidence?: number): Evidence {
  const e: Evidence = { basis, method, claim: redact(claim) };
  if (ref) e.ref = ref;
  if (confidence !== undefined) e.confidence = Math.round(confidence * 100) / 100;
  return e;
}

function weakest(bases: EvidenceBasis[]): EvidenceBasis {
  if (!bases.length) return "unknown";
  const order: EvidenceBasis[] = ["unknown", "inferred", "runtime", "static"];
  return bases.reduce((a, b) => (order.indexOf(a) < order.indexOf(b) ? a : b));
}

function isLoop(n: ts.Node): boolean {
  return ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n);
}

function callNodeKind(ci: CallInfo): NodeKind | undefined {
  switch (ci.cls) {
    case "model-transport":
      return "Junction";
    case "model":
      return "ModelCall";
    case "effect":
      return "Effect";
    case "state-read":
      return "MemoryRead";
    case "state-write":
    case "state-push":
      return "MemoryWrite";
    case "approval":
    case "approval-named":
      return "HumanApproval";
    case "dynamic":
    case "external-unknown":
      return "Unknown";
    default:
      return undefined;
  }
}

function toolName(n: ts.ObjectLiteralExpression): string | undefined {
  const np = findProp(n, "name");
  const hasSchema = ["input_schema", "inputSchema", "parameters"].some((k) => findProp(n, k));
  if (np && ts.isPropertyAssignment(np) && isStringLit(np.initializer) && hasSchema) return np.initializer.text;
  const inner = findInner(n);
  if (inner) {
    const ip = findProp(inner, "name");
    if (ip && ts.isPropertyAssignment(ip) && isStringLit(ip.initializer) && findProp(inner, "parameters")) return ip.initializer.text;
  }
  return undefined;
}

function findInner(n: ts.ObjectLiteralExpression): ts.ObjectLiteralExpression | undefined {
  const f = findProp(n, "function");
  return f && ts.isPropertyAssignment(f) && ts.isObjectLiteralExpression(f.initializer) ? f.initializer : undefined;
}

function symbolNameOf(n: ts.Node): string {
  return ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : `object@${lineOf(n.getSourceFile(), n)}`;
}

function exitKind(s: ts.Statement | undefined): string | undefined {
  if (!s) return undefined;
  if (ts.isReturnStatement(s)) return "return";
  if (ts.isThrowStatement(s)) return "throw";
  if (ts.isContinueStatement(s)) return "continue";
  if (ts.isBreakStatement(s)) return "break";
  if (ts.isBlock(s)) return exitKind(s.statements[s.statements.length - 1]);
  if (ts.isIfStatement(s) && s.elseStatement) {
    const a = exitKind(s.thenStatement);
    const b = exitKind(s.elseStatement);
    return a && b ? a : undefined;
  }
  return undefined;
}

function literalsIn(s: ts.Statement): string | undefined {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (out.length > 6) return;
    if (isStringLit(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) out.push(n.head.text);
    if (ts.isFunctionLike(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(s);
  return out.length ? redact(out.join(" ").slice(0, 120)) : undefined;
}

function rejectionText(s: ts.Statement): string | undefined {
  let found: string | undefined;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (isStringLit(n) && REJECT_TEXT.test(n.text)) found = n.text;
    else if (ts.isTemplateExpression(n) && REJECT_TEXT.test(n.head.text)) found = `${n.head.text}…`;
    ts.forEachChild(n, visit);
  };
  visit(s);
  return found ? redact(found.slice(0, 80)) : undefined;
}

function terminationReason(e: ts.Expression): string {
  const x = skipOuter(e);
  if (ts.isObjectLiteralExpression(x)) {
    for (const k of ["outcome", "status", "reason", "result"]) {
      const p = findProp(x, k);
      if (p && ts.isPropertyAssignment(p)) return isStringLit(p.initializer) ? p.initializer.text : shortText(p.initializer, 30);
    }
    return shortText(x, 40);
  }
  if (isStringLit(x)) return x.text.length > 50 ? `${x.text.slice(0, 49)}…` : x.text;
  if (ts.isNewExpression(x) && x.arguments?.[0]) {
    const a = x.arguments[0];
    return isStringLit(a) ? a.text : ts.isTemplateExpression(a) ? `${a.head.text}…` : shortText(a, 40);
  }
  return shortText(x, 40);
}

function returnExprs(fn: FnInfo): ts.Expression[] {
  const body = fn.node.body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body as ts.Expression];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node) => {
    if (n !== body && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  visit(body);
  return out;
}

/** Function key embedded in a node id (`kind:file#symbol/n`). */
function fnKeyOf(id: string): string | undefined {
  const m = /^[a-z]+:(.+#.+)\/\d+$/.exec(id);
  return m ? m[1] : undefined;
}

function dedupeUnresolved(list: CoverageReport["unresolved"]): CoverageReport["unresolved"] {
  const seen = new Set<string>();
  return list.filter((u) => {
    const k = `${u.file}:${u.line}:${u.reason}:${u.expr}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
