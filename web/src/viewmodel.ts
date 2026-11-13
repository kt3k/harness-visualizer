import { IRIndex } from "../../src/core/graph";
import type { EdgeKind, HarnessIR, IRNode, NodeKind } from "../../src/core/ir";

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

export function computeVisible(ir: HarnessIR, idx: IRIndex, lens: Lens, expanded: Set<string>): { nodes: VisNode[]; edges: VisEdge[] } {
  const hidden = new Set(lens.hideKinds);
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
    const container = idx.isContainer(n.id) && idx.descendants(n.id).some((d) => !hidden.has(d.kind));
    const parent = n.parent && n.parent !== "harness" && idx.node(n.parent)?.kind !== "Harness" ? n.parent : undefined;
    visible.set(n.id, {
      id: n.id,
      node: n,
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
      const ports = (v.node.attrs[role === "to" ? "entryIds" : "exitIds"] as string[] | undefined) ?? [];
      return [...new Set(ports.flatMap((p) => reps(p, role, depth + 1)))];
    }
    // not visible: nearest visible collapsed ancestor
    for (const a of idx.ancestors(id)) {
      const av = visible.get(a);
      if (av) return av.expanded ? [] : [a];
    }
    return [];
  };
  const agg = new Map<string, VisEdge>();
  for (const e of ir.edges) {
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
