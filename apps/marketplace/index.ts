// Marketplace gateway (S1): the one MCP connector ChatGPT, Claude and simulated buyers add.
// Search is handled here; negotiation tools will forward to E1's exchange via handle(move).
// Tool schemas use zod 4 (required by mcp-use); inputs are re-validated against @sa/shared (zod 3).
import { MCPServer } from "mcp-use";
import { z } from "zod";
import { SearchQuery } from "@sa/shared";
import { CATEGORIES, searchProducts } from "./src/search.js";
import { log } from "./src/log.js";
import { registerNegotiationTools } from "./src/negotiate.js";

// mcp-use and Manufact set MCP_URL to the public origin (no path); the endpoint is served at /mcp.
const MCP_URL = new URL("/mcp", process.env.MCP_URL ?? "http://localhost:3002").toString();

const server = new MCPServer({
  name: "sa-marketplace",
  title: "Keyboard Marketplace",
  version: "0.0.1",
  description: "Compare products from competing sellers and negotiate with each seller's agent.",
  instructions:
    "This is a marketplace of competing sellers whose agents negotiate. Use search_products to find products that fit the buyer's needs and present those listings. Listings show public facts only; prices are negotiable through the seller's agent.",
});

// Optional session context: simulated buyers send it so events can be grouped by run.
const buyerContext = {
  run_id: z.string().optional().describe("Eval run id (simulated buyers only)"),
  buyer_id: z.string().optional().describe("Buyer id (simulated buyers only)"),
  buyer_model: z.string().optional().describe("Buyer model name (simulated buyers only)"),
};

const listingSchema = z.object({
  id: z.string(),
  seller_id: z.string(),
  seller_name: z.string(),
  category: z.string(),
  title: z.string(),
  description: z.string(),
  specs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  list_price_cents: z.number().int().describe("List price in integer cents; negotiable"),
  shipping_days: z.number().int(),
  in_stock: z.boolean(),
  mcp_url: z.string(),
});

export const searchProductsTool = server.tool(
  {
    name: "search_products",
    title: "Search products",
    description:
      "Find products from competing sellers. Drops products that miss a hard need and returns up to 5, best fit first.",
    inputSchema: z.object({
      q: z.string().optional().describe("What the buyer wants, e.g. 'quiet wireless keyboard'"),
      category: z.string().optional().describe(`One of: ${CATEGORIES.join(", ")}`),
      max_price_cents: z.number().int().positive().optional().describe("Budget cap in integer cents, e.g. 15000 for $150"),
      must_have: z
        .array(z.string())
        .optional()
        .describe("Hard needs as short product features, e.g. ['silent', 'wireless']. Products missing one are dropped."),
      ...buyerContext,
    }),
    outputSchema: z.object({
      results: z.array(z.object({ listing: listingSchema, fit_note: z.string() })),
      relaxed: z.boolean().describe("true when no product met every need and these are the closest options"),
      note: z.string().optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ must_have, run_id, buyer_id, buyer_model, ...query }) => {
    const parsed = SearchQuery.parse(query);
    const out = searchProducts({ ...parsed, must_have }, MCP_URL);
    const { results } = out;

    await log({
      run_id: run_id ?? "live",
      buyer_id: buyer_id ?? null,
      buyer_model: buyer_model ?? null,
      seller_id: null,
      product_id: null,
      negotiation_id: null,
      actor: "marketplace",
      type: "search",
      price_cents: null,
      payload: { ...parsed, must_have: must_have ?? [], relaxed: out.relaxed, result_ids: results.map((r) => r.listing.id) },
    });

    const lines = results.map(
      (r) => `${r.listing.title} by ${r.listing.seller_name}: $${(r.listing.list_price_cents / 100).toFixed(2)} list (id ${r.listing.id}). ${r.fit_note}`,
    );
    const text =
      [out.note, ...lines].filter(Boolean).join("\n") ||
      `No products found. Categories: ${CATEGORIES.join(", ")}. Try fewer must-haves or a higher budget.`;

    return { content: [{ type: "text", text }], structuredContent: out };
  },
);

registerNegotiationTools(server);

export default server;
