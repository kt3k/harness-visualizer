/**
 * Plain-language phrasing of IR nodes for humans.
 *
 * Generic and deterministic: phrases are assembled only from text the harness
 * authors already wrote (error messages, identifiers, tool descriptions, the
 * first sentence of a system prompt), resolved constants, and well-known SDK
 * semantics (e.g. Anthropic `stop_reason`, OpenAI `tool_calls`). When no rule
 * applies, the code itself is returned and marked as such (`code: true`), so a
 * paraphrase never hides that it is a paraphrase.
 */
import type { ContextLayer, HarnessIR, IRNode } from "./ir";

export interface Phrase {
  text: string;
  /** true when `text` is the raw code because no paraphrase rule applied */
  code?: boolean;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** camelCase / snake_case / SCREAMING_CASE identifier → words */
export function words(id: string): string {
  return id
    .replace(/^(MAX|MIN)_/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.]+/g, " ")
    .trim()
    .toLowerCase();
}

export function duration(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  if (ms >= 1000) return `${Math.round(ms / 1000)} s`;
  return `${ms} ms`;
}

/** "MAX_TURNS = 40" → "40 turns"; "RUN_TIMEOUT_MS = 900000" → "15 min"; cents → dollars */
export function limitPhrase(name: string, value: number): string {
  if (/_MS$/.test(name)) return `${words(name.replace(/_MS$/, ""))} of ${duration(value)}`.replace(/^run timeout of /, "time limit of ");
  if (/_CENTS$/.test(name)) return `$${(value / 100).toLocaleString("en-US")} (${words(name.replace(/_CENTS$/, ""))})`;
  const w = words(name);
  return `${value.toLocaleString("en-US")} ${w}`;
}

/** First sentence of a text, trimmed (for prompts / descriptions). */
export function firstSentence(text: string, max = 110): string {
  const t = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const s = m ? m[1] : t;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function cleanMessage(msg: string): string | undefined {
  const m = msg
    .replace(/\$\{[^}]*\}|…/g, "")
    .replace(/^\s*(error|denied)\s*:\s*/i, "")
    .replace(/[:\s]+$/, "")
    .trim();
  return m.length >= 5 ? m : undefined;
}

/** What a model-output condition means, using SDK semantics. */
function modelOutputPhrase(cond: string): string | undefined {
  const c = cond.replace(/\s+/g, " ");
  if (/stop_reason\s*===\s*"tool_use"/.test(c)) return "the model asks to use a tool";
  if (/stop_reason\s*!==\s*"tool_use"/.test(c)) return "the model answers without using a tool";
  if (/stop_reason\s*===\s*"end_turn"/.test(c)) return "the model gives its final answer";
  if (/stop_reason\s*===\s*"max_tokens"/.test(c)) return "the model ran out of output tokens";
  if (/!\s*\w+\.tool_calls\s*\|\|\s*\w+\.tool_calls\.length\s*===\s*0/.test(c)) return "the model answers without using a tool";
  if (/\.tool_calls\b/.test(c) && /length\s*>\s*0/.test(c)) return "the model asks to use tools";
  if (/\.type\s*!==\s*"tool_use"/.test(c)) return "a part of the reply is not a tool request";
  if (/\.type\s*===\s*"tool_use"/.test(c)) return "a part of the reply is a tool request";
  return undefined;
}

const lastSeg = (e: string) => {
  const t = e.trim().replace(/\?/g, "").replace(/\(\)$/, "");
  return t.split(".").pop() ?? t;
};

/** Generic paraphrase of a boolean expression; undefined if any atom is not understood. */
export function exprPhrase(expr: string): string | undefined {
  const e = expr.trim().replace(/^\((.*)\)$/, "$1").trim();
  // split on top-level || then &&
  for (const [op, word] of [["||", " or "], ["&&", " and "]] as const) {
    const parts = splitTop(e, op);
    if (parts.length > 1) {
      const ps = parts.map((x) => exprPhrase(x));
      return ps.every(Boolean) ? ps.join(word) : undefined;
    }
  }
  let m: RegExpExecArray | null;
  if ((m = /^typeof\s+([\w.?]+)\s*!==\s*"(\w+)"$/.exec(e))) return `${words(lastSeg(m[1]))} is not a ${m[2]}`;
  if ((m = /^([\w.?[\]]+)\s*(===|!==|==|!=)\s*"([^"]*)"$/.exec(e))) return `${words(lastSeg(m[1]))} is ${m[2].startsWith("!") ? "not " : ""}“${m[3]}”`;
  if ((m = /^([\w.?]+)\.length\s*===\s*0$/.exec(e))) return `${words(lastSeg(m[1]))} is empty`;
  if ((m = /^([\w.?]+)\.length\s*>\s*(\d+)$/.exec(e))) return `${words(lastSeg(m[1]))} is longer than ${m[2]}`;
  if ((m = /^(!?)\s*([A-Z][A-Z0-9_]*|[\w.]+)\.(has|includes)\(([\w.?]+)\)$/.exec(e))) return `${words(lastSeg(m[4]))} is ${m[1] ? "not " : ""}in ${words(lastSeg(m[2]))}`;
  if ((m = /^(!?)\s*\/(.+)\/\w*\.test\(([\w.?]+)\)$/.exec(e))) return `${words(lastSeg(m[3]))} ${m[1] ? "does not match" : "matches"} “${m[2].replace(/\\[bsSwWdD][+*?]?/g, " ").replace(/\s+/g, " ").trim()}”`;
  if ((m = /^(!?)\s*Array\.isArray\(([\w.?]+)\)$/.exec(e))) return `${words(lastSeg(m[2]))} is ${m[1] ? "not " : ""}a list`;
  if ((m = /^!\s*([\w.?]+)$/.exec(e))) {
    const w = words(lastSeg(m[1]));
    return /ed$/.test(w) ? `not ${w}` : `there is no ${w}`;
  }
  if ((m = /^([a-z][\w.?]*)$/.exec(e))) return `${words(lastSeg(m[1]))}`;
  return undefined;
}

function splitTop(e: string, op: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let inStr: string | null = null;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (inStr) {
      if (c === inStr && e[i - 1] !== "\\") inStr = null;
    } else if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && e.startsWith(op, i)) {
      out.push(cur);
      cur = "";
      i += op.length - 1;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

export function conditionPhrase(n: IRNode): Phrase {
  const a = n.attrs as Record<string, any>;
  const cond = String(a.condition ?? "");
  const consts = (a.constants ?? {}) as Record<string, number>;
  const purpose = String(a.purpose ?? "");
  const mo = modelOutputPhrase(cond);
  if (mo) return { text: mo };
  if (purpose === "cancellation") return { text: "the run was cancelled (abort / timeout)" };
  const entries = Object.entries(consts);
  if (purpose === "budget" || (n.kind === "Decision" && entries.length && /[<>]/.test(cond))) {
    if (entries.length) {
      const [k, v] = entries[0];
      const subject = /Date\.now\(\)|elapsed|startedAt/.test(cond) ? "the run takes longer than" : /[<]/.test(cond) && !/[>]/.test(cond) ? "below" : "over";
      const lp = limitPhrase(k, v);
      if (subject === "the run takes longer than") return { text: `${subject} ${lp.replace(/^time limit of /, "")}` };
      if (/_CENTS$/.test(k)) return { text: `the amount is ${subject} ${lp}` };
      if (subject === "below") return { text: `still below ${lp}` };
      return { text: `more than ${lp} used` };
    }
    if (/used\s*>\s*.*limit/i.test(cond)) return { text: "the budget is used up" };
  }
  if (/^!\s*approved$|^!\s*\w*approv\w*$/i.test(cond.trim())) return { text: "the human says no" };
  const msg = a.rejectText ? cleanMessage(String(a.rejectText)) : undefined;
  if (msg && msg.includes(" ") && (n.kind === "Guard" || n.kind === "Authorization")) return { text: lower(msg) };
  // policy outcomes like `decision.kind === "deny"` / `"ask"`
  const kindCmp = /\.(kind|status|action|type|decision|result)\s*===\s*"([\w-]+)"/.exec(cond);
  if (kindCmp) {
    const v = kindCmp[2];
    if (/^(deny|denied|reject|block)/.test(v)) return { text: "the permission policy denies it" };
    if (/^(ask|confirm|review)/.test(v)) return { text: "the permission policy requires a human's OK" };
    if (/^(allow|ok)/.test(v)) return { text: "the permission policy allows it" };
  }
  if (/^!\s*approved$|^!\s*\w*approv\w*$/i.test(cond.trim())) return { text: "the human says no" };
  if (/^!\s*handler$/.test(cond.trim()) || /unknown tool/i.test(String(a.rejectText ?? ""))) return { text: "the model named a tool that does not exist" };
  if (/===\s*null$/.test(cond.trim()) && (a.taintSources ?? []).length) return { text: "the model's reply could not be parsed into the expected format" };
  const sw = /^switch\((.+)\)$/.exec(cond);
  if (sw) return { text: words(sw[1].replace(/\?/g, "").split(".").pop() ?? sw[1]) };
  // `!isAllowedCommand(x)` → "the command is not allowed"
  const neg = /^!\s*(is|has|can|should)(\w+)\(/.exec(cond.trim());
  if (neg) return { text: `not ${words(neg[1] + neg[2])}` };
  const pos = /^(is|has|can|should)(\w+)\(/.exec(cond.trim());
  if (pos) return { text: words(pos[1] + pos[2]) };
  const ep = exprPhrase(cond);
  if (ep) return { text: ep };
  return { text: cond || n.label, code: true };
}

/** One line describing an operation node. */
export function nodePhrase(n: IRNode, ir?: HarnessIR): Phrase {
  const a = n.attrs as Record<string, any>;
  switch (n.kind) {
    case "Effect": {
      let d = String(a.describe ?? words(String(a.api ?? n.label)));
      if (a.category === "network" && a.target) d = a.target === "model-supplied URL" ? "fetch a web page chosen by the model" : `call ${a.target}`;
      return { text: d };
    }
    case "MemoryRead":
    case "MemoryWrite": {
      const store = String(a.store ?? "");
      const loc = String(ir?.nodes.find((x) => x.id === store)?.attrs.locator ?? "");
      if (store.startsWith("state:db:")) return { text: `${n.kind === "MemoryRead" ? "read" : "write"} database table ${store.slice(9)}` };
      if (store.startsWith("state:file:")) return { text: `${n.kind === "MemoryRead" ? "read" : "save to"} ${loc.includes("=") ? loc.split("=")[1].trim().replace(/"/g, "") : store.slice(11)}` };
      if (a.op === "replace") return { text: "replace the conversation history" };
      return { text: "add to the conversation" };
    }
    case "ModelCall": {
      const role = modelRole(n, ir);
      return { text: role ? `ask the model — ${role}` : "ask the model" };
    }
    case "Decision":
    case "Guard":
    case "Authorization": {
      const c = conditionPhrase(n);
      return c.code ? { text: `if ${c.text}`, code: true } : { text: `if ${c.text}` };
    }
    case "ToolRequest":
      return { text: "run the tool the model picked" };
    case "HumanApproval":
      return { text: a.mode === "indirect" ? "queue the request for a human to approve later" : "ask a human for approval" };
    case "Termination":
      return { text: `finish: ${terminationPhrase(n)}` };
    case "Unknown":
      return { text: `unknown behavior: ${String(a.reason ?? "")}` };
    case "ExternalEvent":
      return { text: a.trigger === "webhook" ? `when ${words(n.label.replace(/^webhook\s+/, "").replace(/\(.*$/, "")).replace(/^on /, "")} arrives (webhook)` : `when ${n.label.replace(/^entry\s+/, "")} is called` };
    case "Agent":
    case "Procedure":
      return { text: containerTitle(n) };
    case "Tool":
      return { text: `tool “${a.name}”${a.description ? ` — ${lower(String(a.description).replace(/\.$/, ""))}` : ""}` };
    case "Junction":
      return { text: n.attrs.role === "loop-head" ? "repeat" : n.label, code: n.attrs.role !== "loop-head" };
    case "Prompt":
      return { text: n.label.replace(/^prompt (file )?/, "prompt ") };
    case "PromptRule":
      return { text: `prompt says: “${a.text}”` };
    case "State":
      return { text: n.label };
    case "Loop":
      return { text: loopPhrase(n) };
    default:
      return { text: n.label };
  }
}

/** "agent runCodingAgent" → "Coding agent"; "handleCustomerMessage()" → "Customer message handler" */
export function containerTitle(n: IRNode): string {
  const sym = String(n.attrs.fn ?? n.id).split("#").pop() ?? n.label;
  const segs = sym.split(".");
  const base = segs.pop() ?? sym;
  const cls = segs.length && /^[A-Z]/.test(segs[segs.length - 1]) ? `${words(segs[segs.length - 1])}: ` : "";
  let w = words(base);
  if (/^(run|start|do|execute|process) /.test(w)) w = w.replace(/^\w+ /, "");
  else if (/^handle /.test(w)) w = `${w.replace(/^handle /, "")} handler`;
  else if (/^on /.test(w)) w = `${w.replace(/^on /, "")} handler`;
  if (n.kind === "Agent" && !/agent|reviewer|researcher|planner|worker/.test(w)) w = `${w} agent`;
  w = cls + w;
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export function loopPhrase(n: IRNode): string {
  const a = n.attrs as Record<string, any>;
  const consts = (a.constants ?? {}) as Record<string, number>;
  const bounds = Object.entries(consts).map(([k, v]) => limitPhrase(k, v));
  if (a.loopType === "iteration") {
    const m = /of\s+(.+)$/.exec(String(a.condition ?? ""));
    const what = m ? m[1] : "";
    if (/tool_calls|content/.test(what)) return "for each tool request in the model's reply";
    return `for each item of ${what || "a collection"}`;
  }
  if (a.loopType === "retry") return "retry on failure";
  return bounds.length ? `repeat (up to ${bounds.join(", ")})` : "repeat until a stop condition below";
}

export function terminationPhrase(n: IRNode): string {
  const r = String(n.attrs.reason ?? "");
  if (/^[a-z]+(_[a-z]+)+$/.test(r) || /^[a-z]+$/.test(r)) return words(r);
  if (/^[\w.]+$/.test(r)) return `returns ${r}`;
  if (/[(){}`[\]?]/.test(r)) return "returns the result";
  return `“${r}”`;
}

/** Role of a model call: first sentence of its system prompt. */
export function modelRole(n: IRNode, ir?: HarnessIR): string | undefined {
  if (!ir) return undefined;
  const ctx = (n.attrs.context ?? []) as ContextLayer[];
  const p = ctx.find((c) => c.kind === "prompt" && c.ref && (c.slot === "system" || c.transforms.some((t) => /role=system/.test(t)))) ?? ctx.find((c) => c.kind === "prompt" && c.ref);
  const node = p?.ref ? ir.nodes.find((x) => x.id === p.ref) : undefined;
  const text = node ? String(node.attrs.text ?? "") : "";
  if (!text || text.startsWith("«")) return undefined;
  return lower(firstSentence(text.replace(/^you are (an? )?/i, "").replace(/^you /i, "")).replace(/\.$/, ""));
}

/** Short summary of what goes into a model call. */
export function contextSummary(n: IRNode, ir: HarnessIR): string[] {
  const ctx = (n.attrs.context ?? []) as ContextLayer[];
  const out: string[] = [];
  for (const c of ctx) {
    const ref = c.ref ? ir.nodes.find((x) => x.id === c.ref) : undefined;
    if (c.kind === "prompt" && ref) out.push(`instructions: ${ref.label.replace(/^prompt (file )?/, "")}`);
    else if (c.kind === "memory" && ref) out.push(nodePhrase(ref, ir).text.replace(/^read /, ""));
    else if (c.kind === "conversation") out.push(c.transforms.some((t) => /summar/.test(t)) ? "the conversation so far (older turns may be summarized)" : "the conversation so far");
    else if (c.kind === "input") out.push(`the caller's input (${c.expr.split(" ")[0]})`);
    else if (c.kind === "model-output") out.push("output of an earlier model call / agent");
    else if (c.kind === "tool-definitions") {
      /* listed separately */
    } else if (c.certainty !== "resolved") out.push(`something unresolved (${c.expr})`);
  }
  return [...new Set(out)];
}
