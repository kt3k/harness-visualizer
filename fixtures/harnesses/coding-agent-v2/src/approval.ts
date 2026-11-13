// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import { createInterface } from "node:readline/promises";

export async function askHumanApproval(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}
