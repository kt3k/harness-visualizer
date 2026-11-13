/** Human-readable Markdown summary of a Harness IR. Respects redaction level. */
import { IRIndex } from "./graph";
import type { ContextLayer, HarnessIR, IRNode, RedactionLevel } from "./ir";
import { redact, redactPromptBody } from "./redact";

const ref = (n: IRNode) => (n.sourceRefs[0] ? `\`${n.sourceRefs[0].file}:${n.sourceRefs[0].startLine}\`` : "(no source)");

export function markdownSummary(ir: HarnessIR, opts: { redaction?: RedactionLevel } = {}): string {
  const level = opts.redaction ?? "standard";
  const idx = new IRIndex(ir);
  const by = (k: string) => ir.nodes.filter((n) => n.kind === k);
  const L: string[] = [];
  L.push(`# ${ir.harness.name}`, "");
  if (ir.harness.synthetic) L.push("> **Synthetic fixture** — not a production harness.", "");
  if (ir.harness.description) L.push(redact(ir.harness.description), "");
  L.push(`IR ${ir.irVersion} · analyzer ${ir.analysis.analyzerVersion} · inputs ${ir.analysis.inputsHash.slice(0, 12)} · redaction: ${level}`, "");
  L.push("Evidence labels: **static** = derived from code structure; **inferred** = heuristic, verify; **unknown** = not determinable statically.", "");

  L.push("## Agents and loops", "");
  for (const a of by("Agent")) {
    L.push(`- **${a.label}** (${a.attrs.role}${a.attrs.recursive ? ", recursive" : ""}) ${ref(a)}`);
    for (const l of idx.descendants(a.id).filter((n) => n.kind === "Loop")) L.push(`  - ${l.label} — ${l.attrs.loopType}${l.uncertainties.length ? ` ⚠ ${l.uncertainties.join("; ")}` : ""}`);
    for (const t of idx.descendants(a.id).filter((n) => n.kind === "Termination")) L.push(`  - terminates: ${t.label} ${ref(t)}`);
  }
  L.push("");

  L.push("## Model decisions", "");
  for (const m of by("ModelCall")) {
    L.push(`### ${m.label} ${ref(m)}`);
    const ctx = (m.attrs.context as ContextLayer[]) ?? [];
    L.push("Context supplied:");
    for (const c of ctx) L.push(`- [${c.slot}] ${c.kind}: ${c.expr}${c.transforms.length ? ` (${c.transforms.join(", ")})` : ""}${c.certainty !== "resolved" ? ` — **${c.certainty}**` : ""}`);
    const tools = (m.attrs.toolsOffered as string[]) ?? [];
    if (tools.length) L.push(`- tools offered: ${tools.join(", ")}`);
    const handling = (m.attrs.outputHandling as { nodeId: string; condition: string }[]) ?? [];
    if (handling.length) {
      L.push("Output interpreted by:");
      for (const h of handling) {
        const d = idx.node(h.nodeId);
        L.push(`- ${d?.kind} \`${h.condition}\` [authority: ${d?.authority}]`);
      }
    }
    L.push("");
  }

  L.push("## Effects and enforcement", "");
  L.push("| Effect | Category | Irreversible | Code gates (static) | Ungated route |", "|---|---|---|---|---|");
  for (const e of [...by("Effect"), ...by("MemoryWrite").filter((n) => n.attrs.effectCategory)]) {
    const gates = ((e.attrs.gatedBy as string[]) ?? []).map((g) => idx.node(g)?.label ?? g);
    L.push(`| ${e.label} ${ref(e)} | ${e.attrs.category ?? e.attrs.effectCategory} | ${e.attrs.irreversible} | ${gates.join("<br>") || "—"} | ${e.attrs.ungatedRoute ? "**yes**" : "no"} |`);
  }
  L.push("");

  L.push("## Prompt rules (advisory)", "");
  for (const r of by("PromptRule")) {
    const st = String(r.attrs.status);
    L.push(`- ${st === "prompt-only" ? "⚠ **prompt-only**" : st === "possible-mismatch" ? "⚠ **possible mismatch**" : `${st} (inferred)`}: "${level === "strict" ? "«withheld»" : redact(String(r.attrs.text))}" ${ref(r)}`);
    for (const g of (r.attrs.matchedGuards as string[]) ?? []) L.push(`  - related: ${idx.node(g)?.label}`);
    for (const mm of (r.attrs.mismatches as string[]) ?? []) L.push(`  - ${mm}`);
  }
  if (level === "strict") L.push("", "_Prompt bodies withheld (strict redaction)._");
  L.push("");

  L.push("## State and memory", "");
  for (const s of by("State")) {
    const reads = idx.inEdges(s.id, ["writes"]).length;
    const ctx = idx.outEdges(s.id, ["context"]).map((e) => idx.node(e.to)?.label);
    L.push(`- **${s.label}** (${s.attrs.persistence}) — ${reads} write site(s)${ctx.length ? `; enters: ${ctx.join(", ")}` : ""}`);
  }
  L.push("");
  const prompts = by("Prompt");
  if (prompts.length) {
    L.push("## Prompts", "");
    for (const p of prompts) L.push(`- ${p.label} ${ref(p)} (${p.attrs.chars} chars)${level === "strict" ? "" : `: ${redactPromptBody(String(p.attrs.text ?? ""), level).slice(0, 160).replace(/\n/g, " ")}…`}`);
    L.push("");
  }

  L.push("## Unknowns and coverage", "");
  const c = ir.coverage;
  L.push(`- files analysed: ${c.filesAnalyzed.length}; call sites: ${c.callSites.total}`);
  L.push(`- nodes with source link: ${c.sourceLinkCoverage.nodesWithSource}/${c.sourceLinkCoverage.nodes}; edges with evidence: ${c.sourceLinkCoverage.edgesWithEvidenceRef}/${c.sourceLinkCoverage.edges}`);
  for (const u of c.unresolved) L.push(`- unresolved: \`${u.file}:${u.line}\` ${u.expr} — ${u.reason}`);
  for (const g of c.gaps) L.push(`- gap: ${g}`);
  return L.join("\n") + "\n";
}
