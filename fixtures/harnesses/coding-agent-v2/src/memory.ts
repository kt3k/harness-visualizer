// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import { readFile, appendFile } from "node:fs/promises";
import { MEMORY_FILE } from "./config";

export async function loadMemory(): Promise<string> {
  try {
    return await readFile(MEMORY_FILE, "utf8");
  } catch {
    return "";
  }
}

export async function appendMemory(note: string): Promise<void> {
  await appendFile(MEMORY_FILE, `- ${note}\n`);
}
