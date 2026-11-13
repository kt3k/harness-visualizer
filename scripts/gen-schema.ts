// Writes schema/harness-ir.schema.json and schema/trace-event.schema.json
import * as fs from "node:fs";
import { CONTAINER_KINDS, EDGE_SEMANTICS, IR_VERSION } from "../src/core/ir";
import { TRACE_EVENT_TYPES } from "../src/core/trace";

const NODE_KINDS = ["Harness","Agent","Loop","Junction","Procedure","ToolSet","Tool","State","Decision","ModelCall","ToolRequest","Guard","Authorization","HumanApproval","Effect","MemoryRead","MemoryWrite","Prompt","PromptRule","Termination","ExternalEvent","Unknown"];
void CONTAINER_KINDS;
const sourceRef = { type: "object", required: ["file", "startLine", "endLine"], additionalProperties: false, properties: {
  file: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, symbol: { type: "string" },
  role: { enum: ["code", "prompt", "config", "trace"] }, snippet: { type: "string" } } };
const evidence = { type: "object", required: ["basis", "method", "claim"], additionalProperties: false, properties: {
  basis: { enum: ["static", "inferred", "runtime", "unknown"] }, method: { type: "string" }, claim: { type: "string" }, ref: { $ref: "#/$defs/sourceRef" },
  confidence: { type: "number", minimum: 0, maximum: 1 } } };
const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `https://harness-visualizer.local/schema/harness-ir-${IR_VERSION}.json`,
  title: `Harness IR ${IR_VERSION}`,
  type: "object",
  required: ["irVersion", "harness", "analysis", "nodes", "edges", "coverage"],
  $defs: { sourceRef, evidence },
  properties: {
    irVersion: { const: IR_VERSION },
    harness: { type: "object", required: ["id", "name", "synthetic"], properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, synthetic: { type: "boolean" }, version: { type: "string" } } },
    analysis: { type: "object", required: ["analyzer", "analyzerVersion", "adapter", "inputsHash", "redaction"], properties: { inputsHash: { type: "string", pattern: "^[0-9a-f]{64}$" }, redaction: { enum: ["strict", "standard"] } } },
    nodes: { type: "array", items: { type: "object", required: ["id", "kind", "label", "sourceRefs", "evidence", "assurance", "uncertainties", "attrs"], additionalProperties: false, properties: {
      id: { type: "string", minLength: 1 }, kind: { enum: NODE_KINDS }, label: { type: "string" }, parent: { type: "string" }, summary: { type: "string" },
      authority: { enum: ["code", "model", "human", "external", "unknown"] },
      sourceRefs: { type: "array", items: { $ref: "#/$defs/sourceRef" } }, evidence: { type: "array", items: { $ref: "#/$defs/evidence" } },
      assurance: { type: "object", required: ["basis"], additionalProperties: false, properties: { basis: { enum: ["static", "inferred", "runtime", "unknown"] }, enforcement: { enum: ["enforced", "advisory", "none", "unknown"] } } },
      uncertainties: { type: "array", items: { type: "string" } }, attrs: { type: "object" } } } },
    edges: { type: "array", items: { type: "object", required: ["id", "kind", "from", "to", "evidence", "attrs"], additionalProperties: false, properties: {
      id: { type: "string" }, kind: { enum: Object.keys(EDGE_SEMANTICS) }, from: { type: "string" }, to: { type: "string" }, label: { type: "string" }, condition: { type: "string" },
      evidence: { type: "array", items: { $ref: "#/$defs/evidence" } }, attrs: { type: "object" } } } },
    coverage: { type: "object", required: ["filesAnalyzed", "callSites", "unresolved", "unlinkedNodes", "sourceLinkCoverage", "gaps"] },
  },
};
const trace = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Harness trace event v1 (one per JSONL line)",
  type: "object",
  required: ["v", "traceId", "spanId", "seq", "ts", "type"],
  properties: {
    v: { const: 1 }, traceId: { type: "string" }, spanId: { type: "string" }, parentSpanId: { type: "string" }, seq: { type: "integer" },
    ts: { type: "string", format: "date-time" }, type: { enum: TRACE_EVENT_TYPES }, nodeId: { type: "string" },
    loc: { type: "object", required: ["file", "line"], properties: { file: { type: "string" }, line: { type: "integer" } } },
    name: { type: "string" }, status: { enum: ["ok", "error", "denied", "approved", "rejected", "cancelled", "pending"] },
    inputHash: { type: "string" }, outputSummary: { type: "string" }, attrs: { type: "object" },
  },
};
fs.writeFileSync("schema/harness-ir.schema.json", JSON.stringify(schema, null, 2) + "\n");
fs.writeFileSync("schema/trace-event.schema.json", JSON.stringify(trace, null, 2) + "\n");
console.log("schemas written");
