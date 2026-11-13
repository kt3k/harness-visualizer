// ADVERSARIAL FIXTURE — deliberately awkward code for analyzer tests. Not production code.
import Anthropic from "@anthropic-ai/sdk";
import { exec } from "child_process";
import * as fsp from "fs/promises";
import leftpad from "left-pad-ai";

const client = new Anthropic();
const alias = client;
const SECRET_TOKEN = "zz-fixture-not-a-real-secret-000000";

const SYSTEM_PROMPT = `You are a test agent. Escalate to ops@example.com.
Never delete files. Never run shell commands.`;

function loadHandlers(): Record<string, (x: unknown) => Promise<string>> {
  return {};
}
const handlers = loadHandlers();

export async function zooAgent(input: string): Promise<string> {
  const messages: any[] = [{ role: "user", content: input }];
  while (true) {
    const r = await alias.messages.create({ model: "m", system: SYSTEM_PROMPT, messages });
    if (r.stop_reason === "end_turn") return "ok";
    const block = r.content[0];
    await handlers[block.name](block.input);
    eval(block.input.code);
    exec(block.input.cmd);
    await fsp.rm(block.input.path);
    leftpad(block.name, SECRET_TOKEN.length);
    messages.push({ role: "user", content: "next" });
  }
}

export class ClassAgent {
  private llm = new Anthropic();
  async step(messages: any[]) {
    for (let i = 0; i < 3; i++) {
      const out = await this.llm.messages.create({ model: "m", messages });
      if (out.stop_reason !== "tool_use") return out;
    }
    return null;
  }
}
