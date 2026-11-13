// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import { llm, db, stripe, mailer } from "./clients";
import { REFUND_PROMPT } from "./prompts";
import { enqueueApproval } from "./approvals";

const REFUND_AUTO_LIMIT_CENTS = 50_000;
const MAX_TURNS = 10;

const REFUND_TOOLS = [
  { name: "lookup_order", description: "Look up an order by id.", input_schema: { type: "object", properties: { order_id: { type: "string" } } } },
  { name: "issue_refund", description: "Refund an order (amount in cents).", input_schema: { type: "object", properties: { order_id: { type: "string" }, amount_cents: { type: "integer" } } } },
  { name: "email_customer", description: "Send an e-mail to the customer.", input_schema: { type: "object", properties: { subject: { type: "string" }, body: { type: "string" } } } },
];

export async function runRefundAgent(customerId: string, text: string): Promise<string> {
  const messages: any[] = [{ role: "user", content: text }];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await llm.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: REFUND_PROMPT,
      tools: REFUND_TOOLS,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      await db.query("INSERT INTO crm_notes (customer_id, body) VALUES ($1, $2)", [customerId, "refund conversation closed"]);
      return response.content[0].text;
    }
    const results: any[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      let content: string;
      switch (block.name) {
        case "lookup_order": {
          const order = await db.query("SELECT id, total_cents, created_at FROM orders WHERE id = $1 AND customer_id = $2", [block.input.order_id, customerId]);
          content = JSON.stringify(order.rows[0] ?? null);
          break;
        }
        case "issue_refund": {
          if (block.input.amount_cents > REFUND_AUTO_LIMIT_CENTS) {
            const ticket = await enqueueApproval({ customerId, orderId: block.input.order_id, amountCents: block.input.amount_cents });
            content = `pending manager approval (ticket ${ticket})`;
            break;
          }
          const refund = await stripe.refunds.create({ payment_intent: block.input.order_id, amount: block.input.amount_cents });
          content = `refunded: ${refund.id}`;
          break;
        }
        case "email_customer": {
          await mailer.sendMail({ to: customerId, subject: block.input.subject, text: block.input.body });
          content = "sent";
          break;
        }
        default:
          content = "error: unknown tool";
      }
      results.push({ type: "tool_result", tool_use_id: block.id, content });
    }
    messages.push({ role: "user", content: results });
  }
  return "Escalating to a human agent.";
}
