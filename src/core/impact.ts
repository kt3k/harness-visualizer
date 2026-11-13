/**
 * Change impact: forward reachability from seed nodes over control, data,
 * dispatch and authorization edges. Results are POTENTIAL impacts — static
 * reachability, not guaranteed causal consequences.
 */
import { IRIndex } from "./graph";
import type { EdgeKind, HarnessIR } from "./ir";

const FOLLOW: EdgeKind[] = ["transition", "dispatches", "invokes", "context", "interprets", "gates", "writes", "reads", "offers", "resumes", "causal-hypothesis"];

export interface ImpactItem {
  id: string;
  kind: string;
  label: string;
  distance: number;
  via: string;
  /** direct: same iteration / call; indirect: only via a loop back-edge or persisted state (later turns) */
  tier: "direct" | "indirect";
  pathFromSeed: string[];
}

export interface ImpactResult {
  seeds: string[];
  affected: ImpactItem[];
  decisions: ImpactItem[];
  effects: ImpactItem[];
  modelCalls: ImpactItem[];
  transitions: string[];
  note: string;
}

/** Resolve a seed spec: node id | file:line | file path. */
export function seedsFor(ir: HarnessIR, spec: string): string[] {
  if (ir.nodes.some((n) => n.id === spec)) return [spec];
  const m = /^(.+):(\d+)$/.exec(spec);
  if (m) {
    const line = Number(m[2]);
    const hits = ir.nodes.filter((n) => n.kind !== "Harness" && n.sourceRefs.some((r) => r.file === m[1] && r.startLine <= line && line <= r.endLine));
    // the innermost matches (smallest span)
    const size = (id: string) => {
      const r = ir.nodes.find((n) => n.id === id)!.sourceRefs.find((x) => x.file === m[1])!;
      return r.endLine - r.startLine;
    };
    const ids = hits.map((h) => h.id);
    if (!ids.length) return [];
    const min = Math.min(...ids.map(size));
    return ids.filter((id) => size(id) === min);
  }
  return ir.nodes.filter((n) => n.kind !== "Harness" && n.sourceRefs.some((r) => r.file === spec)).map((n) => n.id);
}

export function impactOf(ir: HarnessIR, seeds: string[], maxDistance = 40): ImpactResult {
  const idx = new IRIndex(ir);
  // BFS over (node, tier); a node first reached directly is never downgraded
  const dist = new Map<string, { d: number; via: string; prev?: string; indirect: boolean }>();
  const queue: string[] = [];
  const enqueue = (id: string, d: number, via: string, indirect: boolean, prev?: string) => {
    const cur = dist.get(id);
    if (cur && (!cur.indirect || indirect)) return;
    dist.set(id, { d, via, prev, indirect });
    queue.push(id);
  };
  for (const s of seeds) {
    enqueue(s, 0, "seed", false);
    // a change to a container (prompt, procedure) affects its contents; a rule affects its prompt
    for (const c of idx.descendants(s)) enqueue(c.id, 0, "contained in seed", false, s);
    const n = idx.node(s);
    if (n?.kind === "PromptRule" && n.parent) enqueue(n.parent, 0, "rule belongs to prompt", false, s);
  }
  const transitions = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    const { d, indirect } = dist.get(id)!;
    if (d >= maxDistance) continue;
    const n = idx.node(id);
    const succ = idx.outEdges(id, FOLLOW).map((e) => ({ to: e.to, e }));
    // leaving a container returns control to callers
    for (const a of idx.ancestors(id)) {
      const c = idx.node(a);
      if ((c?.attrs.exitIds as string[] | undefined)?.includes(id)) for (const e of idx.outEdges(a, ["transition"])) succ.push({ to: e.to, e });
    }
    for (const { to, e } of succ) {
      if (e.kind === "transition" && !indirect) transitions.add(e.id);
      const later = indirect || !!e.attrs.backEdge || e.kind === "writes";
      enqueue(to, d + 1, e.kind, later, id);
      // entering a container reaches its entry nodes
      for (const entry of idx.entryLeaves(to)) if (entry !== to) enqueue(entry, d + 1, `${e.kind} (entry)`, later, to);
    }
    if (n?.kind === "State") for (const e of idx.outEdges(id, ["reads", "context"])) enqueue(e.to, d + 1, e.kind, true, id);
  }
  const items: ImpactItem[] = [...dist]
    .filter(([id]) => !seeds.includes(id))
    .map(([id, v]) => {
      const n = idx.node(id)!;
      const path: string[] = [];
      let cur: string | undefined = id;
      while (cur && path.length < 50) {
        path.unshift(cur);
        cur = dist.get(cur)?.prev;
      }
      return { id, kind: (n?.kind ?? "?") as string, label: n?.label ?? id, distance: v.d, via: v.via, tier: (v.indirect ? "indirect" : "direct") as ImpactItem["tier"], pathFromSeed: path };
    })
    .filter((x) => x.kind !== "?")
    .sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "direct" ? -1 : 1) || a.distance - b.distance || a.id.localeCompare(b.id));
  return {
    seeds,
    affected: items,
    decisions: items.filter((i) => ["Decision", "ToolRequest", "Guard", "Authorization", "HumanApproval"].includes(i.kind)),
    effects: items.filter((i) => i.kind === "Effect" || i.kind === "MemoryWrite"),
    modelCalls: items.filter((i) => i.kind === "ModelCall"),
    transitions: [...transitions],
    note: "Potential impact by static reachability. 'direct' = reachable within the same iteration/call; 'indirect' = only through a later turn (loop back-edge) or persisted state — e.g. a changed tool result the model sees next turn can change anything after it. Not every listed item will change; items not listed could still change through unknown/unresolved behavior.",
  };
}
