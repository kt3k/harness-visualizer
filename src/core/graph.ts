/** Index structures over a Harness IR, shared by impact, reconciliation and the UI. */
import { CONTAINER_KINDS, type EdgeKind, type HarnessIR, type IREdge, type IRNode } from "./ir";

export class IRIndex {
  readonly byId = new Map<string, IRNode>();
  readonly children = new Map<string, IRNode[]>();
  readonly out = new Map<string, IREdge[]>();
  readonly in = new Map<string, IREdge[]>();

  constructor(readonly ir: HarnessIR) {
    for (const n of ir.nodes) {
      this.byId.set(n.id, n);
      if (n.parent) this.children.set(n.parent, [...(this.children.get(n.parent) ?? []), n]);
    }
    for (const e of ir.edges) {
      this.out.set(e.from, [...(this.out.get(e.from) ?? []), e]);
      this.in.set(e.to, [...(this.in.get(e.to) ?? []), e]);
    }
  }

  node(id: string): IRNode | undefined {
    return this.byId.get(id);
  }

  outEdges(id: string, kinds?: EdgeKind[]): IREdge[] {
    const l = this.out.get(id) ?? [];
    return kinds ? l.filter((e) => kinds.includes(e.kind)) : l;
  }

  inEdges(id: string, kinds?: EdgeKind[]): IREdge[] {
    const l = this.in.get(id) ?? [];
    return kinds ? l.filter((e) => kinds.includes(e.kind)) : l;
  }

  ancestors(id: string): string[] {
    const out: string[] = [];
    let p = this.byId.get(id)?.parent;
    while (p) {
      out.push(p);
      p = this.byId.get(p)?.parent;
    }
    return out;
  }

  isInside(id: string, container: string): boolean {
    return this.ancestors(id).includes(container);
  }

  descendants(id: string): IRNode[] {
    const out: IRNode[] = [];
    const stack = [...(this.children.get(id) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      out.push(n);
      stack.push(...(this.children.get(n.id) ?? []));
    }
    return out;
  }

  isContainer(id: string): boolean {
    const n = this.byId.get(id);
    return !!n && CONTAINER_KINDS.has(n.kind) && (this.children.get(id)?.length ?? 0) > 0;
  }

  /** Leaf-level entry nodes of a container (recursively through nested containers). */
  entryLeaves(id: string, depth = 0): string[] {
    const n = this.byId.get(id);
    if (!n || depth > 8) return [id];
    const entries = (n.attrs.entryIds as string[] | undefined) ?? [];
    if (!entries.length || !this.isContainer(id)) return [id];
    return [...new Set(entries.flatMap((e) => (this.isContainer(e) ? this.entryLeaves(e, depth + 1) : [e])))];
  }

  /**
   * Static control successors of a leaf node: transitions (container targets expanded to
   * their entry nodes), dispatches, and returns from containers whose exits include this node.
   */
  controlSucc(id: string): { to: string; edge: IREdge }[] {
    const res: { to: string; edge: IREdge }[] = [];
    const push = (e: IREdge) => {
      for (const t of this.isContainer(e.to) ? this.entryLeaves(e.to) : [e.to]) res.push({ to: t, edge: e });
    };
    for (const e of this.outEdges(id, ["transition", "dispatches"])) push(e);
    // returning out of containers this node exits
    for (const anc of this.ancestors(id)) {
      const c = this.byId.get(anc)!;
      const exits = (c.attrs.exitIds as string[] | undefined) ?? [];
      if (!exits.includes(id)) continue;
      for (const e of this.outEdges(anc, ["transition"])) push(e);
    }
    // ModelCall through a wrapper: control continues after the wrapper call (no extra edge needed)
    return res;
  }
}

export function kindOf(ir: HarnessIR, id: string): string | undefined {
  return ir.nodes.find((n) => n.id === id)?.kind;
}
