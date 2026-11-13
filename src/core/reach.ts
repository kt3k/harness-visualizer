/**
 * Potential effects reachable from a node along static control paths, with the
 * enforcement points found on the (shortest) path. Reachability is an
 * over-approximation: a listed effect is *possible* per the static graph,
 * not guaranteed; guards on other paths may differ (see the effect's routes).
 */
import { IRIndex } from "./graph";
import type { IRNode } from "./ir";

export interface ReachedEffect {
  effect: IRNode;
  path: string[];
  gatesOnPath: IRNode[];
  approvalsOnPath: IRNode[];
  modelChoicesOnPath: IRNode[];
  promptOnlyRules: IRNode[];
}

const GATE_KINDS = new Set(["Guard", "Authorization"]);

export function isEffectLike(n: IRNode): boolean {
  return n.kind === "Effect" || n.kind === "Unknown" || (n.kind === "MemoryWrite" && !!n.attrs.effectCategory);
}

export function reachableEffects(idx: IRIndex, from: string, maxNodes = 4000): ReachedEffect[] {
  const prev = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  const found: string[] = [];
  let steps = 0;
  while (queue.length && steps++ < maxNodes) {
    const id = queue.shift()!;
    const n = idx.node(id);
    if (n && id !== from && isEffectLike(n)) found.push(id);
    // starting from a container: do not "return" out of it into arbitrary callers (context-insensitive call graph)
    const succ = idx.isContainer(id) ? idx.entryLeaves(id).map((to) => ({ to })) : idx.controlSucc(id).filter((s) => !(idx.isContainer(from) && s.edge.from === from));
    for (const { to } of succ) {
      if (prev.has(to)) continue;
      prev.set(to, id);
      queue.push(to);
    }
  }
  return found.map((eid) => {
    const path: string[] = [];
    let cur: string | null | undefined = eid;
    while (cur) {
      path.unshift(cur);
      cur = prev.get(cur);
    }
    const nodes = path.map((p) => idx.node(p)!).filter(Boolean);
    const effect = idx.node(eid)!;
    const tool = [effect.id, ...idx.ancestors(effect.id)].map((a) => idx.node(a)!).find((x) => x?.kind === "Tool");
    const rules = idx.ir.nodes.filter(
      (r) => r.kind === "PromptRule" && r.attrs.status === "prompt-only" && tool && ((r.attrs.relatedTools as string[]) ?? []).includes(tool.id),
    );
    return {
      effect,
      path,
      gatesOnPath: nodes.filter((x) => GATE_KINDS.has(x.kind) || (x.kind === "Decision" && x.authority !== "model")),
      approvalsOnPath: nodes.filter((x) => x.kind === "HumanApproval"),
      modelChoicesOnPath: nodes.filter((x) => x.authority === "model" && (x.kind === "Decision" || x.kind === "ToolRequest" || x.kind === "ModelCall")),
      promptOnlyRules: rules,
    };
  });
}
