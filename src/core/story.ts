/**
 * "Story" view model: a human-oriented summary of a harness derived from the
 * IR. Every line keeps the ids of the IR nodes it is based on, so the summary
 * stays traceable to evidence. No LLM is involved; see humanize.ts.
 */
import { IRIndex } from "./graph";
import type { HarnessIR, IRNode } from "./ir";
import { conditionPhrase, containerTitle, contextSummary, limitPhrase, loopPhrase, modelRole, nodePhrase, terminationPhrase, words } from "./humanize";

export type Tone = "model" | "check" | "effect" | "human" | "stop" | "unknown" | "data" | "call" | "plain";

export interface StoryLine {
  text: string;
  ids: string[];
  tone: Tone;
  code?: boolean;
  children?: StoryLine[];
  /** extra detail shown in smaller type */
  note?: string;
  danger?: boolean;
}

export interface Flow {
  id: string;
  title: string;
  kind: "agent" | "subagent" | "entry";
  purpose?: string;
  triggers: StoryLine[];
  steps: StoryLine[];
  endings: StoryLine[];
}

export interface ToolCard {
  id: string;
  name: string;
  does: string;
  offeredTo: string[];
  effects: StoryLine[];
  checks: StoryLine[];
  policy: StoryLine[];
  promptSays: StoryLine[];
  starts: StoryLine[];
  unknown: StoryLine[];
  irreversible: boolean;
}

export interface Touch {
  system: string;
  actions: StoryLine[];
}

export interface Warning {
  level: "danger" | "warn" | "info";
  text: string;
  ids: string[];
}

export interface Story {
  headline: string;
  flows: Flow[];
  commonToolChecks: StoryLine[];
  tools: ToolCard[];
  touches: Touch[];
  warnings: Warning[];
}

const line = (n: IRNode | undefined): number => n?.sourceRefs[0]?.startLine ?? 0;
const range = (n: IRNode): [string, number, number] => [n.sourceRefs[0]?.file ?? "", n.sourceRefs[0]?.startLine ?? 0, n.sourceRefs[0]?.endLine ?? 0];

const SKIP_KINDS = new Set(["Junction", "Prompt", "PromptRule", "State", "ToolSet", "Tool"]);

export function buildStory(ir: HarnessIR): Story {
  const idx = new IRIndex(ir);
  const node = (id: string) => idx.node(id);
  const nodes = ir.nodes;

  // ------------------------------------------------------------ helpers
  const interesting = (c: IRNode) =>
    idx.descendants(c.id).some((d) => ["ModelCall", "Effect", "HumanApproval", "Guard", "Authorization", "Unknown"].includes(d.kind) || (d.kind === "MemoryRead" && /^state:(file|db):/.test(String(d.attrs.store))) || (d.kind === "MemoryWrite" && /^state:(file|db):/.test(String(d.attrs.store))));

  /** describe where a transition edge leads */
  const targetPhrase = (toId: string, back: boolean): string => {
    if (back) return "continue with the next one";
    const t = node(toId);
    if (!t) return "…";
    if (t.kind === "Termination") return `finish (${terminationPhrase(t)})`;
    if (t.kind === "Junction") {
      if (t.attrs.role === "exit") {
        const lit = /"([^"]{2,40})"/.exec(t.label)?.[1];
        return t.attrs.exit === "throw" ? "fail with an error" : lit ? `return “${lit}”` : "return";
      }
      if (t.attrs.role === "loop-head") {
        const loop = t.parent ? node(t.parent) : undefined;
        return loop ? loopPhrase(loop).toLowerCase() : "repeat";
      }
      return t.label;
    }
    if (t.kind === "Agent" || t.kind === "Procedure") return containerTitle(t).toLowerCase();
    if (t.kind === "Guard" || t.kind === "Authorization") return `check: stop if ${conditionPhrase(t).text}`;
    if (t.kind === "Loop") return loopPhrase(t);
    return nodePhrase(t, ir).text;
  };

  const rejectOutcome = (g: IRNode): string => {
    const rej = idx.outEdges(g.id, ["transition"]).find((e) => e.label?.startsWith("reject"));
    if (!rej) return "reject";
    if (rej.attrs.backEdge) return "skip it";
    const t = node(rej.to);
    if (t?.kind === "Termination") return `stop (${terminationPhrase(t)})`;
    if (t?.kind === "Junction" && t.attrs.exit === "throw") return "fail with an error";
    if (t?.kind === "Junction" && t.attrs.exit === "return") return "return an error";
    if (t?.kind === "MemoryWrite") return "report an error to the model";
    return "reject";
  };

  const procedureLine = (p: IRNode, depth: number): StoryLine | undefined => {
    if (p.attrs.role === "model-transport") return undefined;
    if (p.kind === "Agent") return { text: `start the ${containerTitle(p).toLowerCase()}`, ids: [p.id], tone: "call", note: "see its own section" };
    if (!interesting(p)) return undefined;
    const ds = idx.descendants(p.id);
    const hints: string[] = [];
    if (ds.some((d) => d.kind === "ModelCall")) hints.push("uses the model");
    if (ds.some((d) => d.kind === "HumanApproval")) hints.push("asks a human");
    const effects = ds.filter((d) => d.kind === "Effect").map((d) => nodePhrase(d, ir).text);
    if (effects.length) hints.push([...new Set(effects)].join(", "));
    const stores = ds.filter((d) => (d.kind === "MemoryRead" || d.kind === "MemoryWrite") && /^state:(file|db):/.test(String(d.attrs.store))).map((d) => nodePhrase(d, ir).text);
    const text = stores.length && !effects.length && !hints.length ? stores.join(", ") : containerTitle(p);
    return {
      text: text.charAt(0).toUpperCase() + text.slice(1),
      ids: [p.id],
      tone: ds.some((d) => d.kind === "ModelCall") ? "model" : ds.some((d) => d.kind === "Guard" || d.kind === "Authorization" || d.kind === "Decision") && !effects.length && !stores.length ? "check" : stores.length ? "data" : "call",
      note: stores.length && text !== containerTitle(p) ? undefined : hints.join(" · ") || undefined,
      children: depth < 1 ? dropSame(outline(p, depth + 1), text) : undefined,
    };
  };
  const dropSame = (ls: StoryLine[], text: string) => {
    const r = ls.filter((l) => l.text.toLowerCase() !== text.toLowerCase());
    return r.length ? r : undefined;
  };

  const toolNames = (mc: IRNode) => ((mc.attrs.toolsOffered as string[]) ?? []).filter(Boolean);

  function lineFor(n: IRNode, depth: number): StoryLine | undefined {
    const a = n.attrs as Record<string, any>;
    switch (n.kind) {
      case "ModelCall": {
        const role = modelRole(n, ir);
        const tools = toolNames(n);
        const children: StoryLine[] = [{ text: `sees: ${contextSummary(n, ir).join("; ") || "(unresolved)"}`, ids: [n.id], tone: "data" }];
        if (tools.length && a.toolChoice) children.push({ text: `must answer by filling in “${tools.join(", ")}” (structured output — no tool is executed)`, ids: [n.id], tone: "model" });
        else if (tools.length) children.push({ text: `may choose a tool: ${tools.join(", ")}`, ids: [n.id], tone: "model" });
        else children.push({ text: "replies with text", ids: [n.id], tone: "model" });
        return { text: `Ask the model${a.model ? ` (${a.model})` : ""}${role ? ` — ${role}` : ""}`, ids: [n.id], tone: "model", children };
      }
      case "Decision": {
        const outs = idx.outEdges(n.id, ["transition"]);
        const thenE = outs.filter((e) => e.label?.startsWith("if ") || e.label?.startsWith("case ") || e.label === "default");
        if ((thenE.length === 0 || thenE.every((e) => e.attrs.backEdge)) && n.authority === "model" && !outs.some((e) => e.label?.startsWith("case "))) return undefined; // reply-part filters
        const c = conditionPhrase(n);
        if (outs.some((e) => e.label?.startsWith("case ") || e.label === "default")) {
          return {
            text: `${n.authority === "model" ? "The model chooses the" : "Branch on the"} ${c.text}:`,
            code: c.code,
            ids: [n.id],
            tone: n.authority === "model" ? "model" : "plain",
            children: outs.map((e) => {
              const ch = chain(e.to);
              ch.ids.forEach((x) => described.add(x));
              return { text: `${(e.label ?? "").replace(/^case /, "“").replace(/^(“.*)$/, "$1”")} → ${ch.text}`, ids: [e.to, ...ch.ids], tone: "plain" as Tone };
            }),
          };
        }
        const elseE = outs.find((e) => e.label === "else");
        const viaChain = (to: string, back: boolean) => {
          if (back) return targetPhrase(to, true);
          const ch = chain(to);
          ch.ids.forEach((x) => described.add(x));
          return ch.text;
        };
        const thenText = thenE.map((e) => viaChain(e.to, !!e.attrs.backEdge));
        return {
          text: `If ${c.text} → ${[...new Set(thenText)].join(" / ") || "…"}${elseE ? `; otherwise → ${viaChain(elseE.to, !!elseE.attrs.backEdge)}` : ""}`,
          code: c.code,
          ids: [n.id],
          tone: n.authority === "model" ? "model" : n.authority === "human" ? "human" : "plain",
        };
      }
      case "Guard":
      case "Authorization": {
        const c = conditionPhrase(n);
        const out = rejectOutcome(n);
        const text = out.startsWith("stop") ? `Stop if ${c.text}` : out === "skip it" ? `Refuse the request if ${c.text}` : `${out.charAt(0).toUpperCase()}${out.slice(1)} if ${c.text}`;
        return { text, note: out.startsWith("stop") ? `ends with ${out.replace(/^stop \(|\)$/g, "")}` : out === "skip it" ? "the tool is not run" : undefined, code: c.code, ids: [n.id], tone: n.authority === "human" ? "human" : "check" };
      }
      case "Termination": {
        const fromBranch = idx.inEdges(n.id, ["transition"]).every((e) => ["Decision", "Guard", "Authorization"].includes(node(e.from)?.kind ?? "") && !e.label?.startsWith("pass"));
        if (fromBranch && idx.inEdges(n.id, ["transition"]).length) return undefined;
        return { text: `Finish: ${terminationPhrase(n)}`, ids: [n.id], tone: "stop" };
      }
      case "ToolRequest": {
        const cands = idx.outEdges(n.id, ["dispatches"]).map((e) => e.label).filter(Boolean);
        return { text: "Run the tool the model picked", note: cands.length ? `one of: ${cands.join(", ")} — see “What the model can do”` : undefined, ids: [n.id], tone: "model" };
      }
      case "Effect":
        return { text: nodePhrase(n, ir).text.replace(/^./, (x) => x.toUpperCase()), ids: [n.id], tone: "effect", danger: a.irreversible === true };
      case "MemoryRead":
      case "MemoryWrite":
        if (!/^state:(file|db):/.test(String(a.store))) return undefined;
        return { text: nodePhrase(n, ir).text.replace(/^./, (x) => x.toUpperCase()), ids: [n.id], tone: "data" };
      case "HumanApproval":
        return { text: nodePhrase(n, ir).text.replace(/^./, (x) => x.toUpperCase()), ids: [n.id], tone: "human" };
      case "Unknown":
        return { text: `Runs something that cannot be analysed: ${a.reason}`, ids: [n.id], tone: "unknown", danger: true };
      case "Loop": {
        let t = loopPhrase(n);
        if (n.attrs.infinite) {
          const lim = (idx.children.get(n.id) ?? []).filter((g) => (g.kind === "Guard" || g.kind === "Authorization") && (g.attrs.purpose === "budget" || g.attrs.purpose === "cancellation")).map((g) => conditionPhrase(g).text);
          t = lim.length ? `repeat until ${lim.join(" or ")}` : "repeat until one of the exits below";
        }
        return { text: t.replace(/^./, (x) => x.toUpperCase()) + ":", ids: [n.id], tone: "plain", children: outline(n, depth) };
      }
      default:
        return undefined;
    }
  }

  /** ids already described inside a branch chain (not repeated at top level) */
  const described = new Set<string>();
  /** follow a straight-line path from a branch target: "read orders → finish (…)" */
  function chain(start: string): { text: string; ids: string[] } {
    const parts: string[] = [];
    const ids: string[] = [];
    let cur: string | undefined = start;
    for (let i = 0; cur && i < 5; i++) {
      const n = node(cur);
      if (!n || ids.includes(cur)) break;
      ids.push(cur);
      parts.push(targetPhrase(cur, false));
      if (n.kind === "Termination" || n.kind === "Decision" || n.kind === "Guard" || n.kind === "Authorization") break;
      const outs: { to: string }[] = idx.outEdges(cur, ["transition"]).filter((e) => !e.attrs.backEdge);
      if (outs.length !== 1) break;
      cur = outs[0].to;
    }
    return { text: parts.join(" → "), ids };
  }

  /** Source-ordered outline of a container: its own nodes, nested loops, and calls to procedures. */
  function outline(c: IRNode, depth: number): StoryLine[] {
    const items: { at: number; line: StoryLine }[] = [];
    const kids = idx.children.get(c.id) ?? [];
    for (const k of kids) {
      if (SKIP_KINDS.has(k.kind) && k.kind !== "Loop") continue;
      const l = lineFor(k, depth);
      if (l) items.push({ at: line(k), line: l });
    }
    // calls into other containers made from this container's source range
    const fnContainer = [c.id, ...idx.ancestors(c.id)].map((x) => node(x)!).find((x) => ["Agent", "Procedure", "Tool"].includes(x.kind)) ?? c;
    const [file, from, to] = range(c);
    const innerLoops = kids.filter((k) => k.kind === "Loop").map(range);
    for (const e of idx.outEdges(fnContainer.id, ["invokes"])) {
      const callee = node(e.to);
      if (!callee || e.to === fnContainer.id) continue;
      for (const s of (e.attrs.sites as { file: string; line: number }[] | undefined) ?? []) {
        if (s.file !== file || s.line < from || s.line > to) continue;
        if (innerLoops.some(([f, a, b]) => f === s.file && s.line >= a && s.line <= b)) continue; // belongs to a nested loop
        if (callee.kind === "Tool") continue;
        const callers = idx.inEdges(callee.id, ["transition"]).filter((t) => t.label === "call" || t.label?.startsWith("if ") || t.label?.startsWith("tool ="));
        if (callers.length && callers.every((t) => idx.ancestors(t.from).some((a) => node(a)?.kind === "Tool"))) continue;
        const l = procedureLine(callee, depth);
        if (l && e.attrs.mode === "parallel") l.text = `${l.text} — several in parallel`;
        if (l) items.push({ at: s.line, line: l });
      }
    }
    return items
      .sort((a, b) => a.at - b.at)
      .map((x) => x.line)
      .filter((l) => l.tone === "model" || !l.ids.every((id) => described.has(id)) || !!l.children);
  }

  // ------------------------------------------------------------ flows
  const flows: Flow[] = [];
  const entryEvents = nodes.filter((n) => n.kind === "ExternalEvent");
  const covered = new Set<string>();
  const agentTrigger = (agent: IRNode): StoryLine[] => {
    const out: StoryLine[] = [];
    for (const e of [...idx.inEdges(agent.id, ["invokes"]), ...idx.inEdges(agent.id, ["transition"]).filter((t) => node(t.from)?.kind === "ExternalEvent")]) {
      const from = node(e.from);
      if (!from || e.from === agent.id) continue;
      if (from.kind === "ExternalEvent") out.push({ text: nodePhrase(from, ir).text, ids: [from.id], tone: "plain" });
      else if (from.kind === "Tool") {
        const owner = nodes.find((m) => m.kind === "ModelCall" && toolNames(m).includes(String(from.attrs.name)) && idx.outEdges(from.parent ?? "", ["offers"]).concat(idx.outEdges(from.id, ["offers"])).some((o) => o.to === m.id));
        const ownerAgent = owner ? [...idx.ancestors(owner.id)].map((x) => node(x)!).find((x) => x.kind === "Agent") : undefined;
        out.push({ text: `when ${ownerAgent ? `the ${containerTitle(ownerAgent).toLowerCase()}'s model` : "the model"} uses the tool “${from.attrs.name}”`, ids: [from.id], tone: "model" });
      } else if (from.kind === "Procedure" || from.kind === "Agent") {
        const viaEntry = entryEvents.find((ev) => idx.outEdges(ev.id, ["transition"]).some((t) => t.to === from.id));
        if (viaEntry && !interestingOwn(from, agent)) out.push({ text: `${nodePhrase(viaEntry, ir).text} (which calls it)`, ids: [viaEntry.id, from.id], tone: "plain" });
        else out.push({ text: `called by ${containerTitle(from).toLowerCase()}`, ids: [from.id], tone: "plain" });
      } else if (from.kind === "ModelCall") {
        /* transport */
      } else out.push({ text: `called from ${nodePhrase(from, ir).text}`, ids: [from.id], tone: "plain" });
    }
    return dedupe(out);
  };
  /** does procedure p do anything interesting besides calling agent a? */
  const interestingOwn = (p: IRNode, a: IRNode) => idx.descendants(p.id).some((d) => !idx.isInside(d.id, a.id) && ["ModelCall", "Effect", "Guard", "Authorization", "HumanApproval"].includes(d.kind));

  const endingsOf = (c: IRNode): StoryLine[] =>
    dedupe(
      idx
        .descendants(c.id)
        .filter((d) => d.kind === "Termination")
        .map((t) => {
          const cause = idx.inEdges(t.id, ["transition"]).map((e) => node(e.from)!).find((f) => f && ["Decision", "Guard", "Authorization"].includes(f.kind));
          const edge = cause ? idx.inEdges(t.id, ["transition"]).find((e) => e.from === cause.id) : undefined;
          const condText = cause ? conditionPhrase(cause).text : undefined;
          const negated = edge && (edge.label === "else" || edge.label === "pass");
          const caseLabel = edge?.label?.startsWith("case ") ? edge.label.slice(5) : edge?.label === "default" ? "anything else" : undefined;
          const viaLoopExit = idx.inEdges(t.id, ["transition"]).some((e) => e.label?.startsWith("exit:"));
          const why = caseLabel && cause
            ? `${cause.authority === "model" ? "the model's " : ""}${conditionPhrase(cause).text} is ${caseLabel}`
            : viaLoopExit
            ? "the loop limit is reached"
            : condText
              ? negated
                ? `otherwise — i.e. not when ${condText}`
                : condText
              : t.attrs.kind === "error"
                ? "an error is thrown"
                : "it gets through the steps above";
          return { text: `${terminationPhrase(t)}`, note: `when ${why}`, ids: [t.id, ...(cause ? [cause.id] : [])], tone: (t.attrs.kind === "error" ? "stop" : "plain") as Tone };
        }),
    );

  for (const ev of entryEvents) {
    const target = idx.outEdges(ev.id, ["transition"]).map((e) => node(e.to)!).find(Boolean);
    if (!target) continue;
    // an entry that only starts an agent is described as that agent's trigger
    const onlyCallsAgent = target.kind === "Procedure" && !interesting(target) && idx.outEdges(target.id, ["invokes"]).some((e) => node(e.to)?.kind === "Agent");
    if (onlyCallsAgent) continue;
    covered.add(target.id);
    flows.push({
      id: target.id,
      title: containerTitle(target),
      kind: target.kind === "Agent" ? "agent" : "entry",
      purpose: purposeOf(target),
      triggers: target.kind === "Agent" ? agentTrigger(target) : [{ text: nodePhrase(ev, ir).text, ids: [ev.id], tone: "plain" }],
      steps: outline(target, 0),
      endings: endingsOf(target),
    });
  }
  for (const ag of nodes.filter((n) => n.kind === "Agent")) {
    if (covered.has(ag.id)) continue;
    flows.push({
      id: ag.id,
      title: containerTitle(ag),
      kind: ag.attrs.role === "subagent" ? "subagent" : "agent",
      purpose: purposeOf(ag),
      triggers: agentTrigger(ag),
      steps: outline(ag, 0),
      endings: endingsOf(ag),
    });
  }
  // order: entries/agents first, subagents last
  flows.sort((a, b) => (a.kind === "subagent" ? 1 : 0) - (b.kind === "subagent" ? 1 : 0));

  function purposeOf(c: IRNode): string | undefined {
    const mc = idx
      .descendants(c.id)
      .filter((d) => d.kind === "ModelCall")
      .sort((a, b) => line(a) - line(b))[0];
    const role = mc ? modelRole(mc, ir) : undefined;
    return role ? `The model's job: ${role}.` : undefined;
  }

  // ------------------------------------------------------------ tools
  const reachInside = (id: string, depth = 0, seen = new Set<string>()): IRNode[] => {
    if (seen.has(id) || depth > 3) return [];
    seen.add(id);
    const own = idx.descendants(id);
    const called = idx
      .outEdges(id, ["invokes"])
      .filter((e) => node(e.to)?.kind !== "Agent")
      .flatMap((e) => reachInside(e.to, depth + 1, seen));
    return [...own, ...called];
  };
  const delegatedTo = (t: IRNode): string[] =>
    idx
      .inEdges(t.id, ["dispatches"])
      .flatMap((d) => idx.outEdges(d.from, ["transition"]).filter((e) => e.label === `tool = ${t.attrs.name}` && ["Tool", "Procedure"].includes(node(e.to)?.kind ?? "") && e.to !== t.id).map((e) => e.to));
  const tools: ToolCard[] = nodes
    .filter((n) => n.kind === "Tool" && !n.attrs.structuredOutput)
    .map((t) => {
      const inside = [...reachInside(t.id), ...delegatedTo(t).flatMap((x) => [node(x)!, ...reachInside(x)])];
      const effects = dedupe(
        inside
          .filter((d) => d.kind === "Effect" || ((d.kind === "MemoryWrite" || d.kind === "MemoryRead") && /^state:(file|db):/.test(String(d.attrs.store))))
          .map((d) => ({ text: nodePhrase(d, ir).text, ids: [d.id], tone: (d.kind === "Effect" ? "effect" : "data") as Tone, danger: d.attrs.irreversible === true })),
      );
      const checks = dedupe(
        inside
          .filter((d) => (d.kind === "Guard" || d.kind === "Authorization" || (d.kind === "Decision" && d.authority !== "model" && idx.outEdges(d.id, ["gates"]).length > 0)) && d.attrs.purpose !== "budget")
          .map((d) => {
            const c = conditionPhrase(d);
            const gated = d.kind === "Decision";
            return { text: gated ? `only when not: ${c.text}` : `refuses if ${c.text}`, code: c.code, ids: [d.id], tone: "check" as Tone };
          }),
      );
      // policy rules elsewhere that name this tool
      const policy = dedupe(
        nodes
          .filter((d) => (d.kind === "Decision" || d.kind === "Authorization") && new RegExp(`["'\`]${escapeRe(String(t.attrs.name))}["'\`]`).test(String(d.attrs.condition ?? "")) && !idx.isInside(d.id, t.id))
          .map((d) => {
            const outcome = String(d.attrs.outcomeText ?? d.attrs.rejectText ?? "");
            const what = /\bask|confirm/i.test(outcome) ? "needs a human's OK" : /deny|denied|not allowed/i.test(outcome) || d.kind === "Authorization" ? "can be denied" : "special handling";
            return { text: `${what} (permission policy in ${containerTitle(node(containerOfId(d.id))!).toLowerCase()})`, ids: [d.id], tone: "human" as Tone };
          }),
      );
      const agentTargets = [
        ...idx.outEdges(t.id, ["invokes"]).map((e) => e.to),
        ...[t, ...idx.descendants(t.id)].flatMap((d) => idx.outEdges(d.id, ["transition"]).map((e) => e.to)),
      ]
        .map((x) => node(x)!)
        .filter((x) => x?.kind === "Agent");
      const owner = (x: IRNode) => offeredToAgents(t).includes(x.id);
      const starts = dedupe(agentTargets.map((x) => ({ text: owner(x) ? `starts another ${containerTitle(x).toLowerCase()} (recursion)` : `starts the ${containerTitle(x).toLowerCase()}`, ids: [x.id], tone: "call" as Tone })));
      const limits = dedupe(
        inside
          .filter((d) => (d.kind === "Guard" || d.kind === "Authorization") && d.attrs.purpose === "budget")
          .map((d) => ({ text: `refuses if ${conditionPhrase(d).text}`, ids: [d.id], tone: "check" as Tone })),
      );
      const unknown = dedupe(inside.filter((d) => d.kind === "Unknown").map((d) => ({ text: /dynamic|dynamically/.test(String(d.attrs.reason)) ? "loads and runs code at runtime (cannot be analysed)" : `unknown: ${d.attrs.reason}`, ids: [d.id], tone: "unknown" as Tone, danger: true })));
      const promptSays = dedupe(
        nodes
          .filter((r) => r.kind === "PromptRule" && ((r.attrs.relatedTools as string[]) ?? []).includes(t.id))
          .map((r) => ({ text: `“${r.attrs.text}”`, note: r.attrs.status === "prompt-only" ? "not enforced by code" : r.attrs.status === "possible-mismatch" ? "code uses a different limit" : "code check with similar terms exists (verify)", ids: [r.id], tone: "plain" as Tone, danger: r.attrs.status === "prompt-only" || r.attrs.status === "possible-mismatch" })),
      );
      const offeredTo = nodes
        .filter((m) => m.kind === "ModelCall" && idx.inEdges(m.id, ["offers"]).some((o) => o.from === t.id || o.from === t.parent))
        .map((m) => {
          const ag = idx.ancestors(m.id).map((x) => node(x)!).find((x) => x.kind === "Agent" || x.kind === "Procedure");
          return ag ? containerTitle(ag) : "model";
        });
      return {
        id: t.id,
        name: String(t.attrs.name),
        does: String(t.attrs.description ?? ""),
        offeredTo: [...new Set(offeredTo)],
        effects,
        checks: [...checks, ...limits],
        policy,
        promptSays,
        starts,
        unknown,
        irreversible: effects.some((e) => e.danger),
      };
    });
  function offeredToAgents(t: IRNode): string[] {
    return nodes
      .filter((m) => m.kind === "ModelCall" && idx.inEdges(m.id, ["offers"]).some((o) => o.from === t.id || o.from === t.parent))
      .flatMap((m) => idx.ancestors(m.id).filter((a) => node(a)?.kind === "Agent"));
  }
  const toolRequests = nodes.filter((n) => n.kind === "ToolRequest");
  const commonToolChecks = dedupe(
    toolRequests.flatMap((tr) =>
      ((tr.attrs.gatedBy as string[]) ?? [])
        .map((g) => node(g)!)
        .filter((g) => g && g.attrs.purpose !== "budget" && g.attrs.purpose !== "cancellation" && containerOfId(g.id) === containerOfId(tr.id))
        .map((g) => {
          const c = conditionPhrase(g);
          return { text: `${c.text}`, code: c.code, ids: [g.id], tone: (g.authority === "human" ? "human" : "check") as Tone, note: `before ${containerTitle(node(containerOfId(tr.id))!).toLowerCase()} runs any tool → ${rejectOutcome(g)}` };
        }),
    ),
  );

  // ------------------------------------------------------------ touches
  const touchMap = new Map<string, StoryLine[]>();
  const touch = (system: string, l: StoryLine) => touchMap.set(system, dedupe([...(touchMap.get(system) ?? []), l]));
  for (const e of nodes.filter((n) => n.kind === "Effect")) {
    const a = e.attrs as Record<string, any>;
    const system =
      a.category?.startsWith("fs.") ? "Files on disk" : a.category === "process.exec" ? "Shell / processes" : a.category === "network" ? (a.target === "model-supplied URL" ? "The web (URLs chosen by the model)" : `Web: ${a.target ?? "unknown host"}`) : a.target ? String(a.target) : words(String(a.category));
    touch(system, { text: nodePhrase(e, ir).text, ids: [e.id], tone: "effect", danger: a.irreversible === true });
  }
  for (const m of nodes.filter((n) => (n.kind === "MemoryRead" || n.kind === "MemoryWrite") && /^state:(file|db):/.test(String(n.attrs.store)))) {
    const system = String(m.attrs.store).startsWith("state:db:") ? "Database" : "Agent memory file";
    touch(system, { text: nodePhrase(m, ir).text, ids: [m.id], tone: "data" });
  }
  const providers = new Map<string, string[]>();
  for (const m of nodes.filter((n) => n.kind === "ModelCall")) providers.set(String(m.attrs.provider ?? "model"), [...(providers.get(String(m.attrs.provider ?? "model")) ?? []), m.id]);
  for (const [p, ids] of providers) touch(`${p === "anthropic" ? "Anthropic" : p === "openai" ? "OpenAI" : p} API (LLM)`, { text: `${ids.length} model call site(s)`, ids, tone: "model" });
  for (const h of nodes.filter((n) => n.kind === "HumanApproval")) touch("Humans", { text: nodePhrase(h, ir).text, ids: [h.id], tone: "human" });
  for (const u of nodes.filter((n) => n.kind === "Unknown")) touch("Unknown (not analysable)", { text: String(u.attrs.reason), ids: [u.id], tone: "unknown", danger: true });
  const touches = [...touchMap].map(([system, actions]) => ({ system, actions }));

  // ------------------------------------------------------------ warnings
  const warnings: Warning[] = [];
  for (const e of nodes.filter((n) => (n.kind === "Effect" || (n.kind === "MemoryWrite" && n.attrs.effectCategory)) && n.attrs.irreversible === true && n.attrs.ungatedRoute)) {
    warnings.push({ level: "danger", text: `It can ${nodePhrase(e, ir).text} with no code check on at least one path.`, ids: [e.id] });
  }
  for (const r of nodes.filter((n) => n.kind === "PromptRule" && n.attrs.status === "possible-mismatch")) {
    const g = ((r.attrs.matchedGuards as string[]) ?? []).map((x) => node(x)!).find((x) => x && Object.keys(x.attrs.constants ?? {}).length);
    const consts = (g?.attrs.constants ?? {}) as Record<string, number>;
    const lim = Object.entries(consts).map(([k, v]) => limitPhrase(k, v)).join(", ");
    warnings.push({ level: "danger", text: `The prompt says “${r.attrs.text}”, but the code uses a different limit${lim ? `: ${lim}` : ""}.`, ids: [r.id, ...(g ? [g.id] : [])] });
  }
  for (const r of nodes.filter((n) => n.kind === "PromptRule" && n.attrs.status === "prompt-only")) {
    warnings.push({ level: "warn", text: `The prompt says “${r.attrs.text}”, but no code enforces it.`, ids: [r.id] });
  }
  for (const r of nodes.filter((n) => n.kind === "PromptRule" && n.attrs.status === "related-check")) {
    warnings.push({ level: "info", text: `The prompt says “${r.attrs.text}”; related code exists but does not clearly enforce it — verify.`, ids: [r.id, ...((r.attrs.matchedGuards as string[]) ?? [])] });
  }
  for (const e of nodes.filter((n) => n.kind === "Effect" || (n.kind === "MemoryWrite" && n.attrs.effectCategory))) {
    const routes = (e.attrs.routes as { via: string[]; gates: string[] }[] | undefined) ?? [];
    const authz = (r: { gates: string[] }) => r.gates.some((g) => node(g)?.kind === "Authorization");
    if (routes.some(authz) && routes.some((r) => !authz(r))) {
      const unchecked = routes.filter((r) => !authz(r)).map((r) => r.via.join(" → "));
      warnings.push({ level: "warn", text: `“${nodePhrase(e, ir).text}” is permission-checked on some paths but not on: ${unchecked.join("; ")}.`, ids: [e.id] });
    }
  }
  for (const u of nodes.filter((n) => n.kind === "Unknown")) warnings.push({ level: "warn", text: `Runs code that cannot be analysed (${u.attrs.reason}).`, ids: [u.id] });

  // ------------------------------------------------------------ headline
  const agents = nodes.filter((n) => n.kind === "Agent");
  const effectWords = [...new Set(nodes.filter((n) => n.kind === "Effect").map((n) => nodePhrase(n, ir).text))];
  const headline = [
    `${agents.length ? `${agents.length} agent loop${agents.length > 1 ? "s" : ""}` : "No agent loop"}${agents.some((a) => a.attrs.role === "subagent") ? " (incl. subagents)" : ""}`,
    `${nodes.filter((n) => n.kind === "ModelCall").length} model call site(s)`,
    `${tools.length} tool(s) the model can choose`,
    effectWords.length ? `side effects: ${effectWords.slice(0, 6).join(", ")}${effectWords.length > 6 ? ", …" : ""}` : "no side effects found",
  ].join(" · ");

  const order = { danger: 0, warn: 1, info: 2 } as const;
  warnings.sort((a, b) => order[a.level] - order[b.level]);
  return { headline, flows, commonToolChecks, tools, touches, warnings };

  function containerOfId(id: string): string {
    return [id, ...idx.ancestors(id)].find((x) => ["Agent", "Procedure", "Tool"].includes(node(x)?.kind ?? "")) ?? id;
  }
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupe(lines: StoryLine[]): StoryLine[] {
  const seen = new Set<string>();
  return lines.filter((l) => {
    const k = l.text + (l.note ?? "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Plain-text rendering (CLI / Markdown export). */
export function storyMarkdown(ir: HarnessIR, opts: { redaction?: "standard" | "strict" } = {}): string {
  const md = storyMarkdownRaw(ir);
  // strict: withhold quoted prompt text
  return opts.redaction === "strict" ? md.replace(/“[^”]{12,}”/g, "«prompt text withheld»") : md;
}

function storyMarkdownRaw(ir: HarnessIR): string {
  const s = buildStory(ir);
  const L: string[] = [`# ${ir.harness.name}`, "", s.headline, ""];
  const render = (ls: StoryLine[], depth: number) => {
    for (const l of ls) {
      L.push(`${"  ".repeat(depth)}- ${l.code ? `\`${l.text}\`` : l.text}${l.note ? ` _(${l.note})_` : ""}`);
      if (l.children) render(l.children, depth + 1);
    }
  };
  for (const f of s.flows) {
    L.push(`## ${f.title}${f.kind === "subagent" ? " (subagent)" : ""}`, "");
    if (f.purpose) L.push(f.purpose, "");
    L.push("**Starts**");
    render(f.triggers, 0);
    L.push("", "**Steps**");
    render(f.steps, 0);
    L.push("", "**Ends**");
    render(f.endings, 0);
    L.push("");
  }
  if (s.tools.length) {
    L.push("## What the model can do", "");
    for (const t of s.tools) {
      L.push(`- **${t.name}** — ${t.does}`);
      for (const e of [...t.effects, ...t.starts, ...t.unknown]) L.push(`  - does: ${e.text}${e.danger ? " ⚠" : ""}`);
      for (const c of [...t.checks, ...t.policy]) L.push(`  - check: ${c.text}`);
      for (const p of t.promptSays) L.push(`  - prompt: ${p.text} (${p.note})`);
    }
    L.push("");
  }
  if (s.warnings.length) {
    L.push("## Watch out", "");
    for (const w of s.warnings) L.push(`- ${w.level === "danger" ? "⚠ " : ""}${w.text}`);
  }
  return L.join("\n") + "\n";
}
