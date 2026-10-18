/**
 * SPIKE (spike/a2a-primitive): A2AGateway — the buyer reaches a seller agent over A2A JSON-RPC (`message/send`)
 * instead of the MCP gateway. Discovery: GET <base>/.well-known/agent-card.json → card.url.
 * Each call is one A2A message with a DataPart {skill, args}; contextId = buyer_id, so the seller keeps
 * the negotiation per buyer. The reply's DataPart is E1's ExchangeResponse, mapped by the shared NegotiationBook.
 */
import { randomUUID } from "node:crypto";
import type { BuyerContext } from "@sa/shared";
import { NegotiationBook, type ExchangeLike } from "./exchange-map";
import type { Gateway, GwAcceptResult, GwListing, GwOfferArgs, GwOfferResult } from "./types";

type Part = { kind?: string; text?: string; data?: unknown };

export class A2AGateway implements Gateway {
  readonly kind = "exchange" as const; // Gateway.kind is a frozen union; A2A rides as an exchange-backed gateway
  readonly sellerEventsLogged = true;
  private book = new NegotiationBook();
  private endpoint: string | null = null;
  constructor(private base: string) {}

  private async url() {
    if (!this.endpoint) {
      const card = (await (await fetch(new URL("/.well-known/agent-card.json", this.base))).json()) as { url: string };
      this.endpoint = card.url;
    }
    return this.endpoint;
  }

  async send(ctx: BuyerContext, skill: string, args: Record<string, unknown>): Promise<{ text: string; data: unknown }> {
    const res = await fetch(await this.url(), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "message/send",
        params: { message: { kind: "message", messageId: randomUUID(), contextId: ctx.buyer_id, role: "user", parts: [{ kind: "data", data: { skill, args } }] } } }) });
    const j = (await res.json()) as { result?: { parts: Part[] }; error?: { message: string } };
    if (j.error) throw new Error(`A2A ${skill}: ${j.error.message}`);
    const parts = j.result?.parts ?? [];
    return { text: parts.find((p) => p.text)?.text ?? "", data: parts.find((p) => p.data)?.data };
  }

  async search(ctx: BuyerContext, query: string, max?: number): Promise<GwListing[]> {
    const { data } = await this.send(ctx, "search_products", { query });
    return ((data as { results: GwListing[] }).results ?? []).filter((l) => max === undefined || l.list_price_cents <= max);
  }
  async getListing(ctx: BuyerContext, product_id: string) {
    const { data } = await this.send(ctx, "get_listing", { product_id });
    return data && !(data as { error?: string }).error ? (data as GwListing) : null;
  }
  async ask(_ctx: BuyerContext, _product_id: string, _question: string) {
    return { answer: "ask_question is not exposed by the A2A spike seller", grounded: false };
  }
  async offer(ctx: BuyerContext, a: GwOfferArgs): Promise<GwOfferResult> {
    const { data } = await this.send(ctx, "make_offer", { product_id: a.product_id, negotiation_id: a.negotiation_id, offer_price_cents: a.offer_price_cents, message: a.message });
    return this.book.record(data as ExchangeLike, a.product_id, a.offer_price_cents);
  }
  async accept(ctx: BuyerContext, negotiation_id: string): Promise<GwAcceptResult> {
    const n = this.book.pending(negotiation_id);
    if (n?.deal) return { ok: true, deal_id: n.deal.deal_id, final_price_cents: n.deal.unit_price_cents, product_id: n.deal.product_id };
    if (!n?.offer_id) return { ok: false, error: "no live offer to accept" };
    const { data } = await this.send(ctx, "accept_deal", { negotiation_id, offer_id: n.offer_id });
    return this.book.acceptResult(data as ExchangeLike, negotiation_id);
  }
}
