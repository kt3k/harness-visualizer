import { IRIndex } from "../../src/core/graph";
import type { HarnessIR } from "../../src/core/ir";
import type { Reconciliation } from "../../src/core/reconcile";
import { parseTrace, type Trace } from "../../src/core/trace";
import type { BehaviorDiff, IRDiff } from "../../src/core/diff";

export interface HarnessEntry {
  id: string;
  name: string;
  description?: string;
  synthetic: boolean;
  version?: string;
  baseline?: string;
  traces: { file: string; id: string; label?: string; description?: string; adversarial?: boolean; events: number }[];
  stats: Record<string, number>;
}

export interface Bundle {
  entry: HarnessEntry;
  ir: HarnessIR;
  idx: IRIndex;
  rec: Reconciliation;
  traces: Trace[];
  sources: Record<string, string>;
  diff?: { baseline: string; diff: IRDiff; behavior: BehaviorDiff };
}

const base = "./data";
const cache = new Map<string, Promise<Bundle>>();

export async function loadIndex(): Promise<HarnessEntry[]> {
  const r = await fetch(`${base}/harnesses.json`);
  if (!r.ok) throw new Error(`could not load ${base}/harnesses.json (${r.status}) — run "npm run build:data"`);
  return r.json();
}

export async function loadEvaluation(): Promise<unknown | undefined> {
  const r = await fetch(`${base}/evaluation.json`);
  return r.ok ? r.json() : undefined;
}

export function loadBundle(entry: HarnessEntry): Promise<Bundle> {
  if (!cache.has(entry.id)) {
    cache.set(
      entry.id,
      (async () => {
        const get = async (p: string) => {
          const r = await fetch(`${base}/${entry.id}/${p}`);
          if (!r.ok) throw new Error(`${p}: ${r.status}`);
          return r;
        };
        const [ir, rec, sources] = await Promise.all([get("ir.json").then((r) => r.json()), get("reconciliation.json").then((r) => r.json()), get("sources.json").then((r) => r.json())]);
        const traces = await Promise.all(entry.traces.map(async (t) => parseTrace(await (await get(`traces/${t.file}`)).text(), t.id, t.label)));
        let diff;
        if (entry.baseline) {
          const r = await fetch(`${base}/${entry.id}/diff.json`);
          if (r.ok) diff = await r.json();
        }
        return { entry, ir, idx: new IRIndex(ir), rec, traces, sources, diff };
      })(),
    );
  }
  return cache.get(entry.id)!;
}

export function githubUrl(ir: HarnessIR, file: string, start?: number, end?: number): string | undefined {
  const r = ir.harness.repository;
  if (!r) return undefined;
  return `${r.url}/blob/${r.ref}/${r.pathPrefix}/${file}${start ? `#L${start}${end && end !== start ? `-L${end}` : ""}` : ""}`;
}
