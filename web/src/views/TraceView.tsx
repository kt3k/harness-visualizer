import { useEffect, useMemo, useRef, useState } from "react";
import type { ViewProps } from "../App";
import { reconcile } from "../../../src/core/reconcile";
import { mapEvent } from "../../../src/core/reconcile";
import { NodeLink, Chip, SourceLink } from "../Detail";
import { LensGraph } from "./common";
import type { HL } from "../Graph";

const ICON: Record<string, string> = {
  "model.request": "LLM→", "model.response": "LLM←", "tool.request": "⇢ req", "authz.decision": "⛨", "approval.request": "👤?", "approval.response": "👤", "tool.execute": "⚡", "tool.result": "↩",
  "state.read": "⟲", "state.write": "✎", termination: "■", error: "✖", retry: "↻", cancel: "⊘", "loop.iteration": "↻", "agent.start": "▶", "agent.end": "◀", "run.start": "▶▶", "run.end": "◀◀", decision: "◇", "external.event": "⇥",
};

export function TraceView({ b, route, select, go, openSource }: ViewProps) {
  const [why, setWhy] = useState(false);
  const trace = b.traces.find((t) => t.id === route.trace) ?? b.traces[0];
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => setPos(0), [trace?.id]);
  useEffect(() => {
    if (!playing || !trace) return;
    const t = setInterval(() => setPos((p) => (p + 1 >= trace.events.length ? (setPlaying(false), p) : p + 1)), 650);
    return () => clearInterval(t);
  }, [playing, trace]);
  const rec = useMemo(() => (trace ? reconcile(b.ir, [trace]) : undefined), [b, trace]);
  const mapped = useMemo(() => (trace ? trace.events.map((e) => mapEvent(b.idx, e)) : []), [b, trace]);
  const depth = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of trace?.events ?? []) if (!d.has(e.spanId)) d.set(e.spanId, e.parentSpanId ? (d.get(e.parentSpanId) ?? 0) + 1 : 0);
    return d;
  }, [trace]);
  const cur = trace?.events[pos];
  const curNode = mapped[pos]?.nodeId;
  useEffect(() => {
    list.current?.querySelector(`[data-pos="${pos}"]`)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos]);
  const highlight = useMemo(() => {
    const m = new Map<string, HL>();
    for (let i = 0; i <= pos; i++) {
      const id = mapped[i]?.nodeId;
      if (id) m.set(id, "path");
    }
    if (curNode) m.set(curNode, "current");
    return m;
  }, [mapped, pos, curNode]);
  const observedSoFar = useMemo(() => {
    const o: Record<string, number> = {};
    for (let i = 0; i <= pos; i++) {
      const id = mapped[i]?.nodeId;
      if (id) o[id] = (o[id] ?? 0) + 1;
    }
    return o;
  }, [mapped, pos]);
  const curSeq = cur?.seq ?? 0;
  const edgeHl = useMemo(() => new Set((rec?.steps ?? []).filter((st) => st.toSeq <= curSeq).flatMap((st) => st.edges)), [rec, curSeq]);
  if (!trace) return <div className="empty">No traces recorded for this harness.</div>;
  const meta = b.entry.traces.find((t) => t.id === trace.id);
  return (
    <div className="trace-view">
      <div className="trace-side">
        <label>
          Trace{" "}
          <select value={trace.id} onChange={(e) => go({ trace: e.target.value })}>
            {b.traces.map((t) => (
              <option key={t.id} value={t.id}>{t.label ?? t.id}</option>
            ))}
          </select>
        </label>
        {meta?.description && <p className="muted">{meta.description}</p>}
        <div className="replay">
          <button onClick={() => setPos(0)} aria-label="First event">⏮</button>
          <button onClick={() => setPos((p) => Math.max(0, p - 1))} aria-label="Previous event">◀</button>
          <button onClick={() => setPlaying((x) => !x)} aria-label={playing ? "Pause" : "Play"}>{playing ? "⏸" : "▶"}</button>
          <button onClick={() => setPos((p) => Math.min(trace.events.length - 1, p + 1))} aria-label="Next event">▶︎|</button>
          <span>{pos + 1}/{trace.events.length}</span>
        </div>
        <ol className="timeline" ref={list}>
          {trace.events.map((e, i) => {
            const m = mapped[i];
            return (
              <li
                key={i}
                data-pos={i}
                className={`ev ev-${e.type.replace(".", "-")} ${i === pos ? "cur" : ""} ${i > pos ? "future" : ""} ${m?.nodeId ? "" : "unmapped"} st-${e.status ?? "none"}`}
                style={{ paddingLeft: 6 + (depth.get(e.spanId) ?? 0) * 12 }}
                onClick={() => setPos(i)}
              >
                <span className="evicon">{ICON[e.type] ?? "·"}</span>
                <span className={`evtext ${e.status === "denied" || e.status === "rejected" || e.status === "error" ? "warn" : ""}`}>{eventPhrase(e)}</span>
              </li>
            );
          })}
        </ol>
        {trace.parseErrors.length > 0 && (
          <div className="warn">
            {trace.parseErrors.length} malformed line(s) skipped: {trace.parseErrors.map((p) => `line ${p.line}: ${p.error}`).join("; ")}
          </div>
        )}
      </div>
      <div className="trace-main">
        <LensGraph b={b} lensId="trace" selected={route.node ?? curNode} select={select} highlight={highlight} observed={observedSoFar} edgeHighlight={edgeHl} />
        {cur && (
          <div className="evdetail">
            <b>{eventPhrase(cur)}</b>
            {curNode && <> — <NodeLink b={b} id={curNode} select={select} short /></>}
            <button className={`why ${why ? "on" : ""}`} onClick={() => setWhy((x) => !x)} aria-expanded={why}>
              why?
            </button>
            {why && (
              <div className="evidence-box">
                <div>#{cur.seq} {cur.type} · span {cur.spanId}{cur.parentSpanId ? ` (parent ${cur.parentSpanId})` : ""} · {cur.ts}</div>
                <div>{curNode ? `matched to the code via ${mapped[pos].via}` : `not matched to the code: ${mapped[pos]?.reason}`}</div>
                {curNode && b.idx.node(curNode)?.sourceRefs[0] && <SourceLink b={b} r={b.idx.node(curNode)!.sourceRefs[0]} openSource={openSource} />}
                {cur.outputSummary && <div className="muted">output: {cur.outputSummary}</div>}
                {cur.attrs && <code className="small">{JSON.stringify(cur.attrs)}</code>}
              </div>
            )}
          </div>
        )}
      </div>
      <details className="trace-recon">
        <summary>Compare this run with the code</summary>
        {rec && (
          <>
            <p>Mapped events: <b>{rec.mappingCoverage.mapped}/{rec.mappingCoverage.total}</b> · observable nodes seen: {rec.nodeCoverage.observedNodes}/{rec.nodeCoverage.observableNodes}</p>
            <p>Terminated: {rec.traces[0].terminations.map((t) => <Chip key={t} kind="neutral">{t}</Chip>)}</p>
            <h4>Invariant violations ({rec.violations.length})</h4>
            <ul>{rec.violations.map((v, i) => <li key={i} className="warn">#{v.seq} {v.invariant}: {v.detail} {v.nodeId && <NodeLink b={b} id={v.nodeId} select={select} short />}</li>)}</ul>
            <h4>Observed but absent from the static graph ({rec.unexplained.length + rec.mismatches.length})</h4>
            <ul>
              {rec.unexplained.map((u, i) => <li key={i}>#{u.fromSeq}→#{u.toSeq}: <NodeLink b={b} id={u.from} select={select} short /> → <NodeLink b={b} id={u.to} select={select} short /> <span className="muted">{u.note}</span></li>)}
              {rec.mismatches.map((m, i) => <li key={`m${i}`}>#{m.seq} {m.kind}: {m.detail}</li>)}
            </ul>
            <h4>Static branches not observed in this run ({rec.unobservedBranches.length})</h4>
            <p className="muted">Not observed ≠ unreachable.</p>
            <ul className="small">{rec.unobservedBranches.slice(0, 40).map((u) => <li key={u.edgeId}><NodeLink b={b} id={u.nodeId} select={select} short /> <span className="elab">{u.label ?? "→"}</span></li>)}</ul>
          </>
        )}
      </details>
    </div>
  );
}

const EVENT_TEXT: Record<string, (n?: string, st?: string) => string> = {
  "run.start": () => "The run starts",
  "run.end": () => "The run ends",
  "agent.start": (n) => `An agent starts${n ? ` (${n})` : ""}`,
  "agent.end": () => "The agent finishes",
  "loop.iteration": () => "Next round of the loop",
  "model.request": () => "The model is asked",
  "model.response": (_n, st) => (st === "error" ? "The model's reply is unusable" : "The model replies"),
  decision: () => "A branch is taken",
  "tool.request": (n) => `The model asks to use “${n ?? "a tool"}”`,
  "authz.decision": (_n, st) => (st === "denied" ? "A check refuses it" : "A check lets it through"),
  "approval.request": () => "A human is asked for approval",
  "approval.response": (_n, st) => (st === "rejected" ? "The human says no" : st === "pending" ? "Waiting for a human" : "The human says yes"),
  "tool.execute": (n, st) => `${st === "error" ? "Failed to run" : "Runs"} “${n ?? "the tool"}”`,
  "tool.result": (_n, st) => (st === "denied" ? "The model is told it was refused" : "The result goes back to the model"),
  "state.read": () => "Reads stored data",
  "state.write": () => "Saves data",
  error: () => "An error happens",
  retry: () => "Tries again",
  cancel: () => "Cancelled",
  termination: (n) => `Ends${n ? `: ${n}` : ""}`,
  "external.event": (n) => `Started from outside${n ? ` (${n})` : ""}`,
};

function eventPhrase(e: { type: string; name?: string; status?: string }): string {
  return (EVENT_TEXT[e.type] ?? (() => e.type))(e.name, e.status);
}
