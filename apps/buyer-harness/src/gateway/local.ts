/**
 * LocalGateway: an in-process stand-in for the deployed gateway + E1's exchange.
 * Three keyboard sellers (from supabase/seed.sql), each running E2's decide() + voice().
 * This is a MOCK: E1's real exchange adds guardrails, sessions in Supabase, offer ids, expiry.
 */
import { randomUUID } from "node:crypto";
import type { BuyerContext } from "@sa/shared";
import { decide, voice, answerQuestion, type Llm, type PolicyName, type SellerState } from "@sa/seller-mcp/sellers";
import { CATALOG, byId } from "../scripted/catalog";
import type { Gateway, GwAcceptResult, GwListing, GwOfferResult } from "./types";

const SELLER_NAMES: Record<string, string> = {
  kb_keyforge_quiet75: "KeyForge",
  kb_clackco_tkl: "ClackCo",
  kb_typewell_65: "TypeWell",
};

interface Negotiation {
  id: string;
  product_id: string;
  round: number;
  history: SellerState["history"];
  standing?: number; // seller's current offer
  agreed?: number; // seller accepted the buyer's price
  closed: boolean;
}

export class LocalGateway implements Gateway {
  readonly kind = "local" as const;
  private negs = new Map<string, Negotiation>();

  /** @param policy seller policy for every seller; @param sellerLlm voice model (null = templates, fast + free) */
  constructor(private policy: PolicyName, private sellerLlm: Llm | null = null) {}

  private listing(product_id: string): GwListing {
    const c = byId(product_id);
    return { ...c.public, seller_name: SELLER_NAMES[product_id] ?? "Seller", negotiable: this.policy !== "static" };
  }

  async search(_ctx: BuyerContext, query: string, max_price_cents?: number): Promise<GwListing[]> {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const all = CATALOG.map((c) => this.listing(c.terms.product_id)).filter(
      (l) => max_price_cents === undefined || l.list_price_cents <= max_price_cents * 1.25,
    );
    const score = (l: GwListing) => {
      const text = `${l.title} ${l.description} ${Object.entries(l.specs).join(" ")}`.toLowerCase();
      return words.filter((w) => text.includes(w)).length;
    };
    return all.sort((a, b) => score(b) - score(a)).slice(0, 5); // short list (Magentic: 3–5)
  }

  async getListing(_ctx: BuyerContext, product_id: string) {
    return CATALOG.some((c) => c.terms.product_id === product_id) ? this.listing(product_id) : null;
  }

  async ask(_ctx: BuyerContext, product_id: string, question: string) {
    const a = await answerQuestion(byId(product_id).public, question, this.sellerLlm);
    return { answer: a.answer, grounded: a.grounded };
  }

  private key(ctx: BuyerContext, product_id: string) {
    return `${ctx.run_id}:${ctx.buyer_id}:${product_id}`;
  }

  async offer(ctx: BuyerContext, a: { product_id: string; offer_price_cents: number; message?: string }): Promise<GwOfferResult> {
    const { terms } = byId(a.product_id);
    const k = this.key(ctx, a.product_id);
    let n = this.negs.get(k);
    if (!n) this.negs.set(k, (n = { id: `neg_${randomUUID().slice(0, 8)}`, product_id: a.product_id, round: 0, history: [], closed: false }));

    if (n.closed || n.round >= terms.max_rounds) {
      return { negotiation_id: n.id, status: "reject", price_cents: n.agreed ?? n.standing ?? terms.list_price_cents,
        round: n.round, rounds_left: 0, final: true,
        message: "This negotiation has used all its rounds. You can still accept our last offer with accept_deal." };
    }
    n.round++;
    const state: SellerState = { round: n.round, terms, history: [...n.history], buyer_offer_cents: a.offer_price_cents };
    const move = decide(state, { name: this.policy });
    n.history.push({ by: "buyer", round: n.round, price_cents: a.offer_price_cents });
    const v = await voice(move, { terms, prior_prices_cents: n.history.map((h) => h.price_cents), buyer_message: a.message }, this.sellerLlm);

    if (move.action === "accept") n.agreed = move.price_cents;
    else {
      n.history.push({ by: "seller", round: n.round, price_cents: move.price_cents });
      n.standing = move.price_cents;
    }
    return { negotiation_id: n.id, status: move.action === "accept" ? "accept" : "counter", price_cents: move.price_cents,
      round: n.round, rounds_left: terms.max_rounds - n.round, final: move.final, message: v.message };
  }

  async accept(_ctx: BuyerContext, negotiation_id: string): Promise<GwAcceptResult> {
    const n = [...this.negs.values()].find((x) => x.id === negotiation_id);
    if (!n) return { ok: false, error: "unknown negotiation_id" };
    if (n.closed) return { ok: false, error: "this negotiation is already closed" };
    const price = n.agreed ?? n.standing;
    if (price === undefined) return { ok: false, error: "there is no offer from the seller to accept yet; make an offer first" };
    n.closed = true;
    return { ok: true, deal_id: `deal_${randomUUID().slice(0, 8)}`, final_price_cents: price, product_id: n.product_id };
  }

  /** For KPIs: the seller's unit cost (profit = price − cost). Not exposed to buyers. */
  static unitCost(product_id: string) {
    return byId(product_id).terms.unit_cost_cents;
  }
}
