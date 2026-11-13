// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
export const MODEL = "claude-sonnet-4-5";
export const MAX_TURNS = 25;
export const MAX_FORMAT_RETRIES = 2;
export const RUN_TIMEOUT_MS = 15 * 60 * 1000;
export const HISTORY_TOKEN_BUDGET = 60_000;
export const MEMORY_FILE = ".agent/memory.md";
export const SHELL_ALLOWLIST = ["npm", "node", "git", "ls", "cat", "tsc"];
export type PermissionMode = "read-only" | "ask" | "auto";
