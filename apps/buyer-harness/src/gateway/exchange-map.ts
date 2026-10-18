/**
 * Translate E1's ExchangeResponse (what the exchange returns, and what S1's gateway passes through unchanged)
 * into the harness's GwOfferResult / GwAcceptResult. Shared by ExchangeGateway (in-process) and McpGateway (deployed).
 * Also remembers, per negotiation, the live offer_id and any locked deal, because accept_deal needs the offer_id.
 */
import type { GwAcceptResult, GwOfferResult } from "./types";

/** The parts of E1's ExchangeResponse the harness reads (structural, so it also fits the JSON from MCP). */
export interface ExchangeLike {
  ok: boolean;
  negotiation_id?: string;
  status?: "counter" | "accept" | "reject" | "walked" | "info";
  standing_offer?: { offer_id: string; price_cents: number; final: boolean; levers?: string[]; expires_at?: string };
  deal?: { deal_id: string; product_id: string; unit_price_cents: number; total_cents?: number };
  round?: number;
  rounds_left?: number;
  message: string;
  error?: { code: string; message: string };
}

export class NegotiationBook {
  private live = new Map<string, { offer_id?: string; price?: number; product_id: string; deal?: ExchangeLike["deal"] }>();

  record(resp: ExchangeLike, product_id: string, buyerBid: number): GwOfferResult {
    const id = resp.negotiation_id ?? "";
    const prev = this.live.get(id);
    const so = resp.standing_offer;
    const price = resp.deal?.unit_price_cents ?? so?.price_cents ?? prev?.price ?? buyerBid;
    this.live.set(id, { offer_id: so?.offer_id ?? prev?.offer_id, price, product_id, deal: resp.deal ?? prev?.deal });
    const status: GwOfferResult["status"] = resp.ok && resp.status === "accept" ? "accept" : resp.ok && resp.status === "counter" ? "counter" : "reject";
    const err = !resp.ok && resp.error ? ` [${resp.error.code}]` : "";
    return { negotiation_id: id, status, price_cents: price, round: resp.round ?? 0, rounds_left: resp.rounds_left ?? 0,
      final: so?.final ?? (resp.rounds_left ?? 1) === 0, message: `${resp.message}${err}` };
  }

  /** What accept_deal needs: the live offer_id, or the deal the seller already locked by accepting our bid. */
  pending(negotiation_id: string) {
    return this.live.get(negotiation_id);
  }

  acceptResult(resp: ExchangeLike, negotiation_id: string): GwAcceptResult {
    const n = this.live.get(negotiation_id);
    if (resp.ok && resp.deal) {
      if (n) n.deal = resp.deal;
      return { ok: true, deal_id: resp.deal.deal_id, final_price_cents: resp.deal.unit_price_cents, product_id: resp.deal.product_id };
    }
    return { ok: false, error: resp.error ? `${resp.error.code}: ${resp.error.message}` : resp.message || "accept failed" };
  }
}
