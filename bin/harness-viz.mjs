#!/usr/bin/env node
// Thin launcher: runs the TypeScript CLI through tsx (no build step needed).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync(process.execPath, ["--import", "tsx", join(root, "src", "cli.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
