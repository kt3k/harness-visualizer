// Dev helper: node scripts/screenshot.mjs "#/h/coding-agent/decisions" out.png  (needs a running preview server)
// usage: node scripts/shot.mjs <hash> <out.png> [w] [h]
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const [hash, out, w = "1500", h = "950"] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));
p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await p.goto(`http://localhost:4173/${hash}`);
await p.waitForTimeout(2500);
await p.screenshot({ path: out });
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no errors");
await b.close();
