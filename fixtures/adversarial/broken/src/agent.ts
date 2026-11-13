// ADVERSARIAL FIXTURE — contains a syntax error on purpose.
import Anthropic from "@anthropic-ai/sdk";
const c = new Anthropic();
export async function run(q: string) {
  for (let i = 0; i < 2; i++) {
    const r = await c.messages.create({ model: "m", messages: [{ role: "user", content: q }] });
    if (r.stop_reason === "end_turn" {
      return r;
    }
  }
}
