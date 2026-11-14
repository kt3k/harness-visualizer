import { useMemo, useState } from "react";
import type { ViewProps } from "../App";
import { buildStory } from "../../../src/core/story";
import { Lines } from "../StoryLines";

/**
 * Level 0: only the answers to "what does this harness do?".
 * No evidence, statistics or explanations unless the user asks for them.
 */
export function StoryView({ b, route, select, openSource }: ViewProps) {
  const story = useMemo(() => buildStory(b.ir), [b]);
  const [showAll, setShowAll] = useState(false);
  const pick = (id: string) => select(id);
  const common = { b, select: pick, selected: route.node, openSource };
  const warnings = showAll ? story.warnings : story.warnings.slice(0, 5);
  return (
    <div className="story">
      <header className="story-head">
        <h1>{b.ir.harness.name}</h1>
        <p className="headline">{story.headline}</p>
        <nav className="story-toc" aria-label="Sections">
          {story.warnings.length > 0 && <a href="#s-watch" onClick={(e) => jump(e, "s-watch")}>Watch out</a>}
          {story.flows.map((f) => (
            <a key={f.id} href={`#s-${f.id}`} onClick={(e) => jump(e, `s-${f.id}`)}>
              {f.title}
            </a>
          ))}
          {story.tools.length > 0 && <a href="#s-tools" onClick={(e) => jump(e, "s-tools")}>What the model can do</a>}
          <a href="#s-touch" onClick={(e) => jump(e, "s-touch")}>What it touches</a>
        </nav>
      </header>

      {story.warnings.length > 0 && (
        <section className="story-sec" id="s-watch">
          <h2>Watch out</h2>
          <Lines {...common} lines={warnings.map((w) => ({ text: w.text, ids: w.ids, tone: w.level === "danger" ? "effect" : "plain", danger: w.level === "danger" }))} />
          {story.warnings.length > 5 && (
            <button className="linkish" onClick={() => setShowAll((x) => !x)}>
              {showAll ? "fewer" : "more"}
            </button>
          )}
        </section>
      )}

      {story.flows.map((f) => (
        <section key={f.id} className={`story-sec flow kind-${f.kind}`} id={`s-${f.id}`}>
          <h2>{f.title}{f.kind === "subagent" ? " (subagent)" : ""}</h2>
          {f.purpose && <p className="purpose">{f.purpose}</p>}
          <div className="flow-grid">
            <div>
              <h3>Starts</h3>
              <Lines {...common} lines={f.triggers} />
              <h3>Ends</h3>
              <Lines {...common} lines={f.endings} />
            </div>
            <div>
              <h3>Step by step</h3>
              <Lines {...common} lines={f.steps} />
            </div>
          </div>
        </section>
      ))}

      {story.tools.length > 0 && (
        <section className="story-sec" id="s-tools">
          <h2>What the model can do</h2>
          {story.commonToolChecks.length > 0 && (
            <div className="common-checks">
              <b>Before any tool runs</b>
              <Lines {...common} lines={story.commonToolChecks.map((c) => ({ ...c, note: undefined }))} />
            </div>
          )}
          <table className="tbl tools">
            <thead>
              <tr>
                <th>Tool</th>
                <th>What it does</th>
                <th>What can stop it</th>
                <th>What the prompt says</th>
              </tr>
            </thead>
            <tbody>
              {story.tools.map((t) => (
                <tr key={t.id} className={t.irreversible ? "row-danger" : ""}>
                  <td>
                    <button className="story-line" onClick={() => pick(t.id)}>
                      <b>{t.name}</b>
                    </button>
                    {t.does && <div className="muted small">{t.does}</div>}
                  </td>
                  <td>
                    <Lines {...common} lines={[...t.effects, ...t.starts, ...t.unknown]} />
                  </td>
                  <td>
                    <Lines {...common} lines={[...t.checks, ...t.policy]} />
                    {!t.checks.length && !t.policy.length && <span className="warn">nothing specific to this tool</span>}
                  </td>
                  <td>
                    <Lines {...common} lines={t.promptSays} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="story-sec" id="s-touch">
        <h2>What it touches</h2>
        <div className="touch-grid">
          {story.touches.map((t) => (
            <div key={t.system} className="touch">
              <h3>{t.system}</h3>
              <Lines {...common} lines={t.actions} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function jump(e: React.MouseEvent, id: string) {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
