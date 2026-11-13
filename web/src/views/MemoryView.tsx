import type { ContextLayer } from "../../../src/core/ir";
import type { ViewProps } from "../App";
import { NodeLink, Chip } from "../Detail";
import { LensGraph, Split } from "./common";

export function MemoryView({ b, route, select }: ViewProps) {
  const mcs = b.ir.nodes.filter((n) => n.kind === "ModelCall");
  const stores = b.ir.nodes.filter((n) => n.kind === "State");
  const panel = (
    <div>
      <h3>What enters each model call</h3>
      <table className="tbl matrix">
        <thead><tr><th>Model call</th><th>Prompts</th><th>Conversation</th><th>Memory / state reads</th><th>Other inputs</th><th>Unresolved</th></tr></thead>
        <tbody>
          {mcs.map((m) => {
            const ctx = (m.attrs.context as ContextLayer[]) ?? [];
            const cell = (k: string[]) => ctx.filter((c) => k.includes(c.kind));
            const show = (cs: ContextLayer[]) =>
              cs.map((c, i) => (
                <div key={i}>
                  {c.ref && b.idx.node(c.ref) ? <NodeLink b={b} id={c.ref} select={select} short /> : <code>{c.expr}</code>}
                  {c.transforms.length > 0 && <div className="muted">{c.transforms.join(" · ")}</div>}
                </div>
              ));
            const unresolved = ctx.filter((c) => c.certainty !== "resolved");
            return (
              <tr key={m.id}>
                <td><NodeLink b={b} id={m.id} select={select} short /></td>
                <td>{show(cell(["prompt"]))}</td>
                <td>{show(cell(["conversation"]))}</td>
                <td>{show(cell(["memory"]))}</td>
                <td>{show(cell(["input", "model-output", "literal", "parameter"]))}</td>
                <td>{unresolved.length ? <Chip kind="warn">{unresolved.length} uncertain</Chip> : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h3>Stores</h3>
      <table className="tbl">
        <thead><tr><th>Store</th><th>Persistence</th><th>Writers</th><th>Readers / enters</th></tr></thead>
        <tbody>
          {stores.map((s) => (
            <tr key={s.id}>
              <td><NodeLink b={b} id={s.id} select={select} short /></td>
              <td>{String(s.attrs.persistence)} <span className="muted">{String(s.attrs.medium)}</span></td>
              <td>{b.idx.inEdges(s.id, ["writes"]).map((e) => <NodeLink key={e.id} b={b} id={e.from} select={select} short />)}</td>
              <td>
                {b.idx.outEdges(s.id, ["reads", "context"]).map((e) => <NodeLink key={e.id} b={b} id={e.to} select={select} short />)}
                {b.idx.outEdges(s.id, ["reads", "context"]).length === 0 && <span className="warn">no reader found (write-only, or unresolved data flow)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Data-flow links are resolved through constants, parameters (one call level), return values and simple transforms. Anything else is marked uncertain rather than guessed.</p>
    </div>
  );
  return <Split panelTitle="Context assembly & stores" graph={<LensGraph b={b} lensId="memory" selected={route.node} select={select} />} panel={panel} />;
}
