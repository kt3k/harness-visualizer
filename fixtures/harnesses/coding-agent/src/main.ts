// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import { runCodingAgent } from "./agent";

export async function main(argv: string[]) {
  const mode = argv.includes("--read-only") ? "read-only" : "ask";
  const result = await runCodingAgent(argv.filter((a) => !a.startsWith("--")).join(" "), mode);
  console.log(JSON.stringify(result));
}
