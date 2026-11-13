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
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
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
  await act(() => page.locator('a.card[href="#/h/coding-agent/story"]').click());
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

const story = () => page.locator(".story");
await scenario("1. Where does the LLM choose the next action?", "S", async () => {
  await expectText(story(), /Coding agent[\s\S]*Ask the model[\s\S]*may choose a tool: read_file[\s\S]*If the model asks to use a tool/);
  return "Step-by-step outline: the model is asked once per turn, may pick one of 7 tools; its reply decides tool use vs. final answer";
});
await scenario("2. Which rules are enforced by code, which only in the prompt?", "S", async () => {
  await expectText(story(), /Watch out[\s\S]*Do not read secrets[\s\S]*no code enforces it/);
  await expectText(page.locator("table.tools"), /Never delete files outside the workspace/);
  return "Watch out lists prompt-only rules; the tool table shows prompt rules next to the code checks";
});
await scenario("3. Can this model decision lead to a destructive effect, and through which guards?", "S", async () => {
  await expectText(page.locator("table.tools tr", { hasText: "delete_file" }), /delete files[\s\S]*refuses if path outside workspace[\s\S]*human's OK/);
  await expectText(page.locator(".common-checks"), /permission policy denies it/);
  return "delete_file → delete files; stopped by the workspace check, the permission policy (human OK), and the checks before any tool runs";
});
await scenario("4. Which memory is visible to a particular model call?", "S", async () => {
  await expectText(story(), /sees: instructions: prompts\/system\.md; \.agent\/memory\.md; the conversation so far/);
  return "main call: system.md + memory file + conversation (may be summarized); reviewer: reviewer.md + its own conversation";
});
await scenario("5. Why did this observed run terminate or retry?", "E", async () => {
  await tab("Execution trace");
  await act(() => page.locator(".trace-side select").selectOption({ value: "02-delete-denied-then-malformed" }));
  await act(() => page.locator(".timeline li.ev-retry").first().click());
  await expectText(page.locator(".evdetail"), /retry[\s\S]*(callModel|model\.ts)/i);
  await act(() => page.locator(".timeline li.ev-termination").first().click());
  await expectText(page.locator(".evdetail"), /termination[\s\S]*blocked/);
  return "retry = transport retry loop in callModel (529 overloaded); termination = final status 'blocked' after a malformed-output retry";
});
await scenario("6. If a prompt changes, which decisions and downstream effects may be affected?", "F", async () => {
  await tab("Change impact");
  await act(() => page.locator(".impact-controls select").selectOption({ value: "prompt:prompts/system.md" }));
  await expectText(panel(), /Potentially affected decisions[\s\S]*Potentially affected effects[\s\S]*Delete files/);
  return "direct: main model call → its output branches/dispatch → all tool effects (labelled potential); indirect impacts listed separately";
});
await scenario("7. Which parts of the harness remain unknown or insufficiently analyzed?", "S", async () => {
  await expectText(story(), /Watch out[\s\S]*cannot be analysed/);
  return "plugin tool loads and runs code at runtime; full list in the Unknowns & coverage tab";
});

// smoke test: every view of every harness
const index = await (await fetch(`${BASE}data/harnesses.json`)).json();
const smoke = [];
for (const h of index) {
  for (const v of ["story", "overview", "decisions", "effects", "memory", "trace", "impact", "coverage"]) {
    await page.goto(`${BASE}#/h/${h.id}/${v}`);
    await page.waitForTimeout(900);
    const failed = await page.locator(".graph-msg.error, .fatal").count();
    smoke.push({ harness: h.id, view: v, ok: failed === 0 });
  }
}
// mobile: every view must give its content real screen space; tapping a story line opens the details sheet
const mctx = await browser.newContext({ ...require("playwright").devices["iPhone 13"] });
const m = await mctx.newPage();
m.on("pageerror", (e) => errors.push(`[mobile] ${e}`));
const mobile = [];
for (const v of ["story", "overview", "decisions", "effects", "memory", "trace", "impact", "coverage"]) {
  await m.goto(`${BASE}#/h/coding-agent/${v}`);
  await m.waitForTimeout(900);
  const r = await m.evaluate(() => {
    const view = document.querySelector(".view")?.getBoundingClientRect();
    const top = document.querySelector(".top")?.getBoundingClientRect();
    return { viewH: Math.round(view?.height ?? 0), headerH: Math.round(top?.height ?? 0), overflowX: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  mobile.push({ view: v, ...r, ok: r.viewH > 300 && r.headerH < 120 && !r.overflowX });
}
await m.goto(`${BASE}#/h/coding-agent/story`);
await m.waitForTimeout(900);
await m.locator(".story-line", { hasText: "Ask the model" }).first().tap();
await m.waitForTimeout(600);
const sheetOpen = await m.locator("aside.detail.has-node").isVisible();
await m.getByRole("button", { name: "Close details" }).tap();
await m.waitForTimeout(400);
const sheetClosed = !(await m.locator("aside.detail.has-node").count());
mobile.push({ view: "story: tap opens details sheet, close hides it", ok: sheetOpen && sheetClosed });
await browser.close();
const out = { generatedBy: "scripts/e2e.mjs", note: "Interactions counted for a scripted user; includes opening the harness from the home page. Not a human timing study.", scenarios: results, smoke: { views: smoke.length, failed: smoke.filter((s) => !s.ok) }, mobile, runtimeErrors: errors };
fs.writeFileSync("docs/evaluation-ui.json", JSON.stringify(out, null, 2) + "\n");
for (const r of results) console.log(`${r.ok ? "✔" : "✘"} ${r.question} — ${r.interactions} interactions${r.ok ? "" : ` (${r.error})`}`);
console.log(`smoke: ${smoke.length - out.smoke.failed.length}/${smoke.length} views ok; runtime errors: ${errors.length}`);
console.log(`mobile (iPhone 13): ${mobile.filter((x) => x.ok).length}/${mobile.length} ok`, mobile.filter((x) => !x.ok));
if (!results.every((r) => r.ok) || out.smoke.failed.length || errors.length || !mobile.every((x) => x.ok)) process.exitCode = 1;
