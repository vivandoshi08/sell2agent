// Marketplace gateway (S1): the one MCP connector ChatGPT, Claude and simulated buyers add.
// Search is handled here (ranked by the buyer's lever profile); negotiation tools forward to E1's exchange via handle(move).
// Tool schemas use zod 4 (required by mcp-use); inputs are re-validated against @sa/shared (zod 3).
import { MCPServer } from "mcp-use";
import { z } from "zod";
import { SearchProductsInput, SearchProductsOutput, SearchQuery } from "@sa/shared";
import { CATEGORIES, searchProducts } from "./src/search.js";
import { log } from "./src/log.js";
import { registerNegotiationTools, subjectBuyerId, type RequestLike } from "./src/negotiate.js";
import { registerDealTools } from "./src/deal-tools.js";
import { registerListingTools } from "./src/listing-tools.js";
import { registerDiscovery } from "./src/discovery.js";

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

const leverNames = ["price", "quality", "delivery", "warranty", "trust", "convenience"] as const;
const weight = z.number().min(0).max(1);
const preferencesSchema = z
  .object({
    price: weight.optional(),
    quality: weight.optional(),
    delivery: weight.optional(),
    warranty: weight.optional(),
    trust: weight.optional(),
    convenience: weight.optional(),
  })
  .describe(
    "What the buyer values, each 0..1 (1 = matters most): price, quality, delivery (speed), warranty, trust, convenience. " +
      "E.g. a quality-first buyer: { quality: 1, warranty: 0.8, price: 0.2 }. Results are ranked by fit to these.",
  );

const offeredLeverSchema = z.object({ id: z.string(), lever: z.enum(leverNames), label: z.string() });

export const searchProductsTool = server.tool(
  {
    name: "search_products",
    title: "Search products",
    description:
      "Find products from competing sellers. Drops products that miss a hard need, ranks the rest by fit to what the buyer values (preferences), and returns up to 5, best fit first. Each result lists the extras its seller can offer.",
    inputSchema: z.object({
      query: z.string().optional().describe("What the buyer wants, e.g. 'quiet wireless keyboard'"),
      q: z.string().optional().describe("Same as query (older clients)"),
      category: z.string().optional().describe(`One of: ${CATEGORIES.join(", ")}`),
      max_price_cents: z.number().int().positive().optional().describe("Budget cap in integer cents, e.g. 15000 for $150"),
      hard_needs: z
        .array(z.string())
        .optional()
        .describe("Hard needs as short product features, e.g. ['silent', 'wireless']. Products missing one are dropped."),
      must_have: z.array(z.string()).optional().describe("Same as hard_needs (older clients)"),
      preferences: preferencesSchema.optional(),
      ...buyerContext,
    }),
    outputSchema: z.object({
      listings: z.array(listingSchema).describe("Up to 5 listings, best fit first (contract v2)"),
      results: z.array(
        z.object({
          listing: listingSchema,
          fit_note: z.string(),
          fit_score: z.number().optional().describe("0..1 fit to preferences, when given"),
          levers_offered: z.array(offeredLeverSchema).describe("Extras the seller can include; ask for them in make_offer.levers"),
        }),
      ),
      relaxed: z.boolean().describe("true when no product met every need and these are the closest options"),
      note: z.string().optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (a, rc) => {
    const query = a.query ?? a.q;
    const hard_needs = a.hard_needs ?? a.must_have ?? [];
    const buyer_id = a.buyer_id ?? subjectBuyerId(rc as RequestLike);
    // The production bundle runs @sa/shared on the gateway's zod 4, where LeverProfile (an enum-keyed record) needs
    // every lever. Unmentioned levers become 0, which ranks the same as "unknown" (search ignores 0 weights).
    const preferences = a.preferences ? Object.fromEntries(leverNames.map((l) => [l, a.preferences?.[l] ?? 0])) : undefined;
    // Validate against the contract; context fields are optional on the wire, so fill them for the check.
    const contract = SearchProductsInput.parse({
      run_id: a.run_id ?? "live",
      buyer_id: buyer_id ?? "unknown",
      buyer_model: a.buyer_model ?? "unknown",
      query: query ?? "",
      hard_needs,
      max_price_cents: a.max_price_cents,
      preferences,
    });
    const legacy = SearchQuery.parse({ q: query, category: a.category, max_price_cents: a.max_price_cents });
    const out = searchProducts({ ...legacy, must_have: contract.hard_needs, preferences: contract.preferences }, MCP_URL);
    const listings = SearchProductsOutput.parse({ listings: out.results.map((r) => r.listing) }).listings;

    await log({
      run_id: contract.run_id,
      buyer_id: buyer_id ?? null,
      buyer_model: a.buyer_model ?? null,
      seller_id: null,
      product_id: null,
      negotiation_id: null,
      actor: "marketplace",
      type: "search",
      price_cents: null,
      payload: {
        query: query ?? null, category: a.category ?? null, max_price_cents: a.max_price_cents ?? null, hard_needs,
        preferences: contract.preferences ?? null, relaxed: out.relaxed, result_ids: listings.map((l) => l.id),
      },
    });

    const lines = out.results.map((r) => {
      const extras = r.levers_offered.length ? ` Extras: ${r.levers_offered.map((l) => l.label).join(", ")}.` : "";
      return `${r.listing.title} by ${r.listing.seller_name}: $${(r.listing.list_price_cents / 100).toFixed(2)} list (id ${r.listing.id}). ${r.fit_note}${extras}`;
    });
    const text =
      [out.note, ...lines].filter(Boolean).join("\n") ||
      `No products found. Categories: ${CATEGORIES.join(", ")}. Try fewer hard needs or a higher budget.`;

    return { content: [{ type: "text", text }], structuredContent: { listings, ...out } };
  },
);

registerNegotiationTools(server);
registerDealTools(server);
registerListingTools(server, MCP_URL);
registerDiscovery(server, MCP_URL);

export default server;
