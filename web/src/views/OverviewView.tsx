import { useMemo } from "react";
import type { ViewProps } from "../App";
import { NodeLink, Chip } from "../Detail";
import { LensGraph, Split } from "./common";

export function findings(b: ViewProps["b"]) {
  const out: { level: "danger" | "warn" | "info"; text: string; nodes: string[] }[] = [];
  const effects = b.ir.nodes.filter((n) => n.kind === "Effect" || (n.kind === "MemoryWrite" && n.attrs.effectCategory));
  const ungatedIrrev = effects.filter((e) => e.attrs.irreversible === true && e.attrs.ungatedRoute);
  if (ungatedIrrev.length) out.push({ level: "danger", text: `${ungatedIrrev.length} irreversible effect(s) reachable on a route with no enforcing code check`, nodes: ungatedIrrev.map((n) => n.id) });
  const ungated = effects.filter((e) => e.attrs.irreversible !== true && e.attrs.ungatedRoute);
  if (ungated.length) out.push({ level: "warn", text: `${ungated.length} other effect(s) reachable without an enforcing code check on some route`, nodes: ungated.map((n) => n.id) });
  const po = b.ir.nodes.filter((n) => n.kind === "PromptRule" && n.attrs.status === "prompt-only");
  if (po.length) out.push({ level: "warn", text: `${po.length} prompt rule(s) with no matching code guard (advisory only)`, nodes: po.map((n) => n.id) });
  const mm = b.ir.nodes.filter((n) => n.kind === "PromptRule" && n.attrs.status === "possible-mismatch");
  if (mm.length) out.push({ level: "danger", text: `${mm.length} prompt rule(s) whose threshold appears to differ from the code`, nodes: mm.map((n) => n.id) });
  const unk = b.ir.nodes.filter((n) => n.kind === "Unknown");
  if (unk.length) out.push({ level: "warn", text: `${unk.length} operation(s) whose behavior is unknown statically`, nodes: unk.map((n) => n.id) });
  const sub = b.ir.nodes.filter((n) => n.kind === "Agent" && n.attrs.role === "subagent");
  if (sub.length) out.push({ level: "info", text: `${sub.length} subagent(s) with their own loop and context`, nodes: sub.map((n) => n.id) });
  const rec = b.ir.nodes.filter((n) => n.kind === "Agent" && n.attrs.recursive);
  if (rec.length) out.push({ level: "info", text: `${rec.length} recursive agent(s)`, nodes: rec.map((n) => n.id) });
  if (b.rec.violations.length) out.push({ level: "danger", text: `${b.rec.violations.length} invariant violation(s) in recorded traces`, nodes: b.rec.violations.map((v) => v.nodeId).filter((x): x is string => !!x) });
  return out;
}

export function OverviewView({ b, route, select }: ViewProps) {
  const f = useMemo(() => findings(b), [b]);
  const count = (k: string) => b.ir.nodes.filter((n) => n.kind === k).length;
  const panel = (
    <div className="overview-panel">
      <p>{b.ir.harness.description}</p>
      <div className="stats">
        <div><b>{count("Agent")}</b> agents</div>
        <div><b>{count("ModelCall")}</b> model calls</div>
        <div><b>{count("Tool")}</b> tools</div>
        <div><b>{count("Effect")}</b> effects</div>
        <div><b>{count("State")}</b> stores</div>
        <div><b>{count("Unknown")}</b> unknown</div>
        <div><b>{b.traces.length}</b> traces</div>
      </div>
      <h3>Findings</h3>
      <ul className="findings">
        {f.map((x) => (
          <li key={x.text} className={x.level}>
            <Chip kind={x.level === "danger" ? "danger" : x.level === "warn" ? "warn" : "neutral"}>{x.level}</Chip> {x.text}
            <div>{x.nodes.slice(0, 8).map((id) => <NodeLink key={id} b={b} id={id} select={select} short />)}</div>
          </li>
        ))}
      </ul>
      <p className="muted">Click a box to see details; double-click (or Enter) to expand it. Collapsed boxes show how many nodes they contain (▸n).</p>
    </div>
  );
  return <Split panelTitle="Summary & findings" graph={<LensGraph b={b} lensId="overview" selected={route.node} select={select} />} panel={panel} />;
}
