// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import { readFile, writeFile, rm } from "node:fs/promises";
import * as path from "node:path";

const WORKSPACE = process.cwd();

function assertInsideWorkspace(p: string): string {
  const resolved = path.resolve(WORKSPACE, p);
  if (!resolved.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`path outside workspace: ${p}`);
  }
  return resolved;
}

export async function readFileTool(input: { path: string }): Promise<string> {
  const target = assertInsideWorkspace(input.path);
  return await readFile(target, "utf8");
}

export async function writeFileTool(input: { path: string; content: string }): Promise<string> {
  const target = assertInsideWorkspace(input.path);
  await writeFile(target, input.content);
  return `wrote ${input.content.length} bytes`;
}

export async function deleteFileTool(input: { path: string }): Promise<string> {
  const target = assertInsideWorkspace(input.path);
  await rm(target, { force: false });
  return "deleted";
}
