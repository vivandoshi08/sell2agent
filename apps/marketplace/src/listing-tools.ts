// get_listing + ask_question: public product facts, and questions answered only from them (E2's answerQuestion).
// Answers are grounded or an honest "I don't know"; never a price promise (prices go through make_offer).
import { z } from "zod";
import { answerQuestion, defaultLlm } from "@sa/seller-mcp/sellers";
import { getListing } from "./search.js";
import { log } from "./log.js";

const ctxFields = {
  run_id: z.string().optional().describe("Eval run id (simulated buyers only)"),
  buyer_id: z.string().optional().describe("Your buyer_id, if you have one"),
  buyer_model: z.string().optional().describe("Buyer model name, if known"),
};

const notFound = (product_id: string) => ({
  content: [{ type: "text" as const, text: `Unknown product ${product_id}. Use search_products to find one.` }],
  structuredContent: { ok: false, error: { code: "unknown_product", message: `no product ${product_id}` } },
  isError: true,
});

export function registerListingTools(server: any, mcpUrl: string) {
  server.tool(
    {
      name: "get_listing",
      title: "Get listing",
      description: "Public facts for one product: specs, list price, shipping, stock. The price is negotiable through make_offer.",
      inputSchema: z.object({ product_id: z.string().describe("listing.id from search_products"), ...ctxFields }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a: { product_id: string }) => {
      const listing = getListing(a.product_id, mcpUrl);
      if (!listing) return notFound(a.product_id);
      const specs = Object.entries(listing.specs).map(([k, v]) => `${k}: ${v}`).join(", ");
      const text = `${listing.title} by ${listing.seller_name}: $${(listing.list_price_cents / 100).toFixed(2)} list, ships in ${listing.shipping_days} days, ${listing.in_stock ? "in stock" : "out of stock"}. ${listing.description} Specs: ${specs}.`;
      return { content: [{ type: "text", text }], structuredContent: listing };
    },
  );

  server.tool(
    {
      name: "ask_question",
      title: "Ask the seller a question",
      description: "Ask the seller's agent about one product. Answers come only from the product's catalog facts; if they don't cover it, the answer is \"I don't know\". Not for prices: negotiate with make_offer.",
      inputSchema: z.object({ product_id: z.string(), question: z.string().max(800), ...ctxFields }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a: { product_id: string; question: string; run_id?: string; buyer_id?: string; buyer_model?: string }) => {
      const listing = getListing(a.product_id, mcpUrl);
      if (!listing) return notFound(a.product_id);
      const base = { run_id: a.run_id ?? "live", buyer_id: a.buyer_id ?? null, buyer_model: a.buyer_model ?? null,
        seller_id: listing.seller_id, product_id: listing.id, negotiation_id: null, price_cents: null };
      await log({ ...base, actor: "buyer", type: "question_asked", payload: { question: a.question.slice(0, 800) } });
      const r = await answerQuestion({ product_id: listing.id, title: listing.title, description: listing.description,
        specs: listing.specs, list_price_cents: listing.list_price_cents, shipping_days: listing.shipping_days }, a.question, defaultLlm());
      await log({ ...base, actor: "seller", type: "question_answered", payload: { grounded: r.grounded, fields: r.fields, source: r.source } });
      return { content: [{ type: "text", text: r.answer }], structuredContent: { answer: r.answer, grounded: r.grounded } };
    },
  );
}
