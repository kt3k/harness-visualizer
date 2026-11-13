import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { analyzeHarness } from "../src/analyzer/analyze";
import { validateIR } from "../src/ir-validate";
import { find, hasEdge, ir, node } from "./helpers";

const HARNESSES = fs.readdirSync("fixtures/harnesses").filter((d) => fs.existsSync(`fixtures/harnesses/${d}/harness.json`));

describe("all fixtures", () => {
  it.each(HARNESSES)("%s produces schema-valid IR with full source links", (h) => {
    const i = ir(h);
    const v = validateIR(i);
    expect(v.errors).toEqual([]);
    expect(i.coverage.sourceLinkCoverage.nodesWithSource).toBe(i.coverage.sourceLinkCoverage.nodes);
    expect(i.coverage.unlinkedNodes).toEqual([]);
    for (const n of i.nodes) expect(n.evidence.length, n.id).toBeGreaterThan(0);
  });

  it("is deterministic for unchanged inputs", () => {
    const a = JSON.stringify(analyzeHarness("fixtures/harnesses/coding-agent"));
    const b = JSON.stringify(analyzeHarness("fixtures/harnesses/coding-agent"));
    expect(a).toBe(b);
  });
});

describe("simple tool loop", () => {
  const i = ir("simple-tool-loop");
  it("separates model-decided branches from code budget", () => {
    expect(node(i, "decision:src/agent.ts#runWeatherAgent/0").authority).toBe("model");
    expect(node(i, "loop:src/agent.ts#runWeatherAgent/0").attrs.constants).toEqual({ MAX_TURNS: 6 });
    expect(node(i, "termination:src/agent.ts#runWeatherAgent/1").label).toMatch(/turn budget/);
  });
  it("dispatch is model-selected and the network effect is gated by the input guard", () => {
    const tr = node(i, "toolrequest:src/tools.ts#runTool/0");
    expect(tr.authority).toBe("model");
    expect(hasEdge(i, "dispatches", tr.id, "tool:src/tools.ts#WEATHER_TOOLS.get_weather")).toBe(true);
    const fetch = node(i, "effect:src/tools.ts#runTool/0");
    expect(fetch.attrs.category).toBe("network");
    expect(fetch.attrs.target).toBe("api.weather.example");
    expect(fetch.attrs.gatedBy).toContain("guard:src/tools.ts#runTool/0");
  });
  it("prompt rules are advisory and, here, not enforced by code", () => {
    for (const r of find(i, (n) => n.kind === "PromptRule")) {
      expect(r.assurance.enforcement).toBe("advisory");
      expect(r.attrs.status).toBe("prompt-only");
    }
  });
});

describe("coding agent (nested, subagent, approval, memory)", () => {
  const i = ir("coding-agent");
  it("attributes model calls to wrapper call sites and keeps the wrapper's retry loop", () => {
    const mcs = find(i, (n) => n.kind === "ModelCall").map((n) => n.id);
    expect(mcs).toEqual(["modelcall:src/agent.ts#runCodingAgent/0", "modelcall:src/context.ts#compactHistory/0", "modelcall:src/tools/review.ts#runReviewer/0"]);
    expect(node(i, "loop:src/model.ts#callModel/0").attrs.loopType).toBe("retry");
  });
  it("finds the reviewer subagent", () => {
    expect(node(i, "agent:src/tools/review.ts#runReviewer").attrs.role).toBe("subagent");
  });
  it("rm is gated by the workspace assertion and the deny check; approval is only conditional", () => {
    const rm = node(i, "effect:src/tools/fs.ts#deleteFileTool/0");
    expect(rm.attrs.irreversible).toBe(true);
    expect(rm.attrs.gatedBy).toEqual(expect.arrayContaining(["guard:src/tools/fs.ts#assertInsideWorkspace/0", "authorization:src/agent.ts#runCodingAgent/0"]));
    expect(rm.attrs.gatedBy).not.toContain("authorization:src/agent.ts#runCodingAgent/1");
  });
  it("memory file enters the main model call but not the reviewer's", () => {
    expect(hasEdge(i, "context", "memoryread:src/memory.ts#loadMemory/0", "modelcall:src/agent.ts#runCodingAgent/0")).toBe(true);
    expect(hasEdge(i, "context", "memoryread:src/memory.ts#loadMemory/0", "modelcall:src/tools/review.ts#runReviewer/0")).toBe(false);
    const conv = node(i, "modelcall:src/agent.ts#runCodingAgent/0").attrs.context as { kind: string; transforms: string[] }[];
    expect(conv.find((c) => c.kind === "conversation")!.transforms.join(" ")).toMatch(/compactHistory/);
  });
  it("classifies prompt rules against code guards", () => {
    const st = (prefix: string) => find(i, (n) => n.kind === "PromptRule" && String(n.attrs.text).startsWith(prefix))[0].attrs.status;
    expect(st("Never delete files outside")).toBe("possibly-enforced");
    expect(st("Do not read secrets")).toBe("prompt-only");
    expect(st("Never run `git push --force`")).not.toBe("possibly-enforced");
  });
  it("marks the dynamically loaded plugin as unknown", () => {
    const u = find(i, (n) => n.kind === "Unknown");
    expect(u).toHaveLength(2);
    expect(u.every((n) => n.assurance.basis === "unknown" && n.uncertainties.length > 0)).toBe(true);
    expect(i.coverage.unresolved.some((x) => /dynamic import/.test(x.reason))).toBe(true);
  });
  it("human approval answer drives an enforced gate with human authority", () => {
    const g = node(i, "authorization:src/agent.ts#runCodingAgent/1");
    expect(g.authority).toBe("human");
    expect(g.assurance.enforcement).toBe("enforced");
  });
});

describe("support router (structured output, async approval, mismatch)", () => {
  const i = ir("support-refund-agent");
  it("router branch is model-selected via forced tool", () => {
    expect(node(i, "decision:src/router.ts#handleCustomerMessage/0").authority).toBe("model");
    expect(node(i, "tool:src/router.ts#ROUTE_TOOL").attrs.structuredOutput).toBe(true);
  });
  it("flags the refund threshold mismatch between prompt and code", () => {
    const r = find(i, (n) => n.kind === "PromptRule" && String(n.attrs.text).includes("$100"))[0];
    expect(r.attrs.status).toBe("possible-mismatch");
    expect((r.attrs.mismatches as string[])[0]).toMatch(/50000/);
    expect(r.evidence.some((e) => e.basis === "inferred")).toBe(true);
  });
  it("e-mail is an ungated irreversible effect; refund is gated by the code threshold", () => {
    expect(node(i, "effect:src/refund-agent.ts#runRefundAgent/1").attrs.ungatedRoute).toBe(true);
    expect(node(i, "effect:src/refund-agent.ts#runRefundAgent/0").attrs.gatedBy).toContain("decision:src/refund-agent.ts#runRefundAgent/2");
  });
  it("links the async approval to the webhook only as an inferred causal hypothesis", () => {
    const e = i.edges.find((x) => x.kind === "causal-hypothesis")!;
    expect(e.to).toBe("event:src/approvals.ts#onApprovalDecision");
    expect(e.evidence.every((x) => x.basis === "inferred")).toBe(true);
    expect(node(i, "authorization:src/approvals.ts#onApprovalDecision/0").authority).toBe("external");
  });
});

describe("research orchestrator (parallel, recursion, cancellation, budget)", () => {
  const i = ir("research-orchestrator");
  it("fan-out is parallel and the researcher is recursive with a depth guard", () => {
    expect(i.edges.some((e) => e.kind === "invokes" && e.to === "agent:src/researcher.ts#runResearcher" && e.attrs.mode === "parallel")).toBe(true);
    expect(node(i, "agent:src/researcher.ts#runResearcher").attrs.recursive).toBe(true);
    expect(node(i, "guard:src/researcher.ts#runResearcher/1").attrs.purpose).toBe("budget");
  });
  it("cancellation and the token budget gate network effects", () => {
    expect(node(i, "guard:src/researcher.ts#runResearcher/0").attrs.purpose).toBe("cancellation");
    const fetch = node(i, "effect:src/researcher.ts#runResearcher/1");
    expect(fetch.attrs.gatedBy).toEqual(expect.arrayContaining(["guard:src/budget.ts#TokenBudget.consume/0", "authorization:src/researcher.ts#runResearcher/0"]));
    expect(fetch.attrs.target).toBe("model-supplied URL");
  });
});

describe("adversarial fixtures", () => {
  it("zoo: aliases, unresolved dispatch, eval, unknown packages, redaction", () => {
    const i = ir("zoo", "fixtures/adversarial");
    expect(validateIR(i).errors).toEqual([]);
    expect(find(i, (n) => n.kind === "ModelCall")).toHaveLength(2); // through alias, and through a class property
    const unknownReasons = find(i, (n) => n.kind === "Unknown").map((n) => String(n.attrs.reason));
    expect(unknownReasons.some((r) => /cannot be resolved/.test(r))).toBe(true);
    expect(unknownReasons.some((r) => /eval/.test(r))).toBe(true);
    expect(unknownReasons.some((r) => /left-pad-ai/.test(r))).toBe(true);
    const rm = find(i, (n) => n.kind === "Effect" && n.attrs.category === "fs.delete")[0];
    expect(rm.attrs.ungatedRoute).toBe(true);
    const json = JSON.stringify(i);
    expect(json).not.toContain("ops@example.com");
    expect(json).not.toContain("zz-fixture-not-a-real-secret");
  });
  it("empty: valid IR with an explicit coverage gap", () => {
    const i = ir("empty", "fixtures/adversarial");
    expect(validateIR(i).errors).toEqual([]);
    expect(i.coverage.gaps.some((g) => /No model invocation/.test(g))).toBe(true);
  });
  it("broken: syntax errors do not crash the analyzer", () => {
    const i = ir("broken", "fixtures/adversarial");
    expect(validateIR(i).errors).toEqual([]);
    expect(find(i, (n) => n.kind === "ModelCall")).toHaveLength(1);
  });
});
