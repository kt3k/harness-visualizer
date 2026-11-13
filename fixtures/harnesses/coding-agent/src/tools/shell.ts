// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SHELL_ALLOWLIST } from "../config";

const run = promisify(execFile);

function isAllowedCommand(command: string): boolean {
  const program = command.trim().split(/\s+/)[0];
  return SHELL_ALLOWLIST.includes(program);
}

export async function runShellTool(input: { command: string }): Promise<string> {
  if (!isAllowedCommand(input.command)) {
    throw new Error(`command not allowed: ${input.command}`);
  }
  const { stdout, stderr } = await run("sh", ["-c", input.command], { timeout: 120_000 });
  return stdout + stderr;
}
