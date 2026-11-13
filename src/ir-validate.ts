/** Runtime validation of IR documents against schema/harness-ir.schema.json plus referential checks. */
import Ajv2020 from "ajv/dist/2020.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessIR } from "./core/ir";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, "..", "schema", "harness-ir.schema.json"), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvCtor: any = (Ajv2020 as any).default ?? Ajv2020;
const ajv = new AjvCtor({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

export function validateIR(ir: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!validate(ir)) for (const e of (validate.errors ?? []) as { instancePath: string; message?: string }[]) errors.push(`${e.instancePath} ${e.message}`);
  const doc = ir as HarnessIR;
  if (Array.isArray(doc?.nodes) && Array.isArray(doc?.edges)) {
    const ids = new Set<string>();
    for (const n of doc.nodes) {
      if (ids.has(n.id)) errors.push(`duplicate node id ${n.id}`);
      ids.add(n.id);
    }
    for (const n of doc.nodes) if (n.parent && !ids.has(n.parent)) errors.push(`node ${n.id}: parent ${n.parent} missing`);
    for (const e of doc.edges) {
      if (!ids.has(e.from)) errors.push(`edge ${e.id}: from ${e.from} missing`);
      if (!ids.has(e.to)) errors.push(`edge ${e.id}: to ${e.to} missing`);
    }
    // containment must be acyclic
    const parent = new Map(doc.nodes.map((n) => [n.id, n.parent]));
    for (const n of doc.nodes) {
      const seen = new Set<string>();
      let p = n.parent;
      while (p) {
        if (seen.has(p)) {
          errors.push(`containment cycle at ${n.id}`);
          break;
        }
        seen.add(p);
        p = parent.get(p);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
