// review_deal and pay_deal: thin MCP wrappers over S2's deal module (src/deal/, Ananya), backed by the same
// E1 exchange instance as the negotiation tools, so a deal locked by accept_deal is the one the card shows and charges.
// The amount always comes from the exchange's stored deal; nothing here takes a price from the caller.
import { z } from "zod";
import { createDealModule, dealSummary, fromExchange, type CatalogSource } from "./deal/index.js";
import { PRODUCTS, SELLERS } from "./catalog.js";
import { exchange, toCtx, type RequestLike } from "./negotiate.js";

// Public catalog facts for the card (seller name). Never seller policy.
const catalog: CatalogSource = {
  async getProduct(product_id) {
    const p = PRODUCTS.find((x) => x.id === product_id);
    if (!p) return null;
    const seller = SELLERS.find((s) => s.id === p.seller_id);
    return { product_id: p.id, title: p.title, list_price_cents: p.list_price_cents, seller_name: seller?.name ?? p.seller_id };
  },
};

let dealP: ReturnType<typeof makeDeal> | undefined;
async function makeDeal() {
  return createDealModule({ deals: fromExchange(await exchange()), catalog });
}
const deal = () => (dealP ??= makeDeal());

const ctxFields = {
  run_id: z.string().optional().describe("Eval run id (simulated buyers only)"),
  buyer_model: z.string().optional().describe("Buyer model name, if known"),
};

// Mirrors S2's DealCard (src/deal/types.ts); the deal-card view reads structuredContent typed by this.
const dealCardSchema = z.object({
  deal_id: z.string(),
  seller_name: z.string(),
  product: z.object({ id: z.string(), title: z.string() }),
  quantity: z.number().int(),
  list_unit_price_cents: z.number().int(),
  unit_price_cents: z.number().int(),
  list_total_cents: z.number().int(),
  total_cents: z.number().int(),
  savings_cents: z.number().int(),
  levers: z.array(z.object({ name: z.string(), label: z.string() })),
  expires_at: z.string(),
  status: z.enum(["ready", "paid", "expired", "unavailable"]),
  test_mode: z.literal(true),
});

const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

// biome-ignore lint: server type comes from mcp-use
export function registerDealTools(server: any) {
  server.tool(
    {
      name: "review_deal",
      title: "Review the deal",
      description:
        "Show a locked deal as a card the person can approve: product, included extras, negotiated vs. list price, expiry. Call after accept_deal with its deal_id. Nothing is charged until the person approves.",
      inputSchema: z.object({
        deal_id: z.string().describe("deal.deal_id from accept_deal"),
        buyer_id: z.string().optional().describe("The buyer_id that accepted the deal (from accept_deal)"),
        ...ctxFields,
      }),
      outputSchema: dealCardSchema,
      view: { name: "deal-card", description: "Deal card with Approve & Pay", prefersBorder: true },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a: { deal_id: string }) => {
      try {
        const card = await (await deal()).reviewDeal(a.deal_id);
        return { content: [{ type: "text" as const, text: dealSummary(card) }], structuredContent: card };
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    {
      name: "pay_deal",
      title: "Approve and pay",
      description:
        "Pay for a locked deal after the person approves it (Stripe test mode). Charges exactly the stored deal total, at most once per deal. Send the same buyer_id that accepted the deal.",
      inputSchema: z.object({
        deal_id: z.string().describe("deal.deal_id from accept_deal"),
        buyer_id: z.string().optional().describe("The buyer_id that accepted the deal (from accept_deal)"),
        payment_token: z.string().optional().describe("Payment token from the buyer's wallet, if any"),
        ...ctxFields,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (a: { deal_id: string; buyer_id?: string; payment_token?: string; run_id?: string; buyer_model?: string }, rc?: RequestLike) => {
      try {
        const ctx = toCtx(a, rc);
        const r = await (await deal()).payApprovedDeal(a.deal_id, a.payment_token, { buyer: ctx, run_id: ctx.run_id });
        const text = r.status === "succeeded" ? `Paid ${r.payment_intent_id ?? ""} (Stripe test mode).`.trim()
          : `Payment ${r.status}.${r.reasons?.length ? ` ${r.reasons.join(" ")}` : ""}${r.fix ? ` Fix: ${r.fix}` : ""}`;
        return { content: [{ type: "text" as const, text }], structuredContent: r };
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
