// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import Anthropic from "@anthropic-ai/sdk";
import { WEATHER_TOOLS, runTool } from "./tools";

const client = new Anthropic();
const MAX_TURNS = 6;

const SYSTEM_PROMPT = `You are a concise weather assistant.
Use the get_weather tool to look up current conditions; never invent temperatures.
Only answer questions about weather. Always state the unit you are using.`;

export async function runWeatherAgent(question: string): Promise<string> {
  const messages: any[] = [{ role: "user", content: question }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: WEATHER_TOOLS,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      return response.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
    }

    const results: any[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const output = await runTool(block.name, block.input);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
  return "Sorry, I could not finish within the turn budget.";
}
