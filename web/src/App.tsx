import { useCallback, useEffect, useMemo, useState } from "react";
import { loadBundle, loadEvaluation, loadIndex, type Bundle, type HarnessEntry } from "./data";
import { Detail } from "./Detail";
import { SourceView, type SourceTarget } from "./SourceView";
import { Legend } from "./Legend";
import { Search } from "./Search";
import { ExportMenu } from "./ExportMenu";
import { OverviewView } from "./views/OverviewView";
import { DecisionsView } from "./views/DecisionsView";
import { EffectsView } from "./views/EffectsView";
import { MemoryView } from "./views/MemoryView";
import { TraceView } from "./views/TraceView";
import { ImpactView } from "./views/ImpactView";
import { CoverageView } from "./views/CoverageView";
import { Home } from "./views/Home";
import { StoryView } from "./views/StoryView";

export type ViewId = "story" | "overview" | "decisions" | "effects" | "memory" | "trace" | "impact" | "coverage";

export const VIEWS: { id: ViewId; key: string; title: string; hint: string }[] = [
  { id: "story", key: "S", title: "What it does", hint: "Plain-language summary: what starts it, step by step, what the model can do, what it touches, what to watch out for" },
  { id: "overview", key: "A", title: "Map", hint: "Agents, loops, subagents, tools, stores and how they invoke each other" },
  { id: "decisions", key: "B", title: "Decision boundary", hint: "What code decides vs. what the model decides; request → authorization → execution" },
  { id: "effects", key: "C", title: "Effects & authority", hint: "Reachable side effects and the code gates in front of them; prompt-only rules" },
  { id: "memory", key: "D", title: "State & memory", hint: "Stores, reads, writes and what enters each model call" },
  { id: "trace", key: "E", title: "Execution trace", hint: "Recorded runs mapped onto the graph; replay without side effects; reconciliation" },
  { id: "impact", key: "F", title: "Change impact", hint: "What a change to a prompt, guard or code location may affect; version diff" },
  { id: "coverage", key: "G", title: "Unknowns & coverage", hint: "What the analysis could not resolve; metrics" },
];

export interface Route {
  harness?: string;
  view: ViewId;
  node?: string;
  trace?: string;
  seed?: string;
}

function parseHash(): Route {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  const [pathPart, query = ""] = h.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const q = new URLSearchParams(query);
  if (parts[0] !== "h" || !parts[1]) return { view: "story" };
  return { harness: parts[1], view: (VIEWS.find((v) => v.id === parts[2])?.id ?? "story") as ViewId, node: q.get("n") ?? undefined, trace: q.get("t") ?? undefined, seed: q.get("seed") ?? undefined };
}

export function hashOf(r: Route): string {
  if (!r.harness) return "#/";
  const q = new URLSearchParams();
  if (r.node) q.set("n", r.node);
  if (r.trace) q.set("t", r.trace);
  if (r.seed) q.set("seed", r.seed);
  const qs = q.toString();
  return `#/h/${encodeURIComponent(r.harness)}/${r.view}${qs ? `?${qs}` : ""}`;
}

export interface ViewProps {
  b: Bundle;
  route: Route;
  select: (id: string | undefined) => void;
  go: (patch: Partial<Route>) => void;
  openSource: (t: SourceTarget) => void;
  /** select without adding a browser history entry (used while replaying) */
  replaceSelect: (id: string | undefined) => void;
}

export function App() {
  const [index, setIndex] = useState<HarnessEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(parseHash());
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [source, setSource] = useState<SourceTarget | null>(null);
  const [legend, setLegend] = useState(false);
  const [evaluation, setEvaluation] = useState<unknown>();

  useEffect(() => {
    loadIndex().then(setIndex, (e) => setError(String(e.message ?? e)));
    loadEvaluation().then(setEvaluation, () => undefined);
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    if (!index || !route.harness) {
      setBundle(null);
      return;
    }
    const entry = index.find((e) => e.id === route.harness);
    if (!entry) {
      setError(`unknown harness '${route.harness}'`);
      return;
    }
    if (bundle?.entry.id === entry.id) return;
    setBundle(null);
    loadBundle(entry).then(setBundle, (e) => setError(String(e.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, route.harness]);

  const go = useCallback((patch: Partial<Route>) => {
    const next = { ...parseHash(), ...patch };
    location.hash = hashOf(next);
  }, []);
  const select = useCallback((id: string | undefined) => go({ node: id }), [go]);
  const replaceSelect = useCallback((id: string | undefined) => {
    const next = { ...parseHash(), node: id };
    history.replaceState(null, "", hashOf(next));
    setRoute(next);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select")) return;
      if (e.altKey && /^[a-gs]$/i.test(e.key)) {
        const v = VIEWS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
        if (v) go({ view: v.id });
      }
      if (e.key === "?") setLegend((x) => !x);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const viewProps = useMemo(() => (bundle ? { b: bundle, route, select, go, openSource: setSource, replaceSelect } : null), [bundle, route, select, go, replaceSelect]);

  if (error)
    return (
      <div className="fatal">
        <h1>Harness Visualizer</h1>
        <p role="alert">{error}</p>
        <a href="#/" onClick={() => setError(null)}>back</a>
      </div>
    );

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#/">Harness&nbsp;Visualizer</a>
        {index && route.harness && (
          <select aria-label="Harness" value={route.harness} onChange={(e) => go({ harness: e.target.value, node: undefined, trace: undefined, seed: undefined })}>
            {index.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
                {h.synthetic ? " (synthetic)" : ""}
              </option>
            ))}
          </select>
        )}
        {route.harness && (
          <nav className="tabs" aria-label="Views">
            {VIEWS.map((v) => (
              <a key={v.id} href={hashOf({ ...route, view: v.id })} className={route.view === v.id ? "active" : ""} title={`${v.hint} (Alt+${v.key})`} aria-current={route.view === v.id ? "page" : undefined}>
                <span className="tabkey">{v.key}</span> {v.title}
              </a>
            ))}
          </nav>
        )}
        <div className="spacer" />
        {bundle && <Search b={bundle} onPick={(id) => select(id)} />}
        {bundle && <ExportMenu b={bundle} />}
        <button className="ghost" onClick={() => setLegend((x) => !x)} aria-expanded={legend}>
          Legend
        </button>
      </header>
      {legend && <Legend onClose={() => setLegend(false)} />}
      {!route.harness && index && <Home index={index} evaluation={evaluation} />}
      {route.harness && !bundle && <div className="loading">Loading {route.harness}…</div>}
      {viewProps && (
        <main className="main">
          {bundle!.ir.harness.synthetic && <div className="synthetic-banner">Synthetic fixture harness — written to exercise the analyzer; not production code.</div>}
          <section className="view" aria-label={VIEWS.find((v) => v.id === route.view)?.title}>
            {route.view === "story" && <StoryView {...viewProps} />}
            {route.view === "overview" && <OverviewView {...viewProps} />}
            {route.view === "decisions" && <DecisionsView {...viewProps} />}
            {route.view === "effects" && <EffectsView {...viewProps} />}
            {route.view === "memory" && <MemoryView {...viewProps} />}
            {route.view === "trace" && <TraceView {...viewProps} />}
            {route.view === "impact" && <ImpactView {...viewProps} />}
            {route.view === "coverage" && <CoverageView {...viewProps} evaluation={evaluation} />}
          </section>
          <aside className="detail" aria-label="Node details">
            <Detail b={bundle!} id={route.node} select={select} go={go} openSource={setSource} />
          </aside>
        </main>
      )}
      {source && bundle && <SourceView b={bundle} target={source} onClose={() => setSource(null)} />}
    </div>
  );
}
