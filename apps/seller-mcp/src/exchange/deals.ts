/**
 * E1 · Deal lock + payment validator (E9 DealStore, ported). Deals are created only by the exchange from an
 * approved offer, HMAC-signed, immutable. S2's pay handler calls validateForPayment() before payDeal() and
 * markPaid() after. The amount always comes from the stored deal, never from a tool call.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ExchangeStore } from "./store";
import { leverCost } from "./probing";
import type { Catalog, LockedDeal } from "./types";

const SECRET = process.env.EXCHANGE_HMAC_SECRET ?? randomBytes(32).toString("hex");
if (!process.env.EXCHANGE_HMAC_SECRET && process.env.NODE_ENV === "production")
  console.warn("[exchange] EXCHANGE_HMAC_SECRET unset: deal signatures won't survive a restart");

type Unsigned = Omit<LockedDeal, "signature" | "status" | "payment_intent_id">;
const SIGNED_KEYS: (keyof Unsigned)[] = ["deal_id", "negotiation_id", "offer_id", "buyer_id", "seller_id", "product_id", "title",
  "quantity", "unit_price_cents", "total_cents", "list_price_cents", "levers", "currency", "expires_at"];

export function sign(d: Unsigned): string {
  const body = JSON.stringify(SIGNED_KEYS.map((k) => d[k]));
  return createHmac("sha256", SECRET).update(body).digest("hex");
}
export function verify(d: LockedDeal): boolean {
  const a = Buffer.from(sign(d), "hex");
  const b = Buffer.from(d.signature ?? "", "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const DEAL_TTL_MS = 30 * 60_000;

export function lockDeal(fields: Omit<Unsigned, "deal_id" | "total_cents" | "currency" | "expires_at">, now: number): LockedDeal {
  const u: Unsigned = { ...fields, deal_id: `deal_${randomUUID()}`, total_cents: fields.unit_price_cents * fields.quantity,
    currency: "usd", expires_at: new Date(now + DEAL_TTL_MS).toISOString() };
  return Object.freeze({ ...u, status: "locked", signature: sign(u) }) as LockedDeal;
}

export type PaymentCheck =
  | { ok: true; deal: LockedDeal }
  | { ok: false; code: "unknown_deal" | "tampered" | "expired" | "already_paid" | "wrong_buyer" | "amount_mismatch" | "policy_recheck_failed";
      reason: string; fix?: string; payment_intent_id?: string };

export class Deals {
  constructor(private store: ExchangeStore, private catalog: Catalog, private now: () => number = Date.now,
    private onAbandoned: (product_id: string, negotiation_id: string) => unknown = () => {}) {}

  /** S2: the deal card + pay handler read the deal from here. */
  async getLockedDeal(deal_id: string): Promise<LockedDeal | null> {
    const d = await this.store.getDeal(deal_id);
    return d && verify(d) ? d : null;
  }

  /** S2: call before payDeal(). `amount_cents` (optional) is whatever the tool call claimed; it must match. */
  async validateForPayment(deal_id: string, buyer_id: string, amount_cents?: number): Promise<PaymentCheck> {
    const d = await this.store.getDeal(deal_id);
    if (!d) return { ok: false, code: "unknown_deal", reason: `no deal ${deal_id} was issued by this exchange`, fix: "accept a live offer first" };
    if (!verify(d)) return { ok: false, code: "tampered", reason: "deal record failed its signature check" };
    if (d.status === "paid") return { ok: false, code: "already_paid", reason: "deal is already paid", payment_intent_id: d.payment_intent_id };
    if (d.buyer_id !== buyer_id) return { ok: false, code: "wrong_buyer", reason: "deal belongs to a different buyer" };
    if (Date.parse(d.expires_at) <= this.now()) {
      await this.onAbandoned(d.product_id, d.negotiation_id); // E11 probe breaker: an abandoned deal closes the accept zone
      return { ok: false, code: "expired", reason: "deal expired", fix: "make a new offer" };
    }
    if (amount_cents !== undefined && amount_cents !== d.total_cents)
      return { ok: false, code: "amount_mismatch", reason: `amount ${amount_cents} does not match the deal total ${d.total_cents} (cents)`, fix: `pay ${d.total_cents}` };
    const p = await this.catalog.get(d.product_id);
    if (!p || d.unit_price_cents - leverCost(d.levers, p.lever_costs) < p.floor_price_cents)
      return { ok: false, code: "policy_recheck_failed", reason: "deal no longer passes the seller's policy" };
    return { ok: true, deal: d };
  }

  /** S2: after payDeal() succeeds. Idempotent for the same payment_intent_id. */
  async markPaid(deal_id: string, payment_intent_id: string): Promise<void> {
    const d = await this.store.getDeal(deal_id);
    if (!d || !verify(d)) throw new Error(`markPaid: unknown or tampered deal ${deal_id}`);
    if (d.status === "paid") {
      if (d.payment_intent_id === payment_intent_id) return;
      throw new Error(`markPaid: deal ${deal_id} already paid by ${d.payment_intent_id}`);
    }
    await this.store.putDeal({ ...d, status: "paid", payment_intent_id });
  }
}
