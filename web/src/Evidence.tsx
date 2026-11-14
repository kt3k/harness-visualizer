import { useEffect, useState } from "react";
import type { Bundle } from "./data";
import { githubUrl } from "./data";
import type { SourceTarget } from "./SourceView";
import { nodePhrase } from "../../src/core/humanize";

/**
 * Evidence (level 2) is never shown by default. It appears only when the user
 * asks: the per-line "why?" button, the collapsed "Evidence" section of the
 * details panel, or the global "Evidence" switch in the header.
 */

const KEY = "hv-evidence";
let evidenceOn = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();
const listeners = new Set<(v: boolean) => void>();

export function useEvidenceMode(): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(evidenceOn);
  useEffect(() => {
    listeners.add(setV);
    return () => void listeners.delete(setV);
  }, []);
  const set = (n: boolean) => {
    evidenceOn = n;
    try {
      localStorage.setItem(KEY, n ? "1" : "0");
    } catch {
      /* storage unavailable: setting lasts for this page only */
    }
    listeners.forEach((f) => f(n));
  };
  return [v, set];
}

const BASIS_TEXT: Record<string, string> = {
  static: "derived from the code structure",
  inferred: "inferred by a heuristic — verify",
  runtime: "observed in a recorded run",
  unknown: "could not be determined from the code",
};

/** Evidence for one or more IR nodes: where it comes from and how sure the tool is. */
export function Evidence({ b, ids, openSource }: { b: Bundle; ids: string[]; openSource: (t: SourceTarget) => void }) {
  const nodes = [...new Set(ids)].map((id) => b.idx.node(id)).filter((n): n is NonNullable<typeof n> => !!n);
  if (!nodes.length) return <div className="evidence-box">No evidence recorded.</div>;
  return (
    <div className="evidence-box">
      {nodes.map((n) => {
        const obs = b.rec.observedNodes[n.id];
        return (
          <div key={n.id} className="ev-node">
            <div className="ev-title">
              {cap(nodePhrase(n, b.ir).text)} <span className="muted">· {n.kind}</span>
            </div>
            <div className="ev-row">
              <span className="ev-k">How sure</span>
              <span>
                {BASIS_TEXT[n.assurance.basis]}
                {n.assurance.enforcement === "enforced" && "; enforced by code"}
                {n.assurance.enforcement === "advisory" && "; advisory text only (not enforced by code)"}
                {obs !== undefined && obs > 0 && `; seen ${obs}× in recorded runs`}
              </span>
            </div>
            {n.sourceRefs.map((r, i) => {
              const gh = githubUrl(b.ir, r.file, r.startLine, r.endLine);
              return (
                <div key={i} className="ev-row">
                  <span className="ev-k">Source</span>
                  <span>
                    <button className="srcbtn" onClick={() => openSource({ file: r.file, start: r.startLine, end: r.endLine })}>
                      {r.file}:{r.startLine}
                    </button>
                    {gh && (
                      <a href={gh} target="_blank" rel="noreferrer" className="gh">
                        GitHub ↗
                      </a>
                    )}
                    {r.snippet && <code className="ev-snip">{r.snippet}</code>}
                  </span>
                </div>
              );
            })}
            <div className="ev-row">
              <span className="ev-k">Why</span>
              <ul className="ev-claims">
                {n.evidence.map((e, i) => (
                  <li key={i}>
                    <span className={`basis basis-${e.basis}`}>{e.basis}</span> {e.claim}
                  </li>
                ))}
              </ul>
            </div>
            {n.uncertainties.length > 0 && (
              <div className="ev-row">
                <span className="ev-k">Caveats</span>
                <ul className="ev-claims">
                  {n.uncertainties.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
