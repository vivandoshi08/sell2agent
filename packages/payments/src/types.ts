/**
 * Payment types. Local to @sa/payments (packages/shared is frozen).
 * If Neel adopts the `accept_deal` payment proposal, move these into shared.
 */

/** A deal as stored by the SELLER after its policy engine approved it. The amount comes from here, never from a tool call. */
export interface Deal {
  deal_id: string;
  amount_cents: number; // exact total to charge (unit price × qty)
  currency: string; // "usd"
  description: string; // "KeyForge Quiet 75 × 1 (negotiated)"
  seller_id: string;
  /** Extra audit fields that land in PaymentIntent metadata (strings only). */
  metadata?: Record<string, string>;
}

/**
 * How the buyer pays. Accepts all three shapes so seller-mcp can pass through whatever arrives:
 *  - a bare Shared Payment Token: "spt_..."
 *  - a UCP-style instrument: { credential: { type: "stripe_payment_token", token: "spt_..." } }
 *  - a test card (Fallback A, when SPTs aren't available): { test_card: "pm_card_visa" }
 */
export type PaymentCredential =
  | string
  | { credential: { type: "stripe_payment_token"; token: string } }
  | { test_card: string }
  /** A Stripe Checkout Session the buyer (human or Link agent) already completed for this deal. */
  | { checkout_session: string };

export type PaymentStatus =
  | "succeeded"
  | "processing" // automatic_async capture: confirm via webhook
  | "requires_action" // 3DS on the buyer's side; retry same deal_id
  | "refused" // our pre-check said no before touching money
  | "declined" // card declined by Stripe
  | "error";

/** Returned to the buyer agent. `reasons` + `fix` make refusals explainable (good AX). */
export interface PaymentResult {
  status: PaymentStatus;
  deal_id: string;
  amount_cents: number;
  payment_intent_id?: string;
  card?: string; // "visa ****4242"
  mode: "spt" | "test_card" | "checkout";
  /** Local pickup: the card is authorized and captured only when the seller enters `pickup_code`. */
  held?: boolean;
  /** 6-digit code the buyer shows the seller at pickup (only when held). */
  pickup_code?: string;
  /** Marketplace split (Stripe Connect destination charge), when the seller has a connected account. */
  split?: { seller_cents: number; platform_fee_cents: number };
  reasons?: string[];
  fix?: string;
  code?: string;
  message?: string;
}

/** What the buyer's wallet produces after its own checks + (optional) human approval. */
export interface WalletGrant {
  approved: boolean;
  credential?: PaymentCredential;
  reasons?: string[];
  /** Limits the buyer set, shown on screen next to the ones read back from Stripe. */
  limits?: { max_amount_cents: number; currency: string; expires_at: number };
  simulated: boolean; // true when minted with the test helper on the seller's key
}
