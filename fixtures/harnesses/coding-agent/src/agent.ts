// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import { callModel } from "./model";
import { buildSystemPrompt, compactHistory } from "./context";
import { loadMemory } from "./memory";
import { authorize } from "./permissions";
import { askHumanApproval } from "./approval";
import { parseFinalAnswer } from "./final";
import { CODING_TOOLS, TOOL_HANDLERS } from "./tools/index";
import { MAX_TURNS, MAX_FORMAT_RETRIES, RUN_TIMEOUT_MS, type PermissionMode } from "./config";

export type RunResult = { outcome: string; summary?: string; turns: number };

export async function runCodingAgent(task: string, mode: PermissionMode): Promise<RunResult> {
  const memory = await loadMemory();
  const system = buildSystemPrompt(memory);
  let messages: any[] = [{ role: "user", content: task }];
  const startedAt = Date.now();
  let formatRetries = 0;

  for (let turn = 1; ; turn++) {
    if (turn > MAX_TURNS) {
      return { outcome: "max_turns", turns: turn };
    }
    if (Date.now() - startedAt > RUN_TIMEOUT_MS) {
      return { outcome: "timeout", turns: turn };
    }

    messages = await compactHistory(messages);
    const response = await callModel({ system, messages, tools: CODING_TOOLS });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use") {
      const results: any[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        const decision = authorize(block.name, block.input, mode);
        if (decision.kind === "deny") {
          results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: `denied: ${decision.reason}` });
          continue;
        }
        if (decision.kind === "ask") {
          const approved = await askHumanApproval(`Allow ${block.name}? ${JSON.stringify(block.input)}`);
          if (!approved) {
            results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: "denied by user" });
            continue;
          }
        }

        const handler = TOOL_HANDLERS[block.name];
        if (!handler) {
          results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: "error: unknown tool" });
          continue;
        }
        try {
          const output = await handler(block.input);
          results.push({ type: "tool_result", tool_use_id: block.id, content: output });
        } catch (err: any) {
          results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: `error: ${err.message}` });
        }
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    const final = parseFinalAnswer(response.content[0]?.text ?? "");
    if (final === null) {
      formatRetries++;
      if (formatRetries > MAX_FORMAT_RETRIES) {
        return { outcome: "malformed_output", turns: turn };
      }
      messages.push({ role: "user", content: "Your reply was not valid JSON of the required shape. Reply again." });
      continue;
    }
    return { outcome: final.status, summary: final.summary, turns: turn };
  }
}
