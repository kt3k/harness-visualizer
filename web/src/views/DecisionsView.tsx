import type { ViewProps } from "../App";
import { NodeLink, Chip } from "../Detail";
import { LensGraph, Split } from "./common";
import { authorityOf } from "../viewmodel";

export function DecisionsView({ b, route, select }: ViewProps) {
  const mcs = b.ir.nodes.filter((n) => n.kind === "ModelCall");
  const trs = b.ir.nodes.filter((n) => n.kind === "ToolRequest");
  const decisions = b.ir.nodes.filter((n) => n.kind === "Decision");
  const byAuth = (a: string) => decisions.filter((d) => authorityOf(d) === a).length;
  const panel = (
    <div>
      <p>
        <Chip kind="auth-model">model discretion</Chip> {byAuth("model")} branches decided by model output ·{" "}
        <Chip kind="auth-code">deterministic code</Chip> {byAuth("code")} · <Chip kind="auth-human">human</Chip> {byAuth("human")} · <Chip kind="auth-external">external</Chip> {byAuth("external")}
      </p>
      <h3>Where the model chooses the next action</h3>
      <table className="tbl">
        <thead><tr><th>Model call</th><th>Options offered</th><th>Output read by</th></tr></thead>
        <tbody>
          {mcs.map((m) => (
            <tr key={m.id}>
              <td><NodeLink b={b} id={m.id} select={select} short /></td>
              <td>{((m.attrs.toolsOffered as string[]) ?? []).join(", ") || <span className="muted">text only</span>}</td>
              <td>{((m.attrs.outputHandling as { nodeId: string }[]) ?? []).map((h) => <NodeLink key={h.nodeId} b={b} id={h.nodeId} select={select} short />)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Requested → authorized → executed</h3>
      <table className="tbl">
        <thead><tr><th>Tool dispatch (model-selected)</th><th>Code checks before dispatch</th><th>Tools → effects inside</th></tr></thead>
        <tbody>
          {trs.map((t) => (
            <tr key={t.id}>
              <td><NodeLink b={b} id={t.id} select={select} short /></td>
              <td>{((t.attrs.gatedBy as string[]) ?? []).map((g) => <NodeLink key={g} b={b} id={g} select={select} short />)}</td>
              <td>
                {b.idx.outEdges(t.id, ["dispatches"]).map((e) => {
                  const inner = [e.to, ...b.idx.descendants(e.to).map((d) => d.id)].map((x) => b.idx.node(x)!).filter((x) => x.kind === "Effect" || x.kind === "Unknown" || (x.kind === "MemoryWrite" && x.attrs.effectCategory) || x.kind === "Guard" || x.kind === "Authorization");
                  return (
                    <div key={e.id}>
                      <b>{e.label}</b>: {inner.length ? inner.map((x) => <NodeLink key={x.id} b={b} id={x.id} select={select} short />) : <span className="muted">no effect / guard inside (see called procedures)</span>}
                    </div>
                  );
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return <Split panelTitle="Model decision points & request pipeline" graph={<LensGraph b={b} lensId="decisions" selected={route.node} select={select} />} panel={panel} />;
}
