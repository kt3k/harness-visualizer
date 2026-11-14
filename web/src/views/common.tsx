import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Graph, type HL } from "../Graph";
import type { Bundle } from "../data";
import { LENSES, computeVisible, defaultExpanded, type DisplayOptions, type LensId } from "../viewmodel";

const expandedStore = new Map<string, Set<string>>();

function loadDisplay(): DisplayOptions {
  try {
    const v = JSON.parse(localStorage.getItem("hv-display") ?? "null");
    if (v && typeof v.plain === "boolean" && typeof v.simplify === "boolean") return v;
  } catch {
    /* storage unavailable */
  }
  return { plain: true, simplify: true };
}
let displayState = loadDisplay();
const displayListeners = new Set<(d: DisplayOptions) => void>();
export function useDisplay(): [DisplayOptions, (d: DisplayOptions) => void] {
  const [d, setD] = useState(displayState);
  useEffect(() => {
    displayListeners.add(setD);
    return () => void displayListeners.delete(setD);
  }, []);
  const set = (n: DisplayOptions) => {
    displayState = n;
    try {
      localStorage.setItem("hv-display", JSON.stringify(n));
    } catch {
      /* ignore */
    }
    displayListeners.forEach((f) => f(n));
  };
  return [d, set];
}

export function useLens(b: Bundle, lensId: LensId, focus?: string) {
  const lens = LENSES[lensId];
  const key = `${b.entry.id}|${lensId}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => expandedStore.get(key) ?? defaultExpanded(b.ir, b.idx, lens));
  useEffect(() => {
    setExpanded(expandedStore.get(key) ?? defaultExpanded(b.ir, b.idx, lens));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // make sure the focused node is visible: expand its ancestors
  useEffect(() => {
    if (!focus || !b.idx.node(focus)) return;
    const anc = b.idx.ancestors(focus).filter((a) => !expanded.has(a) && b.idx.node(a)?.kind !== "Harness");
    const hiddenKind = [focus, ...b.idx.ancestors(focus)].some((a) => lens.hideKinds.includes(b.idx.node(a)!.kind));
    if (anc.length && !hiddenKind) update(new Set([...expanded, ...anc]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, key]);
  const update = (s: Set<string>) => {
    expandedStore.set(key, s);
    setExpanded(s);
  };
  const toggle = (id: string) => {
    const s = new Set(expanded);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    update(s);
  };
  const [display] = useDisplay();
  const vis = useMemo(() => computeVisible(b.ir, b.idx, lens, expanded, display), [b, lens, expanded, display]);
  const expandAll = () => update(new Set(b.ir.nodes.filter((n) => b.idx.isContainer(n.id) && !lens.hideKinds.includes(n.kind)).map((n) => n.id)));
  const collapseAll = () => update(new Set(["harness"]));
  const reset = () => update(defaultExpanded(b.ir, b.idx, lens));
  return { lens, vis, toggle, expandAll, collapseAll, reset, expanded };
}

export function LensGraph(props: {
  b: Bundle;
  lensId: LensId;
  selected?: string;
  select: (id: string | undefined) => void;
  highlight?: Map<string, HL>;
  edgeHighlight?: Set<string>;
  observed?: Record<string, number>;
  toolbar?: ReactNode;
}) {
  const L = useLens(props.b, props.lensId, props.selected);
  const [display, setDisplay] = useDisplay();
  return (
    <div className="lensgraph">
      <div className="lens-toolbar">
        <label title="Show plain-language labels instead of code"><input type="checkbox" checked={display.plain} onChange={(e) => setDisplay({ ...display, plain: e.target.checked })} /> plain labels</label>
        <label title="Hide loop heads, return points, conversation appends and reply filters; draw edges across them"><input type="checkbox" checked={display.simplify} onChange={(e) => setDisplay({ ...display, simplify: e.target.checked })} /> hide details</label>
        <button onClick={L.reset}>default</button>
        <button onClick={L.expandAll}>expand all</button>
        <button onClick={L.collapseAll}>collapse all</button>
        {props.selected && props.b.idx.isContainer(props.selected) && <button onClick={() => L.toggle(props.selected!)}>{L.expanded.has(props.selected) ? "collapse" : "expand"} selected</button>}
        {props.toolbar}
      </div>
      <Graph
        nodes={L.vis.nodes}
        edges={L.vis.edges}
        selected={props.selected}
        onSelect={props.select}
        onToggle={L.toggle}
        highlight={props.highlight}
        edgeHighlight={props.edgeHighlight}
        observed={props.observed}
        ariaLabel={`${L.lens.title} graph of ${props.b.ir.harness.name}`}
        layoutKey={`${props.b.entry.id}|${props.lensId}`}
      />
    </div>
  );
}

export function Split({ graph, panel, panelTitle, defaultOpen = false }: { graph: ReactNode; panel: ReactNode; panelTitle: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`split ${open ? "" : "collapsed"}`}>
      <div className="split-graph">{graph}</div>
      <div className="split-panel">
        <button className="panel-toggle" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
          {open ? "▾" : "▸"} {panelTitle}
        </button>
        {open && <div className="panel-body">{panel}</div>}
      </div>
    </div>
  );
}
