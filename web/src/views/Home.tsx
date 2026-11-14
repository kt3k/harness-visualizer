import type { HarnessEntry } from "../data";

export function Home({ index, evaluation }: { index: HarnessEntry[]; evaluation?: unknown }) {
  void evaluation;
  return (
    <div className="home">
      <h1>Harness Visualizer</h1>
      <p className="headline">See what an LLM agent harness does: what the model decides, what the code enforces, and what it can affect.</p>
      <div className="cards">
        {index.map((h) => (
          <a key={h.id} className="card" href={`#/h/${h.id}/story`}>
            <h3>{h.name}</h3>
            {h.description && <p>{h.description.replace(/^SYNTHETIC fixture\.\s*/, "")}</p>}
          </a>
        ))}
      </div>
    </div>
  );
}
