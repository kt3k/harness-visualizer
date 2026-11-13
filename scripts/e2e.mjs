/**
 * UI walkthrough: answers the seven operator questions in the built site and
 * counts the UI interactions needed. Also smoke-tests every view of every
 * harness for runtime errors. Requires a running preview server:
 *   npm run build && npx vite preview --port 4173 &   then   npm run e2e
 * Writes docs/evaluation-ui.json. Interaction counts are for a scripted user who
 * knows where to click; they are a lower bound, not a measured human time.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE_URL ?? "http://localhost:4173/";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

let steps = 0;
const act = async (fn) => {
  steps++;
  await fn();
  await page.waitForTimeout(700);
};
const expectText = async (locator, re) => {
  const t = await locator.innerText();
  if (!re.test(t)) throw new Error(`expected ${re} in: ${t.slice(0, 200)} … ${t.slice(-600)}`);
};
const results = [];
async function scenario(q, view, fn) {
  steps = 0;
  const t0 = Date.now();
  await page.goto(`${BASE}#/`);
  await page.waitForTimeout(800);
  await act(() => page.locator('a.card[href="#/h/coding-agent/overview"]').click());
  try {
    const answer = await fn();
    results.push({ question: q, view, interactions: steps, ms: Date.now() - t0, answer, ok: true });
  } catch (e) {
    results.push({ question: q, view, interactions: steps, ms: Date.now() - t0, ok: false, error: String(e.message ?? e) });
  }
}
const tab = (name) => act(() => page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: new RegExp(name) }).click());
const panel = () => page.locator(".split-panel");
const detail = () => page.locator("aside.detail");

await scenario("1. Where does the LLM choose the next action?", "B", async () => {
  await tab("Decision boundary");
  await expectText(panel(), /Where the model chooses the next action[\s\S]*dispatch block\.name/);
  return "Decision boundary table: main model call → stop_reason branch, block.type filter, handler-map dispatch (model-selected)";
});
await scenario("2. Which rules are enforced by code, which only in the prompt?", "C", async () => {
  await tab("Effects");
  await expectText(panel(), /Do not read secrets[\s\S]*prompt-only/);
  await expectText(panel(), /Never delete files outside[\s\S]*possibly-enforced/);
  return ".env rule is prompt-only; workspace rule possibly enforced by assertInsideWorkspace (inferred)";
});
await scenario("3. Can this model decision lead to a destructive effect, and through which guards?", "C", async () => {
  await tab("Effects");
  await act(() => page.getByLabel("Search nodes").fill("model call"));
  await act(() => page.getByLabel("Search nodes").press("Enter"));
  await expectText(detail(), /Potentially reachable effects[\s\S]*fs\.promises\.rm/i);
  await expectText(detail(), /assertInsideWorkspace|resolved\.startsWith/);
  return "rm reachable via delete_file dispatch; gates: deny check, unknown-tool check, workspace assertion (+ conditional approval)";
});
await scenario("4. Which memory is visible to a particular model call?", "D", async () => {
  await tab("State & memory");
  await expectText(panel(), /What enters each model call[\s\S]*read MEMORY_FILE/);
  return "main call: system.md + memory file + compacted conversation; reviewer: reviewer.md + its own conversation only";
});
await scenario("5. Why did this observed run terminate or retry?", "E", async () => {
  await tab("Execution trace");
  await act(() => page.locator(".trace-side select").selectOption({ value: "02-delete-denied-then-malformed" }));
  await act(() => page.locator(".timeline li.ev-retry").first().click());
  await expectText(page.locator(".evdetail"), /retry[\s\S]*(callModel|model\.ts)/);
  await act(() => page.locator(".timeline li.ev-termination").first().click());
  await expectText(page.locator(".evdetail"), /termination[\s\S]*blocked/);
  return "retry = transport retry loop in callModel (529 overloaded); termination = final.status 'blocked' after a malformed-output retry";
});
await scenario("6. If a prompt changes, which decisions and downstream effects may be affected?", "F", async () => {
  await tab("Change impact");
  await act(() => page.locator(".impact-controls select").selectOption({ value: "prompt:prompts/system.md" }));
  await expectText(panel(), /Potentially affected decisions[\s\S]*Potentially affected effects[\s\S]*fs\.promises\.rm/);
  return "potential: main model call → its output branches/dispatch → all tool effects (labelled potential)";
});
await scenario("7. Which parts of the harness remain unknown or insufficiently analyzed?", "G", async () => {
  await tab("Unknowns");
  await expectText(page.locator(".coverage"), /dynamic import/);
  return "plugin tool (dynamic import + plugin.run), plus listed analysis gaps";
});

// smoke test: every view of every harness
const index = await (await fetch(`${BASE}data/harnesses.json`)).json();
const smoke = [];
for (const h of index) {
  for (const v of ["overview", "decisions", "effects", "memory", "trace", "impact", "coverage"]) {
    await page.goto(`${BASE}#/h/${h.id}/${v}`);
    await page.waitForTimeout(900);
    const failed = await page.locator(".graph-msg.error, .fatal").count();
    smoke.push({ harness: h.id, view: v, ok: failed === 0 });
  }
}
await browser.close();
const out = { generatedBy: "scripts/e2e.mjs", note: "Interactions counted for a scripted user; includes opening the harness from the home page. Not a human timing study.", scenarios: results, smoke: { views: smoke.length, failed: smoke.filter((s) => !s.ok) }, runtimeErrors: errors };
fs.writeFileSync("docs/evaluation-ui.json", JSON.stringify(out, null, 2) + "\n");
for (const r of results) console.log(`${r.ok ? "✔" : "✘"} ${r.question} — ${r.interactions} interactions${r.ok ? "" : ` (${r.error})`}`);
console.log(`smoke: ${smoke.length - out.smoke.failed.length}/${smoke.length} views ok; runtime errors: ${errors.length}`);
if (!results.every((r) => r.ok) || out.smoke.failed.length || errors.length) process.exitCode = 1;
