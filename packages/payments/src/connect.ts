/**
 * Marketplace money flow (Stripe Connect, TEST MODE). The buyer pays the platform; Stripe splits the charge:
 * the seller's connected account gets the deal total minus our fee, and we keep `application_fee_amount`.
 * Sellers with a connected account sell for local pickup, so their charges are HELD (manual capture) and only
 * captured when the seller enters the buyer's pickup code; a no-show releases the hold.
 *
 *   ensureSellerAccount(seller_id)  → acct_… (found by metadata.seller_id, created if missing)
 *   onboardingLink(acct, urls)      → Stripe-hosted onboarding (KYC + terms), the seller clicks through
 *   splitFor(seller_id, amount)     → PaymentIntent params for the split + hold ({} when the seller isn't ready)
 *   capturePickup / releaseHold     → seller confirms the handoff, or lets the hold go
 *   createDealCheckout(deal, urls)  → hosted Checkout for the negotiated total, same split (humans + Link agents)
 *
 * No table stores any of this: the seller ↔ account link is the account's metadata, and the hold state is the
 * PaymentIntent's status. The pickup code is an HMAC of the PaymentIntent id, so nothing needs saving.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import { stripe } from "./client";
import type { Deal } from "./types";

/** Our cut in basis points (500 = 5%). */
export function feeBps(): number {
  const n = Number(process.env.PLATFORM_FEE_BPS ?? 500);
  return Number.isFinite(n) && n >= 0 && n <= 5000 ? Math.round(n) : 500;
}
export const platformFee = (amount_cents: number, bps = feeBps()) => Math.round((amount_cents * bps) / 10_000);

export interface SellerAccount {
  id: string;
  seller_id: string;
  /** transfers capability active: charges can be split to this account */
  ready: boolean;
  payouts_enabled: boolean;
  currently_due: string[];
}

const toSeller = (a: Stripe.Account, seller_id: string): SellerAccount => ({
  id: a.id,
  seller_id,
  ready: a.capabilities?.transfers === "active",
  payouts_enabled: !!a.payouts_enabled,
  currently_due: a.requirements?.currently_due ?? [],
});

const cache = new Map<string, { at: number; acct: SellerAccount | null }>();
const TTL_MS = 30_000;

/** The seller's connected account, or null. Looked up by metadata.seller_id (cached 30 s). */
export async function sellerAccount(seller_id: string, { fresh = false } = {}): Promise<SellerAccount | null> {
  const hit = cache.get(seller_id);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.acct;
  let found: Stripe.Account | undefined;
  for await (const a of stripe().accounts.list({ limit: 100 })) {
    if (a.metadata?.seller_id === seller_id) { found = a; break; }
  }
  const acct = found ? toSeller(found, seller_id) : null;
  cache.set(seller_id, { at: Date.now(), acct });
  return acct;
}

/**
 * Find or create the seller's connected account: an individual, Express dashboard, Stripe-collected KYC,
 * Stripe-managed losses (required for v1 accounts on new platforms). Test mode prefills Stripe's published
 * test identity, so onboarding is just reviewing and accepting the terms.
 */
export async function ensureSellerAccount(seller_id: string, opts: { email?: string; name?: string } = {}): Promise<SellerAccount> {
  const existing = await sellerAccount(seller_id, { fresh: true });
  if (existing) return existing;
  const [first, ...rest] = (opts.name ?? "Test Seller").split(" ");
  const a = await stripe().accounts.create({
    country: "US",
    business_type: "individual",
    controller: { fees: { payer: "application" }, losses: { payments: "stripe" }, stripe_dashboard: { type: "express" } },
    capabilities: { transfers: { requested: true } },
    business_profile: { mcc: "5734", product_description: "Used goods sold locally through an AI seller agent" },
    metadata: { seller_id },
    // Stripe's documented test-mode identity (docs.stripe.com/connect/testing). Test keys only (client.ts refuses live).
    individual: {
      first_name: first, last_name: rest.join(" ") || "Seller", email: opts.email ?? `${seller_id}@example.com`, phone: "0000000000",
      dob: { day: 1, month: 1, year: 1901 }, ssn_last_4: "0000", id_number: "000000000",
      address: { line1: "address_full_match", city: "San Francisco", state: "CA", postal_code: "94107", country: "US" },
    },
    external_account: { object: "bank_account", country: "US", currency: "usd", routing_number: "110000000", account_number: "000123456789" } as unknown as string,
  });
  const acct = toSeller(a, seller_id);
  cache.set(seller_id, { at: Date.now(), acct });
  return acct;
}

/** Stripe-hosted onboarding (single use, expires in minutes: create it when the seller clicks). */
export async function onboardingLink(account_id: string, urls: { return_url: string; refresh_url: string }): Promise<string> {
  const l = await stripe().accountLinks.create({ account: account_id, type: "account_onboarding", ...urls });
  return l.url;
}

/** The seller's Stripe Express dashboard (payouts, balance), once onboarding is done. */
export async function dashboardLink(account_id: string): Promise<string> {
  return (await stripe().accounts.createLoginLink(account_id)).url;
}

export interface Split {
  account_id: string;
  fee_cents: number;
  seller_cents: number;
  hold: boolean;
}

/** How a charge for this seller is split. null = no ready connected account: the platform keeps the charge (sim sellers). */
export async function splitFor(seller_id: string, amount_cents: number): Promise<Split | null> {
  if (process.env.STRIPE_CONNECT === "off") return null;
  let acct: SellerAccount | null;
  try { acct = await sellerAccount(seller_id); } catch { return null; } // a lookup failure must never block a payment
  if (!acct?.ready) return null;
  const fee_cents = platformFee(amount_cents);
  return { account_id: acct.id, fee_cents, seller_cents: amount_cents - fee_cents, hold: process.env.PICKUP_HOLD !== "off" };
}

export function splitParams(s: Split | null): Partial<Stripe.PaymentIntentCreateParams> {
  if (!s) return {};
  return {
    application_fee_amount: s.fee_cents,
    transfer_data: { destination: s.account_id },
    ...(s.hold ? { capture_method: "manual" as const } : {}),
  };
}

const pickupKey = () => process.env.PICKUP_SECRET ?? process.env.EXCHANGE_HMAC_SECRET ?? process.env.STRIPE_SECRET_KEY ?? "";

/** 6-digit code the buyer shows at pickup. Derived from the PaymentIntent, so it is never stored. */
export function pickupCode(payment_intent_id: string): string {
  const h = createHmac("sha256", pickupKey()).update(`pickup\u0000${payment_intent_id}`).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

function codeMatches(payment_intent_id: string, code: string): boolean {
  const want = Buffer.from(pickupCode(payment_intent_id)), got = Buffer.from(String(code).replace(/\D/g, ""));
  return got.length === want.length && timingSafeEqual(got, want);
}

export type PickupResult =
  | { ok: true; payment_intent_id: string; status: string; amount_cents: number; fee_cents: number; seller_cents: number }
  | { ok: false; reason: string };

async function ownedHeld(payment_intent_id: string, seller_id: string): Promise<Stripe.PaymentIntent | string> {
  let pi: Stripe.PaymentIntent;
  try { pi = await stripe().paymentIntents.retrieve(payment_intent_id); } catch { return "unknown payment"; }
  if (pi.metadata?.seller_id !== seller_id) return "this payment isn't for this seller";
  if (pi.status !== "requires_capture") return `payment is ${pi.status}, not on hold`;
  return pi;
}

/** Seller confirms the handoff with the buyer's code: capture the hold (Stripe then moves the seller's share). */
export async function capturePickup(payment_intent_id: string, seller_id: string, code: string): Promise<PickupResult> {
  const pi = await ownedHeld(payment_intent_id, seller_id);
  if (typeof pi === "string") return { ok: false, reason: pi };
  if (!codeMatches(pi.id, code)) return { ok: false, reason: "wrong pickup code" };
  const done = await stripe().paymentIntents.capture(pi.id, {}, { idempotencyKey: `pickup-${pi.id}` });
  const fee = done.application_fee_amount ?? 0;
  return { ok: true, payment_intent_id: done.id, status: done.status, amount_cents: done.amount_received, fee_cents: fee, seller_cents: done.amount_received - fee };
}

/** No-show or deal off: release the hold. Nothing is charged. */
export async function releaseHold(payment_intent_id: string, seller_id: string): Promise<PickupResult> {
  const pi = await ownedHeld(payment_intent_id, seller_id);
  if (typeof pi === "string") return { ok: false, reason: pi };
  const done = await stripe().paymentIntents.cancel(pi.id);
  return { ok: true, payment_intent_id: done.id, status: done.status, amount_cents: 0, fee_cents: 0, seller_cents: 0 };
}

export interface SellerPayment {
  payment_intent_id: string;
  deal_id: string | null;
  description: string | null;
  amount_cents: number;
  fee_cents: number;
  seller_cents: number;
  /** held = authorized, waiting for pickup; paid = captured; released = hold canceled */
  state: "held" | "paid" | "released" | "other";
  /** true when Stripe splits this charge to the seller's account (false: made before payouts were connected) */
  split: boolean;
  created: number;
}

/** Recent payments for one seller, newest first (filters the platform's last 100 PaymentIntents). */
export async function sellerPayments(seller_id: string): Promise<SellerPayment[]> {
  const list = await stripe().paymentIntents.list({ limit: 100 });
  return list.data
    .filter((p) => p.metadata?.seller_id === seller_id)
    .map((p) => {
      const fee = p.application_fee_amount ?? 0;
      const state = p.status === "requires_capture" ? "held" : p.status === "succeeded" ? "paid" : p.status === "canceled" ? "released" : "other";
      return { payment_intent_id: p.id, deal_id: p.metadata?.deal_id ?? null, description: p.description, amount_cents: p.amount,
        fee_cents: fee, seller_cents: p.transfer_data?.destination ? p.amount - fee : 0, state, split: !!p.transfer_data?.destination, created: p.created } as SellerPayment;
    });
}

/**
 * Hosted Checkout for a locked deal: the negotiated total as a one-off price, Link on, same split and hold as
 * pay_deal. Humans pay it; Link Agent Wallet agents pay it with a virtual card or a Link Pay Token.
 * Expires with the deal (Stripe's minimum is 30 minutes).
 */
export async function createDealCheckout(deal: Deal, urls: { success_url: string; cancel_url: string; expires_at?: number }): Promise<{ id: string; url: string }> {
  const split = await splitFor(deal.seller_id, deal.amount_cents);
  const metadata = { deal_id: deal.deal_id, seller_id: deal.seller_id, policy: "approved", ...(deal.metadata ?? {}) };
  const minExp = Math.floor(Date.now() / 1000) + 31 * 60;
  const s = await stripe().checkout.sessions.create(
    {
      mode: "payment",
      line_items: [{ quantity: 1, price_data: { currency: deal.currency, unit_amount: deal.amount_cents, product_data: { name: deal.description } } }],
      metadata,
      payment_intent_data: { description: deal.description, metadata, ...splitParams(split) } as Stripe.Checkout.SessionCreateParams.PaymentIntentData,
      success_url: urls.success_url,
      cancel_url: urls.cancel_url,
      expires_at: Math.max(minExp, urls.expires_at ?? 0),
    },
    { idempotencyKey: `checkout-${deal.deal_id}-${Math.floor(Date.now() / 60_000)}` },
  );
  if (!s.url) throw new Error("Stripe returned no Checkout URL");
  return { id: s.id, url: s.url };
}

/**
 * A completed Checkout that can no longer settle its deal (expired, already paid, policy re-check failed):
 * release the hold, or refund if it was captured at once. The buyer is never charged for a deal that didn't close.
 */
export async function voidCheckout(session_id: string, keep_payment_intent_id?: string): Promise<"released" | "refunded" | "nothing"> {
  const cs = await stripe().checkout.sessions.retrieve(session_id, { expand: ["payment_intent"] });
  const pi = cs.payment_intent as Stripe.PaymentIntent | null;
  if (!pi || pi.id === keep_payment_intent_id) return "nothing"; // that one IS the deal's payment
  if (pi.status === "requires_capture") { await stripe().paymentIntents.cancel(pi.id); return "released"; }
  if (pi.status === "succeeded") {
    await stripe().refunds.create({ payment_intent: pi.id, ...(pi.transfer_data ? { reverse_transfer: true, refund_application_fee: true } : {}) },
      { idempotencyKey: `void-${pi.id}` });
    return "refunded";
  }
  return "nothing";
}
