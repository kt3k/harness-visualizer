/**
 * Incremental re-analysis: the IR is a pure function of (analyzer version,
 * harness config, redaction level, input file contents). If the inputs hash
 * matches a cached IR, the cached result is returned unchanged.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HarnessIR } from "../core/ir";
import { ANALYZER_FINGERPRINT, ANALYZER_VERSION, analyzeHarness, discoverFiles, loadHarnessConfig, type AnalyzeOptions } from "./analyze";

export function inputsHash(dir: string, opts: AnalyzeOptions = {}): string {
  const cfg = loadHarnessConfig(dir);
  const files = discoverFiles(path.resolve(dir), cfg.include).map((f) => [f, createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex")]);
  return createHash("sha256").update(JSON.stringify({ v: ANALYZER_VERSION, fp: ANALYZER_FINGERPRINT, cfg, files, redaction: opts.redaction ?? "standard" })).digest("hex");
}

export function analyzeWithCache(dir: string, opts: AnalyzeOptions = {}, cacheDir?: string): { ir: HarnessIR; cached: boolean } {
  if (cacheDir) {
    const h = inputsHash(dir, opts);
    const p = path.join(cacheDir, `${h}.ir.json`);
    if (fs.existsSync(p)) return { ir: JSON.parse(fs.readFileSync(p, "utf8")), cached: true };
    const ir = analyzeHarness(dir, opts);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(ir));
    return { ir, cached: false };
  }
  return { ir: analyzeHarness(dir, opts), cached: false };
}
