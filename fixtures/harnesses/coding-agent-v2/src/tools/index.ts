// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import { readFileTool, writeFileTool, deleteFileTool } from "./fs";
import { runShellTool } from "./shell";
import { delegateReviewTool } from "./review";
import { runPluginTool } from "./plugins";
import { appendMemory } from "../memory";

export const CODING_TOOLS = [
  { name: "read_file", description: "Read a file in the workspace.", input_schema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "write_file", description: "Create or overwrite a file in the workspace.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
  { name: "delete_file", description: "Delete a file in the workspace.", input_schema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "run_shell", description: "Run a shell command in the workspace.", input_schema: { type: "object", properties: { command: { type: "string" } } } },
  { name: "delegate_review", description: "Ask a reviewer subagent to review files.", input_schema: { type: "object", properties: { files: { type: "array" } } } },
  { name: "remember", description: "Save a note to long-term project memory.", input_schema: { type: "object", properties: { note: { type: "string" } } } },
  { name: "plugin", description: "Run a project-provided plugin tool.", input_schema: { type: "object", properties: { plugin: { type: "string" }, args: {} } } },
];

export const TOOL_HANDLERS: Record<string, (input: any) => Promise<string>> = {
  read_file: readFileTool,
  write_file: writeFileTool,
  delete_file: deleteFileTool,
  run_shell: runShellTool,
  delegate_review: delegateReviewTool,
  remember: async (input) => {
    await appendMemory(String(input.note));
    return "saved";
  },
  plugin: runPluginTool,
};
