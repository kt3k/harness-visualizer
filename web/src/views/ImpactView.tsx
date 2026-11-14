import { useMemo, useState } from "react";
import type { ViewProps } from "../App";
import { impactOf, seedsFor } from "../../../src/core/impact";
import { NodeLink, Chip, plainLabel } from "../Detail";
import { LensGraph, Split } from "./common";
import type { HL } from "../Graph";

export function ImpactView({ b, route, select, go }: ViewProps) {
  const [spec, setSpec] = useState("");
  const seeds = useMemo(() => (route.seed ? seedsFor(b.ir, route.seed) : []), [b, route.seed]);
  const res = useMemo(() => (seeds.length ? impactOf(b.ir, seeds) : undefined), [b, seeds]);
  const highlight = useMemo(() => {
    const m = new Map<string, HL>();
    for (const a of res?.affected ?? []) if (a.tier === "direct") m.set(a.id, a.kind === "Effect" || a.kind === "MemoryWrite" ? "warn" : "affected");
    for (const s of seeds) m.set(s, "seed");
    return m;
  }, [res, seeds]);
  const candidates = b.ir.nodes.filter((n) => ["Prompt", "PromptRule", "Guard", "Authorization", "Decision", "ModelCall", "Tool", "State"].includes(n.kind));
  const panel = (
    <div>
      <div className="impact-controls">
        <label>
          Change target{" "}
          <select value={seeds.length === 1 ? seeds[0] : ""} onChange={(e) => go({ seed: e.target.value || undefined, node: e.target.value || undefined })}>
            <option value="">— pick a prompt, rule, guard, decision… —</option>
            {candidates.map((n) => (
              <option key={n.id} value={n.id}>{plainLabel(b, n).slice(0, 80)}</option>
            ))}
          </select>
        </label>
        <form onSubmit={(e) => { e.preventDefault(); go({ seed: spec }); }}>
          <label>
            or code location <input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="src/tools/shell.ts:9 or prompts/system.md" aria-label="file:line or file" />
          </label>
          <button type="submit">analyze</button>
        </form>
        {route.node && route.seed !== route.node && <button onClick={() => go({ seed: route.node })}>use selected node</button>}
      </div>
      {route.seed && !seeds.length && <p className="warn">No node found for “{route.seed}”.</p>}
      {res && (
        <>
          {(["direct", "indirect"] as const).map((tier) => {
            const f = <T extends { tier: string }>(xs: T[]) => xs.filter((x) => x.tier === tier);
            const body = (
              <>
                <h3>Decisions that may change ({f(res.decisions).length})</h3>
                <ul>{f(res.decisions).map((d) => <li key={d.id}><NodeLink b={b} id={d.id} select={select} short /> </li>)}</ul>
                <h3>Model calls that may change ({f(res.modelCalls).length})</h3>
                <ul>{f(res.modelCalls).map((d) => <li key={d.id}><NodeLink b={b} id={d.id} select={select} short /> </li>)}</ul>
                <h3>Effects that may change ({f(res.effects).length})</h3>
                <ul>{f(res.effects).map((d) => <li key={d.id}><NodeLink b={b} id={d.id} select={select} short /> {b.idx.node(d.id)?.attrs.irreversible === true && <Chip kind="danger">irreversible</Chip>} </li>)}</ul>
              </>
            );
            return tier === "direct" ? (
              <div key={tier}>
                <h3 className="tier">Right away</h3>
                {body}
              </div>
            ) : (
              <details key={tier}>
                <summary className="tier">Later (through the conversation or saved data)</summary>
                {body}
              </details>
            );
          })}
        </>
      )}
      {b.diff && (
        <details className="vdiff">
          <summary>Compare with the previous version</summary>
          <VersionDiff {...{ b, select, go }} />
        </details>
      )}
    </div>
  );
  return <Split defaultOpen panelTitle="What may change" graph={<LensGraph b={b} lensId="impact" selected={route.node ?? seeds[0]} select={select} highlight={highlight} />} panel={panel} />;
}

function VersionDiff({ b, select, go }: Pick<ViewProps, "b" | "select" | "go">) {
  if (!b.diff) {
    return <p className="muted">No later version of this harness is loaded for comparison. {b.entry.id === "coding-agent" && <a href="#/h/coding-agent-v2/impact">See coding-agent-v2 for a version diff.</a>}</p>;
  }
  const { diff, behavior, baseline } = b.diff;
  void go;
  return (
    <div className="diff">
      <h3>IR diff vs. {baseline}</h3>
      <p>+{diff.addedNodes.length} nodes, −{diff.removedNodes.length} nodes, {diff.changedNodes.length} changed; +{diff.addedEdges.length}/−{diff.removedEdges.length} edges</p>
      <h4>Added</h4>
      <ul>{diff.addedNodes.map((n) => <li key={n.id}><NodeLink b={b} id={n.id} select={select} short /></li>)}</ul>
      <h4>Changed</h4>
      <ul>
        {diff.changedNodes.map((c) => (
          <li key={c.id}>
            {b.idx.node(c.id) ? <NodeLink b={b} id={c.id} select={select} short /> : <code>{c.id}</code>}
            <ul className="small">{c.changes.map((x) => <li key={x.field}><code>{x.field}</code>: {fmt(x.before)} → {fmt(x.after)}</li>)}</ul>
          </li>
        ))}
      </ul>
      {diff.removedNodes.length > 0 && (<><h4>Removed</h4><ul>{diff.removedNodes.map((n) => <li key={n.id}><code>{n.label}</code></li>)}</ul></>)}
      <h3>Observed behavior before / after</h3>
      
      <table className="tbl">
        <thead><tr><th>Metric</th><th>{baseline}</th><th>this version</th></tr></thead>
        <tbody>
          {behavior.terminations.map((t) => <tr key={`t${t.reason}`}><td>terminated: {t.reason}</td><td>{t.before}</td><td>{t.after}</td></tr>)}
          {behavior.tools.map((t) => <tr key={`u${t.tool}`}><td>tool requested: {t.tool}</td><td>{t.before}</td><td>{t.after}</td></tr>)}
          <tr><td>denials / rejections</td><td>{behavior.denials.before}</td><td>{behavior.denials.after}</td></tr>
          <tr><td>invariant violations</td><td>{behavior.violations.before}</td><td>{behavior.violations.after}</td></tr>
          <tr><td>unexplained successions</td><td>{behavior.unexplained.before}</td><td>{behavior.unexplained.after}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

function fmt(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return "∅";
  return s.length > 90 ? `${s.slice(0, 89)}…` : s;
}
