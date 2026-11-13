// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import { readFileSync } from "node:fs";
import { callModel } from "../model";
import { readFileTool } from "./fs";

const REVIEWER_PROMPT = readFileSync("prompts/reviewer.md", "utf8");
const REVIEWER_TOOLS = [
  { name: "read_file", description: "Read a file in the workspace.", input_schema: { type: "object", properties: { path: { type: "string" } } } },
];
const REVIEWER_MAX_TURNS = 8;

/** Subagent: a read-only review loop with its own prompt and budget. */
export async function runReviewer(files: string[]): Promise<string> {
  const messages: any[] = [{ role: "user", content: `Review these files: ${files.join(", ")}` }];
  for (let turn = 0; turn < REVIEWER_MAX_TURNS; turn++) {
    const response = await callModel({ system: REVIEWER_PROMPT, messages, tools: REVIEWER_TOOLS });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return response.content[0]?.text ?? "";
    }
    const results: any[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "read_file") {
        results.push({ type: "tool_result", tool_use_id: block.id, content: await readFileTool(block.input) });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return "review incomplete: turn budget exhausted";
}

export async function delegateReviewTool(input: { files: string[] }): Promise<string> {
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new Error("files must be a non-empty array");
  }
  return await runReviewer(input.files.slice(0, 10));
}
