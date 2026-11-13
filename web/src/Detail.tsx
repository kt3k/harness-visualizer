import { useMemo, type ReactNode } from "react";
import type { ContextLayer, IRNode, SourceRef } from "../../src/core/ir";
import { reachableEffects } from "../../src/core/reach";
import type { Bundle } from "./data";
import { githubUrl } from "./data";
import type { Route } from "./App";
import type { SourceTarget } from "./SourceView";
import { AUTHORITY_LABEL, authorityOf } from "./viewmodel";
import { kindTag } from "./Graph";
import { nodePhrase } from "../../src/core/humanize";

export function plainLabel(b: Bundle, n: IRNode): string {
  const t = nodePhrase(n, b.ir).text;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

interface Props {
  b: Bundle;
  id?: string;
  select: (id: string | undefined) => void;
  go: (p: Partial<Route>) => void;
  openSource: (t: SourceTarget) => void;
}

export function Chip({ kind, children, title }: { kind: string; children: ReactNode; title?: string }) {
  return (
    <span className={`chip chip-${kind}`} title={title}>
      {children}
    </span>
  );
}

export function NodeLink({ b, id, select, short }: { b: Bundle; id: string; select: (id: string) => void; short?: boolean }) {
  const n = b.idx.node(id);
  if (!n) return <code>{id}</code>;
  return (
    <button className={`nlink auth-${authorityOf(n)}`} onClick={() => select(id)} title={`${n.kind} — code: ${n.label}`}>
      <span className="ktag">{kindTag(n.kind)}</span> {clipText(plainLabel(b, n), short ? 56 : 120)}
    </button>
  );
}

function clipText(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function SourceLink({ b, r, openSource }: { b: Bundle; r: SourceRef; openSource: (t: SourceTarget) => void }) {
  const gh = githubUrl(b.ir, r.file, r.startLine, r.endLine);
  return (
    <span className="srclink">
      <button onClick={() => openSource({ file: r.file, start: r.startLine, end: r.endLine })} title="Open in source viewer">
        {r.file}:{r.startLine}
        {r.endLine !== r.startLine ? `–${r.endLine}` : ""}
      </button>
      {r.role && r.role !== "code" && <Chip kind="neutral">{r.role}</Chip>}
      {gh && (
        <a href={gh} target="_blank" rel="noreferrer" title="Open on GitHub">
          ↗
        </a>
      )}
    </span>
  );
}

export function BasisChip({ basis }: { basis: string }) {
  const t: Record<string, string> = {
    static: "Derived from code structure (AST / symbol resolution)",
    inferred: "Heuristic or model inference — verify before relying on it",
    runtime: "Observed in a trace",
    unknown: "Could not be determined statically",
  };
  return (
    <Chip kind={`basis-${basis}`} title={t[basis]}>
      {basis}
    </Chip>
  );
}

const WHO: Record<string, string> = {
  ModelCall: "The model produces this output. Its content is not determined by code.",
  Decision: "",
  ToolRequest: "The model selects which tool runs (the selector comes from model output).",
  Guard: "Code enforces this check; it cannot be bypassed by the model on this path.",
  Authorization: "Code enforces this permission check.",
  HumanApproval: "A human answers; code acts on the answer.",
  Effect: "Code performs this side effect when control reaches it.",
  PromptRule: "Advisory instruction to the model. Code does not enforce prompt text.",
  Prompt: "Text sent to the model. Instructions in it are advisory.",
  ExternalEvent: "Triggered from outside the analysed code.",
  Unknown: "Behavior not visible to static analysis.",
};

export function Detail({ b, id, select, go, openSource }: Props) {
  const n = id ? b.idx.node(id) : undefined;
  const reach = useMemo(() => (n && ["ModelCall", "Decision", "ToolRequest", "Tool", "Agent", "Loop", "ExternalEvent"].includes(n.kind) ? reachableEffects(b.idx, n.id) : []), [b, n]);
  if (!n)
    return (
      <div className="detail-empty">
        <h2>Details</h2>
        <p>Select a node in the graph (click, or focus the graph and use the arrow keys).</p>
        <p className="muted">Every claim shows its evidence basis: <BasisChip basis="static" /> <BasisChip basis="inferred" /> <BasisChip basis="runtime" /> <BasisChip basis="unknown" /></p>
      </div>
    );
  const auth = authorityOf(n);
  const obs = b.rec.observedNodes[n.id];
  const inE = b.idx.inEdges(n.id);
  const outE = b.idx.outEdges(n.id);
  const a = n.attrs as Record<string, any>;
  const sel = (x: string) => select(x);
  return (
    <div className="detail-body">
      <div className="dhead">
        <div className="dkind">
          {kindTag(n.kind)} {n.kind}
        </div>
        <h2>{plainLabel(b, n)}</h2>
        {plainLabel(b, n) !== n.label && <div className="codelabel-line" title="label derived from code">code: <code>{n.label}</code></div>}
        <div className="chips">
          <Chip kind={`auth-${auth}`} title="Who decides what happens at this node">
            {AUTHORITY_LABEL[auth]}
          </Chip>
          <BasisChip basis={n.assurance.basis} />
          {n.assurance.enforcement && (
            <Chip kind={`enf-${n.assurance.enforcement}`} title={n.assurance.enforcement === "enforced" ? "Enforced by code" : "Advisory only (not enforced by code)"}>
              {n.assurance.enforcement}
            </Chip>
          )}
          {a.irreversible === true && <Chip kind="danger">irreversible</Chip>}
          {obs !== undefined && obs > 0 && <Chip kind="basis-runtime" title="Times observed in the loaded traces">observed ×{obs}</Chip>}
          {obs === undefined && b.traces.length > 0 && ["ModelCall", "Effect", "ToolRequest", "Authorization", "Guard", "Decision", "Termination", "MemoryWrite", "MemoryRead", "HumanApproval"].includes(n.kind) && <Chip kind="neutral" title="Not seen in the loaded traces. This does not mean unreachable.">not observed</Chip>}
        </div>
      </div>
      {n.summary && <p className="summary">{n.summary}</p>}
      {(WHO[n.kind] || n.kind === "Decision") && (
        <Section title="Decision authority">
          <p>
            {n.kind === "Decision"
              ? auth === "model"
                ? "Model discretion: the condition compares model output against fixed options; the model's output selects the branch."
                : auth === "code"
                  ? a.validatesModelInput
                    ? "Deterministic code applied to model-supplied data (threshold/predicate defined in code)."
                    : "Deterministic code."
                  : `Decided by ${auth} input.`
              : WHO[n.kind]}
          </p>
        </Section>
      )}

      {n.kind === "ModelCall" && <ModelCallSection b={b} n={n} sel={sel} />}
      {(n.kind === "Decision" || n.kind === "ToolRequest" || n.kind === "Guard" || n.kind === "Authorization") && (
        <Section title={n.kind === "ToolRequest" ? "Dispatch" : "Condition and branches"}>
          {a.condition && <pre className="code">{a.condition}</pre>}
          {a.selector && n.kind === "ToolRequest" && <p>Selector: <code>{a.selector}</code> ({a.mechanism})</p>}
          {a.purpose && <p>Purpose: <b>{a.purpose}</b> <BasisChip basis="inferred" /></p>}
          {a.rejectText && <p>On reject: <code>{a.rejectText}</code> ({a.rejectExit})</p>}
          {a.constants && Object.keys(a.constants).length > 0 && <p>Constants: {Object.entries(a.constants).map(([k, v]) => <code key={k}>{k} = {String(v)} </code>)}</p>}
          <ul className="edges">
            {b.idx.outEdges(n.id, ["transition", "dispatches"]).map((e) => (
              <li key={e.id}>
                <span className="elab">{e.kind === "dispatches" ? `tool '${e.label}' →` : `${e.label ?? "→"} →`}</span> <NodeLink b={b} id={e.to} select={sel} short />
                {b.rec.observedEdges[e.id] ? <Chip kind="basis-runtime">observed</Chip> : null}
              </li>
            ))}
          </ul>
          {(a.taintSources ?? []).length > 0 && (
            <div>
              Depends on:{" "}
              {[...new Set((a.taintSources as string[]).map((s) => s.replace(/^\w+:/, "")))].map((s) =>
                b.idx.node(s) ? <NodeLink key={s} b={b} id={s} select={sel} short /> : <code key={s}>{s}</code>,
              )}
            </div>
          )}
        </Section>
      )}
      {(n.kind === "Effect" || n.kind === "MemoryWrite" || n.kind === "MemoryRead") && <EffectSection b={b} n={n} sel={sel} />}
      {n.kind === "PromptRule" && (
        <Section title="Rule enforcement">
          <blockquote>{a.text}</blockquote>
          <p>
            Status:{" "}
            <Chip kind={a.status === "prompt-only" ? "danger" : a.status === "possible-mismatch" ? "warn" : "neutral"}>{a.status}</Chip> <BasisChip basis={a.status === "prompt-only" ? "static" : "inferred"} />
          </p>
          {(a.matchedGuards as string[]).length > 0 && (
            <div>
              Possibly related code checks (keyword overlap — verify):
              <ul>
                {(a.matchedGuards as string[]).map((g) => (
                  <li key={g}><NodeLink b={b} id={g} select={sel} /></li>
                ))}
              </ul>
            </div>
          )}
          {(a.mismatches as string[]).map((m) => <p key={m} className="warn">⚠ {m}</p>)}
          {(a.relatedTools as string[]).length > 0 && <p>Mentions: {(a.relatedTools as string[]).map((t) => <NodeLink key={t} b={b} id={t} select={sel} short />)}</p>}
        </Section>
      )}
      {n.kind === "Prompt" && (
        <Section title="Prompt text">
          <pre className="prompt">{a.text}</pre>
          <p>Rules: {b.idx.children.get(n.id)?.map((r) => <NodeLink key={r.id} b={b} id={r.id} select={sel} short />) ?? "none"}</p>
          <p>Sent to: {b.idx.outEdges(n.id, ["context"]).map((e) => <NodeLink key={e.id} b={b} id={e.to} select={sel} short />)}</p>
        </Section>
      )}
      {n.kind === "State" && (
        <Section title="Store">
          <p>Persistence: <b>{a.persistence}</b> · {a.medium} · <code>{a.locator}</code></p>
          <p>Written by: {b.idx.inEdges(n.id, ["writes"]).map((e) => <NodeLink key={e.id} b={b} id={e.from} select={sel} short />)}</p>
          <p>Read by: {b.idx.outEdges(n.id, ["reads", "context"]).map((e) => <NodeLink key={e.id} b={b} id={e.to} select={sel} short />)}</p>
        </Section>
      )}
      {n.kind === "Tool" && (
        <Section title="Tool">
          {a.description && <p>{a.description}</p>}
          {a.structuredOutput && <p>Used as a forced structured-output schema (not executed).</p>}
          <p>Handler: {a.handlerFn ? <code>{a.handlerFn}</code> : a.handler ? <code>{a.handler}</code> : "inline in the dispatch site"} {a.handlerVia && <span className="muted">via {a.handlerVia}</span>}</p>
          <p>Offered to: {b.idx.outEdges(n.parent ?? "", ["offers"]).concat(b.idx.outEdges(n.id, ["offers"])).map((e) => <NodeLink key={e.id} b={b} id={e.to} select={sel} short />)}</p>
          <p>Dispatched by: {b.idx.inEdges(n.id, ["dispatches"]).map((e) => <NodeLink key={e.id} b={b} id={e.from} select={sel} short />)}</p>
          <details>
            <summary>schema</summary>
            <pre className="code">{a.schema}</pre>
          </details>
        </Section>
      )}
      {(n.kind === "Agent" || n.kind === "Loop") && (
        <Section title={n.kind}>
          {a.role && <p>Role: <b>{a.role}</b>{a.recursive ? " · recursive" : ""}</p>}
          {a.invokedBy && <p>Invoked by: {(a.invokedBy as string[]).map((x) => <NodeLink key={x} b={b} id={x} select={sel} />)}</p>}
          {a.loopType && <p>Loop type: <b>{a.loopType}</b> {a.loopType === "retry" && <BasisChip basis="inferred" />}</p>}
          {a.condition !== undefined && <p>Header: <code>{a.condition || "(none)"}</code></p>}
          {a.constants && Object.keys(a.constants).length > 0 && <p>Bound: {Object.entries(a.constants).map(([k, v]) => <code key={k}>{k} = {String(v)}</code>)}</p>}
          {a.modelCalls && <p>Model calls: {(a.modelCalls as string[]).map((x) => <NodeLink key={x} b={b} id={x} select={sel} short />)}</p>}
          {a.terminations && <p>Terminations: {(a.terminations as string[]).map((x) => <NodeLink key={x} b={b} id={x} select={sel} short />)}</p>}
        </Section>
      )}
      {n.kind === "Unknown" && (
        <Section title="Why unknown">
          <p className="warn">{a.reason}</p>
        </Section>
      )}

      {reach.length > 0 && (
        <Section title={`Potentially reachable effects (${reach.length})`}>
          <p className="muted">Static reachability (over-approximation). Guards listed are those on the shortest path; see each effect for all routes.</p>
          <ul className="reach">
            {reach.slice(0, 30).map((r) => (
              <li key={r.effect.id}>
                <NodeLink b={b} id={r.effect.id} select={sel} short />
                {r.effect.attrs.irreversible === true && <Chip kind="danger">irreversible</Chip>}
                <div className="via">
                  {r.gatesOnPath.length ? (
                    <>through: {r.gatesOnPath.map((g) => <NodeLink key={g.id} b={b} id={g.id} select={sel} short />)}</>
                  ) : (
                    <span className="warn">no code gate on this path</span>
                  )}
                  {r.approvalsOnPath.length > 0 && <> · approval: {r.approvalsOnPath.map((g) => <NodeLink key={g.id} b={b} id={g.id} select={sel} short />)}</>}
                  {r.promptOnlyRules.length > 0 && <> · prompt-only rules: {r.promptOnlyRules.map((g) => <NodeLink key={g.id} b={b} id={g.id} select={sel} short />)}</>}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Inputs / outputs">
        <EdgeList b={b} edges={inE} dir="in" sel={sel} />
        <EdgeList b={b} edges={outE} dir="out" sel={sel} />
      </Section>
      <Section title="Source">
        {n.sourceRefs.length ? n.sourceRefs.map((r, i) => <div key={i}><SourceLink b={b} r={r} openSource={openSource} />{r.snippet && <code className="snip">{r.snippet}</code>}</div>) : <p className="warn">No source reference.</p>}
      </Section>
      <Section title="Evidence">
        <ul className="evidence">
          {n.evidence.map((e, i) => (
            <li key={i}>
              <BasisChip basis={e.basis} /> <code>{e.method}</code> {e.claim}
              {e.confidence !== undefined && <span className="muted"> (heuristic score {e.confidence}, not a probability of truth)</span>}
              {e.ref && <> — <SourceLink b={b} r={e.ref} openSource={openSource} /></>}
            </li>
          ))}
        </ul>
      </Section>
      {n.uncertainties.length > 0 && (
        <Section title="Uncertainties">
          <ul>
            {n.uncertainties.map((u) => (
              <li key={u} className="warn">{u}</li>
            ))}
          </ul>
        </Section>
      )}
      <RuntimeSection b={b} n={n} />
      <div className="actions">
        <button onClick={() => go({ view: "impact", seed: n.id, node: n.id })}>Change impact from here</button>
        <button onClick={() => go({ view: "effects", node: n.id })}>Effects view</button>
      </div>
      <details className="raw">
        <summary>raw attributes</summary>
        <pre className="code">{JSON.stringify({ id: n.id, parent: n.parent, ...n.attrs }, null, 2)}</pre>
      </details>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dsec">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function ModelCallSection({ b, n, sel }: { b: Bundle; n: IRNode; sel: (id: string) => void }) {
  const a = n.attrs as Record<string, any>;
  const ctx = (a.context ?? []) as ContextLayer[];
  return (
    <>
      <Section title="Context the model receives">
        <table className="ctx">
          <thead>
            <tr><th>slot</th><th>kind</th><th>source</th><th>certainty</th></tr>
          </thead>
          <tbody>
            {ctx.map((c) => (
              <tr key={c.order} className={c.certainty !== "resolved" ? "uncertain" : ""}>
                <td>{c.slot}</td>
                <td>{c.kind}</td>
                <td>
                  {c.ref && b.idx.node(c.ref) ? <NodeLink b={b} id={c.ref} select={sel} short /> : <code>{c.expr}</code>}
                  {c.transforms.length > 0 && <div className="muted">{c.transforms.join(" · ")}</div>}
                </td>
                <td>{c.certainty === "resolved" ? "resolved" : <span className="warn">{c.certainty}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>Model: <code>{a.model ?? "?"}</code> · provider {a.provider} · {a.api}</p>
        {a.toolsOffered?.length > 0 && <p>Tools offered (options the model can choose): {(a.toolsOffered as string[]).map((t) => <code key={t}>{t} </code>)}</p>}
        {a.toolChoice && <p>tool_choice: <code>{a.toolChoice}</code></p>}
        {a.structuredOutput && <p>Structured output: <code>{a.structuredOutput}</code></p>}
        {a.transport && <p className="muted">Called through a wrapper; SDK call at {a.transport.file}:{a.transport.startLine}</p>}
      </Section>
      <Section title="What the harness does with the output">
        {(a.outputHandling ?? []).length === 0 ? (
          <p className="warn">No branch on this call's output was found (output may flow elsewhere, unresolved).</p>
        ) : (
          <ul className="edges">
            {(a.outputHandling as { nodeId: string; condition: string }[]).map((h) => {
              const d = b.idx.node(h.nodeId);
              return (
                <li key={h.nodeId}>
                  <NodeLink b={b} id={h.nodeId} select={sel} short /> <span className="muted">[{d && authorityOf(d)}]</span>
                  <ul>
                    {b.idx.outEdges(h.nodeId, ["transition"]).map((e) => (
                      <li key={e.id}>
                        <span className="elab">{e.label ?? "→"}</span> → <NodeLink b={b} id={e.to} select={sel} short />
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </>
  );
}

function EffectSection({ b, n, sel }: { b: Bundle; n: IRNode; sel: (id: string) => void }) {
  const a = n.attrs as Record<string, any>;
  return (
    <Section title={n.kind === "Effect" ? "Effect" : "State access"}>
      <p>
        {a.category ?? a.effectCategory ?? "state"} · <code>{a.api}</code>
        {a.target && <> → {a.target}</>} · irreversible: <b>{String(a.irreversible)}</b>
      </p>
      {a.args && <p>Arguments: {(a.args as string[]).map((x, i) => <code key={i}>{x} </code>)}</p>}
      {a.modelControlledArgs?.length > 0 && <p className="warn">Model-controlled arguments: {(a.modelControlledArgs as string[]).join(", ")}</p>}
      {a.sql && <pre className="code">{a.sql}</pre>}
      {a.routes && (
        <div>
          <p>Enforcement on each analysed call route <BasisChip basis="static" />:</p>
          <ul className="routes">
            {(a.routes as { via: string[]; gates: string[] }[]).map((r, i) => (
              <li key={i}>
                <span className="muted">{r.via.join(" → ")}</span>
                <div>{r.gates.length ? r.gates.map((g) => <NodeLink key={g} b={b} id={g} select={sel} short />) : <span className="warn">no code gate</span>}</div>
              </li>
            ))}
          </ul>
          {a.ungatedRoute && <p className="warn">⚠ At least one route reaches this operation without an enforcing code check.</p>}
        </div>
      )}
    </Section>
  );
}

function EdgeList({ b, edges, dir, sel }: { b: Bundle; edges: { id: string; kind: string; from: string; to: string; label?: string; evidence: { basis: string }[] }[]; dir: "in" | "out"; sel: (id: string) => void }) {
  if (!edges.length) return null;
  const groups = new Map<string, typeof edges>();
  for (const e of edges) groups.set(e.kind, [...(groups.get(e.kind) ?? []), e]);
  return (
    <div className="elist">
      <h4>{dir === "in" ? "Incoming" : "Outgoing"}</h4>
      {[...groups].map(([k, es]) => (
        <details key={k} open={es.length <= 6}>
          <summary>
            {k} ({es.length})
          </summary>
          <ul>
            {es.map((e) => (
              <li key={e.id}>
                {e.label && <span className="elab">{e.label}</span>} <NodeLink b={b} id={dir === "in" ? e.from : e.to} select={sel} short />
                {e.evidence.some((x) => x.basis === "inferred") && <BasisChip basis="inferred" />}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

function RuntimeSection({ b, n }: { b: Bundle; n: IRNode }) {
  const events = b.rec.mapping.filter((m) => m.nodeId === n.id);
  if (!b.traces.length) return null;
  return (
    <Section title="Runtime evidence">
      {events.length === 0 ? (
        <p className="muted">Not observed in {b.traces.length} loaded trace(s). Not observed ≠ unreachable.</p>
      ) : (
        <ul>
          {[...new Set(events.map((e) => e.trace))].map((t) => (
            <li key={t}>
              <a href={`#/h/${b.entry.id}/trace?t=${encodeURIComponent(t)}&n=${encodeURIComponent(n.id)}`}>{t}</a>: {events.filter((e) => e.trace === t).map((e) => `#${e.seq} ${e.type}`).join(", ")}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
