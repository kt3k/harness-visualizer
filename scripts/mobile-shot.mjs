// Dev helper: node scripts/mobile-shot.mjs "#/h/coding-agent/story" out.png  (needs a running preview server)
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const [hash, out] = process.argv.slice(2);
const b = await chromium.launch();
const ctx = await b.newContext({ ...devices["iPhone 13"] });
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));
await p.goto(`http://localhost:4173/${hash}`);
await p.waitForTimeout(2500);
await p.screenshot({ path: out, fullPage: false });
const m = await p.evaluate(() => {
  const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
  return { vw: innerWidth, vh: innerHeight, docW: document.documentElement.scrollWidth, top: r(".top"), main: r(".main"), view: r(".view"), story: r(".story"), detail: r(".detail"), graph: r(".graph") };
});
console.log(JSON.stringify(m), errors.length ? errors : "no errors");
await b.close();
