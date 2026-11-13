/**
 * Generates SYNTHETIC fixture traces (JSONL) for the fixture harnesses using the
 * instrumentation API with a deterministic clock. Nothing from the harnesses is
 * executed: each scenario scripts the events an instrumented run would emit.
 * Scenarios marked "adversarial" are hand-crafted to exercise the checker.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createTracer, memorySink, type Span } from "../src/instrument/tracer";

type Ev = Parameters<Span["event"]>[1];
const root = "fixtures/harnesses";

function write(harness: string, name: string, meta: { label: string; description: string; adversarial?: boolean }, build: (run: Span) => void) {
  const mem = memorySink();
  let t = Date.parse("2026-11-01T10:00:00.000Z");
  let ids = 0;
  const tracer = createTracer({ sink: mem.sink, traceId: `${harness}:${name}`, now: () => new Date((t += 137)).toISOString(), newId: () => `s${++ids}`, captureLoc: false });
  const run = tracer.root("run.start", { name: meta.label });
  build(run);
  run.event("run.end", {});
  const dir = path.join(root, harness, "traces");
  fs.mkdirSync(dir, { recursive: true });
  const header = `// ${JSON.stringify({ label: meta.label, description: meta.description, synthetic: true, adversarial: !!meta.adversarial })}\n`;
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), header + mem.jsonl());
}

// ---------------------------------------------------------------- coding agent
const CA = {
  agent: "agent:src/agent.ts#runCodingAgent",
  loop: "loop:src/agent.ts#runCodingAgent/0",
  mem: "memoryread:src/memory.ts#loadMemory/0",
  compact: "memorywrite:src/agent.ts#runCodingAgent/3",
  model: "modelcall:src/agent.ts#runCodingAgent/0",
  pushAssistant: "memorywrite:src/agent.ts#runCodingAgent/0",
  dispatch: "toolrequest:src/agent.ts#runCodingAgent/0",
  authz: "authorization:src/agent.ts#runCodingAgent/0",
  approval: "humanapproval:src/approval.ts#askHumanApproval/0",
  approvalGate: "authorization:src/agent.ts#runCodingAgent/1",
  pushResults: "memorywrite:src/agent.ts#runCodingAgent/1",
  pushRetry: "memorywrite:src/agent.ts#runCodingAgent/2",
  read: "effect:src/tools/fs.ts#readFileTool/0",
  write: "effect:src/tools/fs.ts#writeFileTool/0",
  rm: "effect:src/tools/fs.ts#deleteFileTool/0",
  shellAuthz: "authorization:src/tools/shell.ts#runShellTool/0",
  shell: "effect:src/tools/shell.ts#runShellTool/0",
  done: "termination:src/agent.ts#runCodingAgent/3",
  malformed: "termination:src/agent.ts#runCodingAgent/2",
  revAgent: "agent:src/tools/review.ts#runReviewer",
  revLoop: "loop:src/tools/review.ts#runReviewer/0",
  revModel: "modelcall:src/tools/review.ts#runReviewer/0",
  revPush: "memorywrite:src/tools/review.ts#runReviewer/0",
  revDispatch: "toolrequest:src/tools/review.ts#runReviewer/0",
  revPushResults: "memorywrite:src/tools/review.ts#runReviewer/1",
  revDone: "termination:src/tools/review.ts#runReviewer/0",
  plugin0: "unknown:src/tools/plugins.ts#runPluginTool/0",
  plugin1: "unknown:src/tools/plugins.ts#runPluginTool/1",
};

function caTurn(a: Span, i: number, stop: string, out: string) {
  a.event("loop.iteration", { nodeId: CA.loop, attrs: { iteration: i } });
  a.event("state.write", { nodeId: CA.compact, attrs: { op: "replace", compacted: false } });
  a.event("model.request", { nodeId: CA.model, input: { turn: i } });
  a.event("model.response", { nodeId: CA.model, status: "ok", output: out, attrs: { stop_reason: stop } });
  a.event("state.write", { nodeId: CA.pushAssistant, attrs: { role: "assistant" } });
}

function caTool(a: Span, tool: string, input: unknown, opts: { authz?: "allow" | "deny" | "ask"; approved?: boolean; effect?: string; effectStatus?: "ok" | "error"; extra?: (s: Span) => void } = {}) {
  const req = a.child("tool.request", { nodeId: CA.dispatch, name: tool, input, attrs: { tool } });
  const authz = opts.authz ?? "allow";
  req.event("authz.decision", { nodeId: CA.authz, status: authz === "deny" ? "denied" : "ok", attrs: { decision: authz } });
  if (authz === "deny") return req.event("tool.result", { name: tool, status: "denied", output: "denied: read-only mode", attrs: { tool } });
  if (authz === "ask") {
    req.event("approval.request", { nodeId: CA.approval, input });
    req.event("approval.response", { nodeId: CA.approval, status: opts.approved ? "approved" : "rejected" });
    req.event("authz.decision", { nodeId: CA.approvalGate, status: opts.approved ? "ok" : "denied" });
    if (!opts.approved) return req.event("tool.result", { name: tool, status: "denied", output: "denied by user", attrs: { tool } });
  }
  opts.extra?.(req);
  if (opts.effect) req.event("tool.execute", { nodeId: opts.effect, name: tool, status: opts.effectStatus ?? "ok", input, attrs: { tool } });
  req.event("tool.result", { name: tool, status: opts.effectStatus ?? "ok", attrs: { tool } });
}

write("coding-agent", "01-fix-failing-test", { label: "Fix a failing unit test", description: "Happy path: read, write, run tests, finish with valid JSON." }, (run) => {
  const a = run.child("agent.start", { nodeId: CA.agent, name: "runCodingAgent" });
  a.event("state.read", { nodeId: CA.mem, output: "- tests live in test/" });
  caTurn(a, 1, "tool_use", "read_file src/sum.ts");
  caTool(a, "read_file", { path: "src/sum.ts" }, { effect: CA.read });
  a.event("state.write", { nodeId: CA.pushResults, attrs: { role: "user", content: "tool_result" } });
  caTurn(a, 2, "tool_use", "write_file src/sum.ts");
  caTool(a, "write_file", { path: "src/sum.ts" }, { effect: CA.write });
  a.event("state.write", { nodeId: CA.pushResults });
  caTurn(a, 3, "tool_use", "run_shell npm test");
  caTool(a, "run_shell", { command: "npm test" }, { effect: CA.shell, extra: (s) => s.event("authz.decision", { nodeId: CA.shellAuthz, status: "ok" }) });
  a.event("state.write", { nodeId: CA.pushResults });
  caTurn(a, 4, "end_turn", '{"status":"done","summary":"fixed off-by-one in sum()"}');
  a.event("termination", { nodeId: CA.done, name: "done" });
  a.event("agent.end", { nodeId: CA.agent, status: "ok" });
});

write("coding-agent", "02-delete-denied-then-malformed", { label: "Clean up build output (delete denied, malformed final answer, API retry)", description: "Human rejects delete_file; the transport retries an overloaded API call; the model's final answer is not valid JSON once and is retried." }, (run) => {
  const a = run.child("agent.start", { nodeId: CA.agent });
  a.event("state.read", { nodeId: CA.mem });
  a.event("loop.iteration", { nodeId: CA.loop, attrs: { iteration: 1 } });
  a.event("state.write", { nodeId: CA.compact });
  a.event("model.request", { nodeId: CA.model });
  a.event("error", { loc: { file: "src/model.ts", line: 13 }, status: "error", attrs: { status: 529, message: "overloaded" } });
  a.event("retry", { loc: { file: "src/model.ts", line: 17 }, attrs: { attempt: 2, backoffMs: 1000 } });
  a.event("model.response", { nodeId: CA.model, status: "ok", attrs: { stop_reason: "tool_use" } });
  a.event("state.write", { nodeId: CA.pushAssistant });
  caTool(a, "delete_file", { path: "dist/bundle.js" }, { authz: "ask", approved: false });
  a.event("state.write", { nodeId: CA.pushResults });
  caTurn(a, 2, "end_turn", "I could not delete the file, so I am done.");
  a.event("decision", { nodeId: "decision:src/agent.ts#runCodingAgent/3", name: "final === null", attrs: { branch: "then" } });
  a.event("state.write", { nodeId: CA.pushRetry, attrs: { content: "Your reply was not valid JSON…" } });
  caTurn(a, 3, "end_turn", '{"status":"blocked","summary":"delete was not approved"}');
  a.event("decision", { nodeId: "decision:src/agent.ts#runCodingAgent/3", name: "final === null", attrs: { branch: "else" } });
  a.event("termination", { nodeId: CA.done, name: "blocked" });
  a.event("agent.end", { nodeId: CA.agent });
});

write("coding-agent", "03-review-subagent-and-plugin", { label: "Refactor with a review and a plugin tool", description: "Main agent delegates to the reviewer subagent (which reads files without the main permission check), runs a dynamically loaded plugin, and the model requests a tool that does not exist." }, (run) => {
  const a = run.child("agent.start", { nodeId: CA.agent });
  a.event("state.read", { nodeId: CA.mem });
  caTurn(a, 1, "tool_use", "delegate_review");
  const req = a.child("tool.request", { nodeId: CA.dispatch, name: "delegate_review", attrs: { tool: "delegate_review" } });
  req.event("authz.decision", { nodeId: CA.authz, status: "ok" });
  const sub = req.child("agent.start", { nodeId: CA.revAgent, name: "runReviewer" });
  sub.event("loop.iteration", { nodeId: CA.revLoop, attrs: { iteration: 1 } });
  sub.event("model.request", { nodeId: CA.revModel });
  sub.event("model.response", { nodeId: CA.revModel, attrs: { stop_reason: "tool_use" } });
  sub.event("state.write", { nodeId: CA.revPush });
  const sreq = sub.child("tool.request", { nodeId: CA.revDispatch, name: "read_file", attrs: { tool: "read_file" } });
  sreq.event("tool.execute", { nodeId: CA.read, name: "read_file", input: { path: ".env" }, attrs: { tool: "read_file", note: "reviewer path has no authorize() call" } });
  sub.event("state.write", { nodeId: CA.revPushResults });
  sub.event("loop.iteration", { nodeId: CA.revLoop, attrs: { iteration: 2 } });
  sub.event("model.request", { nodeId: CA.revModel });
  sub.event("model.response", { nodeId: CA.revModel, attrs: { stop_reason: "end_turn" } });
  sub.event("state.write", { nodeId: CA.revPush });
  sub.event("termination", { nodeId: CA.revDone, name: "review text" });
  sub.event("agent.end", { nodeId: CA.revAgent });
  req.event("tool.result", { name: "delegate_review", status: "ok" });
  a.event("state.write", { nodeId: CA.pushResults });
  caTurn(a, 2, "tool_use", "plugin lint");
  caTool(a, "plugin", { plugin: "lint" }, { extra: (s) => s.event("tool.execute", { nodeId: CA.plugin0, name: "import()", attrs: { module: ".agent/plugins/lint.js" } }), effect: CA.plugin1 });
  a.event("state.write", { nodeId: CA.pushResults });
  caTurn(a, 3, "tool_use", "git_push (hallucinated tool)");
  const bad = a.child("tool.request", { nodeId: CA.dispatch, name: "git_push", attrs: { tool: "git_push" } });
  bad.event("authz.decision", { nodeId: CA.authz, status: "ok" });
  bad.event("tool.execute", { name: "git_push", status: "error", attrs: { tool: "git_push" } });
  a.event("state.write", { nodeId: CA.pushResults });
  caTurn(a, 4, "end_turn", '{"status":"done","summary":"refactored; review LGTM"}');
  a.event("termination", { nodeId: CA.done, name: "done" });
  a.event("agent.end", { nodeId: CA.agent });
});

write("coding-agent", "04-adversarial-invariants", { label: "ADVERSARIAL: injected violations", description: "Hand-crafted to exercise the checker: an rm executes after a denial in the same request span, the reviewer loop exceeds its static bound, an event references a stale node id, and one line is malformed.", adversarial: true }, (run) => {
  const a = run.child("agent.start", { nodeId: CA.agent });
  caTurn(a, 1, "tool_use", "delete_file");
  const req = a.child("tool.request", { nodeId: CA.dispatch, name: "delete_file", attrs: { tool: "delete_file" } });
  req.event("authz.decision", { nodeId: CA.authz, status: "denied" });
  req.event("tool.execute", { nodeId: CA.rm, name: "delete_file", status: "ok", attrs: { tool: "delete_file" } });
  const sub = a.child("agent.start", { nodeId: CA.revAgent });
  for (let i = 1; i <= 9; i++) sub.event("loop.iteration", { nodeId: CA.revLoop, attrs: { iteration: i } });
  sub.event("model.request", { nodeId: "modelcall:src/tools/review.ts#runReviewer/7" });
  a.event("termination", { name: "killed", attrs: { reason: "operator interrupt" } });
});
// a malformed line appended to the adversarial trace
fs.appendFileSync(path.join(root, "coding-agent/traces/04-adversarial-invariants.jsonl"), '{"v":1,"traceId":"x","seq":"not-a-number"}\n{broken json\n');

// v2: same scenarios after the change
write("coding-agent-v2", "01-force-push-blocked", { label: "Publish branch (v2: force push blocked)", description: "After the change: the model tries `git push --force`; the user approves, but the shell allowlist now rejects it; a .env read is refused." }, (run) => {
  const a = run.child("agent.start", { nodeId: CA.agent });
  a.event("state.read", { nodeId: CA.mem });
  caTurn(a, 1, "tool_use", "run_shell git push --force");
  caTool(a, "run_shell", { command: "git push --force" }, { authz: "ask", approved: true, extra: (s) => s.event("authz.decision", { nodeId: CA.shellAuthz, status: "denied", attrs: { reason: "command not allowed" } }) });
  a.event("state.write", { nodeId: CA.pushResults });
  caTurn(a, 2, "tool_use", "read_file .env");
  caTool(a, "read_file", { path: ".env" }, { extra: (s) => s.event("authz.decision", { nodeId: "authorization:src/tools/fs.ts#readFileTool/0", status: "denied" }) });
  a.event("state.write", { nodeId: CA.pushResults });
  caTurn(a, 3, "end_turn", '{"status":"blocked","summary":"force push is not allowed"}');
  a.event("termination", { nodeId: CA.done, name: "blocked" });
  a.event("agent.end", { nodeId: CA.agent });
});
write("coding-agent", "05-force-push-allowed", { label: "Publish branch (v1: force push executes)", description: "Before the change: the same request; the user approves and the shell allowlist admits `git push --force`." }, (run) => {
  const a = run.child("agent.start", { nodeId: CA.agent });
  a.event("state.read", { nodeId: CA.mem });
  caTurn(a, 1, "tool_use", "run_shell git push --force");
  caTool(a, "run_shell", { command: "git push --force" }, { authz: "ask", approved: true, effect: CA.shell, extra: (s) => s.event("authz.decision", { nodeId: CA.shellAuthz, status: "ok" }) });
  a.event("state.write", { nodeId: CA.pushResults });
  caTurn(a, 2, "end_turn", '{"status":"done","summary":"pushed"}');
  a.event("termination", { nodeId: CA.done, name: "done" });
  a.event("agent.end", { nodeId: CA.agent });
});

// ---------------------------------------------------------------- simple loop
const W = {
  agent: "agent:src/agent.ts#runWeatherAgent",
  loop: "loop:src/agent.ts#runWeatherAgent/0",
  model: "modelcall:src/agent.ts#runWeatherAgent/0",
  push: "memorywrite:src/agent.ts#runWeatherAgent/0",
  dispatch: "toolrequest:src/tools.ts#runTool/0",
  guard: "guard:src/tools.ts#runTool/0",
  pushResults: "memorywrite:src/agent.ts#runWeatherAgent/1",
  end: "termination:src/agent.ts#runWeatherAgent/0",
  budget: "termination:src/agent.ts#runWeatherAgent/1",
};
write("simple-tool-loop", "01-weather-in-paris", { label: "Weather in Paris", description: "One tool call then an answer. Tool execution is located by source location (loc), not node id." }, (run) => {
  const a = run.child("agent.start", { nodeId: W.agent });
  a.event("loop.iteration", { nodeId: W.loop, attrs: { iteration: 1 } });
  a.event("model.request", { nodeId: W.model });
  a.event("model.response", { nodeId: W.model, attrs: { stop_reason: "tool_use" } });
  a.event("state.write", { nodeId: W.push });
  const r = a.child("tool.request", { nodeId: W.dispatch, name: "get_weather", attrs: { tool: "get_weather" } });
  r.event("tool.execute", { loc: { file: "src/tools.ts", line: 30 }, name: "get_weather", attrs: { tool: "get_weather" } });
  a.event("state.write", { nodeId: W.pushResults });
  a.event("loop.iteration", { nodeId: W.loop, attrs: { iteration: 2 } });
  a.event("model.request", { nodeId: W.model });
  a.event("model.response", { nodeId: W.model, attrs: { stop_reason: "end_turn" } });
  a.event("state.write", { nodeId: W.push });
  a.event("termination", { nodeId: W.end, name: "answered" });
});
write("simple-tool-loop", "02-invalid-city-budget", { label: "Invalid city until the turn budget runs out", description: "The model keeps sending an over-long city name; the input guard rejects it every time and the loop exits on its turn budget." }, (run) => {
  const a = run.child("agent.start", { nodeId: W.agent });
  for (let i = 1; i <= 6; i++) {
    a.event("loop.iteration", { nodeId: W.loop, attrs: { iteration: i } });
    a.event("model.request", { nodeId: W.model });
    a.event("model.response", { nodeId: W.model, attrs: { stop_reason: "tool_use" } });
    a.event("state.write", { nodeId: W.push });
    const r = a.child("tool.request", { nodeId: W.dispatch, name: "get_weather", attrs: { tool: "get_weather" } });
    r.event("authz.decision", { nodeId: W.guard, status: "denied", attrs: { reason: "invalid city" } });
    a.event("state.write", { nodeId: W.pushResults });
  }
  a.event("termination", { nodeId: W.budget, name: "turn budget exhausted" });
});

// ---------------------------------------------------------------- support
const S = {
  history: "memoryread:src/router.ts#handleCustomerMessage/0",
  router: "modelcall:src/router.ts#handleCustomerMessage/0",
  route: "decision:src/router.ts#handleCustomerMessage/0",
  routeEnd: "termination:src/router.ts#handleCustomerMessage/0",
  fallback: "termination:src/router.ts#handleCustomerMessage/4",
  agent: "agent:src/refund-agent.ts#runRefundAgent",
  loop: "loop:src/refund-agent.ts#runRefundAgent/0",
  model: "modelcall:src/refund-agent.ts#runRefundAgent/0",
  push: "memorywrite:src/refund-agent.ts#runRefundAgent/0",
  dispatch: "toolrequest:src/refund-agent.ts#runRefundAgent/0",
  lookup: "memoryread:src/refund-agent.ts#runRefundAgent/0",
  threshold: "decision:src/refund-agent.ts#runRefundAgent/2",
  enqueue: "humanapproval:src/refund-agent.ts#runRefundAgent/0",
  enqueueWrite: "memorywrite:src/approvals.ts#enqueueApproval/0",
  refund: "effect:src/refund-agent.ts#runRefundAgent/0",
  mail: "effect:src/refund-agent.ts#runRefundAgent/1",
  pushResults: "memorywrite:src/refund-agent.ts#runRefundAgent/2",
  notes: "memorywrite:src/refund-agent.ts#runRefundAgent/1",
  done: "termination:src/refund-agent.ts#runRefundAgent/0",
  hook: "event:src/approvals.ts#onApprovalDecision",
  hookRead: "memoryread:src/approvals.ts#onApprovalDecision/0",
  hookGate: "authorization:src/approvals.ts#onApprovalDecision/0",
  hookRefund: "effect:src/approvals.ts#onApprovalDecision/0",
  hookWrite: "memorywrite:src/approvals.ts#onApprovalDecision/0",
  hookDone: "termination:src/approvals.ts#onApprovalDecision/1",
};
function refundTurn(a: Span, i: number, stop: string) {
  a.event("loop.iteration", { nodeId: S.loop, attrs: { iteration: i } });
  a.event("model.request", { nodeId: S.model });
  a.event("model.response", { nodeId: S.model, attrs: { stop_reason: stop } });
  a.event("state.write", { nodeId: S.push });
}
function routerStart(run: Span, intent: string) {
  const r = run.child("external.event", { nodeId: "event:entry:src/router.ts#handleCustomerMessage", name: "customer message" });
  r.event("state.read", { nodeId: S.history });
  r.event("model.request", { nodeId: S.router });
  r.event("model.response", { nodeId: S.router, output: { intent }, attrs: { intent } });
  return r;
}
write("support-refund-agent", "01-small-refund", { label: "Refund $30 (auto)", description: "Router picks refund; amount below the code threshold; refund issued; customer e-mailed (no gate on e-mail)." }, (run) => {
  const r = routerStart(run, "refund");
  const a = r.child("agent.start", { nodeId: S.agent });
  refundTurn(a, 1, "tool_use");
  let t = a.child("tool.request", { nodeId: S.dispatch, name: "lookup_order", attrs: { tool: "lookup_order" } });
  t.event("state.read", { nodeId: S.lookup });
  a.event("state.write", { nodeId: S.pushResults });
  refundTurn(a, 2, "tool_use");
  t = a.child("tool.request", { nodeId: S.dispatch, name: "issue_refund", input: { amount_cents: 3000 }, attrs: { tool: "issue_refund", amount_cents: 3000 } });
  t.event("tool.execute", { nodeId: S.refund, name: "issue_refund", attrs: { tool: "issue_refund", amount_cents: 3000 } });
  a.event("state.write", { nodeId: S.pushResults });
  refundTurn(a, 3, "tool_use");
  t = a.child("tool.request", { nodeId: S.dispatch, name: "email_customer", attrs: { tool: "email_customer" } });
  t.event("tool.execute", { nodeId: S.mail, name: "email_customer", attrs: { tool: "email_customer" } });
  a.event("state.write", { nodeId: S.pushResults });
  refundTurn(a, 4, "end_turn");
  a.event("state.write", { nodeId: S.notes });
  a.event("termination", { nodeId: S.done, name: "reply" });
  r.event("termination", { nodeId: S.routeEnd, name: "refund agent reply" });
});
write("support-refund-agent", "02-large-refund-async-approval", { label: "Refund $800 (queued for manager)", description: "Amount above the code threshold ($500): the request is queued for a manager. Note the prompt claims a $100 threshold." }, (run) => {
  const r = routerStart(run, "refund");
  const a = r.child("agent.start", { nodeId: S.agent });
  refundTurn(a, 1, "tool_use");
  const t = a.child("tool.request", { nodeId: S.dispatch, name: "issue_refund", attrs: { tool: "issue_refund", amount_cents: 80000 } });
  t.event("approval.request", { nodeId: S.enqueue, status: "pending" });
  t.event("state.write", { nodeId: S.enqueueWrite, attrs: { table: "approval_queue" } });
  a.event("state.write", { nodeId: S.pushResults });
  refundTurn(a, 2, "end_turn");
  a.event("state.write", { nodeId: S.notes });
  a.event("termination", { nodeId: S.done, name: "reply" });
  r.event("termination", { nodeId: S.routeEnd, name: "refund agent reply" });
});
write("support-refund-agent", "03-manager-approves-webhook", { label: "Manager approves queued refund (webhook)", description: "Separate run triggered by the back-office webhook; executes the refund." }, (run) => {
  const h = run.child("external.event", { nodeId: S.hook, name: "approval decision", attrs: { approved: true } });
  h.event("state.read", { nodeId: S.hookRead });
  h.event("authz.decision", { nodeId: S.hookGate, status: "ok" });
  h.event("tool.execute", { nodeId: S.hookRefund, name: "stripe.refunds.create" });
  h.event("state.write", { nodeId: S.hookWrite });
  h.event("termination", { nodeId: S.hookDone, name: "refunded" });
});
write("support-refund-agent", "04-malformed-route", { label: "Router returns no tool call", description: "Malformed model output: the forced route tool call is missing, so the router falls through to its default branch." }, (run) => {
  const r = run.child("external.event", { nodeId: "event:entry:src/router.ts#handleCustomerMessage" });
  r.event("state.read", { nodeId: S.history });
  r.event("model.request", { nodeId: S.router });
  r.event("model.response", { nodeId: S.router, status: "error", output: "(text only, no tool_use block)" });
  r.event("termination", { nodeId: S.fallback, name: "did not understand" });
});

// ---------------------------------------------------------------- research
const R = {
  planner: "modelcall:src/orchestrator.ts#runResearch/0",
  synth: "modelcall:src/orchestrator.ts#runResearch/1",
  report: "effect:src/orchestrator.ts#runResearch/0",
  end: "termination:src/orchestrator.ts#runResearch/0",
  agent: "agent:src/researcher.ts#runResearcher",
  loop: "loop:src/researcher.ts#runResearcher/0",
  cancel: "guard:src/researcher.ts#runResearcher/0",
  cancelled: "termination:src/researcher.ts#runResearcher/0",
  model: "modelcall:src/researcher.ts#runResearcher/0",
  push: "memorywrite:src/researcher.ts#runResearcher/0",
  answer: "termination:src/researcher.ts#runResearcher/1",
  dispatch: "toolrequest:src/researcher.ts#runResearcher/0",
  search: "effect:src/researcher.ts#runResearcher/0",
  hostGate: "authorization:src/researcher.ts#runResearcher/0",
  fetch: "effect:src/researcher.ts#runResearcher/1",
  depth: "guard:src/researcher.ts#runResearcher/1",
  pushTool: "memorywrite:src/researcher.ts#runResearcher/1",
};
function step(a: Span, i: number, tools: boolean) {
  a.event("loop.iteration", { nodeId: R.loop, attrs: { iteration: i } });
  a.event("model.request", { nodeId: R.model });
  a.event("model.response", { nodeId: R.model, attrs: { tool_calls: tools } });
  a.event("state.write", { nodeId: R.push });
}
write("research-orchestrator", "01-parallel-with-cancel", { label: "Three parallel researchers, one cancelled", description: "Planner fans out to 3 researchers in parallel. One fetches a disallowed host (denied), one recurses into a sub-question, one is cancelled by the run timeout." }, (run) => {
  const o = run.child("external.event", { nodeId: "event:entry:src/orchestrator.ts#runResearch" });
  o.event("model.request", { nodeId: R.planner });
  o.event("model.response", { nodeId: R.planner, output: { questions: 3 } });
  const r1 = o.child("agent.start", { nodeId: R.agent, attrs: { depth: 0 } });
  const r2 = o.child("agent.start", { nodeId: R.agent, attrs: { depth: 0 } });
  const r3 = o.child("agent.start", { nodeId: R.agent, attrs: { depth: 0 } });
  step(r1, 1, true);
  step(r2, 1, true);
  let t = r1.child("tool.request", { nodeId: R.dispatch, name: "fetch_url", attrs: { tool: "fetch_url", host: "random-blog.example" } });
  t.event("authz.decision", { nodeId: R.hostGate, status: "denied" });
  r1.event("state.write", { nodeId: R.pushTool });
  t = r2.child("tool.request", { nodeId: R.dispatch, name: "spawn_subresearch", attrs: { tool: "spawn_subresearch" } });
  const sub = t.child("agent.start", { nodeId: R.agent, attrs: { depth: 1 } });
  step(sub, 1, true);
  const st = sub.child("tool.request", { nodeId: R.dispatch, name: "web_search", attrs: { tool: "web_search" } });
  st.event("tool.execute", { nodeId: R.search, name: "web_search" });
  sub.event("state.write", { nodeId: R.pushTool });
  step(sub, 2, false);
  sub.event("termination", { nodeId: R.answer, name: "answer" });
  r2.event("state.write", { nodeId: R.pushTool });
  step(r1, 2, false);
  r1.event("termination", { nodeId: R.answer, name: "answer" });
  r3.event("loop.iteration", { nodeId: R.loop, attrs: { iteration: 1 } });
  r3.event("cancel", { nodeId: R.cancel, status: "cancelled", attrs: { reason: "RUN_TIMEOUT_MS elapsed" } });
  r3.event("termination", { nodeId: R.cancelled, name: "research cancelled", status: "error" });
  step(r2, 2, false);
  r2.event("termination", { nodeId: R.answer, name: "answer" });
  o.event("model.request", { nodeId: R.synth });
  o.event("model.response", { nodeId: R.synth });
  o.event("tool.execute", { nodeId: R.report, name: "writeFile report.md" });
  o.event("termination", { nodeId: R.end, name: "report written" });
});
console.log("traces written");
