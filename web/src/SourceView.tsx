import { useEffect, useRef } from "react";
import type { Bundle } from "./data";
import { githubUrl } from "./data";

export interface SourceTarget {
  file: string;
  start?: number;
  end?: number;
}

export function SourceView({ b, target, onClose }: { b: Bundle; target: SourceTarget; onClose: () => void }) {
  const text = b.sources[target.file];
  const ref = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeBtn.current?.focus();
    ref.current?.querySelector(".hl")?.scrollIntoView({ block: "center" });
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [target, onClose]);
  const nodesHere = b.ir.nodes.filter((n) => n.kind !== "Harness" && n.sourceRefs.some((r) => r.file === target.file));
  const lineNodes = new Map<number, string[]>();
  for (const n of nodesHere) {
    const r = n.sourceRefs.find((x) => x.file === target.file)!;
    if (r.endLine - r.startLine < 3) lineNodes.set(r.startLine, [...(lineNodes.get(r.startLine) ?? []), n.kind]);
  }
  const gh = githubUrl(b.ir, target.file, target.start, target.end);
  return (
    <div className="source-overlay" role="dialog" aria-modal="true" aria-label={`Source ${target.file}`} onClick={onClose}>
      <div className="source" onClick={(e) => e.stopPropagation()}>
        <div className="source-head">
          <b>{target.file}</b>
          {target.start && <span> lines {target.start}–{target.end ?? target.start}</span>}
          <span className="muted"> · read-only, redacted copy of the analysed source</span>
          <div className="spacer" />
          {gh && (
            <a href={gh} target="_blank" rel="noreferrer">
              open on GitHub ↗
            </a>
          )}
          <button ref={closeBtn} onClick={onClose}>
            Close (Esc)
          </button>
        </div>
        <div className="source-body" ref={ref}>
          {text === undefined ? (
            <p className="warn">Source not available in this bundle.</p>
          ) : (
            <table>
              <tbody>
                {text.split("\n").map((line, i) => {
                  const ln = i + 1;
                  const hl = target.start && ln >= target.start && ln <= (target.end ?? target.start);
                  return (
                    <tr key={ln} className={hl ? "hl" : ""}>
                      <td className="ln">{ln}</td>
                      <td className="marks">{(lineNodes.get(ln) ?? []).slice(0, 2).map((k) => <span key={k} className={`mark mk-${k}`} title={k}>{k[0]}</span>)}</td>
                      <td className="src">
                        <code>{line || " "}</code>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
