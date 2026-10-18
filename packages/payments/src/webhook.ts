/**
 * Stripe webhook verification. Framework-agnostic: pass the RAW request body (Buffer/string)
 * and the `stripe-signature` header. Locally: `stripe listen --forward-to localhost:3001/stripe/webhook`
 * prints a whsec_... secret → put it in STRIPE_WEBHOOK_SECRET.
 *
 * Express example (seller-mcp):
 *   app.post("/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
 *     const ev = verifyWebhook(req.body, req.header("stripe-signature"));
 *     if (!ev) return res.sendStatus(400);
 *     // payment_intent.succeeded → mark deal paid, logEvent({ type: "payment_succeeded", ... })
 *     res.sendStatus(200);
 *   });
 */
import Stripe from "stripe";
import { stripe } from "./client";

export const WEBHOOK_EVENTS = [
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "shared_payment.granted_token.deactivated",
] as const;

export function verifyWebhook(rawBody: string | Buffer, signature: string | undefined): Stripe.Event | null {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !signature) return null;
  try {
    return stripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    return null;
  }
}

/** Pull our deal_id back out of a payment event. */
export function dealIdFromEvent(ev: Stripe.Event): string | undefined {
  const obj = ev.data.object as { metadata?: Record<string, string> };
  return obj?.metadata?.deal_id;
}
