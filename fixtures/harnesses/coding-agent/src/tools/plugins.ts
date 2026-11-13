// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import * as path from "node:path";

/** Loads a project-provided plugin module at runtime. Its behavior is not visible statically. */
export async function runPluginTool(input: { plugin: string; args: unknown }): Promise<string> {
  const modulePath = path.join(process.cwd(), ".agent/plugins", `${input.plugin}.js`);
  const plugin = await import(modulePath);
  return String(await plugin.run(input.args));
}
