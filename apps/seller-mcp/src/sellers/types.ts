/**
 * E2 · Seller decision types (the "Seller decision" seam in docs/BUILD_PLAN.md).
 *
 * E1's exchange builds a SellerState each turn and calls decide(). E2 owns everything in this folder.
 * Money is integer cents.
 *
 * TODO(Neel, contract owner): BuyerLeverProfile, Lever and LeverPackage are planned for packages/shared
 * (BUILD_PLAN first-hour checklist). They live here until then; move them as-is.
 */

/** The levers a buyer can care about (FINAL_ARCHITECTURE §1). */
export type LeverName = "price" | "quality" | "delivery" | "warranty" | "trust" | "convenience";

/** What a buyer values, 0..1 per lever. Missing = unknown. */
export type BuyerLeverProfile = Partial<Record<LeverName, number>>;

/** A non-price extra the seller can include (priced against margin). */
export interface Lever {
  id: string; // "warranty_2y" | "ship_2day" | ...
  lever: LeverName; // which buyer value it serves
  label: string; // public, e.g. "2-year warranty" (matches contract v2 LeverOption)
  cost_cents: number; // PRIVATE: what it costs the seller
  /** What it would cost the buyer to get separately (retail value). Shown to buyers; drives the pitch. */
  buyer_value_cents?: number;
}

/** A lever as it appears in an offer: public fields only (matches contract v2 LeverPackageItem). */
export interface PackageItem {
  id: string;
  lever: LeverName;
  label: string;
}

/** What the seller's private policy says about one product. */
export interface ProductTerms {
  product_id: string;
  title: string;
  list_price_cents: number;
  floor_price_cents: number; // HARD floor; never below
  unit_cost_cents: number;
  max_rounds: number;
}

/** One past offer in this negotiation. */
export interface PastOffer {
  by: "buyer" | "seller";
  round: number;
  price_cents: number;
  levers?: string[]; // lever ids included in a seller offer
}

/** Everything decide() is allowed to look at. Built by E1's exchange each turn. */
export interface SellerState {
  round: number; // 1-based; the seller's turn number in this negotiation
  terms: ProductTerms;
  history: PastOffer[];
  /** The buyer's latest offer this turn, if it made one. */
  buyer_offer_cents?: number;
}

export type PolicyName = "static" | "negotiating" | "balanced" | "lever_policy";

export interface SellerPolicy {
  name: PolicyName;
  /** Soft floor buffer: offers stop this fraction of the list–floor gap above the hard floor (E4/E11: 3%). */
  soft_floor_buffer?: number;
  /** On the final round, accept buyer bids between the hard and soft floor (E11 option (b)). */
  final_round_accept_zone?: boolean;
  /** lever_policy only: what this seller can include besides price. */
  lever_menu?: Lever[];
  /** lever_policy only: a buyer must value a lever at least this much (0..1) to be offered it. Default 0.6. */
  lever_weight_threshold?: number;
}

/** Why the seller is doing what it does. The voice must say THIS reason (E5: no reason → invented limits). */
export type ReasonCode =
  | "fixed_price" // static seller: price doesn't move
  | "opening_at_list" // holding list in the opening round
  | "pacing" // conceding slowly as rounds pass
  | "buyer_offer_meets_ask" // buyer offered at or above what we'd ask now → accept
  | "already_at_best" // we're at our lowest offer; no further movement
  | "final_offer" // last round; this offer is final
  | "final_round_accept" // last round; buyer bid is within the accept zone
  | "lever_instead_of_cut"; // holding price and adding a lever this buyer values

export interface ProposedMove {
  action: "offer" | "accept";
  price_cents: number; // the offer price, or the buyer price being accepted
  final: boolean; // true only when code says no further rounds (bluff ban)
  reason: ReasonCode;
  /** Plain-English true reason handed to the voice. Never mentions floor or cost. */
  reason_text: string;
  /** Debug only (never shown to buyers): fraction of the list→floor gap conceded. */
  conceded_fraction: number;
  /** Levers included in this offer (public fields). Empty for price-only policies. */
  lever_package?: PackageItem[];
  /** PRIVATE: total seller cost of the included levers. */
  lever_cost_cents?: number;
}
