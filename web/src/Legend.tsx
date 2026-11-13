export function Legend({ onClose }: { onClose: () => void }) {
  return (
    <div className="legend" role="dialog" aria-label="Legend">
      <div className="legend-head">
        <b>Legend</b>
        <button onClick={onClose}>close</button>
      </div>
      <div className="legend-grid">
        <div>
          <h4>Who decides (fill colour)</h4>
          <p><span className="sw auth-code" /> deterministic code</p>
          <p><span className="sw auth-model" /> model discretion</p>
          <p><span className="sw auth-human" /> human input</p>
          <p><span className="sw auth-external" /> external event</p>
          <p><span className="sw auth-unknown" /> unknown (dashed)</p>
        </div>
        <div>
          <h4>Node shapes</h4>
          <p><b>LLM</b> pill — model call</p>
          <p><b>◇</b> hexagon — branch (Decision)</p>
          <p><b>⛨</b> octagon — code guard / authorization (enforced)</p>
          <p><b>⇢</b> parallelogram — tool dispatch (model-selected)</p>
          <p><b>⚡</b> box — side effect; red border = irreversible</p>
          <p><b>⟲ ✎</b> rounded — state read / write</p>
          <p><b>■</b> double box — termination</p>
          <p><b>¶</b> note — prompt / prompt rule (advisory)</p>
          <p>small pill — loop head / return point</p>
        </div>
        <div>
          <h4>Edges</h4>
          <p><span className="ln ek-transition" /> possible control flow (static)</p>
          <p><span className="ln ek-transition back" /> loop back-edge</p>
          <p><span className="ln ek-dispatches" /> model-selected dispatch</p>
          <p><span className="ln ek-gates" /> enforcement gate ⊣</p>
          <p><span className="ln ek-context" /> data enters model context</p>
          <p><span className="ln ek-writes" /> state read/write</p>
          <p><span className="ln ek-invokes" /> invocation</p>
          <p><span className="ln inferred" /> inferred (heuristic)</p>
        </div>
        <div>
          <h4>Evidence</h4>
          <p><span className="chip chip-basis-static">static</span> from code structure</p>
          <p><span className="chip chip-basis-inferred">inferred</span> heuristic — verify</p>
          <p><span className="chip chip-basis-runtime">runtime</span> observed in a trace</p>
          <p><span className="chip chip-basis-unknown">unknown</span> not determinable</p>
          <p><span className="obs-sw">3</span> observed count (trace)</p>
          <h4>Keys</h4>
          <p>Alt+A…G views · arrows move · Enter expand · +/− zoom · 0 fit · / search · ? legend</p>
        </div>
      </div>
    </div>
  );
}
