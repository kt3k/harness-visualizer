import { useState } from "react";
import type { StoryLine, Tone } from "../../src/core/story";
import type { Bundle } from "./data";
import type { SourceTarget } from "./SourceView";
import { Evidence, useEvidenceMode } from "./Evidence";

const ICON: Record<Tone, string> = { model: "✦", check: "⛨", effect: "⚡", human: "👤", stop: "■", unknown: "?", data: "⛁", call: "↳", plain: "•" };
const TONE_TITLE: Record<Tone, string> = {
  model: "decided or produced by the model",
  check: "a check in the code",
  effect: "side effect",
  human: "a human decides",
  stop: "the run ends",
  unknown: "cannot be checked",
  data: "reads or writes stored data",
  call: "calls another part",
  plain: "step",
};

export interface LinesProps {
  b: Bundle;
  lines: StoryLine[];
  select: (id: string) => void;
  selected?: string;
  openSource: (t: SourceTarget) => void;
  depth?: number;
}

/**
 * Plain-language lines. Clicking a line opens its details (level 1). The small
 * "why?" button (shown on hover/focus, or always when the Evidence switch is on)
 * reveals the evidence for that line inline (level 2). Nothing else is shown.
 */
export function Lines({ b, lines, select, selected, openSource, depth = 0 }: LinesProps) {
  return (
    <ul className={`story-lines depth-${depth}`}>
      {lines.map((l, i) => (
        <Line key={i} l={l} b={b} select={select} selected={selected} openSource={openSource} depth={depth} />
      ))}
    </ul>
  );
}

function Line({ l, b, select, selected, openSource, depth }: { l: StoryLine } & Omit<LinesProps, "lines"> & { depth: number }) {
  const [why, setWhy] = useState(false);
  const [evidenceMode] = useEvidenceMode();
  return (
    <li className={`tone-${l.tone} ${l.danger ? "danger" : ""} ${l.ids.includes(selected ?? "\u0000") ? "sel" : ""} ${evidenceMode ? "ev-mode" : ""}`}>
      <div className="line-row">
        <button className="story-line" onClick={() => l.ids[0] && select(l.ids[0])} aria-label={`${l.text}. Show details`}>
          <span className="ticon" aria-hidden="true" title={TONE_TITLE[l.tone]}>
            {ICON[l.tone]}
          </span>
          <span className={l.code ? "code-inline" : ""}>{l.text}</span>
          {l.note && <span className="lnote"> — {l.note}</span>}
        </button>
        {l.ids.length > 0 && (
          <button className={`why ${why ? "on" : ""}`} onClick={() => setWhy((x) => !x)} aria-expanded={why} aria-label="Show evidence for this line">
            why?
          </button>
        )}
      </div>
      {why && <Evidence b={b} ids={l.ids} openSource={openSource} />}
      {l.children && l.children.length > 0 && <Lines b={b} lines={l.children} select={select} selected={selected} openSource={openSource} depth={depth + 1} />}
    </li>
  );
}
