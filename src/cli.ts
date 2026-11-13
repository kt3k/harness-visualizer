#!/usr/bin/env node
/**
 * harness-viz CLI
 *   analyze <harness-dir> [--out ir.json] [--redaction strict|standard] [--cache dir]
 *   reconcile <ir.json> <trace.jsonl...> [--out report.json]
 *   impact <ir.json> <node-id | file:line> [--json]
 *   diff <old-ir.json> <new-ir.json> [--json]
 *   summary <ir.json> [--redaction strict|standard]
 *   validate <ir.json>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { analyzeWithCache } from "./analyzer/cache";
import type { HarnessIR, RedactionLevel } from "./core/ir";
import { parseTrace } from "./core/trace";
import { reconcile } from "./core/reconcile";
import { impactOf, seedsFor } from "./core/impact";
import { diffIR } from "./core/diff";
import { markdownSummary } from "./core/summary";
import { validateIR } from "./ir-validate";

function arg(name: string, args: string[]): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function readIR(p: string): HarnessIR {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));
  const out = arg("--out", rest);
  const write = (s: string) => (out ? fs.writeFileSync(out, s) : process.stdout.write(s + "\n"));
  switch (cmd) {
    case "analyze": {
      const dir = positional[0];
      if (!dir) throw new Error("usage: analyze <harness-dir>");
      const redaction = (arg("--redaction", rest) ?? "standard") as RedactionLevel;
      const { ir, cached } = analyzeWithCache(dir, { redaction }, arg("--cache", rest));
      const v = validateIR(ir);
      if (!v.ok) throw new Error(`analyzer produced invalid IR:\n${v.errors.join("\n")}`);
      write(JSON.stringify(ir, null, 2));
      const c = ir.coverage;
      process.stderr.write(
        `${cached ? "[cache hit] " : ""}${ir.harness.id}: ${ir.nodes.length} nodes, ${ir.edges.length} edges, ${c.unresolved.length} unresolved, ${c.unlinkedNodes.length} unlinked\n`,
      );
      break;
    }
    case "reconcile": {
      const ir = readIR(positional[0]);
      const traces = positional.slice(1).map((p) => parseTrace(fs.readFileSync(p, "utf8"), path.basename(p)));
      write(JSON.stringify(reconcile(ir, traces), null, 2));
      break;
    }
    case "impact": {
      const ir = readIR(positional[0]);
      const seeds = seedsFor(ir, positional[1]);
      const res = impactOf(ir, seeds);
      if (rest.includes("--json")) write(JSON.stringify(res, null, 2));
      else {
        write(`Seeds: ${seeds.join(", ") || "(none matched)"}\nPOTENTIALLY affected (reachability, not guaranteed):`);
        for (const tier of ["direct", "indirect"] as const) {
          const items = res.affected.filter((a) => a.tier === tier);
          write(`${tier === "direct" ? "Direct (same iteration/call)" : "Indirect (later turns / persisted state)"}: ${items.length}`);
          for (const a of items) write(`  [${a.kind}] ${a.id}  (distance ${a.distance}, via ${a.via})`);
        }
      }
      break;
    }
    case "diff": {
      const d = diffIR(readIR(positional[0]), readIR(positional[1]));
      if (rest.includes("--json")) write(JSON.stringify(d, null, 2));
      else write(`added ${d.addedNodes.length}, removed ${d.removedNodes.length}, changed ${d.changedNodes.length} nodes; added ${d.addedEdges.length}, removed ${d.removedEdges.length} edges`);
      break;
    }
    case "summary": {
      const redaction = (arg("--redaction", rest) ?? "standard") as RedactionLevel;
      write(markdownSummary(readIR(positional[0]), { redaction }));
      break;
    }
    case "validate": {
      const v = validateIR(readIR(positional[0]));
      write(v.ok ? "valid" : v.errors.join("\n"));
      if (!v.ok) process.exitCode = 1;
      break;
    }
    default:
      process.stderr.write("commands: analyze | reconcile | impact | diff | summary | validate\n");
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`${e.stack ?? e}\n`);
  process.exitCode = 1;
});
