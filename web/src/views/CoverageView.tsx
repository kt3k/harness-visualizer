import type { ViewProps } from "../App";
import { NodeLink, SourceLink, Chip } from "../Detail";

export function CoverageView({ b, select, openSource, evaluation }: ViewProps & { evaluation?: unknown }) {
  const c = b.ir.coverage;
  const unknowns = b.ir.nodes.filter((n) => n.kind === "Unknown");
  const inferred = b.ir.nodes.filter((n) => n.assurance.basis === "inferred" || n.evidence.some((e) => e.basis === "inferred"));
  const ev = (evaluation as { harnesses?: Record<string, Record<string, unknown>> } | undefined)?.harnesses?.[b.entry.id];
  const pct = (a: number, t: number) => (t ? `${Math.round((100 * a) / t)}%` : "n/a");
  return (
    <div className="coverage">
      <h2>What the analysis knows, infers, and does not know</h2>
      <div className="stats">
        <div><b>{c.filesAnalyzed.length}</b> files analysed</div>
        <div><b>{c.callSites.total}</b> call sites classified</div>
        <div><b>{pct(c.sourceLinkCoverage.nodesWithSource, c.sourceLinkCoverage.nodes)}</b> nodes with source link</div>
        <div><b>{pct(c.sourceLinkCoverage.edgesWithEvidenceRef, c.sourceLinkCoverage.edges)}</b> edges with evidence</div>
        <div><b>{unknowns.length}</b> unknown operations</div>
        <div><b>{c.unresolved.length}</b> unresolved items</div>
        <div><b>{inferred.length}</b> nodes relying on inference</div>
        <div><b>{pct(b.rec.mappingCoverage.mapped, b.rec.mappingCoverage.total)}</b> trace events mapped</div>
      </div>
      <h3>Unknown behavior</h3>
      <ul>{unknowns.map((u) => <li key={u.id}><NodeLink b={b} id={u.id} select={select} /> — {String(u.attrs.reason)}</li>)}{!unknowns.length && <li className="muted">none</li>}</ul>
      <h3>Unresolved items</h3>
      <table className="tbl">
        <thead><tr><th>Location</th><th>Expression</th><th>Reason</th></tr></thead>
        <tbody>{c.unresolved.map((u, i) => <tr key={i}><td><SourceLink b={b} r={{ file: u.file, startLine: u.line, endLine: u.line }} openSource={openSource} /></td><td><code>{u.expr}</code></td><td>{u.reason} {u.nodeId && <NodeLink b={b} id={u.nodeId} select={select} short />}</td></tr>)}</tbody>
      </table>
      <h3>Known analysis gaps</h3>
      <ul>{c.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
      <h3>Inferred claims (verify)</h3>
      <ul className="small">{inferred.slice(0, 60).map((n) => <li key={n.id}><NodeLink b={b} id={n.id} select={select} short /> — {n.evidence.filter((e) => e.basis === "inferred").map((e) => e.method).join(", ")}</li>)}</ul>
      <h3>Call-site classification</h3>
      <table className="tbl small"><tbody>{Object.entries(c.callSites.byClass).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>
      <h3>Files</h3>
      <ul className="small">{c.filesAnalyzed.map((f) => <li key={f.path}><button className="nlink" onClick={() => openSource({ file: f.path })}>{f.path}</button> <span className="muted">{f.lines} lines · sha256 {f.sha256.slice(0, 10)}</span></li>)}</ul>
      {ev && (
        <>
          <h3>Extraction precision vs. hand labels <Chip kind="neutral">fixture evaluation</Chip></h3>
          <pre className="code">{JSON.stringify(ev, null, 2)}</pre>
        </>
      )}
    </div>
  );
}
