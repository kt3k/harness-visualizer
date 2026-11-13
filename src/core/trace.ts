/**
 * Runtime trace event schema (v1). One JSON object per line (JSONL).
 * See docs/ir-spec.md §Trace events and schema/trace-event.schema.json.
 */
import { redactDeep } from "./redact";

export const TRACE_VERSION = 1;

export type TraceEventType =
  | "run.start"
  | "run.end"
  | "agent.start"
  | "agent.end"
  | "loop.iteration"
  | "model.request"
  | "model.response"
  | "decision"
  | "tool.request"
  | "authz.decision"
  | "approval.request"
  | "approval.response"
  | "tool.execute"
  | "tool.result"
  | "state.read"
  | "state.write"
  | "error"
  | "retry"
  | "cancel"
  | "termination"
  | "external.event";

export const TRACE_EVENT_TYPES: TraceEventType[] = [
  "run.start", "run.end", "agent.start", "agent.end", "loop.iteration", "model.request", "model.response", "decision", "tool.request",
  "authz.decision", "approval.request", "approval.response", "tool.execute", "tool.result", "state.read", "state.write", "error", "retry",
  "cancel", "termination", "external.event",
];

export interface TraceEvent {
  v: 1;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  seq: number;
  ts: string;
  type: TraceEventType;
  /** IR node id, when the instrumentation knows it */
  nodeId?: string;
  /** source location captured at the instrumentation point */
  loc?: { file: string; line: number };
  /** e.g. tool name, termination reason */
  name?: string;
  status?: "ok" | "error" | "denied" | "approved" | "rejected" | "cancelled" | "pending";
  inputHash?: string;
  outputSummary?: string;
  attrs?: Record<string, unknown>;
}

export interface Trace {
  id: string;
  label?: string;
  events: TraceEvent[];
  parseErrors: { line: number; error: string }[];
}

export function parseTrace(text: string, id: string, label?: string): Trace {
  const events: TraceEvent[] = [];
  const parseErrors: Trace["parseErrors"] = [];
  text.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("//")) return;
    try {
      const e = JSON.parse(t);
      const problem = checkEvent(e);
      if (problem) parseErrors.push({ line: i + 1, error: problem });
      else events.push(redactDeep(e as TraceEvent));
    } catch (err) {
      parseErrors.push({ line: i + 1, error: `invalid JSON: ${(err as Error).message}` });
    }
  });
  events.sort((a, b) => a.seq - b.seq);
  return { id, label, events, parseErrors };
}

function checkEvent(e: unknown): string | undefined {
  if (!e || typeof e !== "object") return "event is not an object";
  const o = e as Record<string, unknown>;
  for (const k of ["traceId", "spanId", "ts", "type"]) if (typeof o[k] !== "string") return `missing string field '${k}'`;
  if (typeof o.seq !== "number") return "missing numeric field 'seq'";
  if (!TRACE_EVENT_TYPES.includes(o.type as TraceEventType)) return `unknown event type '${String(o.type)}'`;
  return undefined;
}
