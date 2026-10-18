/**
 * Spike: Stripe-hosted Checkout as the pay surface for a LOCKED deal, with guardrails in code.
 *
 *  createDealCheckout(): server code (not the agent) turns a validated LockedDeal into a Checkout Session.
 *    Amount, currency, quantity and expiry come from the stored deal; no buyer knobs (no adjustable qty,
 *    no promo codes, no adaptive pricing). Could equally be issued via the Stripe MCP `stripe_api_write
 *    PostCheckoutSessions` (mcp-probe.ts proves it), but then the PARAMS come from an LLM: keep it in code.
 *
 *  handleStripeEvent(): `checkout.session.completed` → verify signature → re-check session vs deal
 *    (amount, currency, livemode, paid) → validateForPayment → markPaid → logEvent. Money has already moved
 *    by the time we see this, so any failed check REFUNDS and logs guardrail_blocked instead of trusting it.
 */
import type Stripe from "stripe";
import type { NegotiationEvent } from "../../packages/shared/src/index";
import type { Deals } from "../../apps/seller-mcp/src/exchange/deals";
import type { LockedDeal } from "../../apps/seller-mcp/src/exchange/types";

export function checkoutParams(d: LockedDeal, success_url: string): Stripe.Checkout.SessionCreateParams {
  const meta = { deal_id: d.deal_id, buyer_id: d.buyer_id, negotiation_id: d.negotiation_id, seller_id: d.seller_id, product_id: d.product_id };
  return {
    mode: "payment",
    line_items: [{ quantity: d.quantity, price_data: { currency: d.currency, unit_amount: d.unit_price_cents, product_data: { name: d.title } } }],
    allow_promotion_codes: false,
    adaptive_pricing: { enabled: false }, // keep presentment == settlement currency so amount_total compares 1:1
    client_reference_id: d.deal_id,
    metadata: meta,
    payment_intent_data: { metadata: meta },
    expires_at: Math.floor(Date.parse(d.expires_at) / 1000), // Stripe requires 30 min..24 h out: create at lock time
    success_url,
  };
}

export async function createDealCheckout(s: Stripe, deals: Deals, deal_id: string, buyer_id: string, success_url: string) {
  const check = await deals.validateForPayment(deal_id, buyer_id);
  if (!check.ok) return check;
  const session = await s.checkout.sessions.create(checkoutParams(check.deal, success_url), { idempotencyKey: `checkout-${deal_id}` });
  return { ok: true as const, url: session.url!, session_id: session.id };
}

export interface WebhookDeps {
  stripe: Stripe;
  webhookSecret: string;
  deals: Deals;
  logEvent: (e: NegotiationEvent) => Promise<void>;
  refund: (payment_intent_id: string, reason: string) => Promise<void>;
}

export type WebhookOutcome =
  | { status: 400; reason: string }
  | { status: 200; result: "ignored" | "paid" | "duplicate" | "refunded"; code?: string; deal_id?: string };

export async function handleStripeEvent(raw: string | Buffer, sig: string | undefined, deps: WebhookDeps): Promise<WebhookOutcome> {
  let ev: Stripe.Event;
  try { ev = deps.stripe.webhooks.constructEvent(raw, sig ?? "", deps.webhookSecret); }
  catch (e) { return { status: 400, reason: `bad signature: ${(e as Error).message}` }; }
  if (ev.type !== "checkout.session.completed" && ev.type !== "checkout.session.async_payment_succeeded") return { status: 200, result: "ignored" };

  const cs = ev.data.object as Stripe.Checkout.Session;
  const deal_id = cs.metadata?.deal_id ?? cs.client_reference_id ?? "";
  const pi = typeof cs.payment_intent === "string" ? cs.payment_intent : cs.payment_intent?.id ?? "";
  if (cs.payment_status !== "paid") return { status: 200, result: "ignored", deal_id }; // async methods finish later

  const deal = await deps.deals.getLockedDeal(deal_id);
  const base = { run_id: "live", buyer_id: cs.metadata?.buyer_id ?? null, buyer_model: null, seller_id: deal?.seller_id ?? null,
    product_id: deal?.product_id ?? null, negotiation_id: deal?.negotiation_id ?? null, actor: "seller" as const };

  // Session-vs-deal checks the Stripe side can't do for us.
  let code: string | undefined;
  if (!deal) code = "unknown_deal";
  else if (ev.livemode) code = "livemode_refused";
  else if (cs.currency !== deal.currency) code = "currency_mismatch";
  else if (deal.status === "paid" && deal.payment_intent_id === pi) return { status: 200, result: "duplicate", deal_id }; // webhook retry
  else {
    // buyer_id from OUR metadata (set server-side at session creation), so this is "the deal's own link was used".
    const v = await deps.deals.validateForPayment(deal_id, deal.buyer_id, cs.amount_total ?? -1);
    if (!v.ok) code = v.code;
  }

  if (code) {
    if (pi) await deps.refund(pi, code); // money already moved: undo it, never keep an out-of-policy charge
    await deps.logEvent({ ...base, type: "guardrail_blocked", price_cents: cs.amount_total ?? null,
      payload: { deal_id, rule: "tampered_payment", reason: code, payment_intent_id: pi || null, checkout_session_id: cs.id, refunded: !!pi } });
    return { status: 200, result: "refunded", code, deal_id };
  }

  await deps.deals.markPaid(deal_id, pi);
  await deps.logEvent({ ...base, type: "payment_succeeded", price_cents: cs.amount_total ?? null,
    payload: { deal_id, payment_intent_id: pi, checkout_session_id: cs.id, mode: "checkout", status: "succeeded" } });
  return { status: 200, result: "paid", deal_id };
}
