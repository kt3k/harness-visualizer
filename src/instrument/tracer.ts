/**
 * Opt-in trace instrumentation (event schema v1, see src/core/trace.ts).
 *
 * Design rules:
 *  - Never changes harness semantics: every method only records and returns.
 *  - Inputs/outputs are recorded as hashes + short redacted summaries, never raw.
 *  - Clock and id generation are injectable so fixture traces are reproducible.
 *
 * Usage in a harness (illustrative):
 *   const tracer = createTracer({ sink: jsonlFileSink("run.jsonl") });
 *   const run = tracer.root("run.start", { name: task });
 *   const res = await client.messages.create(req);
 *   run.event("model.request", { nodeId: "modelcall:src/agent.ts#runCodingAgent/0", input: req });
 */
import { fnv1a, redact } from "../core/redact";
import type { TraceEvent, TraceEventType } from "../core/trace";

export interface TracerOptions {
  sink: (e: TraceEvent) => void;
  traceId?: string;
  now?: () => string;
  newId?: () => string;
  /** capture call-site file:line from the stack when no nodeId is given (default true) */
  captureLoc?: boolean;
  /** rewrite absolute paths to repository-relative ones */
  relativize?: (file: string) => string;
}

export interface EventInput {
  nodeId?: string;
  loc?: { file: string; line: number };
  name?: string;
  status?: TraceEvent["status"];
  input?: unknown;
  output?: unknown;
  attrs?: Record<string, unknown>;
}

export interface Span {
  id: string;
  event(type: TraceEventType, e?: EventInput): TraceEvent;
  child(type: TraceEventType, e?: EventInput): Span;
}

export function summarize(v: unknown, max = 80): string {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  const r = redact(s.replace(/\s+/g, " "));
  return r.length > max ? `${r.slice(0, max - 1)}…` : r;
}

export function createTracer(opts: TracerOptions) {
  let seq = 0;
  let idn = 0;
  const traceId = opts.traceId ?? `t-${Date.now().toString(36)}`;
  const now = opts.now ?? (() => new Date().toISOString());
  const newId = opts.newId ?? (() => `s${++idn}`);
  const emit = (spanId: string, parent: string | undefined, type: TraceEventType, e: EventInput = {}): TraceEvent => {
    const ev: TraceEvent = { v: 1, traceId, spanId, seq: ++seq, ts: now(), type };
    if (parent) ev.parentSpanId = parent;
    if (e.nodeId) ev.nodeId = e.nodeId;
    const loc = e.loc ?? (!e.nodeId && opts.captureLoc !== false ? callerLoc(opts.relativize) : undefined);
    if (loc) ev.loc = loc;
    if (e.name) ev.name = redact(e.name);
    if (e.status) ev.status = e.status;
    if (e.input !== undefined) ev.inputHash = fnv1a(JSON.stringify(e.input) ?? "");
    if (e.output !== undefined) ev.outputSummary = summarize(e.output);
    if (e.attrs) ev.attrs = JSON.parse(redact(JSON.stringify(e.attrs)));
    opts.sink(ev);
    return ev;
  };
  const makeSpan = (id: string, parent?: string): Span => ({
    id,
    event: (type, e) => emit(id, parent, type, e),
    child: (type, e) => {
      const s = makeSpan(newId(), id);
      s.event(type, e);
      return s;
    },
  });
  return {
    traceId,
    root(type: TraceEventType = "run.start", e?: EventInput): Span {
      const s = makeSpan(newId());
      s.event(type, e);
      return s;
    },
  };
}

function callerLoc(relativize?: (f: string) => string): { file: string; line: number } | undefined {
  const stack = new Error().stack?.split("\n") ?? [];
  // skip frames inside this module
  const frame = stack.find((l, i) => i > 2 && !l.includes("instrument/tracer"));
  const m = frame && /\(?([^()\s]+):(\d+):\d+\)?$/.exec(frame.trim());
  if (!m) return undefined;
  const file = m[1].replace(/^file:\/\//, "");
  return { file: relativize ? relativize(file) : file, line: Number(m[2]) };
}

/** Collects events in memory (tests, fixture generation). */
export function memorySink(): { sink: (e: TraceEvent) => void; events: TraceEvent[]; jsonl: () => string } {
  const events: TraceEvent[] = [];
  return { events, sink: (e) => events.push(e), jsonl: () => events.map((e) => JSON.stringify(e)).join("\n") + "\n" };
}
