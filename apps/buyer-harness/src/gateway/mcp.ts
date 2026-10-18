/**
 * McpGateway: talks to the DEPLOYED gateway (S1) over MCP Streamable HTTP, exactly like ChatGPT/Claude would.
 * Use: --gateway https://dark-zero-mesv5.run.mcp-use.com/mcp   (or GATEWAY_URL)
 *
 * Shapes follow S1's published log (docs/live/s1.md, 10:16 pm):
 *   search_products({ q, category?, max_price_cents?, must_have?, run_id, buyer_id, buyer_model })
 *     → structuredContent { results: [{ listing: Listing, fit_note }], relaxed, note? }
 *   make_offer / accept_deal / check_offers / walk_away → E1's ExchangeResponse, passed through unchanged
 *   accept_deal({ negotiation_id, offer_id, buyer_id }): accept is by the live offer_id
 * Simulated buyers always send their own buyer_id (the gateway only mints anon_ ids when none is sent).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BuyerContext } from "@sa/shared";
import { NegotiationBook, type ExchangeLike } from "./exchange-map";
import type { Gateway, GwAcceptResult, GwListing, GwOfferArgs, GwOfferResult } from "./types";

export class McpGateway implements Gateway {
  readonly kind = "mcp" as const;
  readonly sellerEventsLogged = true; // the exchange behind the gateway logs seller events
  private client?: Client;
  private book = new NegotiationBook();

  /**
   * @param strategy seller strategy for eval A/B runs. S1 passes it through make_offer (#64) and E1 honours it only for a
   * signed eval run_id (signEvalRun, #62); for any other run_id it's ignored, so live buyers never set it.
   */
  constructor(private url: string, private strategy?: "static" | "negotiating" | "balanced") {}

  private async c(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: "sa-buyer-harness", version: "0.2.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
    return (this.client = client);
  }

  /** Call a tool; return structuredContent, else the first text block parsed as JSON. Throws on transport errors only. */
  private async call(name: string, args: Record<string, unknown>): Promise<any> {
    const res = (await (await this.c()).callTool({ name, arguments: args }, undefined, { timeout: 15_000 })) as {
      structuredContent?: unknown; content?: { type: string; text?: string }[]; isError?: boolean;
    };
    if (res.structuredContent) return res.structuredContent;
    const text = res.content?.find((b) => b.type === "text")?.text ?? "";
    try { return JSON.parse(text); } catch { return { ok: !res.isError, message: text }; }
  }

  private ids(ctx: BuyerContext) {
    return { run_id: ctx.run_id, buyer_id: ctx.buyer_id, buyer_model: ctx.buyer_model };
  }

  private static listing(l: any): GwListing {
    return { product_id: l.id ?? l.product_id, seller_name: l.seller_name ?? "", title: l.title, description: l.description ?? "",
      specs: l.specs ?? {}, list_price_cents: l.list_price_cents, shipping_days: l.shipping_days ?? 0, negotiable: l.negotiable ?? true,
      extras: l.extras ?? l.allowed_levers ?? l.levers };
  }

  async search(ctx: BuyerContext, query: string, max_price_cents?: number, must_have?: string[]): Promise<GwListing[]> {
    const out = await this.call("search_products", { ...this.ids(ctx), q: query, max_price_cents, must_have });
    const rows: any[] = out.results ?? out.listings ?? [];
    return rows.map((r) => McpGateway.listing(r.listing ?? r));
  }

  async getListing(ctx: BuyerContext, product_id: string) {
    try {
      const l = await this.call("get_listing", { ...this.ids(ctx), product_id });
      return l?.title ? McpGateway.listing(l.listing ?? l) : null;
    } catch {
      return null;
    }
  }

  async ask(ctx: BuyerContext, product_id: string, question: string) {
    const a = await this.call("ask_question", { ...this.ids(ctx), product_id, question });
    return { answer: String(a.answer ?? a.message ?? ""), grounded: Boolean(a.grounded) };
  }

  async offer(ctx: BuyerContext, a: GwOfferArgs): Promise<GwOfferResult> {
    const resp = (await this.call("make_offer", { ...this.ids(ctx), product_id: a.product_id, negotiation_id: a.negotiation_id,
      offer_price_cents: a.offer_price_cents, quantity: 1, message: a.message, levers: a.levers,
      ...(this.strategy ? { strategy: this.strategy } : {}) })) as ExchangeLike;
    return this.book.record(resp, a.product_id, a.offer_price_cents);
  }

  async accept(ctx: BuyerContext, negotiation_id: string): Promise<GwAcceptResult> {
    const n = this.book.pending(negotiation_id);
    if (!n) return { ok: false, error: "unknown negotiation_id" };
    if (n.deal) return { ok: true, deal_id: n.deal.deal_id, final_price_cents: n.deal.unit_price_cents, product_id: n.deal.product_id };
    if (!n.offer_id) return { ok: false, error: "the seller has no live offer to accept yet" };
    const resp = (await this.call("accept_deal", { ...this.ids(ctx), negotiation_id, offer_id: n.offer_id })) as ExchangeLike;
    return this.book.acceptResult(resp, negotiation_id);
  }

  async close() {
    await this.client?.close();
  }
}
