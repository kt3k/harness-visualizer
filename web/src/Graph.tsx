import ELK from "elkjs/lib/elk.bundled.js";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import type { VisEdge, VisNode } from "./viewmodel";
import { authorityOf, shortLabel } from "./viewmodel";

const elk = new ELK();

export type HL = "seed" | "affected" | "path" | "current" | "observed" | "warn";

interface Props {
  nodes: VisNode[];
  edges: VisEdge[];
  selected?: string;
  highlight?: Map<string, HL>;
  edgeHighlight?: Set<string>;
  observed?: Record<string, number>;
  onSelect: (id: string | undefined) => void;
  onToggle: (id: string) => void;
  ariaLabel: string;
  layoutKey: string;
}

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  vis: VisNode;
  depth: number;
}

interface Line {
  e: VisEdge;
  pts: { x: number; y: number }[];
}

const LEAF_H = 34;

function leafSize(v: VisNode): { w: number; h: number } {
  if (v.node.kind === "Junction") return { w: v.node.attrs.role === "loop-head" ? 120 : 110, h: 22 };
  const label = shortLabel(v.node, 40);
  const w = Math.min(250, Math.max(96, label.length * 6.4 + (v.container ? 44 : 30)));
  return { w, h: v.node.kind === "Decision" ? 40 : LEAF_H };
}

export function Graph(p: Props) {
  const [layout, setLayout] = useState<{ boxes: Box[]; lines: Line[]; w: number; h: number } | null>(null);
  const [tf, setTf] = useState({ k: 1, x: 0, y: 0 });
  const [err, setErr] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const lastKey = useRef<string>("");

  const structureKey = useMemo(() => p.nodes.map((n) => `${n.id}${n.expanded ? "+" : ""}`).join("|") + "#" + p.edges.map((e) => e.id).join("|"), [p.nodes, p.edges]);

  useEffect(() => {
    let cancelled = false;
    const byParent = new Map<string | undefined, VisNode[]>();
    for (const n of p.nodes) byParent.set(n.parent, [...(byParent.get(n.parent) ?? []), n]);
    const ids = new Set(p.nodes.map((n) => n.id));
    // reparent nodes whose parent is not visible/expanded to the root
    for (const n of p.nodes) if (n.parent && !ids.has(n.parent)) {
      byParent.set(n.parent, (byParent.get(n.parent) ?? []).filter((x) => x !== n));
      byParent.set(undefined, [...(byParent.get(undefined) ?? []), n]);
    }
    const build = (v: VisNode): Record<string, unknown> => {
      if (v.expanded) {
        return {
          id: v.id,
          layoutOptions: { "elk.padding": "[top=34,left=12,bottom=12,right=12]", "elk.nodeLabels.placement": "INSIDE V_TOP H_LEFT" },
          children: (byParent.get(v.id) ?? []).map(build),
        };
      }
      const s = leafSize(v);
      return { id: v.id, width: s.w, height: s.h };
    };
    const graph = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.hierarchyHandling": "INCLUDE_CHILDREN",
        "elk.json.edgeCoords": "ROOT",
        "elk.json.shapeCoords": "ROOT",
        "elk.spacing.nodeNode": "22",
        "elk.layered.spacing.nodeNodeBetweenLayers": "34",
        "elk.spacing.edgeNode": "14",
        "elk.layered.spacing.edgeNodeBetweenLayers": "14",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
        "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
      },
      children: (byParent.get(undefined) ?? []).map(build),
      edges: p.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
    };
    elk
      .layout(graph as never)
      .then((res: any) => {
        if (cancelled) return;
        const boxes: Box[] = [];
        const visById = new Map(p.nodes.map((n) => [n.id, n]));
        const walk = (n: any, depth: number) => {
          for (const c of n.children ?? []) {
            const v = visById.get(c.id);
            if (v) boxes.push({ id: c.id, x: c.x, y: c.y, w: c.width, h: c.height, vis: v, depth });
            walk(c, depth + 1);
          }
        };
        walk(res, 0);
        const edgeById = new Map(p.edges.map((e) => [e.id, e]));
        const lines: Line[] = [];
        const collect = (n: any) => {
          for (const e of n.edges ?? []) {
            const ve = edgeById.get(e.id);
            const s = e.sections?.[0];
            if (ve && s) lines.push({ e: ve, pts: [s.startPoint, ...(s.bendPoints ?? []), s.endPoint] });
          }
          for (const c of n.children ?? []) collect(c);
        };
        collect(res);
        setLayout({ boxes, lines, w: res.width, h: res.height });
        setErr(null);
      })
      .catch((e: Error) => !cancelled && setErr(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  // fit on new layoutKey (harness / lens change); otherwise keep the user's view
  useEffect(() => {
    if (!layout || !wrap.current) return;
    if (lastKey.current !== p.layoutKey) {
      lastKey.current = p.layoutKey;
      fit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, p.layoutKey]);

  // keep selection in view
  useEffect(() => {
    if (!layout || !p.selected || !wrap.current) return;
    const b = layout.boxes.find((x) => x.id === p.selected);
    if (!b) return;
    const W = wrap.current.clientWidth;
    const H = wrap.current.clientHeight;
    const sx = b.x * tf.k + tf.x;
    const sy = b.y * tf.k + tf.y;
    if (sx < 0 || sy < 0 || sx + b.w * tf.k > W || sy + b.h * tf.k > H) setTf((t) => ({ ...t, x: W / 2 - (b.x + b.w / 2) * t.k, y: H / 2 - (b.y + b.h / 2) * t.k }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.selected, layout]);

  function fit() {
    if (!layout || !wrap.current) return;
    const W = wrap.current.clientWidth;
    const H = wrap.current.clientHeight;
    const fitK = Math.min(W / (layout.w + 40), H / (layout.h + 40));
    if (fitK >= 0.55) {
      const k = Math.min(1.2, fitK);
      setTf({ k, x: (W - layout.w * k) / 2, y: Math.max(10, (H - layout.h * k) / 2) });
      return;
    }
    // large graph: keep text readable and anchor on the selection (or the first agent / entry point)
    const k = 0.7;
    const target =
      layout.boxes.find((b) => b.id === p.selected) ??
      layout.boxes.filter((b) => b.vis.node.kind === "Agent" || b.vis.node.kind === "ExternalEvent").sort((a, b) => a.y - b.y)[0] ??
      layout.boxes.sort((a, b) => a.y - b.y)[0];
    if (!target) return;
    setTf({ k, x: W / 2 - (target.x + target.w / 2) * k, y: 30 - target.y * k });
  }

  const onWheel = (e: WheelEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const f = Math.exp(-e.deltaY * 0.0015);
    setTf((t) => {
      const k = Math.min(3, Math.max(0.08, t.k * f));
      return { k, x: mx - ((mx - t.x) * k) / t.k, y: my - ((my - t.y) * k) / t.k };
    });
  };
  const onDown = (e: PointerEvent) => {
    if ((e.target as Element).closest("[data-node]")) return;
    drag.current = { x: e.clientX, y: e.clientY, tx: tf.x, ty: tf.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (d) setTf((t) => ({ ...t, x: d.tx + e.clientX - d.x, y: d.ty + e.clientY - d.y }));
  };
  const onUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 4) p.onSelect(undefined);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!layout) return;
    const boxes = layout.boxes.filter((b) => !b.vis.expanded);
    const cur = layout.boxes.find((b) => b.id === p.selected);
    if (e.key === "+" || e.key === "=") setTf((t) => ({ ...t, k: Math.min(3, t.k * 1.2) }));
    else if (e.key === "-") setTf((t) => ({ ...t, k: Math.max(0.08, t.k / 1.2) }));
    else if (e.key === "0") fit();
    else if (e.key === "Escape") p.onSelect(undefined);
    else if ((e.key === "Enter" || e.key === " ") && cur && cur.vis.container) p.onToggle(cur.id);
    else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      if (!cur) {
        if (boxes[0]) p.onSelect(boxes[0].id);
        return;
      }
      const cx = cur.x + cur.w / 2;
      const cy = cur.y + cur.h / 2;
      const dir = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key]!;
      let best: Box | undefined;
      let bestScore = Infinity;
      for (const b of layout.boxes) {
        if (b.id === cur.id) continue;
        const dx = b.x + b.w / 2 - cx;
        const dy = b.y + b.h / 2 - cy;
        const along = dx * dir[0] + dy * dir[1];
        if (along <= 4) continue;
        const across = Math.abs(dx * dir[1] - dy * dir[0]);
        const score = along + across * 2.5;
        if (score < bestScore) {
          bestScore = score;
          best = b;
        }
      }
      if (best) p.onSelect(best.id);
    } else return;
    e.preventDefault();
  };

  const hl = p.highlight;
  const dimming = !!hl && hl.size > 0;
  const containers = layout?.boxes.filter((b) => b.vis.expanded).sort((a, b) => a.depth - b.depth) ?? [];
  const leaves = layout?.boxes.filter((b) => !b.vis.expanded) ?? [];

  return (
    <div className="graph" ref={wrap} tabIndex={0} role="application" aria-label={`${p.ariaLabel}. Arrow keys move selection, Enter expands or collapses, plus and minus zoom, 0 fits.`} onKeyDown={onKey} onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
      {!layout && !err && <div className="graph-msg">Laying out…</div>}
      {err && <div className="graph-msg error">Layout failed: {err}</div>}
      <div className="graph-tools" onPointerDown={(e) => e.stopPropagation()}>
        <button onClick={() => setTf((t) => ({ ...t, k: Math.min(3, t.k * 1.25) }))} aria-label="Zoom in">+</button>
        <button onClick={() => setTf((t) => ({ ...t, k: Math.max(0.08, t.k / 1.25) }))} aria-label="Zoom out">−</button>
        <button onClick={fit} aria-label="Reset view">reset</button>
        <button onClick={() => {
          if (!layout || !wrap.current) return;
          const W = wrap.current.clientWidth;
          const H = wrap.current.clientHeight;
          const k = Math.min(1.2, Math.min(W / (layout.w + 40), H / (layout.h + 40)));
          setTf({ k, x: (W - layout.w * k) / 2, y: Math.max(10, (H - layout.h * k) / 2) });
        }} aria-label="Show whole graph">whole</button>
      </div>
      <svg width="100%" height="100%">
        <defs>
          {["transition", "dispatches", "gates", "context", "writes", "reads", "invokes", "offers", "interprets", "corresponds", "causal-hypothesis", "resumes", "hl"].map((k) => (
            <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              {k === "gates" ? <path d="M 7 0 L 7 10 M 0 5 L 7 5" className={`mk mk-${k}`} /> : <path d="M 0 0 L 10 5 L 0 10 z" className={`mk mk-${k}`} />}
            </marker>
          ))}
        </defs>
        <g transform={`translate(${tf.x},${tf.y}) scale(${tf.k})`}>
          {containers.map((b) => (
            <g
              key={b.id}
              data-node={b.id}
              className={`container k-${b.vis.node.kind} auth-${authorityOf(b.vis.node)} ${p.selected === b.id ? "sel" : ""} ${hl?.get(b.id) ? `hl-${hl.get(b.id)}` : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                p.onSelect(b.id);
              }}
            >
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />
              <g className="chead" onClick={(e) => {
                e.stopPropagation();
                p.onToggle(b.id);
              }}>
                <rect x={b.x} y={b.y} width={b.w} height={26} rx={8} className="chead-bg" />
                <text x={b.x + 10} y={b.y + 17} className="ctitle">▾ {kindTag(b.vis.node.kind)} {shortLabel(b.vis.node, Math.max(10, Math.floor(b.w / 7) - 6))}</text>
              </g>
              <title>{`${b.vis.node.kind}: ${b.vis.node.label} — click header to collapse`}</title>
            </g>
          ))}
          {layout?.lines.map((l) => {
            const d = l.pts.map((pt, i) => `${i ? "L" : "M"}${pt.x},${pt.y}`).join(" ");
            const on = p.edgeHighlight && l.e.edgeIds.some((x) => p.edgeHighlight!.has(x));
            const dim = dimming && !on && !(hl?.has(l.e.from) && hl?.has(l.e.to));
            const mid = l.pts[Math.floor(l.pts.length / 2)];
            const prev = l.pts[Math.floor(l.pts.length / 2) - 1] ?? mid;
            const showLabel = l.e.labels.length > 0 && (l.e.kind === "dispatches" || l.e.kind === "gates" || /^(if |reject|pass|else|case |tool = |exit|default|no |other|fork|throws)/.test(l.e.labels[0]));
            return (
              <g key={l.e.id} className={`edge ek-${l.e.kind} ${l.e.back ? "back" : ""} ${l.e.inferred ? "inferred" : ""} ${on ? "on" : ""} ${dim ? "dim" : ""}`}>
                <path d={d} markerEnd={`url(#arrow-${on ? "hl" : l.e.kind})`} />
                {showLabel && (
                  <text x={(mid.x + prev.x) / 2 + 3} y={(mid.y + prev.y) / 2 - 3} className="elabel">
                    {truncate(l.e.labels[0], 30)}
                    {l.e.count > 1 && l.e.labels.length > 1 ? ` +${l.e.labels.length - 1}` : ""}
                  </text>
                )}
                <title>{`${l.e.kind}${l.e.inferred ? " (inferred)" : ""}: ${l.e.labels.join(" | ") || ""} ×${l.e.count}`}</title>
              </g>
            );
          })}
          {leaves.map((b) => {
            const n = b.vis.node;
            const h = hl?.get(b.id);
            const obs = p.observed?.[b.id];
            return (
              <g
                key={b.id}
                data-node={b.id}
                className={`node k-${n.kind} auth-${authorityOf(n)} ${p.selected === b.id ? "sel" : ""} ${h ? `hl-${h}` : ""} ${dimming && !h ? "dim" : ""} ${n.attrs.irreversible === true ? "irreversible" : ""} ${n.assurance.basis === "inferred" ? "basis-inferred" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  p.onSelect(b.id);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (b.vis.container) p.onToggle(b.id);
                }}
              >
                <Shape b={b} />
                <text x={b.x + (n.kind === "Junction" ? b.w / 2 : 10)} y={b.y + b.h / 2 + 4} textAnchor={n.kind === "Junction" ? "middle" : "start"} className="nlabel">
                  {n.kind !== "Junction" && <tspan className="ktag">{kindTag(n.kind)} </tspan>}
                  {shortLabel(n, Math.max(8, Math.floor((b.w - 30) / 6.4)))}
                </text>
                {b.vis.container && (
                  <text x={b.x + b.w - 8} y={b.y + 13} textAnchor="end" className="expand-hint">
                    ▸{b.vis.hiddenCount}
                  </text>
                )}
                {obs !== undefined && obs > 0 && (
                  <g className="obs">
                    <circle cx={b.x + b.w - 4} cy={b.y + b.h - 2} r={8} />
                    <text x={b.x + b.w - 4} y={b.y + b.h + 1.5} textAnchor="middle">{obs > 99 ? "99+" : obs}</text>
                  </g>
                )}
                <title>{`${n.kind} · ${authorityOf(n)}${n.assurance.enforcement ? ` · ${n.assurance.enforcement}` : ""} · ${n.assurance.basis}\n${n.label}${b.vis.container ? "\n(double-click to expand)" : ""}`}</title>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function kindTag(k: string): string {
  return (
    {
      ModelCall: "LLM",
      Decision: "◇",
      Guard: "⛨",
      Authorization: "⛨",
      Effect: "⚡",
      ToolRequest: "⇢",
      HumanApproval: "👤",
      MemoryRead: "⟲",
      MemoryWrite: "✎",
      Termination: "■",
      Unknown: "?",
      ExternalEvent: "⇥",
      Agent: "AGENT",
      Loop: "↻",
      Tool: "TOOL",
      ToolSet: "TOOLS",
      Procedure: "ƒ",
      State: "DB",
      Prompt: "¶",
      PromptRule: "¶",
    } as Record<string, string>
  )[k] ?? "";
}

function Shape({ b }: { b: Box }) {
  const { x, y, w, h } = b;
  const k = b.vis.node.kind;
  if (k === "Decision") {
    const c = 10;
    return <polygon className="shape" points={`${x + c},${y} ${x + w - c},${y} ${x + w},${y + h / 2} ${x + w - c},${y + h} ${x + c},${y + h} ${x},${y + h / 2}`} />;
  }
  if (k === "Guard" || k === "Authorization") {
    const c = 7;
    return <polygon className="shape" points={`${x + c},${y} ${x + w - c},${y} ${x + w},${y + c} ${x + w},${y + h - c} ${x + w - c},${y + h} ${x + c},${y + h} ${x},${y + h - c} ${x},${y + c}`} />;
  }
  if (k === "ToolRequest") {
    const c = 9;
    return <polygon className="shape" points={`${x + c},${y} ${x + w},${y} ${x + w - c},${y + h} ${x},${y + h}`} />;
  }
  if (k === "Junction") return <rect className="shape" x={x} y={y} width={w} height={h} rx={h / 2} />;
  if (k === "State" || k === "MemoryRead" || k === "MemoryWrite")
    return (
      <g>
        <rect className="shape" x={x} y={y} width={w} height={h} rx={k === "State" ? 4 : 12} />
        {k === "State" && <path className="shape-line" d={`M${x},${y + 6} Q${x + w / 2},${y + 13} ${x + w},${y + 6}`} />}
      </g>
    );
  if (k === "Termination") return <g><rect className="shape" x={x} y={y} width={w} height={h} rx={4} /><rect className="shape-line" x={x + 3} y={y + 3} width={w - 6} height={h - 6} rx={3} fill="none" /></g>;
  if (k === "ExternalEvent") return <polygon className="shape" points={`${x},${y} ${x + w - 10},${y} ${x + w},${y + h / 2} ${x + w - 10},${y + h} ${x},${y + h}`} />;
  if (k === "Prompt" || k === "PromptRule") return <polygon className="shape" points={`${x},${y} ${x + w - 10},${y} ${x + w},${y + 10} ${x + w},${y + h} ${x},${y + h}`} />;
  return <rect className="shape" x={x} y={y} width={w} height={h} rx={k === "ModelCall" ? h / 2 : 6} />;
}
