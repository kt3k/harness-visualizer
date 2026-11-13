// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import { readFileSync } from "node:fs";
import { callModel } from "./model";
import { HISTORY_TOKEN_BUDGET } from "./config";

const SYSTEM_PROMPT = readFileSync("prompts/system.md", "utf8");

export function buildSystemPrompt(memory: string): string {
  return `${SYSTEM_PROMPT}\n\n## Project memory\n${memory}`;
}

function estimateTokens(messages: any[]): number {
  return JSON.stringify(messages).length / 4;
}

/** Replaces old turns with a model-written summary when over budget. */
export async function compactHistory(messages: any[]): Promise<any[]> {
  if (estimateTokens(messages) < HISTORY_TOKEN_BUDGET) {
    return messages;
  }
  const old = messages.slice(0, -6);
  const summary = await callModel({
    system: "Summarize this coding session. Keep file names, decisions and open problems.",
    messages: [{ role: "user", content: JSON.stringify(old) }],
    max_tokens: 1500,
  });
  return [{ role: "user", content: `Summary of earlier work: ${summary.content[0].text}` }, ...messages.slice(-6)];
}
