import { useMemo } from "react";
import type { ViewProps } from "../App";
import { NodeLink, Chip, BasisChip } from "../Detail";
import { LensGraph, Split } from "./common";
import { reachableEffects, isEffectLike } from "../../../src/core/reach";
import type { HL } from "../Graph";

export function EffectsView({ b, route, select }: ViewProps) {
  const sel = route.node ? b.idx.node(route.node) : undefined;
  const reach = useMemo(() => (sel ? reachableEffects(b.idx, sel.id) : []), [b, sel]);
  const highlight = useMemo(() => {
    const m = new Map<string, HL>();
    if (!sel) return m;
    for (const r of reach) {
      for (const p of r.path) if (!m.has(p)) m.set(p, "path");
      for (const g of r.gatesOnPath) m.set(g.id, "warn");
      m.set(r.effect.id, "affected");
    }
    // effects selected directly: show their gates
    if (isEffectLike(sel)) for (const g of (sel.attrs.gatedBy as string[]) ?? []) m.set(g, "warn");
    m.set(sel.id, "seed");
    return m;
  }, [reach, sel]);
  const effects = b.ir.nodes.filter(isEffectLike);
  const rules = b.ir.nodes.filter((n) => n.kind === "PromptRule");
  const panel = (
    <div>
      <p className="muted">
        Select a model call, decision or tool dispatch to highlight every effect it can potentially reach (orange) and the code gates on the way (yellow). Reachability is static and over-approximate.
      </p>
      {sel && reach.length > 0 && (
        <p>
          From <NodeLink b={b} id={sel.id} select={select} short />: {reach.length} reachable effect(s), {reach.filter((r) => r.gatesOnPath.length === 0).length} with no code gate on the shortest path.
        </p>
      )}
      <h3>Side effects and their enforcement points</h3>
      <table className="tbl">
        <thead><tr><th>Effect</th><th>Category</th><th>Irreversible</th><th>Code gates (all routes)</th><th>Ungated route</th></tr></thead>
        <tbody>
          {effects.map((e) => (
            <tr key={e.id} className={e.attrs.ungatedRoute && e.attrs.irreversible === true ? "row-danger" : ""}>
              <td><NodeLink b={b} id={e.id} select={select} short /></td>
              <td>{String(e.attrs.category ?? e.attrs.effectCategory ?? e.kind)}</td>
              <td>{e.attrs.irreversible === true ? <Chip kind="danger">yes</Chip> : String(e.attrs.irreversible ?? "unknown")}</td>
              <td><Gates b={b} ids={(e.attrs.gatedBy as string[]) ?? []} select={select} /></td>
              <td>{e.kind === "Unknown" ? <Chip kind="warn">unknown</Chip> : e.attrs.ungatedRoute ? <Chip kind="danger">yes</Chip> : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Prompt rules: enforced by code, or only instructions?</h3>
      <table className="tbl">
        <thead><tr><th>Rule (advisory)</th><th>Status</th><th>Related code check</th></tr></thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td><NodeLink b={b} id={r.id} select={select} /></td>
              <td>
                <Chip kind={r.attrs.status === "prompt-only" ? "danger" : r.attrs.status === "possible-mismatch" ? "warn" : "neutral"}>{String(r.attrs.status)}</Chip>
                {r.attrs.status !== "prompt-only" && <BasisChip basis="inferred" />}
              </td>
              <td>
                {((r.attrs.matchedGuards as string[]) ?? []).map((g) => <NodeLink key={g} b={b} id={g} select={select} short />)}
                {((r.attrs.mismatches as string[]) ?? []).map((m) => <div key={m} className="warn">{m}</div>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return <Split panelTitle="Effects, gates and prompt rules" graph={<LensGraph b={b} lensId="effects" selected={route.node} select={select} highlight={highlight} />} panel={panel} />;
}

export function Gates({ b, ids, select }: { b: ViewProps["b"]; ids: string[]; select: (id: string) => void }) {
  const nodes = ids.map((g) => b.idx.node(g)).filter((x): x is NonNullable<typeof x> => !!x);
  const main = nodes.filter((n) => n.attrs.purpose !== "budget" && n.attrs.purpose !== "cancellation");
  const budget = nodes.filter((n) => n.attrs.purpose === "budget" || n.attrs.purpose === "cancellation");
  return (
    <>
      {main.map((n) => <NodeLink key={n.id} b={b} id={n.id} select={select} short />)}
      {!main.length && <span className="warn">no authorization/validation gate </span>}
      {budget.length > 0 && <span className="muted" title={budget.map((n) => n.label).join("\n")}> +{budget.length} budget/cancellation</span>}
    </>
  );
}
