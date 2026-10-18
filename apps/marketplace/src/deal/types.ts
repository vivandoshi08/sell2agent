/**
 * S2-owned (Ananya). Types for the deal card and the pay_deal handler.
 *
 * `StoredDeal` and `DealSource` are S2's local view of what the exchange (Vivan, E1) gives us.
 * They are a stand-in until E1 publishes its types (his page: `validateForPayment()` signature at H1).
 * At Bridge 1 we swap the mock for his real functions; only `exchange-adapter` code should change.
 */
import type { BuyerContext } from "@sa/shared";
import type { PaymentCredential, PaymentResult } from "@sa/payments";

/** One lever included in a deal, e.g. { name: "extended_warranty", detail: "2 years" }. Public. */
export interface DealLever {
  name: string;
  detail?: string;
}

/** Exchange states we care about (from E1's state machine: OPEN → NEGOTIATING → AGREED → PAID, plus terminal states). */
export type DealState = "AGREED" | "PAID" | "EXPIRED" | "WALKED_AWAY" | "ESCALATED";

/** A deal the exchange has locked and re-checked. Amounts are integer cents. */
export interface StoredDeal {
  deal_id: string;
  negotiation_id: string;
  buyer_id: string;
  seller_id: string;
  product_id: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  levers: DealLever[];
  expires_at: string; // ISO 8601
  state: DealState;
  /** E1's locked deal carries these, so the card doesn't need a catalog lookup for them. */
  title?: string;
  list_price_cents?: number;
}

/** Public product facts the card needs. Comes from the catalog (S1), never from seller policy. */
export interface ProductFacts {
  product_id: string;
  title: string;
  list_price_cents: number;
  seller_name: string;
}

/** Refusal codes from the exchange's payment check. Mirrors E1's plan: tampering, replay, expired, unknown. */
export type ValidationCode =
  | "unknown_deal" | "expired" | "already_paid" | "wrong_buyer" | "tampered" | "not_payable"
  | "amount_mismatch" | "policy_recheck_failed"; // the last two come from E1's real exchange

export type Validation =
  | { ok: true; deal: StoredDeal }
  | { ok: false; code: ValidationCode; reason: string; fix?: string; payment_intent_id?: string };

/** What S2 needs from the exchange (E1). */
export interface DealSource {
  /** Read-only lookup for rendering the card. Returns null for an unknown deal. */
  getDeal(deal_id: string): Promise<StoredDeal | null>;
  /** E1 re-checks policy and binding before money moves. */
  validateForPayment(deal_id: string, buyer: Partial<BuyerContext> | undefined, credential: PaymentCredential): Promise<Validation>;
  /** Tell the exchange the deal is paid (E1: `ex.markPaid`). Optional for mocks. */
  markPaid?(deal_id: string, payment_intent_id: string): Promise<void>;
  /** run_id / buyer_model of the negotiation a deal came from, so payment events keep their run (the approve link carries none). */
  runContext?(negotiation_id: string): Promise<{ run_id?: string | null; buyer_model?: string | null } | null>;
}

export interface CatalogSource {
  getProduct(product_id: string): Promise<ProductFacts | null>;
}

/** What the card shows. Public fields only: a test fails if any private field appears here. */
export interface DealCard {
  deal_id: string;
  seller_name: string;
  product: { id: string; title: string };
  quantity: number;
  list_unit_price_cents: number;
  unit_price_cents: number;
  list_total_cents: number;
  total_cents: number;
  savings_cents: number;
  levers: { name: string; label: string }[];
  expires_at: string;
  status: "ready" | "paid" | "expired" | "unavailable";
  /** Always shown on the card: payments are Stripe test mode with a simulated wallet. */
  test_mode: true;
}

/** Result shown on the card after Approve & Pay. Same shape as @sa/payments, so the buyer agent gets reasons and a fix. */
export type PayResult = PaymentResult & { already_paid?: boolean };
