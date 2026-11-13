// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "./config";

const anthropic = new Anthropic();
const MAX_ATTEMPTS = 4;

/** Thin transport wrapper: retries overloaded / 5xx errors with backoff. */
export async function callModel(params: { system: string; messages: any[]; tools?: any[]; max_tokens?: number }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await anthropic.messages.create({ model: MODEL, max_tokens: 4096, ...params });
    } catch (err: any) {
      if (attempt >= MAX_ATTEMPTS || !(err.status === 529 || err.status >= 500)) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
}
