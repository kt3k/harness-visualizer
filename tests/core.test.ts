import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reconcile } from "../src/core/reconcile";
import { impactOf, seedsFor } from "../src/core/impact";
import { diffIR } from "../src/core/diff";
import { redact, redactDeep } from "../src/core/redact";
import { markdownSummary } from "../src/core/summary";
import { parseTrace } from "../src/core/trace";
import { analyzeWithCache, inputsHash } from "../src/analyzer/cache";
import { createTracer, memorySink } from "../src/instrument/tracer";
import { reachableEffects } from "../src/core/reach";
import { IRIndex } from "../src/core/graph";
import { ir, node, traces } from "./helpers";

describe("reconciliation", () => {
  const i = ir("coding-agent");
  const rec = reconcile(i, traces("coding-agent"));
  it("maps events by node id, location and tool name; reports the rest", () => {
    expect(rec.mappingCoverage.total).toBeGreaterThan(100);
    expect(rec.mappingCoverage.mapped / rec.mappingCoverage.total).toBeGreaterThan(0.97);
    expect(rec.mapping.some((m) => m.via === "loc")).toBe(true);
    expect(rec.mismatches.some((m) => m.kind === "observed-tool-absent-from-static-graph" && /git_push/.test(m.detail))).toBe(true);
    expect(rec.mismatches.some((m) => /stale instrumentation/.test(m.detail))).toBe(true);
    expect(rec.mismatches.filter((m) => m.kind === "parse-error")).toHaveLength(2);
  });
  it("explains every regular succession with a static path", () => {
    expect(rec.unexplained).toEqual([]);
    expect(rec.steps.length).toBeGreaterThan(50);
  });
  it("detects injected invariant violations", () => {
    const kinds = rec.violations.map((v) => v.invariant).sort();
    expect(kinds).toEqual(["denied-request-not-executed", "loop-bound"]);
  });
  it("never calls unobserved branches unreachable", () => {
    expect(rec.unobservedBranches.length).toBeGreaterThan(0);
    for (const u of rec.unobservedBranches) expect(u.note).toMatch(/does NOT mean unreachable/);
  });
  it("reports observed successions that have no static path", () => {
    const t = parseTrace(
      [
        { v: 1, traceId: "x", spanId: "s1", seq: 1, ts: "2026-01-01T00:00:00Z", type: "tool.execute", nodeId: "effect:src/tools/fs.ts#deleteFileTool/0" },
        { v: 1, traceId: "x", spanId: "s1", seq: 2, ts: "2026-01-01T00:00:01Z", type: "model.request", nodeId: "modelcall:src/context.ts#compactHistory/0" },
        { v: 1, traceId: "x", spanId: "s1", seq: 3, ts: "2026-01-01T00:00:02Z", type: "state.read", nodeId: "memoryread:src/memory.ts#loadMemory/0" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
      "synthetic-mismatch",
    );
    const r = reconcile(i, [t]);
    expect(r.unexplained.length).toBeGreaterThan(0);
    expect(r.unexplained[0].note).toMatch(/no static control path/);
  });
  it("covers retries, cancellation, malformed outputs, denial and subagents across fixture traces", () => {
    const all = ["coding-agent", "support-refund-agent", "research-orchestrator", "simple-tool-loop"].flatMap((h) => traces(h).flatMap((t) => t.events));
    for (const ty of ["retry", "cancel", "error", "approval.response", "agent.start"]) expect(all.some((e) => e.type === ty), ty).toBe(true);
    expect(all.some((e) => e.status === "denied")).toBe(true);
    expect(all.some((e) => e.type === "decision" && e.name === "final === null")).toBe(true);
    const research = reconcile(ir("research-orchestrator"), traces("research-orchestrator"));
    expect(research.unexplained).toEqual([]);
    const support = reconcile(ir("support-refund-agent"), traces("support-refund-agent"));
    expect(support.mappingCoverage.mapped).toBe(support.mappingCoverage.total);
  });
});

describe("change impact", () => {
  const i = ir("coding-agent");
  it("a prompt change potentially affects its model call, the decisions reading its output and downstream effects", () => {
    const res = impactOf(i, ["prompt:prompts/system.md"]);
    expect(res.modelCalls.map((m) => m.id)).toContain("modelcall:src/agent.ts#runCodingAgent/0");
    // the reviewer call is reachable only through control flow (whether it runs), not through its context
    const main = res.modelCalls.find((m) => m.id === "modelcall:src/agent.ts#runCodingAgent/0")!;
    expect(main.distance).toBe(1);
    expect(main.via).toBe("context");
    const rev = res.modelCalls.find((m) => m.id === "modelcall:src/tools/review.ts#runReviewer/0");
    if (rev) expect(rev.via).not.toBe("context");
    expect(res.decisions.map((m) => m.id)).toContain("toolrequest:src/agent.ts#runCodingAgent/0");
    expect(res.effects.map((m) => m.id)).toContain("effect:src/tools/fs.ts#deleteFileTool/0");
    expect(res.note).toMatch(/Potential/);
  });
  it("resolves file:line and file seeds", () => {
    expect(seedsFor(i, "src/tools/shell.ts:14")).toEqual(["authorization:src/tools/shell.ts#runShellTool/0"]);
    expect(seedsFor(i, "prompts/reviewer.md").length).toBeGreaterThan(0);
  });
  it("diffs IR versions with stable ids", () => {
    const d = diffIR(ir("coding-agent"), ir("coding-agent-v2"));
    expect(d.removedNodes).toEqual([]);
    expect(d.addedNodes.map((n) => n.id)).toEqual(expect.arrayContaining(["authorization:src/tools/fs.ts#readFileTool/0", "decision:src/tools/shell.ts#isAllowedCommand/0"]));
    expect(d.changedNodes.find((c) => c.id === "guard:src/agent.ts#runCodingAgent/0")!.changes[0].after).toEqual({ MAX_TURNS: 25 });
  });
  it("reachable effects list the gates on the path", () => {
    const idx = new IRIndex(i);
    const r = reachableEffects(idx, "modelcall:src/agent.ts#runCodingAgent/0");
    const rm = r.find((x) => x.effect.id === "effect:src/tools/fs.ts#deleteFileTool/0")!;
    expect(rm.gatesOnPath.map((g) => g.id)).toContain("authorization:src/agent.ts#runCodingAgent/0");
  });
});

describe("redaction", () => {
  it("masks secrets, credentials and personal data", () => {
    const s = redact('const API_KEY = "abcd1234efgh5678"; mail me@example.com, token ghp_abcdefghijklmnopqrstuvwxyz0123 and sk-proj-abcdefghijklmnop1234 call +1 415-555-0100');
    expect(s).not.toMatch(/abcd1234efgh5678|me@example\.com|ghp_|sk-proj|555-0100/);
    expect(s).toContain("«redacted:");
  });
  it("strict level withholds prompt bodies", () => {
    const out = redactDeep({ text: "You are a careful agent working in a sensitive environment..." }, "strict");
    expect(out.text).toMatch(/withheld/);
  });
  it("summary respects redaction", () => {
    const md = markdownSummary(ir("support-refund-agent"), { redaction: "strict" });
    expect(md).not.toContain("Never refund more than");
    expect(md).toContain("possible mismatch");
  });
});

describe("incremental analysis cache", () => {
  it("returns the cached IR when inputs are unchanged", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hv-cache-"));
    const a = analyzeWithCache("fixtures/harnesses/simple-tool-loop", {}, dir);
    const b = analyzeWithCache("fixtures/harnesses/simple-tool-loop", {}, dir);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.ir.analysis.inputsHash).toBe(a.ir.analysis.inputsHash);
    expect(inputsHash("fixtures/harnesses/simple-tool-loop")).toBe(a.ir.analysis.inputsHash);
  });
});

describe("instrumentation", () => {
  it("records hashes and redacted summaries, never raw inputs", () => {
    const mem = memorySink();
    const t = createTracer({ sink: mem.sink, traceId: "t", now: () => "2026-01-01T00:00:00Z", captureLoc: false });
    const run = t.root("run.start");
    const s = run.child("tool.request", { name: "read_file", input: { path: "/secret", password: "hunter2hunter2" } });
    s.event("tool.result", { output: "contact admin@example.com" });
    const [, req, res] = mem.events;
    expect(req.parentSpanId).toBe(run.id);
    expect(req.inputHash).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(req)).not.toContain("hunter2");
    expect(res.outputSummary).not.toContain("admin@example.com");
    expect(mem.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
  it("captures call-site location when no node id is given", () => {
    const mem = memorySink();
    createTracer({ sink: mem.sink }).root("run.start");
    expect(mem.events[0].loc?.file).toMatch(/core\.test\.ts$/);
  });
});

describe("example IR documents", () => {
  it("checked-in examples are current", () => {
    for (const [file, h] of [["examples/ir/simple-tool-loop.ir.json", "simple-tool-loop"], ["examples/ir/coding-agent.ir.json", "coding-agent"]] as const) {
      const ex = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(ex.nodes.map((n: { id: string }) => n.id)).toEqual(ir(h).nodes.map((n) => n.id));
    }
  });
  it("node lookup helper works", () => {
    expect(node(ir("simple-tool-loop"), "harness").kind).toBe("Harness");
  });
});
