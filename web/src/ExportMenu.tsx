import { useState } from "react";
import type { RedactionLevel } from "../../src/core/ir";
import { redactDeep } from "../../src/core/redact";
import { markdownSummary } from "../../src/core/summary";
import type { Bundle } from "./data";

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportMenu({ b }: { b: Bundle }) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<RedactionLevel>("standard");
  const id = b.ir.harness.id;
  return (
    <div className="export">
      <button className="ghost" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        Export
      </button>
      {open && (
        <div className="export-menu" role="menu">
          <fieldset>
            <legend>Redaction</legend>
            <label><input type="radio" checked={level === "standard"} onChange={() => setLevel("standard")} /> standard (mask secrets, e-mails, phone numbers)</label>
            <label><input type="radio" checked={level === "strict"} onChange={() => setLevel("strict")} /> strict (also withhold prompt bodies and trace summaries)</label>
          </fieldset>
          <button role="menuitem" onClick={() => download(`${id}.ir.json`, JSON.stringify(redactDeep({ ...b.ir, analysis: { ...b.ir.analysis, redaction: level } }, level), null, 2), "application/json")}>IR (JSON)</button>
          <button role="menuitem" onClick={() => download(`${id}.summary.md`, markdownSummary(redactDeep(b.ir, level), { redaction: level }), "text/markdown")}>Summary (Markdown)</button>
          <button role="menuitem" onClick={() => download(`${id}.reconciliation.json`, JSON.stringify(redactDeep(b.rec, level), null, 2), "application/json")}>Reconciliation report (JSON)</button>
        </div>
      )}
    </div>
  );
}
