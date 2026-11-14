import { useMemo, type ReactNode } from "react";
import type { ContextLayer, IRNode, SourceRef } from "../../src/core/ir";
import { reachableEffects } from "../../src/core/reach";
import type { Bundle } from "./data";
import { githubUrl } from "./data";
import type { Route } from "./App";
import type { SourceTarget } from "./SourceView";
import { AUTHORITY_LABEL, authorityOf } from "./viewmodel";
import { kindTag } from "./Graph";
import { conditionPhrase, contextSummary, edgeOutcome, loopPhrase, nodePhrase } from "../../src/core/humanize";
import { buildStory } from "../../src/core/story";
import { Evidence, useEvidenceMode } from "./Evidence";
import { Lines } from "./StoryLines";

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
  ModelCall: "The model writes this answer; the code does not decide its content.",
  ToolRequest: "The model picks which tool runs.",
  Guard: "A check in the code; the model cannot get past it on this path.",
  Authorization: "A permission check in the code.",
  HumanApproval: "A person answers; the code acts on the answer.",
  Effect: "The code does this when it gets here.",
  PromptRule: "An instruction to the model. Text in a prompt does not stop anything by itself.",
  Prompt: "Text sent to the model.",
  ExternalEvent: "Something outside starts this.",
  Unknown: "What this does cannot be determined from the code.",
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function Detail({ b, id, select, go, openSource }: Props) {
  const n = id ? b.idx.node(id) : undefined;
  const [evidenceMode] = useEvidenceMode();
  const story = useMemo(() => buildStory(b.ir), [b]);
  const reach = useMemo(() => (n && ["ModelCall", "Decision", "ToolRequest", "Tool", "Agent", "ExternalEvent"].includes(n.kind) ? reachableEffects(b.idx, n.id) : []), [b, n]);
  if (!n) return null;
  const a = n.attrs as Record<string, any>;
  const sel = (x: string) => select(x);
  const lineProps = { b, select: sel, selected: id, openSource };
  const plainList = (ids: string[]) => ids.map((g) => <NodeLink key={g} b={b} id={g} select={sel} short />);
  const realGates = (ids: string[]) => ids.filter((g) => !["budget", "cancellation"].includes(String(b.idx.node(g)?.attrs.purpose)));
  const branches = (nid: string) =>
    b.idx.outEdges(nid, ["transition", "dispatches"]).filter((e) => e.kind === "transition" || !b.idx.outEdges(nid, ["transition"]).some((t) => t.to === e.to));
  const flow = story.flows.find((f) => f.id === n.id);
  const card = story.tools.find((t) => t.id === n.id);

  let who = WHO[n.kind];
  if (n.kind === "Decision") who = n.authority === "model" ? "The model's answer decides which way this goes." : n.authority === "human" ? "A person's answer decides which way this goes." : "The code decides which way this goes.";

  return (
    <div className="detail-body">
      <button className="sheet-close" onClick={() => select(undefined)} aria-label="Close details">
        ✕ close
      </button>
      <div className="dhead">
        <h2>{plainLabel(b, n)}</h2>
        {who && <p className="who">{who}</p>}
      </div>

      {n.kind === "ModelCall" && (
        <>
          <Section title="Sees">
            <ul>{contextSummary(n, b.ir).map((c) => <li key={c}>{c}</li>)}</ul>
          </Section>
          <Section title="Can choose">
            <p>{(a.toolsOffered ?? []).length ? (a.toolChoice ? `must fill in the “${a.toolsOffered.join(", ")}” form` : (a.toolsOffered as string[]).join(", ")) : "only replies with text"}</p>
          </Section>
          {(a.outputHandling ?? []).length > 0 && (
            <Section title="Its answer decides">
              <ul className="edges">
                {(a.outputHandling as { nodeId: string }[]).map((h) => (
                  <li key={h.nodeId}>
                    <NodeLink b={b} id={h.nodeId} select={sel} short />
                    <Branches b={b} edges={branches(h.nodeId)} sel={sel} />
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}

      {(n.kind === "Decision" || n.kind === "Guard" || n.kind === "Authorization") && (
        <Section title="Then">
          <Branches b={b} edges={branches(n.id)} sel={sel} />
        </Section>
      )}

      {n.kind === "ToolRequest" && (
        <>
          <Section title="The model picks one of">
            <p>{plainList(b.idx.outEdges(n.id, ["dispatches"]).map((e) => e.to))}</p>
          </Section>
          {realGates(a.gatedBy ?? []).length > 0 && (
            <Section title="Checked before">
              <p>{plainList(realGates(a.gatedBy ?? []))}</p>
            </Section>
          )}
        </>
      )}

      {(n.kind === "Effect" || n.kind === "MemoryWrite" || n.kind === "MemoryRead") && (
        <Section title="What can stop it">
          {a.irreversible === true && <p className="warn">Cannot be undone.</p>}
          {realGates(a.gatedBy ?? []).length ? <p>{plainList(realGates(a.gatedBy ?? []))}</p> : <p className="muted">No specific check.</p>}
          {a.ungatedRoute && <p className="warn">On at least one path, nothing in the code stops it.</p>}
          {(a.modelControlledArgs ?? []).length > 0 && <p>The model controls what it acts on.</p>}
        </Section>
      )}

      {n.kind === "PromptRule" && (
        <Section title="Is it enforced?">
          <p>
            {a.status === "prompt-only"
              ? "No code check for it was found."
              : a.status === "possible-mismatch"
                ? "Related code exists, but it seems to use a different limit."
                : a.status === "related-check"
                  ? "Related code exists, but may not enforce it."
                  : "A matching code check seems to exist."}
          </p>
          {(a.matchedGuards ?? []).length > 0 && <p>Related code: {plainList(a.matchedGuards)}</p>}
        </Section>
      )}

      {n.kind === "Prompt" && (
        <Section title="Text">
          <pre className="prompt">{a.text}</pre>
          <p>Sent to: {plainList(b.idx.outEdges(n.id, ["context"]).map((e) => e.to))}</p>
        </Section>
      )}

      {n.kind === "State" && (
        <Section title="Kept">
          <p>{a.persistence === "ephemeral" ? "In memory, for one run." : a.persistence === "durable" ? "In a file; it survives between runs." : "In a database."}</p>
          <p>Written by: {plainList(b.idx.inEdges(n.id, ["writes"]).map((e) => e.from))}</p>
          <p>Used by: {plainList(b.idx.outEdges(n.id, ["reads", "context"]).map((e) => e.to))}</p>
        </Section>
      )}

      {card && (
        <>
          {card.does && <p>{card.does}</p>}
          <Section title="What it does">
            <Lines {...lineProps} lines={[...card.effects, ...card.starts, ...card.unknown]} />
          </Section>
          <Section title="What can stop it">
            <Lines {...lineProps} lines={[...card.checks, ...card.policy]} />
          </Section>
          {card.promptSays.length > 0 && (
            <Section title="What the prompt says">
              <Lines {...lineProps} lines={card.promptSays} />
            </Section>
          )}
        </>
      )}

      {flow && (
        <>
          {flow.purpose && <p className="purpose">{flow.purpose}</p>}
          <Section title="Starts">
            <Lines {...lineProps} lines={flow.triggers} />
          </Section>
          <Section title="Ends">
            <Lines {...lineProps} lines={flow.endings} />
          </Section>
        </>
      )}
      {n.kind === "Loop" && <p>{cap(loopPhrase(n))}.</p>}

      {reach.length > 0 && (
        <Section title="May lead to">
          <ul className="reach">
            {reach.slice(0, 20).map((r) => {
              const gates = r.gatesOnPath.filter((g) => !["budget", "cancellation"].includes(String(g.attrs.purpose)));
              return (
                <li key={r.effect.id}>
                  <NodeLink b={b} id={r.effect.id} select={sel} short />
                  {r.effect.attrs.irreversible === true && <span className="warn"> (cannot be undone)</span>}
                  <div className="via">{gates.length ? <>stopped by: {gates.map((g) => <NodeLink key={g.id} b={b} id={g.id} select={sel} short />)}</> : <span className="warn">nothing in the code on the way</span>}</div>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      <div className="actions">
        <button onClick={() => go({ view: "impact", seed: n.id, node: n.id })}>What changes if this changes?</button>
      </div>

      <details className="evidence-sec" open={evidenceMode}>
        <summary>Evidence</summary>
        <Evidence b={b} ids={[n.id]} openSource={openSource} />
        <TechnicalExtras b={b} n={n} sel={sel} />
      </details>
    </div>
  );
}

function Branches({ b, edges, sel }: { b: Bundle; edges: { id: string; label?: string; to: string; kind: string }[]; sel: (id: string) => void }) {
  if (!edges.length) return null;
  return (
    <ul className="edges">
      {edges.map((e) => {
        const o = e.kind === "dispatches" ? e.label : edgeOutcome(e.label);
        return (
          <li key={e.id}>
            {o && <span className="elab">{o} →</span>} <NodeLink b={b} id={e.to} select={sel} short />
          </li>
        );
      })}
    </ul>
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

/** Technical details, only inside the opened Evidence section. */
function TechnicalExtras({ b, n, sel }: { b: Bundle; n: IRNode; sel: (id: string) => void }) {
  const a = n.attrs as Record<string, any>;
  const ctx = (a.context ?? []) as ContextLayer[];
  return (
    <div className="tech">
      <p>
        <span className="ev-k">Code</span> <code>{n.label}</code>
      </p>
      {a.condition && <pre className="code">{a.condition}</pre>}
      {(n.kind === "Decision" || n.kind === "Guard" || n.kind === "Authorization") && (
        <p className="small">
          {n.kind === "Decision" ? `decided by ${AUTHORITY_LABEL[authorityOf(n)]}` : `check purpose: ${a.purpose}`}
          {a.validatesModelInput ? "; applied to model-supplied data" : ""}
        </p>
      )}
      {ctx.length > 0 && (
        <table className="ctx">
          <thead>
            <tr><th>slot</th><th>kind</th><th>source</th><th>certainty</th></tr>
          </thead>
          <tbody>
            {ctx.map((c) => (
              <tr key={c.order}>
                <td>{c.slot}</td>
                <td>{c.kind}</td>
                <td>
                  <code>{c.expr}</code>
                  {c.transforms.length > 0 && <div className="muted">{c.transforms.join(" · ")}</div>}
                </td>
                <td>{c.certainty}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {a.routes && (
        <div>
          <p className="small">Checks on each call path:</p>
          <ul className="routes small">
            {(a.routes as { via: string[]; gates: string[] }[]).map((r, i) => (
              <li key={i}>
                <code>{r.via.join(" → ")}</code>: {r.gates.length ? r.gates.map((g) => <NodeLink key={g} b={b} id={g} select={sel} short />) : "none"}
              </li>
            ))}
          </ul>
        </div>
      )}
      <EdgeList b={b} edges={b.idx.inEdges(n.id)} dir="in" sel={sel} />
      <EdgeList b={b} edges={b.idx.outEdges(n.id)} dir="out" sel={sel} />
      <RuntimeRefs b={b} n={n} />
      <details className="raw">
        <summary>raw attributes</summary>
        <pre className="code">{JSON.stringify({ id: n.id, parent: n.parent, ...n.attrs }, null, 2)}</pre>
      </details>
    </div>
  );
}

function EdgeList({ b, edges, dir, sel }: { b: Bundle; edges: { id: string; kind: string; from: string; to: string; label?: string; evidence: { basis: string }[] }[]; dir: "in" | "out"; sel: (id: string) => void }) {
  if (!edges.length) return null;
  const groups = new Map<string, typeof edges>();
  for (const e of edges) groups.set(e.kind, [...(groups.get(e.kind) ?? []), e]);
  return (
    <div className="elist">
      <h4>{dir === "in" ? "Incoming edges" : "Outgoing edges"}</h4>
      {[...groups].map(([k, es]) => (
        <details key={k}>
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

function RuntimeRefs({ b, n }: { b: Bundle; n: IRNode }) {
  const events = b.rec.mapping.filter((m) => m.nodeId === n.id);
  if (!b.traces.length) return null;
  return (
    <div className="small">
      <h4>Recorded runs</h4>
      {events.length === 0 ? (
        <p className="muted">Not seen in {b.traces.length} recorded run(s). Not seen does not mean it cannot happen.</p>
      ) : (
        <ul>
          {[...new Set(events.map((e) => e.trace))].map((t) => (
            <li key={t}>
              <a href={`#/h/${b.entry.id}/trace?t=${encodeURIComponent(t)}&n=${encodeURIComponent(n.id)}`}>{t}</a>: {events.filter((e) => e.trace === t).map((e) => `#${e.seq} ${e.type}`).join(", ")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
