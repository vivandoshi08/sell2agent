/**
 * SHARED CONTRACT — FROZEN.
 * Every app imports from here. Do not edit without telling the whole team.
 * If you need a change: stop, tell your human, one person edits, everyone pulls.
 */
import { z } from "zod";

// ---------- Ports & URLs (keep in sync with .env.example) ----------
export const PORTS = {
  dashboard: 3000,
  sellerMcp: 3001,
  marketplace: 3002,
} as const;

// ---------- Catalog ----------
export const Concession = z.enum([
  "free_shipping",
  "bundle_discount",
  "volume_discount",
  "extended_warranty",
]);
export type Concession = z.infer<typeof Concession>;

export const Product = z.object({
  id: z.string(), // e.g. "kb_quietpro_75"
  seller_id: z.string(),
  category: z.string(), // e.g. "mechanical_keyboard"
  title: z.string(),
  description: z.string(),
  specs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  list_price_cents: z.number().int().positive(),
  inventory: z.number().int().nonnegative(),
  shipping_days: z.number().int().nonnegative(),
});
export type Product = z.infer<typeof Product>;

/** PRIVATE to the seller. Never returned by any buyer-facing tool. */
export const SellerPolicy = z.object({
  product_id: z.string(),
  floor_price_cents: z.number().int().positive(), // hard minimum, enforced in code
  unit_cost_cents: z.number().int().nonnegative(), // for margin calc
  target_margin_pct: z.number().min(0).max(100),
  max_rounds: z.number().int().positive().default(4),
  allowed_concessions: z.array(Concession),
});
export type SellerPolicy = z.infer<typeof SellerPolicy>;

export const Seller = z.object({
  id: z.string(),
  name: z.string(),
  mcp_url: z.string().url(), // where buyer agents connect
  strategy: z.enum(["static", "negotiating"]), // static = baseline for evals
});
export type Seller = z.infer<typeof Seller>;

/** What the marketplace search returns. Public info only. */
export const Listing = Product.omit({ inventory: true }).extend({
  seller_name: z.string(),
  mcp_url: z.string().url(),
  in_stock: z.boolean(),
});
export type Listing = z.infer<typeof Listing>;

// ---------- Marketplace API (apps/marketplace, HTTP) ----------
// GET /search?q=...&category=...&max_price_cents=...  -> SearchResponse
export const SearchQuery = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  max_price_cents: z.coerce.number().int().optional(),
});
export const SearchResponse = z.object({ listings: z.array(Listing) });
export type SearchResponse = z.infer<typeof SearchResponse>;

// ---------- Seller MCP tools (apps/seller-mcp) ----------
// Every tool input carries session context so the seller can log + remember.
export const BuyerContext = z.object({
  run_id: z.string(),
  buyer_id: z.string(),
  buyer_model: z.string(), // e.g. "claude-sonnet-5-5", "gpt-x", "gemini-x"
});
export type BuyerContext = z.infer<typeof BuyerContext>;

export const TOOL_NAMES = {
  getListing: "get_listing",
  askQuestion: "ask_question",
  makeOffer: "make_offer",
  acceptDeal: "accept_deal",
} as const;

export const GetListingInput = BuyerContext.extend({ product_id: z.string() });
export const GetListingOutput = Listing;

export const AskQuestionInput = BuyerContext.extend({
  product_id: z.string(),
  question: z.string(),
});
export const AskQuestionOutput = z.object({
  answer: z.string(), // must be grounded in catalog data only
  grounded: z.boolean(), // false => "I don't know", never invent
});

export const MakeOfferInput = BuyerContext.extend({
  product_id: z.string(),
  negotiation_id: z.string().optional(), // omit on first offer; seller creates one
  offer_price_cents: z.number().int().positive(),
  quantity: z.number().int().positive().default(1),
  message: z.string().optional(), // free-text from buyer agent
});
export const OfferStatus = z.enum(["accept", "counter", "reject"]);
export const MakeOfferOutput = z.object({
  negotiation_id: z.string(),
  status: OfferStatus,
  price_cents: z.number().int().positive(), // accepted or countered unit price
  concessions: z.array(Concession).default([]),
  round: z.number().int().positive(),
  rounds_left: z.number().int().nonnegative(),
  message: z.string(), // seller agent's pitch / reason
});
export type MakeOfferOutput = z.infer<typeof MakeOfferOutput>;

export const AcceptDealInput = BuyerContext.extend({
  negotiation_id: z.string(),
});
export const AcceptDealOutput = z.object({
  deal_id: z.string(),
  final_price_cents: z.number().int().positive(),
  quantity: z.number().int().positive(),
  stripe_payment_intent_id: z.string(), // Stripe TEST mode only
  client_secret: z.string().optional(),
});
export type AcceptDealOutput = z.infer<typeof AcceptDealOutput>;

// ---------- Event log: the integration bus ----------
// Seller AND buyer write every action here. Dashboard only reads it.
export const EventType = z.enum([
  "run_started",
  "search",
  "listing_viewed",
  "question_asked",
  "question_answered",
  "offer_made", // by buyer
  "offer_countered", // by seller
  "offer_accepted",
  "offer_rejected",
  "deal_accepted",
  "payment_succeeded",
  "payment_failed",
  "buyer_walked_away",
  "guardrail_blocked", // seller code blocked an LLM proposal (e.g. below floor)
  "run_finished",
]);
export type EventType = z.infer<typeof EventType>;

export const Actor = z.enum(["buyer", "seller", "marketplace", "harness"]);

export const NegotiationEvent = z.object({
  id: z.string().uuid().optional(), // DB default
  run_id: z.string(),
  buyer_id: z.string().nullable(),
  buyer_model: z.string().nullable(),
  seller_id: z.string().nullable(),
  product_id: z.string().nullable(),
  negotiation_id: z.string().nullable(),
  actor: Actor,
  type: EventType,
  price_cents: z.number().int().nullable(),
  payload: z.record(z.string(), z.unknown()).default({}),
  ts: z.string().datetime().optional(), // DB default now()
});
export type NegotiationEvent = z.infer<typeof NegotiationEvent>;

// ---------- Eval runs ----------
export const BuyerTask = z.object({
  buyer_id: z.string(),
  buyer_model: z.string(),
  goal: z.string(), // "Buy a quiet mechanical keyboard"
  category: z.string(),
  budget_cents: z.number().int().positive(), // hard cap, enforced in harness code
  must_have: z.array(z.string()).default([]),
});
export type BuyerTask = z.infer<typeof BuyerTask>;

export const RunConfig = z.object({
  run_id: z.string(),
  label: z.string(), // "baseline" | "negotiating" | anything
  seller_strategy: z.enum(["static", "negotiating"]),
  buyers: z.array(BuyerTask),
});
export type RunConfig = z.infer<typeof RunConfig>;

export const RunResult = z.object({
  run_id: z.string(),
  label: z.string(),
  buyers: z.number().int(),
  conversions: z.number().int(),
  conversion_rate: z.number(), // conversions / buyers
  safe_conversions: z.number().int(), // no floor breach, no ungrounded claims
  safe_conversion_rate: z.number(),
  revenue_cents: z.number().int(),
  profit_cents: z.number().int(),
  avg_margin_pct: z.number(),
  avg_rounds: z.number(),
});
export type RunResult = z.infer<typeof RunResult>;
