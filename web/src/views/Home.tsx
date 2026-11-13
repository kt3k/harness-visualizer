import type { HarnessEntry } from "../data";

export function Home({ index, evaluation }: { index: HarnessEntry[]; evaluation?: unknown }) {
  const ev = evaluation as { overall?: Record<string, unknown> } | undefined;
  return (
    <div className="home">
      <section className="intro">
        <h1>Harness Visualizer</h1>
        <p>
          An inspectable model of LLM agent harnesses, extracted <b>statically</b> from source code (TypeScript adapter) and reconciled with <b>recorded traces</b>. It separates what
          <b> code enforces</b> from what the <b>model decides</b>, shows which <b>effects</b> are reachable through which <b>gates</b>, what <b>state</b> enters each model call, and which
          parts remain <b>unknown</b>.
        </p>
        <p className="muted">Every claim carries an evidence label: static (from code structure), inferred (heuristic — verify), runtime (observed), or unknown. Reachability-based results are potential, not guaranteed.</p>
      </section>
      <h2>Sample harnesses</h2>
      <p className="muted">All samples are <b>synthetic fixtures</b> written for this project. Their sources and traces are part of the repository.</p>
      <div className="cards">
        {index.map((h) => (
          <a key={h.id} className="card" href={`#/h/${h.id}/overview`}>
            <h3>{h.name}</h3>
            <p>{h.description}</p>
            <div className="cardstats">
              <span>{h.stats.agents} agents</span>
              <span>{h.stats.modelCalls} model calls</span>
              <span>{h.stats.effects} effects</span>
              <span>{h.stats.promptOnlyRules} prompt-only rules</span>
              <span>{h.stats.unknowns} unknown</span>
              <span>{h.traces.length} traces</span>
              {h.baseline && <span>diff vs {h.baseline}</span>}
            </div>
          </a>
        ))}
      </div>
      <h2>Questions you can answer</h2>
      <ol className="questions">
        <li><b>Where does the LLM choose the next action?</b> — B Decision boundary: violet nodes; the table lists every model call and the branches that read its output.</li>
        <li><b>Which rules are enforced by code, which only by the prompt?</b> — C Effects &amp; authority: prompt rule table (prompt-only = no matching guard).</li>
        <li><b>Can this model decision lead to a destructive effect, and through which guards?</b> — select the model call in C; reachable effects and gates are highlighted.</li>
        <li><b>Which memory is visible to a model call?</b> — D State &amp; memory matrix, or the model call's detail panel.</li>
        <li><b>Why did a run terminate or retry?</b> — E Execution trace: replay events; terminations and retries map to source.</li>
        <li><b>If a prompt changes, what may be affected?</b> — F Change impact: pick the prompt or rule.</li>
        <li><b>What remains unknown?</b> — G Unknowns &amp; coverage.</li>
      </ol>
      {ev?.overall && (
        <>
          <h2>Evaluation (on synthetic fixtures)</h2>
          <pre className="code">{JSON.stringify(ev.overall, null, 2)}</pre>
        </>
      )}
    </div>
  );
}
