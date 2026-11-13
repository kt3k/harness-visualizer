import { useMemo, useState } from "react";
import type { ViewProps } from "../App";
import { buildStory, type StoryLine, type Tone } from "../../../src/core/story";
import { Chip } from "../Detail";

const ICON: Record<Tone, string> = { model: "✦", check: "⛨", effect: "⚡", human: "👤", stop: "■", unknown: "?", data: "⛁", call: "↳", plain: "•" };
const TONE_TITLE: Record<Tone, string> = {
  model: "decided or produced by the model",
  check: "enforced by code",
  effect: "side effect",
  human: "a human decides",
  stop: "the run ends",
  unknown: "cannot be analysed",
  data: "reads or writes stored data",
  call: "calls another part",
  plain: "step",
};

function Lines({ lines, select, selected, depth = 0 }: { lines: StoryLine[]; select: (id: string) => void; selected?: string; depth?: number }) {
  return (
    <ul className={`story-lines depth-${depth}`}>
      {lines.map((l, i) => (
        <li key={i} className={`tone-${l.tone} ${l.danger ? "danger" : ""} ${l.ids.includes(selected ?? "\u0000") ? "sel" : ""}`}>
          <button className="story-line" onClick={() => l.ids[0] && select(l.ids[0])} title={`${TONE_TITLE[l.tone]} — click for evidence and source`}>
            <span className="ticon" aria-label={TONE_TITLE[l.tone]}>{ICON[l.tone]}</span>
            <span className={l.code ? "code-inline" : ""}>{l.text}</span>
            {l.note && <span className="lnote"> — {l.note}</span>}
          </button>
          {l.children && l.children.length > 0 && <Lines lines={l.children} select={select} selected={selected} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

export function StoryView({ b, route, select, go }: ViewProps) {
  const story = useMemo(() => buildStory(b.ir), [b]);
  const [showAll, setShowAll] = useState(false);
  const pick = (id: string) => select(id);
  const warnings = showAll ? story.warnings : story.warnings.slice(0, 6);
  return (
    <div className="story">
      <header className="story-head">
        <h1>{b.ir.harness.name}</h1>
        <p className="headline">{story.headline}</p>
        <p className="muted small">
          Written from the code by rules, not by an AI. Every line links to its evidence (click it). Wording is a paraphrase — lines in <span className="code-inline">monospace</span> are raw code the
          rules could not paraphrase.
        </p>
        <nav className="story-toc" aria-label="Sections">
          <a href="#s-watch" onClick={(e) => jump(e, "s-watch")}>Watch out ({story.warnings.length})</a>
          {story.flows.map((f) => (
            <a key={f.id} href={`#s-${f.id}`} onClick={(e) => jump(e, `s-${f.id}`)}>{f.title}</a>
          ))}
          <a href="#s-tools" onClick={(e) => jump(e, "s-tools")}>What the model can do</a>
          <a href="#s-touch" onClick={(e) => jump(e, "s-touch")}>What it touches</a>
        </nav>
      </header>

      {story.warnings.length > 0 && (
        <section className="story-sec" id="s-watch">
          <h2>Watch out</h2>
          <ul className="warnings">
            {warnings.map((w, i) => (
              <li key={i} className={w.level}>
                <button className="story-line" onClick={() => pick(w.ids[0])}>
                  <Chip kind={w.level === "danger" ? "danger" : w.level === "warn" ? "warn" : "neutral"}>{w.level === "danger" ? "risk" : w.level === "warn" ? "gap" : "verify"}</Chip> {w.text}
                </button>
              </li>
            ))}
          </ul>
          {story.warnings.length > 6 && <button className="linkish" onClick={() => setShowAll((x) => !x)}>{showAll ? "show fewer" : `show all ${story.warnings.length}`}</button>}
        </section>
      )}

      {story.flows.map((f) => (
        <section key={f.id} className={`story-sec flow kind-${f.kind}`} id={`s-${f.id}`}>
          <h2>
            {f.title} <Chip kind={f.kind === "subagent" ? "auth-model" : "neutral"}>{f.kind === "entry" ? "entry point" : f.kind}</Chip>
            <button className="linkish small" onClick={() => go({ view: "decisions", node: f.id })}>show in graph →</button>
          </h2>
          {f.purpose && <p className="purpose">{f.purpose}</p>}
          <div className="flow-grid">
            <div>
              <h3>Starts</h3>
              <Lines lines={f.triggers} select={pick} selected={route.node} />
              <h3>Ends</h3>
              <Lines lines={f.endings} select={pick} selected={route.node} />
            </div>
            <div>
              <h3>Step by step</h3>
              <Lines lines={f.steps} select={pick} selected={route.node} />
            </div>
          </div>
        </section>
      ))}

      <section className="story-sec" id="s-tools">
        <h2>What the model can do</h2>
        <p className="muted">The model chooses among these tools; the code decides whether and how each one runs.</p>
        {story.commonToolChecks.length > 0 && (
          <div className="common-checks">
            <b>Checked before any tool runs:</b>
            <Lines lines={story.commonToolChecks} select={pick} selected={route.node} />
          </div>
        )}
        <table className="tbl tools">
          <thead>
            <tr>
              <th>Tool</th>
              <th>What it really does</th>
              <th>What can stop it (code)</th>
              <th>What the prompt says (not enforced)</th>
            </tr>
          </thead>
          <tbody>
            {story.tools.map((t) => (
              <tr key={t.id} className={t.irreversible ? "row-danger" : ""}>
                <td>
                  <button className="story-line" onClick={() => pick(t.id)}>
                    <b>{t.name}</b>
                  </button>
                  <div className="muted small">{t.does}</div>
                  {t.offeredTo.length > 0 && <div className="muted small">used by: {t.offeredTo.join(", ")}</div>}
                </td>
                <td>
                  <Lines lines={[...t.effects, ...t.starts, ...t.unknown]} select={pick} selected={route.node} />
                  {!t.effects.length && !t.starts.length && !t.unknown.length && <span className="muted">no side effect found</span>}
                </td>
                <td>
                  <Lines lines={[...t.checks, ...t.policy]} select={pick} selected={route.node} />
                  {!t.checks.length && !t.policy.length && <span className="warn">nothing specific to this tool</span>}
                </td>
                <td>
                  <Lines lines={t.promptSays} select={pick} selected={route.node} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="story-sec" id="s-touch">
        <h2>What it touches</h2>
        <div className="touch-grid">
          {story.touches.map((t) => (
            <div key={t.system} className="touch">
              <h3>{t.system}</h3>
              <Lines lines={t.actions} select={pick} selected={route.node} />
            </div>
          ))}
        </div>
      </section>
      <p className="muted small">
        Want the full picture? The other tabs show the underlying graph: <a href="#" onClick={(e) => { e.preventDefault(); go({ view: "decisions" }); }}>decision boundary</a>,{" "}
        <a href="#" onClick={(e) => { e.preventDefault(); go({ view: "effects" }); }}>effects</a>, <a href="#" onClick={(e) => { e.preventDefault(); go({ view: "trace" }); }}>recorded runs</a>.
      </p>
    </div>
  );
}

function jump(e: React.MouseEvent, id: string) {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
