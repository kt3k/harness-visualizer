/**
 * Builds the static data consumed by the visualizer (web/public/data):
 * analyses every harness under fixtures/harnesses, reconciles its traces,
 * writes redacted sources, summaries, diffs against baselines and metrics.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { analyzeWithCache } from "../src/analyzer/cache";
import { discoverFiles, loadHarnessConfig } from "../src/analyzer/analyze";
import type { HarnessIR } from "../src/core/ir";
import { redact } from "../src/core/redact";
import { parseTrace, type Trace } from "../src/core/trace";
import { reconcile } from "../src/core/reconcile";
import { compareBehavior, diffIR } from "../src/core/diff";
import { markdownSummary } from "../src/core/summary";
import { validateIR } from "../src/ir-validate";

const SRC = process.argv[2] ?? "fixtures/harnesses";
const OUT = process.argv[3] ?? "web/public/data";
const REPO = process.env.REPO_URL ?? "https://github.com/kt3k/harness-visualizer";
const REF = process.env.REPO_REF ?? "main";

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const index: unknown[] = [];
const irs = new Map<string, { ir: HarnessIR; traces: Trace[] }>();
const t0 = Date.now();
for (const name of fs.readdirSync(SRC).sort()) {
  const dir = path.join(SRC, name);
  if (!fs.existsSync(path.join(dir, "harness.json"))) continue;
  const cfg = loadHarnessConfig(dir);
  cfg.repository = { url: REPO, ref: REF, pathPrefix: path.posix.join(SRC.split(path.sep).join("/"), name) };
  // write repository info back into the IR (not into the source config)
  const started = Date.now();
  const { ir } = analyzeWithCache(dir, { redaction: "standard" }, ".cache/ir");
  ir.harness.repository = cfg.repository;
  const v = validateIR(ir);
  if (!v.ok) throw new Error(`${name}: invalid IR\n${v.errors.join("\n")}`);
  const ms = Date.now() - started;
  const out = path.join(OUT, cfg.id);
  fs.mkdirSync(path.join(out, "traces"), { recursive: true });
  fs.writeFileSync(path.join(out, "ir.json"), JSON.stringify(ir));
  fs.writeFileSync(path.join(out, "summary.md"), markdownSummary(ir));
  const sources: Record<string, string> = {};
  for (const f of discoverFiles(dir, cfg.include)) sources[f] = redact(fs.readFileSync(path.join(dir, f), "utf8"));
  fs.writeFileSync(path.join(out, "sources.json"), JSON.stringify(sources));
  const traces: Trace[] = [];
  const traceMeta: unknown[] = [];
  const tdir = path.join(dir, "traces");
  if (fs.existsSync(tdir)) {
    for (const f of fs.readdirSync(tdir).filter((x) => x.endsWith(".jsonl")).sort()) {
      const text = fs.readFileSync(path.join(tdir, f), "utf8");
      const metaLine = text.split("\n")[0];
      const meta = metaLine.startsWith("//") ? JSON.parse(metaLine.slice(2)) : {};
      const tr = parseTrace(text, f.replace(/\.jsonl$/, ""), meta.label);
      traces.push(tr);
      fs.writeFileSync(path.join(out, "traces", f), text);
      traceMeta.push({ file: f, id: tr.id, ...meta, events: tr.events.length });
    }
  }
  const rec = reconcile(ir, traces);
  fs.writeFileSync(path.join(out, "reconciliation.json"), JSON.stringify(rec));
  irs.set(cfg.id, { ir, traces });
  index.push({
    id: cfg.id,
    name: cfg.name,
    description: cfg.description,
    synthetic: cfg.synthetic,
    version: cfg.version,
    baseline: cfg.baseline,
    traces: traceMeta,
    stats: {
      nodes: ir.nodes.length,
      edges: ir.edges.length,
      agents: ir.nodes.filter((n) => n.kind === "Agent").length,
      modelCalls: ir.nodes.filter((n) => n.kind === "ModelCall").length,
      effects: ir.nodes.filter((n) => n.kind === "Effect").length,
      promptOnlyRules: ir.nodes.filter((n) => n.kind === "PromptRule" && n.attrs.status === "prompt-only").length,
      unknowns: ir.nodes.filter((n) => n.kind === "Unknown").length,
      analysisMs: ms,
    },
  });
  console.log(`${cfg.id}: ${ir.nodes.length} nodes, ${traces.length} traces, mapping ${rec.mappingCoverage.mapped}/${rec.mappingCoverage.total} (${ms} ms)`);
}
// diffs against baselines
for (const [id, { ir, traces }] of irs) {
  if (!ir.harness.baseline) continue;
  const base = irs.get(ir.harness.baseline);
  if (!base) continue;
  const d = diffIR(base.ir, ir);
  const behavior = compareBehavior(base.ir, reconcile(base.ir, base.traces), ir, reconcile(ir, traces), base.traces, traces);
  fs.writeFileSync(path.join(OUT, id, "diff.json"), JSON.stringify({ baseline: ir.harness.baseline, diff: d, behavior }));
}
fs.writeFileSync(path.join(OUT, "harnesses.json"), JSON.stringify(index, null, 2));
const evalPath = "docs/evaluation-results.json";
if (fs.existsSync(evalPath)) fs.copyFileSync(evalPath, path.join(OUT, "evaluation.json"));
console.log(`site data written to ${OUT} in ${Date.now() - t0} ms`);
