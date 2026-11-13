import * as fs from "node:fs";
import * as path from "node:path";
import { analyzeHarness } from "../src/analyzer/analyze";
import type { HarnessIR, IRNode } from "../src/core/ir";
import { parseTrace, type Trace } from "../src/core/trace";

const cache = new Map<string, HarnessIR>();
export function ir(name: string, dir = "fixtures/harnesses"): HarnessIR {
  const key = `${dir}/${name}`;
  if (!cache.has(key)) cache.set(key, analyzeHarness(key));
  return cache.get(key)!;
}
export function node(i: HarnessIR, id: string): IRNode {
  const n = i.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`node ${id} not found`);
  return n;
}
export function find(i: HarnessIR, pred: (n: IRNode) => boolean): IRNode[] {
  return i.nodes.filter(pred);
}
export function traces(name: string): Trace[] {
  const dir = path.join("fixtures/harnesses", name, "traces");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => parseTrace(fs.readFileSync(path.join(dir, f), "utf8"), f.replace(/\.jsonl$/, "")));
}
export function hasEdge(i: HarnessIR, kind: string, from: string, to: string): boolean {
  return i.edges.some((e) => e.kind === kind && e.from === from && e.to === to);
}
