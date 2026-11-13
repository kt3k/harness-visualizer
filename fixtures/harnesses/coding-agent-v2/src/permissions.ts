// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import type { PermissionMode } from "./config";

const MUTATING_TOOLS = new Set(["write_file", "delete_file", "run_shell", "remember"]);

export type Decision = { kind: "allow" } | { kind: "ask"; reason: string } | { kind: "deny"; reason: string };

export function authorize(toolName: string, input: any, mode: PermissionMode): Decision {
  if (mode === "read-only" && MUTATING_TOOLS.has(toolName)) {
    return { kind: "deny", reason: "read-only mode" };
  }
  if (toolName === "delete_file" || (toolName === "run_shell" && /\bgit\s+push\b/.test(input.command))) {
    return { kind: "ask", reason: `confirm ${toolName}` };
  }
  return { kind: "allow" };
}
