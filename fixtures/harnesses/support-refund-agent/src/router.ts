// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import { llm, db } from "./clients";
import { ROUTER_PROMPT, SMALLTALK_PROMPT } from "./prompts";
import { runRefundAgent } from "./refund-agent";

const ROUTE_TOOL = {
  name: "route",
  description: "Choose the route for this message.",
  input_schema: {
    type: "object",
    properties: { intent: { enum: ["refund", "order_status", "escalate", "smalltalk"] }, order_id: { type: "string" } },
    required: ["intent"],
  },
};

export async function handleCustomerMessage(customerId: string, text: string): Promise<string> {
  const history = await db.query("SELECT body FROM crm_notes WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 5", [customerId]);
  const classification = await llm.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 200,
    system: ROUTER_PROMPT,
    tools: [ROUTE_TOOL],
    tool_choice: { type: "tool", name: "route" },
    messages: [{ role: "user", content: `${history.rows.map((r: any) => r.body).join("\n")}\n\n${text}` }],
  });
  const route = classification.content.find((b: any) => b.type === "tool_use")?.input;

  switch (route?.intent) {
    case "refund":
      return await runRefundAgent(customerId, text);
    case "order_status": {
      const order = await db.query("SELECT status FROM orders WHERE id = $1 AND customer_id = $2", [route.order_id, customerId]);
      return order.rows[0] ? `Your order is ${order.rows[0].status}.` : "I could not find that order.";
    }
    case "escalate":
      await db.query("INSERT INTO tickets (customer_id, body) VALUES ($1, $2)", [customerId, text]);
      return "A human agent will get back to you.";
    case "smalltalk": {
      const reply = await llm.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        system: SMALLTALK_PROMPT,
        messages: [{ role: "user", content: text }],
      });
      return reply.content[0].text;
    }
    default:
      return "Sorry, I did not understand. A human will follow up.";
  }
}
