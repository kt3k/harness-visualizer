/**
 * Static/runtime reconciliation. Maps trace events to IR nodes, explains
 * observed successions with static paths, reports unexplained successions,
 * unobserved static branches (never called "unreachable") and violations of
 * enforceable invariants.
 *
 * An observed succession A→B is temporal order only. It is "explained" when a
 * static control path exists from A to B whose interior nodes are of kinds
 * that this trace does not instrument; it is never reported as causation.
 */
import { IRIndex } from "./graph";
import type { HarnessIR, IRNode, NodeKind, SourceRef } from "./ir";
import type { Trace, TraceEvent, TraceEventType } from "./trace";

const EXPECTED: Partial<Record<TraceEventType, NodeKind[]>> = {
  "run.start": ["Harness"],
  "run.end": ["Harness"],
  "agent.start": ["Agent"],
  "agent.end": ["Agent"],
  "loop.iteration": ["Loop", "Junction"],
  "model.request": ["ModelCall"],
  "model.response": ["ModelCall"],
  decision: ["Decision", "Guard", "Authorization"],
  "tool.request": ["ToolRequest", "Tool"],
  "authz.decision": ["Authorization", "Guard", "Decision"],
  "approval.request": ["HumanApproval"],
  "approval.response": ["HumanApproval"],
  "tool.execute": ["Effect", "MemoryWrite", "Tool", "Unknown"],
  "tool.result": ["Effect", "MemoryWrite", "Tool", "Unknown"],
  "state.read": ["MemoryRead"],
  "state.write": ["MemoryWrite"],
  termination: ["Termination"],
  "external.event": ["ExternalEvent"],
};

/**
 * Event types that represent a control step (used for successions). `tool.request`
 * marks the model's request (logically before authorization) and opens a span; it
 * is mapped and counted but not used as a step, since dispatch code may run after
 * the authorization checks.
 */
const STEP_TYPES = new Set<TraceEventType>(["model.request", "decision", "authz.decision", "approval.request", "tool.execute", "state.read", "state.write", "termination", "external.event"]);

export interface MappedEvent {
  trace: string;
  seq: number;
  type: TraceEventType;
  nodeId?: string;
  via?: "nodeId" | "loc" | "name";
  reason?: string;
}

export interface Reconciliation {
  traces: { id: string; label?: string; events: number; mapped: number; parseErrors: number; terminations: string[] }[];
  mapping: MappedEvent[];
  mappingCoverage: { mapped: number; total: number };
  observedNodes: Record<string, number>;
  observedEdges: Record<string, number>;
  nodeCoverage: { observableNodes: number; observedNodes: number };
  unexplained: { trace: string; fromSeq: number; toSeq: number; from: string; to: string; note: string }[];
  unobservedBranches: { nodeId: string; edgeId: string; label?: string; source?: SourceRef; note: string }[];
  unobservedNodes: string[];
  violations: { trace: string; seq: number; invariant: string; detail: string; nodeId?: string; source?: SourceRef }[];
  /** static path (edge ids) explaining each observed succession */
  steps: { trace: string; fromSeq: number; toSeq: number; edges: string[] }[];
  mismatches: { trace: string; seq: number; kind: string; detail: string }[];
}

const OBSERVABLE: NodeKind[] = ["ModelCall", "ToolRequest", "Authorization", "HumanApproval", "Effect", "MemoryRead", "MemoryWrite", "Termination", "Decision", "Guard"];

export function mapEvent(idx: IRIndex, e: TraceEvent): { nodeId?: string; via?: MappedEvent["via"]; reason?: string } {
  const expected = EXPECTED[e.type] ?? [];
  if (e.nodeId) {
    if (idx.node(e.nodeId)) return { nodeId: e.nodeId, via: "nodeId" };
    return { reason: `nodeId '${e.nodeId}' not in IR (stale instrumentation or code changed)` };
  }
  if (e.loc) {
    const cands = idx.ir.nodes.filter((n) => n.sourceRefs.some((r) => r.file === e.loc!.file && r.startLine <= e.loc!.line && e.loc!.line <= r.endLine));
    const pick = (list: IRNode[]) =>
      list.sort((a, b) => span(a, e) - span(b, e))[0];
    const preferred = pick(cands.filter((n) => expected.includes(n.kind)));
    if (preferred) return { nodeId: preferred.id, via: "loc" };
    if (e.type === "error" || e.type === "retry" || e.type === "cancel") {
      const any = pick(cands.filter((n) => !["Harness", "Agent", "Procedure", "ToolSet"].includes(n.kind)));
      if (any) return { nodeId: any.id, via: "loc" };
    }
  }
  const name = e.name ?? (e.attrs?.tool as string | undefined);
  if (name && (e.type.startsWith("tool.") || e.type === "tool.request")) {
    const tools = idx.ir.nodes.filter((n) => n.kind === "Tool" && n.attrs.name === name);
    if (tools.length) return { nodeId: tools[0].id, via: "name", reason: tools.length > 1 ? `tool name '${name}' is ambiguous (${tools.length} definitions); picked first` : undefined };
    return { reason: `tool '${name}' is not defined in the static graph` };
  }
  if (e.type === "run.start" || e.type === "run.end") return { nodeId: idx.ir.nodes.find((n) => n.kind === "Harness")?.id, via: "name" };
  return { reason: e.loc ? `no ${expected.join("/") || "node"} at ${e.loc.file}:${e.loc.line}` : "event carries neither nodeId nor loc" };
}

function span(n: IRNode, e: TraceEvent): number {
  const r = n.sourceRefs.find((x) => x.file === e.loc?.file);
  return r ? r.endLine - r.startLine : 1e9;
}

export function reconcile(ir: HarnessIR, traces: Trace[]): Reconciliation {
  const idx = new IRIndex(ir);
  const res: Reconciliation = {
    traces: [],
    mapping: [],
    mappingCoverage: { mapped: 0, total: 0 },
    observedNodes: {},
    observedEdges: {},
    nodeCoverage: { observableNodes: 0, observedNodes: 0 },
    unexplained: [],
    unobservedBranches: [],
    unobservedNodes: [],
    violations: [],
    mismatches: [],
    steps: [],
  };
  for (const t of traces) {
    const mapped = new Map<number, string>();
    let mcount = 0;
    const terminations: string[] = [];
    for (const e of t.events) {
      const m = mapEvent(idx, e);
      res.mapping.push({ trace: t.id, seq: e.seq, type: e.type, nodeId: m.nodeId, via: m.via, reason: m.reason });
      res.mappingCoverage.total++;
      if (m.nodeId) {
        mapped.set(e.seq, m.nodeId);
        mcount++;
        res.mappingCoverage.mapped++;
        res.observedNodes[m.nodeId] = (res.observedNodes[m.nodeId] ?? 0) + 1;
        for (const a of idx.ancestors(m.nodeId)) res.observedNodes[a] = res.observedNodes[a] ?? 0;
      } else {
        res.mismatches.push({ trace: t.id, seq: e.seq, kind: e.type === "tool.request" || e.type === "tool.execute" ? "observed-tool-absent-from-static-graph" : "unmapped-event", detail: m.reason ?? "unmapped" });
      }
      if (e.type === "termination") terminations.push(e.name ?? String(e.attrs?.reason ?? "?"));
      if (e.type === "termination" && m.nodeId && idx.node(m.nodeId)?.kind !== "Termination") {
        res.mismatches.push({ trace: t.id, seq: e.seq, kind: "termination-not-static", detail: `termination '${e.name}' does not correspond to a static Termination node` });
      }
    }
    res.traces.push({ id: t.id, label: t.label, events: t.events.length, mapped: mcount, parseErrors: t.parseErrors.length, terminations });
    for (const pe of t.parseErrors) res.mismatches.push({ trace: t.id, seq: -1, kind: "parse-error", detail: `line ${pe.line}: ${pe.error}` });

    // ---- successions
    // nodes that emitted step events in this trace: a path through them would have produced an event
    const instrumented = new Set<string>();
    for (const e of t.events) if (STEP_TYPES.has(e.type) && mapped.get(e.seq)) instrumented.add(mapped.get(e.seq)!);
    const steps = t.events.filter((e) => STEP_TYPES.has(e.type) && mapped.get(e.seq) && !isDup(e));
    const bySpan = new Map<string, TraceEvent[]>();
    for (const e of steps) bySpan.set(e.spanId, [...(bySpan.get(e.spanId) ?? []), e]);
    const pairs: [TraceEvent, TraceEvent][] = [];
    for (const list of bySpan.values()) for (let i = 1; i < list.length; i++) pairs.push([list[i - 1], list[i]]);
    // parent -> first event of a child span
    for (const [spanId, list] of bySpan) {
      const first = list[0];
      const parent = t.events.find((e) => e.spanId === spanId)?.parentSpanId;
      if (!parent) continue;
      const before = (bySpan.get(parent) ?? []).filter((e) => e.seq < first.seq).pop();
      if (before) pairs.push([before, first]);
    }
    for (const [a, b] of pairs) {
      const from = mapped.get(a.seq)!;
      const to = mapped.get(b.seq)!;
      const path = findPath(idx, from, to, instrumented);
      if (path) {
        res.steps.push({ trace: t.id, fromSeq: a.seq, toSeq: b.seq, edges: path });
        for (const eid of path) res.observedEdges[eid] = (res.observedEdges[eid] ?? 0) + 1;
      } else {
        res.unexplained.push({ trace: t.id, fromSeq: a.seq, toSeq: b.seq, from, to, note: "observed succession has no static control path (absent from static graph, or analysis gap)" });
      }
    }

    // ---- invariants
    const spanEvents = new Map<string, TraceEvent[]>();
    for (const e of t.events) spanEvents.set(e.spanId, [...(spanEvents.get(e.spanId) ?? []), e]);
    for (const list of spanEvents.values()) {
      let denied: TraceEvent | undefined;
      for (const e of list) {
        if ((e.type === "authz.decision" && e.status === "denied") || (e.type === "approval.response" && e.status === "rejected")) denied = e;
        if (e.type === "tool.execute" && denied) {
          const nid = mapped.get(e.seq);
          res.violations.push({
            trace: t.id,
            seq: e.seq,
            invariant: "denied-request-not-executed",
            detail: `execution at seq ${e.seq} follows a denial at seq ${denied.seq} in the same request span`,
            nodeId: nid,
            source: nid ? idx.node(nid)?.sourceRefs[0] : undefined,
          });
        }
      }
    }
    const iterations = new Map<string, number>();
    for (const e of t.events) {
      if (e.type !== "loop.iteration") continue;
      const nid = mapped.get(e.seq);
      if (!nid) continue;
      const key = `${e.spanId}|${nid}`;
      iterations.set(key, Math.max(iterations.get(key) ?? 0, Number(e.attrs?.iteration ?? 0) || (iterations.get(key) ?? 0) + 1));
      const loop = idx.node(nid)!;
      const loopNode = loop.kind === "Junction" ? idx.node(loop.parent!)! : loop;
      const bound = staticBound(loopNode);
      if (bound !== undefined && iterations.get(key)! > bound) {
        res.violations.push({ trace: t.id, seq: e.seq, invariant: "loop-bound", detail: `iteration ${iterations.get(key)} exceeds static bound ${bound} (${loopNode.attrs.condition})`, nodeId: loopNode.id, source: loopNode.sourceRefs[0] });
      }
    }
  }

  // ---- coverage of static structure
  const observable = ir.nodes.filter((n) => OBSERVABLE.includes(n.kind));
  res.nodeCoverage = { observableNodes: observable.length, observedNodes: observable.filter((n) => (res.observedNodes[n.id] ?? 0) > 0).length };
  res.unobservedNodes = observable.filter((n) => !res.observedNodes[n.id]).map((n) => n.id);
  for (const n of ir.nodes) {
    if (!["Decision", "Guard", "Authorization", "ToolRequest"].includes(n.kind)) continue;
    for (const e of idx.outEdges(n.id, ["transition", "dispatches"])) {
      if (e.kind === "dispatches") continue;
      if (res.observedEdges[e.id]) continue;
      res.unobservedBranches.push({ nodeId: n.id, edgeId: e.id, label: e.label, source: n.sourceRefs[0], note: "not observed in the supplied traces — this does NOT mean unreachable" });
    }
  }
  return res;
}

function isDup(e: TraceEvent): boolean {
  return e.type === "model.response" || e.type === "tool.result" || e.type === "approval.response";
}

function staticBound(loop: IRNode): number | undefined {
  const cond = String(loop.attrs.condition ?? "");
  const consts = (loop.attrs.constants ?? {}) as Record<string, number>;
  const m = /^\s*\w+\s*(<|<=)\s*([A-Z_][A-Z0-9_]*|\d+)\s*$/.exec(cond);
  if (!m) return undefined;
  const v = /^\d+$/.test(m[2]) ? Number(m[2]) : consts[m[2]];
  if (v === undefined) return undefined;
  return m[1] === "<=" ? v + 1 : v;
}

/** BFS over static control successors; interior nodes must not be nodes instrumented in this trace. */
export function findPath(idx: IRIndex, from: string, to: string, instrumented: Set<string>, maxDepth = 80): string[] | undefined {
  if (from === to) {
    // self-succession: needs a cycle
  }
  const prev = new Map<string, { node: string; edge: string }>();
  const queue: { id: string; d: number }[] = [{ id: from, d: 0 }];
  const seen = new Set<string>([from]);
  while (queue.length) {
    const { id, d } = queue.shift()!;
    if (d > maxDepth) continue;
    for (const { to: nx, edge } of idx.controlSucc(id)) {
      if (nx === to) {
        const path = [edge.id];
        let cur = id;
        while (cur !== from) {
          const p = prev.get(cur)!;
          path.unshift(p.edge);
          cur = p.node;
        }
        return path;
      }
      if (seen.has(nx)) continue;
      if (instrumented.has(nx)) continue;
      seen.add(nx);
      prev.set(nx, { node: id, edge: edge.id });
      queue.push({ id: nx, d: d + 1 });
    }
  }
  return undefined;
}
