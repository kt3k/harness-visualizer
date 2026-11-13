import { useEffect, useMemo, useRef, useState } from "react";
import type { Bundle } from "./data";
import { kindTag } from "./Graph";

export function Search({ b, onPick }: { b: Bundle; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target as HTMLElement)?.closest("input,textarea,select")) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return b.ir.nodes
      .filter((n) => n.kind !== "Harness" && (n.label.toLowerCase().includes(s) || n.id.toLowerCase().includes(s) || n.kind.toLowerCase() === s))
      .slice(0, 25);
  }, [q, b]);
  const pick = (id: string) => {
    onPick(id);
    setOpen(false);
    setQ("");
  };
  return (
    <div className="search">
      <input
        ref={input}
        value={q}
        placeholder="Search nodes ( / )"
        aria-label="Search nodes"
        role="combobox"
        aria-expanded={open && results.length > 0}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setI(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setI((x) => Math.min(results.length - 1, x + 1));
          else if (e.key === "ArrowUp") setI((x) => Math.max(0, x - 1));
          else if (e.key === "Enter" && results[i]) pick(results[i].id);
          else if (e.key === "Escape") setOpen(false);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && results.length > 0 && (
        <ul className="search-results" role="listbox">
          {results.map((n, k) => (
            <li key={n.id} role="option" aria-selected={k === i} className={k === i ? "active" : ""} onMouseDown={() => pick(n.id)}>
              <span className="ktag">{kindTag(n.kind)}</span> {n.label} <span className="muted">{n.kind}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
