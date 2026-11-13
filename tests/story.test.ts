import { describe, expect, it } from "vitest";
import { buildStory, storyMarkdown } from "../src/core/story";
import { conditionPhrase, exprPhrase, limitPhrase, nodePhrase } from "../src/core/humanize";
import { ir, node } from "./helpers";

const flat = (ls: { text: string; children?: unknown[] }[]): string[] => ls.flatMap((l) => [l.text, ...flat((l.children ?? []) as { text: string }[])]);

describe("plain-language phrasing", () => {
  it("paraphrases expressions generically", () => {
    expect(exprPhrase('mode === "read-only" && MUTATING_TOOLS.has(toolName)')).toBe("mode is “read-only” and tool name is in mutating tools");
    expect(exprPhrase('typeof input.city !== "string" || input.city.length > 80')).toBe("city is not a string or city is longer than 80");
    expect(exprPhrase("!item || !event.approved")).toBe("there is no item or not approved");
    expect(exprPhrase("foo(bar) + 1")).toBeUndefined();
    expect(limitPhrase("RUN_TIMEOUT_MS", 900000)).toBe("time limit of 15 min");
    expect(limitPhrase("REFUND_AUTO_LIMIT_CENTS", 50000)).toBe("$500 (refund auto limit)");
  });
  it("uses SDK semantics, developer messages and constants", () => {
    const i = ir("coding-agent");
    expect(conditionPhrase(node(i, "decision:src/agent.ts#runCodingAgent/0")).text).toBe("the model asks to use a tool");
    expect(conditionPhrase(node(i, "guard:src/agent.ts#runCodingAgent/0")).text).toBe("more than 40 turns used");
    expect(conditionPhrase(node(i, "guard:src/tools/fs.ts#assertInsideWorkspace/0")).text).toBe("path outside workspace");
    expect(nodePhrase(node(i, "effect:src/tools/fs.ts#deleteFileTool/0"), i).text).toBe("delete files");
  });
  it("falls back to code and marks it", () => {
    const p = conditionPhrase({ ...node(ir("coding-agent"), "decision:src/context.ts#compactHistory/0"), attrs: { condition: "weird(x)[0] ^ y" } });
    expect(p.code).toBe(true);
  });
});

describe("story", () => {
  it("coding agent: trigger, loop, model choice, endings and tool table", () => {
    const s = buildStory(ir("coding-agent"));
    const main = s.flows.find((f) => f.title === "Coding agent")!;
    expect(main.triggers[0].text).toMatch(/main\(argv\)/);
    const steps = flat(main.steps).join("\n");
    expect(steps).toMatch(/Ask the model/);
    expect(steps).toMatch(/Stop if more than 40 turns used/);
    expect(steps).toMatch(/Ask a human for approval/);
    expect(main.endings.map((e) => e.text)).toEqual(expect.arrayContaining(["max turns", "timeout", "malformed output"]));
    const reviewer = s.flows.find((f) => f.title === "Reviewer")!;
    expect(reviewer.kind).toBe("subagent");
    expect(reviewer.triggers[0].text).toMatch(/delegate_review/);
    const del = s.tools.find((t) => t.name === "delete_file")!;
    expect(del.irreversible).toBe(true);
    expect(del.checks.map((c) => c.text)).toContain("refuses if path outside workspace");
    expect(del.policy[0].text).toMatch(/human's OK/);
    expect(s.warnings.some((w) => /\.env/.test(w.text))).toBe(true);
    // every line is traceable to IR nodes
    const ids = new Set(ir("coding-agent").nodes.map((n) => n.id));
    for (const f of s.flows) for (const l of [...f.steps, ...f.triggers, ...f.endings]) for (const id of l.ids) expect(ids.has(id), id).toBe(true);
  });
  it("support: model-chosen route with chains, threshold mismatch, ungated e-mail", () => {
    const s = buildStory(ir("support-refund-agent"));
    const router = s.flows.find((f) => /Customer message/.test(f.title))!;
    const sw = router.steps.find((l) => /The model chooses the intent/.test(l.text))!;
    expect(sw.children!.map((c) => c.text)).toEqual(expect.arrayContaining([expect.stringMatching(/^“order_status” → read database table orders → finish/)]));
    expect(s.warnings[0].level).toBe("danger");
    expect(s.warnings.map((w) => w.text).join("\n")).toMatch(/\$500/);
    expect(s.warnings.map((w) => w.text).join("\n")).toMatch(/send an e-mail with no code check/);
  });
  it("markdown respects strict redaction", () => {
    expect(storyMarkdown(ir("support-refund-agent"), { redaction: "strict" })).not.toMatch(/Never refund more than/);
  });
});
