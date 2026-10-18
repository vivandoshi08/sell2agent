/**
 * McpGateway: talks to the DEPLOYED gateway (S1) over MCP Streamable HTTP, exactly like ChatGPT/Claude would.
 * Use: GATEWAY_URL=https://<manufact-deploy>/mcp pnpm buyers ...
 *
 * Tool names + argument shapes follow packages/shared (TOOL_NAMES, *Input). `search_products` isn't in the
 * frozen contract yet. TODO(at Bridge 2): check its argument/response shape against S1's server.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AcceptDealOutput, MakeOfferOutput, TOOL_NAMES, type BuyerContext } from "@sa/shared";
import type { Gateway, GwAcceptResult, GwListing, GwOfferResult } from "./types";

export class McpGateway implements Gateway {
  readonly kind = "mcp" as const;
  private client?: Client;

  constructor(private url: string) {}

  private async c(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: "sa-buyer-harness", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
    return (this.client = client);
  }

  /** Call a tool and return its JSON payload (structuredContent, else first text block parsed as JSON). */
  private async call(name: string, args: Record<string, unknown>): Promise<any> {
    const res = (await (await this.c()).callTool({ name, arguments: args }, undefined, { timeout: 15_000 })) as {
      structuredContent?: unknown; content?: { type: string; text?: string }[]; isError?: boolean;
    };
    const text = res.content?.find((b) => b.type === "text")?.text ?? "";
    if (res.isError) throw new Error(`${name} failed: ${text.slice(0, 300)}`);
    if (res.structuredContent) return res.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }

  async search(ctx: BuyerContext, query: string, max_price_cents?: number): Promise<GwListing[]> {
    const out = await this.call("search_products", { ...ctx, q: query, query, max_price_cents });
    const raw: any[] = out.listings ?? out.results ?? [];
    return raw.map((l) => ({
      product_id: l.id ?? l.product_id, seller_name: l.seller_name ?? "", title: l.title, description: l.description ?? "",
      specs: l.specs ?? {}, list_price_cents: l.list_price_cents, shipping_days: l.shipping_days ?? 0, negotiable: l.negotiable ?? true,
    }));
  }

  async getListing(ctx: BuyerContext, product_id: string) {
    try {
      const l = await this.call(TOOL_NAMES.getListing, { ...ctx, product_id });
      return { product_id: l.id ?? product_id, seller_name: l.seller_name ?? "", title: l.title, description: l.description ?? "",
        specs: l.specs ?? {}, list_price_cents: l.list_price_cents, shipping_days: l.shipping_days ?? 0, negotiable: true };
    } catch {
      return null;
    }
  }

  async ask(ctx: BuyerContext, product_id: string, question: string) {
    const a = await this.call(TOOL_NAMES.askQuestion, { ...ctx, product_id, question });
    return { answer: String(a.answer ?? a.message ?? ""), grounded: Boolean(a.grounded) };
  }

  async offer(ctx: BuyerContext, a: { product_id: string; negotiation_id?: string; offer_price_cents: number; message?: string }): Promise<GwOfferResult> {
    const raw = await this.call(TOOL_NAMES.makeOffer, { ...ctx, ...a, quantity: 1 });
    const o = MakeOfferOutput.passthrough().parse(raw);
    return { negotiation_id: o.negotiation_id, status: o.status, price_cents: o.price_cents, round: o.round,
      rounds_left: o.rounds_left, final: Boolean((raw as any).final ?? o.rounds_left === 0), message: o.message };
  }

  async accept(ctx: BuyerContext, negotiation_id: string): Promise<GwAcceptResult> {
    try {
      const raw = await this.call(TOOL_NAMES.acceptDeal, { ...ctx, negotiation_id });
      const d = AcceptDealOutput.partial({ stripe_payment_intent_id: true, quantity: true }).passthrough().parse(raw);
      return { ok: true, deal_id: d.deal_id, final_price_cents: d.final_price_cents, product_id: String((raw as any).product_id ?? "") };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async close() {
    await this.client?.close();
  }
}
