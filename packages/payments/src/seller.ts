/**
 * SELLER side: charge an approved deal. Used by apps/seller-mcp inside `accept_deal` / `pay_deal`.
 * Flow (docs/tracks/stripe.md §1): pre-check the buyer's token against the deal → create + confirm a
 * PaymentIntent for exactly deal.amount_cents with an idempotency key → return an explainable result.
 */
import Stripe from "stripe";
import { stripe } from "./client";
import { pickupCode, splitFor, splitParams, type Split } from "./connect";
import type { Deal, PaymentCredential, PaymentResult } from "./types";

/** Minimal view of a granted token, so the check is a pure function we can unit test. */
export interface TokenView {
  currency: string;
  max_amount: number;
  expires_at: number | null;
  deactivated_reason: string | null;
}

/** Pure pre-check. Empty array = OK. Refuse before touching money and say exactly why. */
export function precheckToken(deal: Deal, tok: TokenView, nowSec = Math.floor(Date.now() / 1000)): string[] {
  const why: string[] = [];
  if (tok.deactivated_reason) why.push(`token is ${tok.deactivated_reason}`);
  if (tok.currency.toLowerCase() !== deal.currency.toLowerCase())
    why.push(`token currency ${tok.currency} does not match deal currency ${deal.currency}`);
  if (tok.max_amount < deal.amount_cents)
    why.push(`token cap ${tok.max_amount} < deal total ${deal.amount_cents} (cents)`);
  if (tok.expires_at !== null && tok.expires_at <= nowSec) why.push("token expired");
  return why;
}

/** Normalize the accepted credential shapes. */
export function parseCredential(c: PaymentCredential):
  { kind: "spt"; token: string } | { kind: "test_card"; pm: string } | { kind: "checkout"; session: string } {
  if (typeof c === "string") return { kind: "spt", token: c };
  if ("test_card" in c) return { kind: "test_card", pm: c.test_card };
  if ("checkout_session" in c) return { kind: "checkout", session: c.checkout_session };
  return { kind: "spt", token: c.credential.token };
}

/** Fields every result for a split / held charge carries. */
function splitResult(split: Split | null, pi: { id: string; status: string }): Partial<PaymentResult> {
  const held = pi.status === "requires_capture";
  return {
    ...(split ? { split: { seller_cents: split.seller_cents, platform_fee_cents: split.fee_cents } } : {}),
    ...(held ? { held: true, pickup_code: pickupCode(pi.id) } : {}),
  };
}

/**
 * A Checkout Session the buyer completed: it counts as payment for this deal only if it was created for this deal,
 * for exactly the stored total, and Stripe holds or has captured the money. Nothing is charged here.
 */
async function verifyCheckout(deal: Deal, session_id: string): Promise<PaymentResult> {
  const base = { deal_id: deal.deal_id, amount_cents: deal.amount_cents, mode: "checkout" } as const;
  let cs: Stripe.Checkout.Session;
  try { cs = await stripe().checkout.sessions.retrieve(session_id, { expand: ["payment_intent", "payment_intent.payment_method"] }); }
  catch (e) { return { ...base, status: "refused", reasons: [`could not read checkout session: ${(e as Error).message}`] }; }
  const why: string[] = [];
  if (cs.metadata?.deal_id !== deal.deal_id) why.push("checkout session was created for a different deal");
  if (cs.amount_total !== deal.amount_cents) why.push(`checkout total ${cs.amount_total} != deal total ${deal.amount_cents} (cents)`);
  if (cs.status !== "complete") why.push(`checkout is ${cs.status}, not complete`);
  const pi = cs.payment_intent as Stripe.PaymentIntent | null;
  if (!pi || !["requires_capture", "succeeded", "processing"].includes(pi.status)) why.push(`payment is ${pi?.status ?? "missing"}`);
  if (why.length) return { ...base, status: "refused", reasons: why, fix: "open the deal's approve link again to get a fresh checkout" };
  const fee = pi!.application_fee_amount ?? 0;
  const pm = pi!.payment_method as Stripe.PaymentMethod | null;
  const split: Split | null = pi!.transfer_data?.destination
    ? { account_id: String(pi!.transfer_data.destination), fee_cents: fee, seller_cents: pi!.amount - fee, hold: pi!.status === "requires_capture" }
    : null;
  return { ...base, status: pi!.status === "processing" ? "processing" : "succeeded", payment_intent_id: pi!.id,
    card: pm?.card ? `${pm.card.brand} ****${pm.card.last4}` : undefined, ...splitResult(split, pi!) };
}

function auditMetadata(deal: Deal): Record<string, string> {
  return { deal_id: deal.deal_id, seller_id: deal.seller_id, policy: "approved", ...(deal.metadata ?? {}) };
}

export async function payDeal(deal: Deal, credential: PaymentCredential): Promise<PaymentResult> {
  if (!Number.isInteger(deal.amount_cents) || deal.amount_cents < 50) {
    return { status: "refused", deal_id: deal.deal_id, amount_cents: deal.amount_cents, mode: "spt",
      reasons: ["deal amount must be an integer number of cents and at least 50 (Stripe minimum)"] };
  }
  const cred = parseCredential(credential);
  if (cred.kind === "checkout") return verifyCheckout(deal, cred.session);
  const base = { deal_id: deal.deal_id, amount_cents: deal.amount_cents, mode: cred.kind } as const;
  const s = stripe();
  // Marketplace split: the seller's share goes to their connected account, our fee stays; held until pickup.
  const split = await splitFor(deal.seller_id, deal.amount_cents);

  let cardLabel: string | undefined;
  let paymentParams: Partial<Stripe.PaymentIntentCreateParams>;

  if (cred.kind === "spt") {
    let tok: Stripe.SharedPayment.GrantedToken;
    try {
      tok = await s.sharedPayment.grantedTokens.retrieve(cred.token);
    } catch (e) {
      const err = e as Stripe.errors.StripeError;
      return { ...base, status: "refused", reasons: [`could not read token: ${err.message}`],
        fix: "mint a new Shared Payment Token and retry with the same deal_id" };
    }
    const lim = tok.usage_limits;
    const why = lim
      ? precheckToken(deal, { currency: lim.currency, max_amount: lim.max_amount, expires_at: lim.expires_at,
          deactivated_reason: tok.deactivated_reason ?? null })
      : ["token has no usage limits"];
    if (why.length) {
      return { ...base, status: "refused", reasons: why,
        fix: `mint a new SPT with currency=${deal.currency}, max_amount=${deal.amount_cents}, then retry deal ${deal.deal_id}` };
    }
    const card = tok.payment_method_details?.card;
    cardLabel = card ? `${card.brand} ****${card.last4}` : undefined;
    paymentParams = { payment_method_data: { shared_payment_granted_token: cred.token } as Stripe.PaymentIntentCreateParams.PaymentMethodData };
  } else {
    paymentParams = { payment_method: cred.pm };
  }

  try {
    const pi = await s.paymentIntents.create(
      {
        amount: deal.amount_cents, // ALWAYS the server-side deal total
        currency: deal.currency,
        confirm: true,
        description: deal.description,
        metadata: auditMetadata(deal),
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        ...paymentParams,
        ...splitParams(split),
      },
      { idempotencyKey: `pay_deal-${deal.deal_id}-${cred.kind === "spt" ? cred.token : cred.pm}${split ? `-split-${split.hold ? "hold" : "now"}` : ""}` },
    );
    return {
      ...base,
      // Held (requires_capture) counts as paid for the deal: the money is secured, captured at pickup.
      status: pi.status === "succeeded" || pi.status === "requires_capture" ? "succeeded" : pi.status === "requires_action" ? "requires_action" : "processing",
      ...splitResult(split, pi),
      payment_intent_id: pi.id,
      card: cardLabel ?? (cred.kind === "test_card" ? "test card" : undefined),
      ...(pi.status === "requires_action" ? { fix: "buyer must complete authentication, then retry the same deal_id" } : {}),
    };
  } catch (e) {
    const err = e as Stripe.errors.StripeError;
    if (err.type === "StripeCardError") {
      return { ...base, status: "declined", code: err.decline_code ?? err.code, message: err.message,
        fix: "use a different payment method and retry the same deal_id" };
    }
    return { ...base, status: "error", code: err.code, message: err.message };
  }
}
