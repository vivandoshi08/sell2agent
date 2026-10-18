/**
 * E1 · Exchange interface (the "Exchange interface" seam in docs/BUILD_PLAN.md).
 *
 * S1's gateway turns each buyer tool call into a Move and calls `exchange.handle(move)`.
 * The exchange owns sessions, offers, deals, protocol rules and guardrails; E2's decide()/voice()
 * only propose. Money is integer cents.
 *
 * TODO(Neel, contract owner): NegotiationState, StandingOffer and LockedDeal are asked for in
 * packages/shared (docs/e1-asks.html n1–n5). They live here until then; move them as-is.
 */
import type { BuyerContext } from "@sa/shared";
import type { BuyerLeverProfile } from "../sellers";

// ---------- State machine ----------
export type NegotiationState =
  | "open" // session created, no seller offer yet
  | "negotiating" // offers on the table
  | "agreed" // a deal is locked, waiting for payment
  | "paid"
  | "walked_away"
  | "follow_up" // walked away, buyer opted in to a later offer (stage 3)
  | "escalated" // a human must decide
  | "expired";

export type BuyerAction = "offer" | "accept" | "walk" | "status";

// ---------- Moves (gateway → exchange) ----------
interface MoveBase {
  ctx: BuyerContext; // run_id, buyer_id, buyer_model: on every call (offers are bound to buyer_id)
}
/** make_offer. Omit negotiation_id to open a new negotiation on product_id. */
export interface OfferMove extends MoveBase {
  kind: "offer";
  product_id: string;
  negotiation_id?: string;
  offer_price_cents: number;
  quantity?: number;
  message?: string; // UNTRUSTED free text from the buyer agent
  buyer_profile?: BuyerLeverProfile;
  /** Lever package the buyer wants included (must be in the listing's allowed levers). Omit to keep the current one. */
  levers?: string[];
  /** Eval A/B only: seller strategy for this negotiation. Honoured only for a signed eval run_id (signEvalRun); floors still hold. */
  strategy?: "static" | "negotiating" | "balanced";
}
/** accept_deal: accept the seller's standing offer, by its offer_id. */
export interface AcceptMove extends MoveBase {
  kind: "accept";
  negotiation_id: string;
  offer_id: string;
}
export interface WalkMove extends MoveBase {
  kind: "walk";
  negotiation_id: string;
  reason?: string;
  /** Opt in to one later offer (allow_followups). Without this, the seller never contacts the buyer. */
  followup?: FollowUpConsent;
}
export interface FollowUpConsent {
  reply_to: string; // agent email, phone, or A2A address
  channel: "email" | "sms" | "a2a";
}
export interface FollowUp extends FollowUpConsent {
  consent_at: string;
  due_at: string;
  sent_at?: string;
  offer_id?: string;
  unsubscribed?: boolean;
}
/** What the outreach scheduler hands the messaging door (S1's Inkbox adapter). Readable text + a machine-readable offer. */
export interface OutboundMessage {
  negotiation_id: string;
  buyer_id: string;
  seller_id: string;
  channel: FollowUpConsent["channel"];
  reply_to: string;
  subject: string;
  text: string;
  offer: { offer_id: string; product_id: string; title: string; price_cents: number; list_price_cents: number; levers: string[]; expires_at: string;
    accept: string; counter: string; stop: string };
}
/** check_offers: read-only. */
export interface StatusMove extends MoveBase {
  kind: "status";
  negotiation_id: string;
}
export type Move = OfferMove | AcceptMove | WalkMove | StatusMove;

// ---------- Records ----------
export interface StandingOffer {
  offer_id: string; // bound to negotiation + buyer
  negotiation_id: string;
  buyer_id: string;
  price_cents: number; // unit price
  quantity: number;
  levers: string[]; // lever package (e.g. ["free_shipping"]); [] = price only
  final: boolean;
  expires_at: string; // ISO
  status: "live" | "superseded" | "accepted" | "expired";
  round: number;
}

/** Shape S2 asked for (dashboard page, seam "exchange · deals"). Amount always comes from here. */
export interface LockedDeal {
  deal_id: string;
  negotiation_id: string;
  offer_id: string;
  buyer_id: string;
  seller_id: string;
  product_id: string;
  title: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  list_price_cents: number;
  levers: string[];
  currency: "usd";
  expires_at: string;
  status: "locked" | "paid" | "expired";
  payment_intent_id?: string;
  signature: string; // HMAC over every field above except status/payment_intent_id
}

export interface Negotiation {
  id: string;
  run_id: string;
  /** Eval A/B override (signed eval runs only); absent = the product's catalog strategy. */
  strategy?: "static" | "negotiating" | "balanced";
  /** Seller-facing event fields (Instinct demo): public listing title, and how the buyer reached us (from ctx). */
  product_title?: string;
  channel?: string; // "messaging" (Instinct) | "mcp_app" (ChatGPT/Claude) | "web" | "harness"
  agent_operator?: string; // "instinct" | "chatgpt" | "claude" | "harness"
  buyer_id: string;
  buyer_model: string;
  seller_id: string;
  product_id: string;
  quantity: number;
  state: NegotiationState;
  round: number; // seller turns taken
  history: { by: "buyer" | "seller"; round: number; price_cents: number }[];
  standing_offer_id?: string;
  deal_id?: string;
  attack_flags: number; // buyer messages flagged by the input guard (circuit breaker)
  frozen: boolean; // breaker tripped: price frozen at current ask, truthfully final
  escalations: string[]; // out-of-policy asks logged for a human
  levers: string[]; // current lever package
  buyer_profile?: BuyerLeverProfile; // last stated, for re-packaging a follow-up
  followup?: FollowUp;
  created_at: string;
  updated_at: string;
}

// ---------- Response (exchange → gateway) ----------
export interface ExchangeError {
  code:
    | "bad_request"
    | "unknown_product"
    | "unknown_negotiation"
    | "wrong_buyer"
    | "not_allowed" // action not allowed in this state
    | "stale_offer" // offer_id superseded
    | "unknown_offer"
    | "offer_expired"
    | "round_cap" // past the round cap: only accept or walk
    | "rate_limited" // too many negotiation starts
    | "bad_lever" // lever not offered, or package costs more than the price allows
    | "closed";
  message: string; // agent-readable: what went wrong and what to do
}

export interface ExchangeResponse {
  ok: boolean;
  negotiation_id?: string;
  /** Echo of ctx.buyer_id (incl. gateway-minted anon_ ids) so the caller can send it back on the next move. */
  buyer_id?: string;
  state?: NegotiationState;
  /** "counter" = seller offer stands; "accept" = seller accepted buyer price, deal locked. */
  status?: "counter" | "accept" | "reject" | "walked" | "info";
  standing_offer?: Omit<StandingOffer, "buyer_id" | "status" | "negotiation_id">;
  deal?: Omit<LockedDeal, "signature">;
  round?: number;
  rounds_left?: number;
  allowed_actions: BuyerAction[];
  message: string; // seller's words (guarded) or an explanation
  reason?: string; // true reason code
  error?: ExchangeError;
}

// ---------- Ports ----------
/** Seller-private terms for one product, plus who sells it and how. */
export interface ProductConfig {
  product_id: string;
  seller_id: string;
  title: string;
  list_price_cents: number;
  floor_price_cents: number;
  unit_cost_cents: number;
  max_rounds: number;
  allowed_levers: string[];
  lever_costs?: Record<string, number>; // seller cost per lever, cents (default DEFAULT_LEVER_COSTS)
  strategy: "static" | "negotiating" | "balanced";
}
export interface Catalog {
  get(product_id: string): Promise<ProductConfig | null>;
}
