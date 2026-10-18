/**
 * S2-owned. Adapts E1's real exchange (`import { Exchange } from "@sa/seller-mcp/exchange"`) to S2's DealSource.
 * Structural types only, so this folder doesn't depend on @sa/seller-mcp; the gateway passes the instance in:
 *
 *   const ex = await Exchange.fromEnv();                        // or new Exchange()
 *   const deal = createDealModule({ deals: fromExchange(ex), catalog });   // catalog: S1's public listings, optional
 *
 * Mapping (E1 → S2): status locked/paid/expired → AGREED/PAID/EXPIRED; levers string[] → { name }.
 */
import type { BuyerContext } from "@sa/shared";
import type { DealSource, StoredDeal, Validation, ValidationCode } from "./types";

/** The slice of E1's LockedDeal that S2 reads. */
export interface E1LockedDeal {
  deal_id: string; negotiation_id: string; buyer_id: string; seller_id: string; product_id: string; title: string;
  quantity: number; unit_price_cents: number; total_cents: number; list_price_cents: number; levers: string[];
  expires_at: string; status: "locked" | "paid" | "expired"; payment_intent_id?: string;
}

export interface ExchangeLike {
  deals: {
    getLockedDeal(deal_id: string): Promise<E1LockedDeal | null>;
    validateForPayment(deal_id: string, buyer_id: string, amount_cents?: number):
      Promise<{ ok: true; deal: E1LockedDeal } | { ok: false; code: string; reason: string; fix?: string; payment_intent_id?: string }>;
  };
  markPaid(deal_id: string, payment_intent_id: string): Promise<void>;
}

const STATE = { locked: "AGREED", paid: "PAID", expired: "EXPIRED" } as const;
const KNOWN: ValidationCode[] = ["unknown_deal", "expired", "already_paid", "wrong_buyer", "tampered", "not_payable", "amount_mismatch", "policy_recheck_failed"];

export function toStoredDeal(d: E1LockedDeal): StoredDeal {
  return {
    deal_id: d.deal_id, negotiation_id: d.negotiation_id, buyer_id: d.buyer_id, seller_id: d.seller_id, product_id: d.product_id,
    quantity: d.quantity, unit_price_cents: d.unit_price_cents, total_cents: d.total_cents,
    levers: d.levers.map((name) => ({ name })), expires_at: d.expires_at, state: STATE[d.status] ?? "ESCALATED",
    title: d.title, list_price_cents: d.list_price_cents,
  };
}

export function fromExchange(ex: ExchangeLike): DealSource {
  return {
    async getDeal(deal_id) {
      const d = await ex.deals.getLockedDeal(deal_id);
      return d ? toStoredDeal(d) : null;
    },
    async validateForPayment(deal_id, buyer: Partial<BuyerContext> | undefined): Promise<Validation> {
      if (!buyer?.buyer_id) {
        return { ok: false, code: "wrong_buyer", reason: "pay_deal was called without the buyer_id that accepted the deal",
          fix: "call pay_deal with the same buyer_id (and run_id) used for accept_deal" };
      }
      // No amount is passed: S2 never takes an amount from the caller, it charges the stored total.
      const r = await ex.deals.validateForPayment(deal_id, buyer.buyer_id);
      if (r.ok) return { ok: true, deal: toStoredDeal(r.deal) };
      const code = (KNOWN as string[]).includes(r.code) ? (r.code as ValidationCode) : "not_payable";
      return { ok: false, code, reason: r.reason, fix: r.fix, payment_intent_id: r.payment_intent_id };
    },
    markPaid: (deal_id, pi) => ex.markPaid(deal_id, pi),
  };
}
