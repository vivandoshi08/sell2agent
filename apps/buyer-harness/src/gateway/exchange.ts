/**
 * ExchangeGateway: simulated buyers shop through E1's REAL exchange, in-process, the same way S1's deployed
 * gateway forwards make_offer / accept_deal to `Exchange.handle()`. Real offer_ids, real guardrails
 * (input guard, decision guard, output guard, probe breaker, start limit), E2's real decide() + voice().
 * Use when the deployed gateway isn't reachable (cloud workspaces), or to A/B seller strategies cheaply:
 *   new ExchangeGateway("negotiating" | "balanced" | "static", sellerLlm)
 * The exchange logs seller-side events itself; they're forwarded to the run's event log (attach()).
 */
import type { BuyerContext, NegotiationEvent } from "@sa/shared";
import { Exchange, StaticCatalog, SEED_PRODUCTS } from "@sa/seller-mcp/exchange";
import { answerQuestion, type BuyerLeverProfile, type Llm } from "@sa/seller-mcp/sellers";
import { LocalGateway } from "./local";
import { NegotiationBook, type ExchangeLike } from "./exchange-map";
import { byId } from "../scripted/catalog";
import type { Gateway, GwAcceptResult, GwOfferArgs, GwOfferResult } from "./types";

export type Strategy = "static" | "negotiating" | "balanced";

export class ExchangeGateway implements Gateway {
  readonly kind = "exchange" as const;
  readonly sellerEventsLogged = true;
  readonly exchange: Exchange;
  private book = new NegotiationBook();
  private emit: ((e: NegotiationEvent) => void) | null = null;
  private listings: LocalGateway; // public catalog + search (keyboards; same ids as the exchange's seed)

  /** @param opts.max_rounds override every product's round cap (E1's seed uses 3–4; PR #39 proposes 6). */
  constructor(public strategy: Strategy, private sellerLlm: Llm | null = null, opts: { max_rounds?: number } = {}) {
    this.exchange = new Exchange({
      catalog: new StaticCatalog(SEED_PRODUCTS, { strategy, ...(opts.max_rounds ? { max_rounds: opts.max_rounds } : {}) }),
      llm: sellerLlm,
      sink: async (e) => { this.emit?.(e); }, // → runAll's sink: jsonl + Supabase when configured
    });
    this.listings = new LocalGateway(strategy === "static" ? "static" : "negotiating", sellerLlm);
  }

  attach(emit: (e: NegotiationEvent) => void) {
    this.emit = emit;
  }

  search(ctx: BuyerContext, query: string, max?: number) {
    return this.listings.search(ctx, query, max);
  }
  getListing(ctx: BuyerContext, product_id: string) {
    return this.listings.getListing(ctx, product_id);
  }
  async ask(_ctx: BuyerContext, product_id: string, question: string) {
    const a = await answerQuestion(byId(product_id).public, question, this.sellerLlm);
    return { answer: a.answer, grounded: a.grounded };
  }

  async offer(ctx: BuyerContext, a: GwOfferArgs): Promise<GwOfferResult> {
    const resp = (await this.exchange.handle({ kind: "offer", ctx, product_id: a.product_id, negotiation_id: a.negotiation_id,
      offer_price_cents: a.offer_price_cents, message: a.message, buyer_profile: a.buyer_profile as BuyerLeverProfile })) as ExchangeLike;
    return this.book.record(resp, a.product_id, a.offer_price_cents);
  }

  async accept(ctx: BuyerContext, negotiation_id: string): Promise<GwAcceptResult> {
    const n = this.book.pending(negotiation_id);
    if (!n) return { ok: false, error: "unknown negotiation_id" };
    if (n.deal) return { ok: true, deal_id: n.deal.deal_id, final_price_cents: n.deal.unit_price_cents, product_id: n.deal.product_id };
    if (!n.offer_id) return { ok: false, error: "the seller has no live offer to accept yet" };
    const resp = (await this.exchange.handle({ kind: "accept", ctx, negotiation_id, offer_id: n.offer_id })) as ExchangeLike;
    return this.book.acceptResult(resp, negotiation_id);
  }
}
