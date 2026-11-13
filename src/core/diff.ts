/** IR version diff and observed-behavior comparison. */
import type { HarnessIR, IRNode } from "./ir";
import type { Reconciliation } from "./reconcile";

const COMPARED_ATTRS = ["condition", "constants", "text", "toolsOffered", "gatedBy", "status", "purpose", "category", "irreversible", "model", "loopType", "candidates", "reason"];

export interface IRDiff {
  addedNodes: IRNode[];
  removedNodes: IRNode[];
  changedNodes: { id: string; kind: string; label: string; changes: { field: string; before: unknown; after: unknown }[] }[];
  addedEdges: string[];
  removedEdges: string[];
}

export function diffIR(a: HarnessIR, b: HarnessIR): IRDiff {
  const am = new Map(a.nodes.map((n) => [n.id, n]));
  const bm = new Map(b.nodes.map((n) => [n.id, n]));
  const changed: IRDiff["changedNodes"] = [];
  for (const [id, nb] of bm) {
    const na = am.get(id);
    if (!na) continue;
    const changes: { field: string; before: unknown; after: unknown }[] = [];
    for (const f of ["label", "authority", "parent"] as const) if (na[f] !== nb[f]) changes.push({ field: f, before: na[f], after: nb[f] });
    if (na.assurance.enforcement !== nb.assurance.enforcement) changes.push({ field: "enforcement", before: na.assurance.enforcement, after: nb.assurance.enforcement });
    for (const k of COMPARED_ATTRS) {
      const x = JSON.stringify(na.attrs[k] ?? null);
      const y = JSON.stringify(nb.attrs[k] ?? null);
      if (x !== y) changes.push({ field: `attrs.${k}`, before: na.attrs[k], after: nb.attrs[k] });
    }
    if (changes.length) changed.push({ id, kind: nb.kind, label: nb.label, changes });
  }
  const ae = new Set(a.edges.map((e) => e.id));
  const be = new Set(b.edges.map((e) => e.id));
  return {
    addedNodes: b.nodes.filter((n) => !am.has(n.id)),
    removedNodes: a.nodes.filter((n) => !bm.has(n.id)),
    changedNodes: changed,
    addedEdges: [...be].filter((x) => !ae.has(x)),
    removedEdges: [...ae].filter((x) => !be.has(x)),
  };
}

export interface BehaviorDiff {
  terminations: { reason: string; before: number; after: number }[];
  tools: { tool: string; before: number; after: number }[];
  denials: { before: number; after: number };
  violations: { before: number; after: number };
  unexplained: { before: number; after: number };
  note: string;
}

export function compareBehavior(beforeIR: HarnessIR, before: Reconciliation, afterIR: HarnessIR, after: Reconciliation, beforeTraces: { events: { type: string; name?: string; status?: string }[] }[], afterTraces: { events: { type: string; name?: string; status?: string }[] }[]): BehaviorDiff {
  void beforeIR;
  void afterIR;
  const count = (traces: typeof beforeTraces, f: (e: { type: string; name?: string; status?: string }) => string | undefined) => {
    const m = new Map<string, number>();
    for (const t of traces) for (const e of t.events) {
      const k = f(e);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const merge = (x: Map<string, number>, y: Map<string, number>) => [...new Set([...x.keys(), ...y.keys()])].sort().map((k) => ({ key: k, before: x.get(k) ?? 0, after: y.get(k) ?? 0 }));
  const term = merge(count(beforeTraces, (e) => (e.type === "termination" ? e.name ?? "?" : undefined)), count(afterTraces, (e) => (e.type === "termination" ? e.name ?? "?" : undefined)));
  const tools = merge(count(beforeTraces, (e) => (e.type === "tool.request" ? e.name ?? "?" : undefined)), count(afterTraces, (e) => (e.type === "tool.request" ? e.name ?? "?" : undefined)));
  const den = (ts: typeof beforeTraces) => ts.reduce((s, t) => s + t.events.filter((e) => e.status === "denied" || e.status === "rejected").length, 0);
  return {
    terminations: term.map((x) => ({ reason: x.key, before: x.before, after: x.after })),
    tools: tools.map((x) => ({ tool: x.key, before: x.before, after: x.after })),
    denials: { before: den(beforeTraces), after: den(afterTraces) },
    violations: { before: before.violations.length, after: after.violations.length },
    unexplained: { before: before.unexplained.length, after: after.unexplained.length },
    note: "Observed differences between trace sets. Trace sets are small samples of nondeterministic runs; differences are evidence, not proof, of a behavioral change.",
  };
}
