/**
 * Evaluation on the hand-labelled synthetic fixtures. Writes
 * docs/evaluation-results.json and prints a Markdown table.
 * Metrics are computed, not estimated; see docs/evaluation.md for limits.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { analyzeHarness } from "../src/analyzer/analyze";
import type { HarnessIR, IRNode } from "../src/core/ir";
import { parseTrace } from "../src/core/trace";
import { reconcile } from "../src/core/reconcile";

const ROOT = "fixtures/harnesses";
const KIND_MAP: Record<string, (n: IRNode) => boolean> = {
  model_call: (n) => n.kind === "ModelCall",
  effect: (n) => n.kind === "Effect",
  state_access: (n) => (n.kind === "MemoryRead" || n.kind === "MemoryWrite") && /^state:(file|db):/.test(String(n.attrs.store ?? "")),
  check: (n) => n.kind === "Guard" || n.kind === "Authorization",
  model_branch: (n) => (n.kind === "Decision" && n.authority === "model") || n.kind === "ToolRequest",
  human_input: (n) => n.kind === "HumanApproval",
  unknown: (n) => n.kind === "Unknown",
};
const STATUS: Record<string, string> = { "possibly-enforced": "enforced", "related-check": "partial", "prompt-only": "not-enforced", "possible-mismatch": "mismatch" };

interface Row { tp: number; fp: number; fn: number; misses: string[]; extras: string[] }
const results: Record<string, unknown> = {};
const totals: Record<string, Row> = {};
let ruleOk = 0;
let ruleTotal = 0;
const lines: string[] = ["| Harness | Kind | Precision | Recall | TP | FP | FN |", "|---|---|---|---|---|---|---|"];
for (const h of fs.readdirSync(ROOT).sort()) {
  const exp = path.join(ROOT, h, "expected.json");
  if (!fs.existsSync(exp)) continue;
  const labels = JSON.parse(fs.readFileSync(exp, "utf8"));
  const t0 = performance.now();
  const ir: HarnessIR = analyzeHarness(path.join(ROOT, h));
  const ms = performance.now() - t0;
  const per: Record<string, Row> = {};
  for (const [kind, pred] of Object.entries(KIND_MAP)) {
    const got = ir.nodes.filter(pred).map((n) => ({ id: n.id, file: n.sourceRefs[0]?.file, line: n.sourceRefs[0]?.startLine }));
    const want = labels.items.filter((i: { kind: string }) => i.kind === kind);
    if (!want.length && !got.length) continue;
    const used = new Set<string>();
    let tp = 0;
    const misses: string[] = [];
    for (const w of want) {
      const m = got.find((g) => !used.has(g.id) && g.file === w.file && Math.abs((g.line ?? 0) - w.line) <= 1);
      if (m) {
        used.add(m.id);
        tp++;
      } else misses.push(`${w.file}:${w.line}`);
    }
    const extras = got.filter((g) => !used.has(g.id)).map((g) => `${g.file}:${g.line} (${g.id})`);
    per[kind] = { tp, fp: extras.length, fn: misses.length, misses, extras };
    const t = (totals[kind] ??= { tp: 0, fp: 0, fn: 0, misses: [], extras: [] });
    t.tp += tp;
    t.fp += extras.length;
    t.fn += misses.length;
    lines.push(`| ${h} | ${kind} | ${fmt(tp, tp + extras.length)} | ${fmt(tp, tp + misses.length)} | ${tp} | ${extras.length} | ${misses.length} |`);
  }
  const rules = ir.nodes.filter((n) => n.kind === "PromptRule");
  const ruleResults = labels.rules.map((r: { startsWith: string; truth: string }) => {
    const n = rules.find((x) => String(x.attrs.text).startsWith(r.startsWith));
    const got = n ? STATUS[String(n.attrs.status)] : "not-extracted";
    ruleTotal++;
    if (got === r.truth) ruleOk++;
    return { rule: r.startsWith, truth: r.truth, analyzer: got, ok: got === r.truth };
  });
  const traces = fs.existsSync(path.join(ROOT, h, "traces"))
    ? fs.readdirSync(path.join(ROOT, h, "traces")).filter((f) => f.endsWith(".jsonl")).map((f) => parseTrace(fs.readFileSync(path.join(ROOT, h, "traces", f), "utf8"), f))
    : [];
  const rec = reconcile(ir, traces);
  const c = ir.coverage;
  results[h] = {
    extraction: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, { precision: ratio(v.tp, v.tp + v.fp), recall: ratio(v.tp, v.tp + v.fn), tp: v.tp, fp: v.fp, fn: v.fn, misses: v.misses, extras: v.extras }])),
    promptRules: ruleResults,
    sourceLinkCoverage: { nodes: ratio(c.sourceLinkCoverage.nodesWithSource, c.sourceLinkCoverage.nodes), edgesWithEvidence: ratio(c.sourceLinkCoverage.edgesWithEvidenceRef, c.sourceLinkCoverage.edges) },
    traceMapping: { mapped: rec.mappingCoverage.mapped, total: rec.mappingCoverage.total, ratio: ratio(rec.mappingCoverage.mapped, rec.mappingCoverage.total) },
    unresolved: c.unresolved.length,
    unknownNodes: ir.nodes.filter((n) => n.kind === "Unknown").length,
    inferredNodes: ir.nodes.filter((n) => n.assurance.basis === "inferred").length,
    nodesWithInferredClaims: ir.nodes.filter((n) => n.evidence.some((e) => e.basis === "inferred")).length,
    nodes: ir.nodes.length,
    edges: ir.edges.length,
    analysisMs: Math.round(ms),
  };
}
const overall = {
  extraction: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, { precision: ratio(v.tp, v.tp + v.fp), recall: ratio(v.tp, v.tp + v.fn), tp: v.tp, fp: v.fp, fn: v.fn }])),
  promptRuleClassificationAccuracy: { correct: ruleOk, total: ruleTotal, ratio: ratio(ruleOk, ruleTotal) },
  note: "Synthetic fixtures labelled by the fixture author. Small sample; not evidence of performance on real harnesses.",
};
fs.writeFileSync("docs/evaluation-results.json", JSON.stringify({ generatedBy: "scripts/evaluate.ts", overall, harnesses: results }, null, 2) + "\n");
console.log(lines.join("\n"));
console.log(`\nprompt rule classification: ${ruleOk}/${ruleTotal}`);
for (const [k, v] of Object.entries(overall.extraction)) console.log(`${k}: precision ${v.precision} recall ${v.recall}`);

function ratio(a: number, b: number) {
  return b ? Math.round((1000 * a) / b) / 1000 : null;
}
function fmt(a: number, b: number) {
  return b ? (a / b).toFixed(2) : "n/a";
}
