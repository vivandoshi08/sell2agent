/**
 * S2-owned. The pay_deal handler: Approve & Pay on the deal card ends here.
 *
 * Order (agreed with E1's plan): E1 validates → S2 charges the STORED amount → S2 logs.
 *  - The amount always comes from the exchange's stored deal, never from the tool call.
 *  - One successful payment per deal, whatever credential a retry brings. @sa/payments keys its
 *    Stripe idempotency on deal + credential, so a retry with a different card would be a second
 *    charge; this handler blocks that.
 */
import type { BuyerContext, NegotiationEvent } from "@sa/shared";
import type { Deal, PaymentCredential, PaymentResult } from "@sa/payments";
import type { DealSource, PayResult, StoredDeal } from "./types";

export interface PayDeps {
  deals: DealSource;
  payDeal: (deal: Deal, credential: PaymentCredential) => Promise<PaymentResult>;
  logEvent: (e: NegotiationEvent) => Promise<void>;
  /** Credential used when the card sends none. Test mode only: the human approving on the card is the consent. */
  defaultCredential: () => PaymentCredential | null;
  /** Where results live between calls. In-memory is fine for one gateway process. */
  results?: Map<string, PayResult>;
}

export interface PayContext {
  buyer?: Partial<BuyerContext>;
  run_id?: string;
}

const FIXES: Record<string, string> = {
  unknown_deal: "call accept_deal to lock a deal, then review_deal with the deal_id it returns",
  expired: "the offer expired; make a new offer to get a fresh deal",
  already_paid: "this deal is already paid; nothing more to do",
  wrong_buyer: "only the buyer who accepted this deal can pay for it",
  tampered: "the deal changed after it was locked; accept the current offer again",
  not_payable: "this deal can't be paid in its current state; check_offers for the live offer",
};

function toPaymentsDeal(d: StoredDeal): Deal {
  return {
    deal_id: d.deal_id,
    amount_cents: d.total_cents,
    currency: "usd",
    description: `${d.product_id} × ${d.quantity} (negotiated)`,
    seller_id: d.seller_id,
    metadata: { negotiation_id: d.negotiation_id, buyer_id: d.buyer_id, product_id: d.product_id, lane: "s2" },
  };
}

export function createPayHandler(deps: PayDeps) {
  const results = deps.results ?? new Map<string, PayResult>();
  const inFlight = new Map<string, Promise<PayResult>>();

  async function log(type: "payment_succeeded" | "payment_failed", deal: StoredDeal | null, deal_id: string, r: PayResult, ctx: PayContext) {
    try {
      await deps.logEvent({
        run_id: ctx.run_id ?? ctx.buyer?.run_id ?? "live",
        buyer_id: deal?.buyer_id ?? ctx.buyer?.buyer_id ?? null,
        buyer_model: ctx.buyer?.buyer_model ?? null,
        seller_id: deal?.seller_id ?? null,
        product_id: deal?.product_id ?? null,
        negotiation_id: deal?.negotiation_id ?? null,
        actor: "seller",
        type,
        price_cents: r.amount_cents || null,
        payload: { deal_id, payment_intent_id: r.payment_intent_id ?? null, mode: r.mode, status: r.status, reasons: r.reasons ?? [] },
      });
    } catch (e) {
      // Logging must never break a payment response.
      console.error("[pay_deal] logEvent failed", (e as Error).message);
    }
  }

  async function run(deal_id: string, credential: PaymentCredential | undefined, ctx: PayContext): Promise<PayResult> {
    const prior = results.get(deal_id);
    if (prior && (prior.status === "succeeded" || prior.status === "processing")) return { ...prior, already_paid: true };

    const cred = credential ?? deps.defaultCredential();
    if (!cred) {
      return { status: "refused", deal_id, amount_cents: 0, mode: "spt",
        reasons: ["no payment credential was provided"],
        fix: "pass a Shared Payment Token capped at the deal total, or set STRIPE_PAYMENT_MODE=test_card for test mode" };
    }

    const check = await deps.deals.validateForPayment(deal_id, ctx.buyer, cred);
    if (!check.ok) {
      const r: PayResult = { status: "refused", deal_id, amount_cents: 0, mode: typeof cred === "object" && "test_card" in cred ? "test_card" : "spt",
        code: check.code, reasons: [check.reason], fix: FIXES[check.code] };
      await log("payment_failed", null, deal_id, r, ctx);
      return r;
    }

    const result: PayResult = await deps.payDeal(toPaymentsDeal(check.deal), cred);
    results.set(deal_id, result);
    // "processing" is confirmed later by the Stripe webhook, so it isn't logged as a success yet.
    if (result.status === "succeeded") await log("payment_succeeded", check.deal, deal_id, result, ctx);
    else if (result.status !== "processing") await log("payment_failed", check.deal, deal_id, result, ctx);
    return result;
  }

  /** Concurrent double-clicks share one attempt instead of racing two charges. */
  return async function payApprovedDeal(deal_id: string, credential?: PaymentCredential, ctx: PayContext = {}): Promise<PayResult> {
    const pending = inFlight.get(deal_id);
    if (pending) return pending;
    const p = run(deal_id, credential, ctx).finally(() => inFlight.delete(deal_id));
    inFlight.set(deal_id, p);
    return p;
  };
}
