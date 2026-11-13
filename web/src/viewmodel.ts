import { IRIndex } from "../../src/core/graph";
import type { EdgeKind, HarnessIR, IREdge, IRNode, NodeKind } from "../../src/core/ir";
import { nodePhrase } from "../../src/core/humanize";

export interface DisplayOptions {
  /** plain-language labels instead of code */
  plain: boolean;
  /** hide implementation details (loop heads, return points, conversation appends, reply filters) and draw edges across them */
  simplify: boolean;
}

/** Nodes that are implementation detail for a reader: hidden when simplifying, edges are drawn across them. */
export function isDetailNode(n: IRNode, idx: IRIndex): boolean {
  if (n.kind === "Junction") return true;
  if (n.kind === "MemoryWrite" && !/^state:(file|db):/.test(String(n.attrs.store ?? ""))) return true;
  if (n.kind === "Decision" && n.authority === "model") {
    const outs = idx.outEdges(n.id, ["transition"]);
    const thenE = outs.filter((e) => e.label?.startsWith("if "));
    if (!outs.some((e) => e.label?.startsWith("case ")) && (thenE.length === 0 || thenE.every((e) => e.attrs.backEdge))) return true;
  }
  return false;
}

export type LensId = "overview" | "decisions" | "effects" | "memory" | "trace" | "impact";

export interface Lens {
  id: LensId;
  title: string;
  hideKinds: NodeKind[];
  /** extra per-node hiding (e.g. small predicate helpers in the overview) */
  hideNode?: (n: IRNode) => boolean;
  edgeKinds: EdgeKind[];
  expand: (n: IRNode, idx: IRIndex) => boolean;
}

const hasDesc = (idx: IRIndex, n: IRNode, kinds: NodeKind[]) => idx.descendants(n.id).some((d) => kinds.includes(d.kind));

export const LENSES: Record<LensId, Lens> = {
  overview: {
    id: "overview",
    title: "Architecture",
    hideKinds: ["PromptRule"],
    hideNode: (n) => n.kind === "Procedure" && (n.attrs.role === "policy" || n.attrs.role === "procedure") && !n.attrs.exported,
    edgeKinds: ["invokes", "dispatches", "resumes", "causal-hypothesis", "context", "reads", "writes", "offers"],
    expand: (n) => n.kind === "Harness",
  },
  decisions: {
    id: "decisions",
    title: "Decision boundary",
    hideKinds: ["Prompt", "PromptRule", "State"],
    edgeKinds: ["transition", "dispatches"],
    expand: (n, idx) => ["Harness", "Agent", "Loop", "ToolSet"].includes(n.kind) || (n.kind === "Procedure" && hasDesc(idx, n, ["ModelCall", "ToolRequest"])),
  },
  effects: {
    id: "effects",
    title: "Effects & authority",
    hideKinds: ["State", "Prompt", "PromptRule"],
    edgeKinds: ["transition", "dispatches", "gates"],
    expand: (n, idx) => ["Harness", "Agent", "Loop", "ToolSet"].includes(n.kind) || ((n.kind === "Tool" || n.kind === "Procedure") && hasDesc(idx, n, ["Effect", "Guard", "Authorization", "ToolRequest", "Unknown"])),
  },
  memory: {
    id: "memory",
    title: "State & memory",
    hideKinds: ["PromptRule", "Junction", "Decision", "Guard", "Authorization", "Termination", "ToolRequest", "HumanApproval", "Effect", "ExternalEvent", "Unknown", "Tool"],
    edgeKinds: ["context", "reads", "writes", "offers"],
    expand: (n, idx) => ["Harness", "Agent", "Loop"].includes(n.kind) || (n.kind === "Procedure" && hasDesc(idx, n, ["ModelCall", "MemoryRead", "MemoryWrite"])),
  },
  trace: {
    id: "trace",
    title: "Execution trace",
    hideKinds: ["Prompt", "PromptRule", "State"],
    edgeKinds: ["transition", "dispatches"],
    expand: (n, idx) => ["Harness", "Agent", "Loop", "ToolSet"].includes(n.kind) || ((n.kind === "Tool" || n.kind === "Procedure") && hasDesc(idx, n, ["Effect", "ModelCall", "ToolRequest", "Authorization", "HumanApproval"])),
  },
  impact: {
    id: "impact",
    title: "Change impact",
    hideKinds: ["PromptRule"],
    edgeKinds: ["transition", "dispatches", "context"],
    expand: (n, idx) => ["Harness", "Agent", "Loop", "ToolSet"].includes(n.kind) || ((n.kind === "Tool" || n.kind === "Procedure") && hasDesc(idx, n, ["Effect", "ModelCall", "ToolRequest", "Guard", "Authorization"])),
  },
};

export interface VisNode {
  id: string;
  node: IRNode;
  label: string;
  codeLabel: boolean;
  parent?: string; // visible parent container (expanded)
  container: boolean; // has children
  expanded: boolean;
  hiddenCount: number;
}

export interface VisEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  labels: string[];
  count: number;
  edgeIds: string[];
  back: boolean;
  inferred: boolean;
}

export function defaultExpanded(ir: HarnessIR, idx: IRIndex, lens: Lens): Set<string> {
  return new Set(ir.nodes.filter((n) => idx.isContainer(n.id) && lens.expand(n, idx)).map((n) => n.id));
}

export function computeVisible(ir: HarnessIR, idx: IRIndex, lens: Lens, expanded: Set<string>, opts: DisplayOptions = { plain: true, simplify: true }): { nodes: VisNode[]; edges: VisEdge[] } {
  const hidden = new Set(lens.hideKinds);
  const skip = (id: string) => {
    const n = idx.node(id);
    return !!n && opts.simplify && isDetailNode(n, idx);
  };
  const visible = new Map<string, VisNode>();
  const isShown = (n: IRNode): boolean => {
    if (hidden.has(n.kind)) return false;
    if (lens.hideNode?.(n)) return false;
    for (const a of idx.ancestors(n.id)) {
      const an = idx.node(a)!;
      if (hidden.has(an.kind)) return false;
      if (!expanded.has(a)) return false;
    }
    return true;
  };
  for (const n of ir.nodes) {
    if (n.kind === "Harness") continue;
    if (!isShown(n)) continue;
    if (skip(n.id)) continue;
    const container = idx.isContainer(n.id) && idx.descendants(n.id).some((d) => !hidden.has(d.kind));
    const parent = n.parent && n.parent !== "harness" && idx.node(n.parent)?.kind !== "Harness" ? n.parent : undefined;
    const ph = opts.plain ? nodePhrase(n, ir) : { text: n.label, code: false };
    visible.set(n.id, {
      id: n.id,
      node: n,
      label: ph.text.charAt(0).toUpperCase() + ph.text.slice(1),
      codeLabel: !!ph.code,
      parent,
      container,
      expanded: container && expanded.has(n.id),
      hiddenCount: container && !expanded.has(n.id) ? idx.descendants(n.id).filter((d) => !hidden.has(d.kind)).length : 0,
    });
  }
  /** representative visible leaves for an endpoint */
  const reps = (id: string, role: "from" | "to", depth = 0): string[] => {
    if (depth > 10) return [];
    const v = visible.get(id);
    if (v && !v.expanded) return [id];
    if (v && v.expanded) {
      let ports = (v.node.attrs[role === "to" ? "entryIds" : "exitIds"] as string[] | undefined) ?? [];
      if (role === "to") ports = ports.flatMap((p) => (skip(p) ? succThrough(p).map((r) => r.to) : [p]));
      else ports = ports.flatMap((p) => (skip(p) ? idx.inEdges(p, ["transition"]).map((x) => x.from).filter((x) => !skip(x)) : [p]));
      return [...new Set(ports.flatMap((p) => reps(p, role, depth + 1)))];
    }
    // not visible: nearest visible collapsed ancestor
    for (const a of idx.ancestors(id)) {
      const av = visible.get(a);
      if (av) return av.expanded ? [] : [a];
    }
    return [];
  };
  // contract hidden detail nodes: draw transitions across them
  const succThrough = (id: string, seen = new Set<string>()): { to: string; back: boolean }[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    return idx.outEdges(id, ["transition", "dispatches"]).flatMap((x) => (skip(x.to) ? succThrough(x.to, seen).map((r) => ({ ...r, back: r.back || !!x.attrs.backEdge })) : [{ to: x.to, back: !!x.attrs.backEdge }]));
  };
  const effectiveEdges: IREdge[] = [];
  for (const e of ir.edges) {
    if (skip(e.from) && (e.kind === "transition" || e.kind === "dispatches")) continue;
    if (skip(e.to) && (e.kind === "transition" || e.kind === "dispatches")) {
      for (const r of succThrough(e.to)) effectiveEdges.push({ ...e, id: e.id, to: r.to, attrs: { ...e.attrs, backEdge: !!e.attrs.backEdge || r.back } });
      continue;
    }
    if (skip(e.to) || skip(e.from)) continue;
    effectiveEdges.push(e);
  }
  const agg = new Map<string, VisEdge>();
  for (const e of effectiveEdges) {
    if (!lens.edgeKinds.includes(e.kind)) continue;
    const fs = reps(e.from, "from");
    const ts = reps(e.to, "to");
    for (const f of fs)
      for (const t of ts) {
        if (f === t) continue;
        if (idx.isInside(t, f) || idx.isInside(f, t)) continue;
        const key = `${e.kind}|${f}|${t}`;
        const cur = agg.get(key) ?? { id: key, from: f, to: t, kind: e.kind, labels: [], count: 0, edgeIds: [], back: false, inferred: false };
        cur.count++;
        cur.edgeIds.push(e.id);
        if (e.label && !cur.labels.includes(e.label) && cur.labels.length < 4) cur.labels.push(e.label);
        if (e.attrs.backEdge) cur.back = true;
        if (e.evidence.some((x) => x.basis === "inferred")) cur.inferred = true;
        agg.set(key, cur);
      }
  }
  return { nodes: [...visible.values()], edges: [...agg.values()] };
}

export const AUTHORITY_LABEL: Record<string, string> = {
  code: "deterministic code",
  model: "model discretion",
  human: "human input",
  external: "external event",
  unknown: "unknown",
};

export function authorityOf(n: IRNode): string {
  if (n.kind === "Unknown") return "unknown";
  return n.authority ?? (n.kind === "Prompt" || n.kind === "PromptRule" ? "model" : "code");
}

export function shortLabel(n: IRNode, max = 44): string {
  const l = n.label;
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}
