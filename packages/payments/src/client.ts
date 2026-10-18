import Stripe from "stripe";

/** Pinned to match stripe@23.1.0-beta.1. Preview SDKs break between betas: don't bump during the hackathon. */
export const STRIPE_API_VERSION = "2026-09-30.preview";

export type PaymentMode = "spt" | "test_card";

let cached: Stripe | null = null;

/** Single Stripe client. Refuses live keys: this project is TEST MODE ONLY. */
export function stripe(): Stripe {
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set (copy .env.example to .env)");
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new Error("Refusing to start: STRIPE_SECRET_KEY must be a test key (sk_test_ or rk_test_)");
  }
  cached = new Stripe(key, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion, maxNetworkRetries: 2 });
  return cached;
}

/** "spt" (Shared Payment Tokens, preferred) or "test_card" (Fallback A). Set after running the smoke test. */
export function paymentMode(): PaymentMode {
  return process.env.STRIPE_PAYMENT_MODE === "test_card" ? "test_card" : "spt";
}
