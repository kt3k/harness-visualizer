// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import { db, stripe } from "./clients";

export async function enqueueApproval(req: { customerId: string; orderId: string; amountCents: number }): Promise<string> {
  const res = await db.query("INSERT INTO approval_queue (customer_id, order_id, amount_cents) VALUES ($1, $2, $3) RETURNING id", [req.customerId, req.orderId, req.amountCents]);
  return res.rows[0].id;
}

/** Webhook: a manager approved or rejected a queued refund in the back office. */
export async function onApprovalDecision(event: { ticketId: string; approved: boolean; managerId: string }) {
  const res = await db.query("SELECT order_id, amount_cents FROM approval_queue WHERE id = $1", [event.ticketId]);
  const item = res.rows[0];
  if (!item || !event.approved) {
    return { status: "rejected" };
  }
  await stripe.refunds.create({ payment_intent: item.order_id, amount: item.amount_cents });
  await db.query("UPDATE approval_queue SET status = 'done' WHERE id = $1", [event.ticketId]);
  return { status: "refunded" };
}
