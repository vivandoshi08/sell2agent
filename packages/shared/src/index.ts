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

// ---------- Levers (n5; FINAL_ARCHITECTURE §1–2) ----------
/** What a buyer can value, and what a seller can offer besides price. */
export const LeverName = z.enum(["price", "quality", "delivery", "warranty", "trust", "convenience"]);
export type LeverName = z.infer<typeof LeverName>;

/** A buyer's lever profile: weight 0..1 per lever (missing = unknown). */
export const LeverProfile = z.record(LeverName, z.number().min(0).max(1));
export type LeverProfile = z.infer<typeof LeverProfile>;

/** One extra the seller can include (a menu item). Cost is PRIVATE to the seller. */
export const LeverOption = z.object({
  id: z.string(), // "extended_warranty_2y"
  lever: LeverName, // which buyer value it serves
  label: z.string(), // "2-year warranty" (public)
  cost_cents: z.number().int().nonnegative(), // PRIVATE: never in buyer-facing output
  max_per_deal: z.number().int().positive().default(1),
});
export type LeverOption = z.infer<typeof LeverOption>;

/** Levers included in an offer or deal. Public shape: no costs. */
export const LeverPackageItem = z.object({ id: z.string(), lever: LeverName, label: z.string() });
export const LeverPackage = z.array(LeverPackageItem);
export type LeverPackage = z.infer<typeof LeverPackage>;

/** What a seller wants, weights 0..1 (FINAL_ARCHITECTURE §2 "Objective"). */
export const SellerObjective = z.object({
  margin: z.number().min(0).max(1).default(0.5),
  conversion: z.number().min(0).max(1).default(0.5),
  clear_stock: z.number().min(0).max(1).default(0),
  repeat_customers: z.number().min(0).max(1).default(0),
  premium_image: z.number().min(0).max(1).default(0),
});
export type SellerObjective = z.infer<typeof SellerObjective>;

export const PolicyName = z.enum(["static", "negotiating", "balanced", "lever_policy", "learned"]);
export type PolicyName = z.infer<typeof PolicyName>;

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
  // added (contract v2): all optional so existing rows still parse
  lever_menu: z.array(LeverOption).default([]),
  objective: SellerObjective.optional(),
  policy: PolicyName.default("negotiating"),
  min_margin_after_levers_pct: z.number().min(0).max(100).optional(),
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
  lever_profile: LeverProfile.optional(), // added (contract v2): what this buyer values
});
export type BuyerContext = z.infer<typeof BuyerContext>;

export const TOOL_NAMES = {
  getListing: "get_listing",
  askQuestion: "ask_question",
  makeOffer: "make_offer",
  acceptDeal: "accept_deal",
  // added (contract v2, n7)
  searchProducts: "search_products",
  payDeal: "pay_deal",
  checkOffers: "check_offers",
} as const;

// search_products (gateway, S1). Preferences are a lever profile (FINAL_ARCHITECTURE §1).
export const SearchProductsInput = BuyerContext.extend({
  query: z.string(),
  hard_needs: z.array(z.string()).default([]),
  max_price_cents: z.number().int().positive().optional(),
  preferences: LeverProfile.optional(),
});
export const SearchProductsOutput = z.object({ listings: z.array(Listing).max(5) });

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
  // added (contract v2, n1)
  offer_id: z.string(), // the live offer; accept_deal must name it
  final: z.boolean(), // set by code, never by the LLM
  expires_at: z.string().datetime().nullable(), // after this, the offer can't be accepted
  lever_package: LeverPackage.default([]),
});
export type MakeOfferOutput = z.infer<typeof MakeOfferOutput>;

export const AcceptDealInput = BuyerContext.extend({
  negotiation_id: z.string(),
  offer_id: z.string(), // added (contract v2, n1): only the live offer made to THIS buyer can be accepted
});
export const AcceptDealOutput = z.object({
  deal_id: z.string(),
  final_price_cents: z.number().int().positive(),
  quantity: z.number().int().positive(),
  stripe_payment_intent_id: z.string().optional(), // contract v2: payment happens in pay_deal; optional here
  client_secret: z.string().optional(),
  // added (contract v2, n4)
  lever_package: LeverPackage.default([]),
  expires_at: z.string().datetime().nullable().optional(),
});
export type AcceptDealOutput = z.infer<typeof AcceptDealOutput>;

// pay_deal (n7): amount comes from the stored, locked deal; never from the caller.
export const PayDealInput = BuyerContext.extend({
  deal_id: z.string(),
  payment_token: z.string().optional(), // Stripe Shared Payment Token (spt_...) when available
});
export const PayDealOutput = z.object({
  deal_id: z.string(),
  status: z.enum(["succeeded", "processing", "requires_action", "refused", "declined", "error"]),
  amount_cents: z.number().int(),
  payment_intent_id: z.string().optional(),
  reasons: z.array(z.string()).optional(),
  fix: z.string().optional(),
});
export type PayDealOutput = z.infer<typeof PayDealOutput>;

// check_offers (n7): pending follow-ups for a returning buyer.
export const CheckOffersInput = BuyerContext;
export const CheckOffersOutput = z.object({
  offers: z.array(z.object({
    offer_id: z.string(), negotiation_id: z.string(), product_id: z.string(), price_cents: z.number().int(),
    lever_package: LeverPackage.default([]), expires_at: z.string().datetime().nullable(), message: z.string(),
  })),
});

// ---------- Negotiation + offer status (n2, n3) ----------
export const NegotiationStatus = z.enum([
  "open", "negotiating", "agreed", "accepted", "rejected", "paid", "abandoned",
  "walked_away", "follow_up", "escalated", "expired",
]);
export type NegotiationStatus = z.infer<typeof NegotiationStatus>;
export const OfferRowStatus = z.enum(["live", "superseded", "accepted", "expired"]);

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
  "guardrail_blocked", // seller code blocked an LLM proposal; rule in payload.rule (GuardrailRule)
  "offer_expired", // added (contract v2)
  "judged", // added (contract v2): per-negotiation judge result for S2's safe conversion
  "run_finished",
]);
export type EventType = z.infer<typeof EventType>;

/** n6: guardrail events stay `guardrail_blocked`; the rule goes in `payload.rule` using these names. */
export const GuardrailRule = z.enum([
  "accept_below_floor",
  "offer_below_soft_floor", // clamped
  "price_in_text_mismatch",
  "floor_disclosure",
  "unpriced_concession",
  "false_final",
  "injection_flag",
  "stale_or_foreign_offer", // accept named an offer that isn't live or isn't this buyer's
  "tampered_payment", // pay_deal amount/buyer doesn't match the locked deal
  "buyer_wallet_cap", // buyer-side: harness/wallet blocked an over-budget move
]);
export type GuardrailRule = z.infer<typeof GuardrailRule>;

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
