/**
 * "My store" HTTP API for one human seller, mounted on the dashboard's Vite dev server (vite.config.ts). SERVER-SIDE ONLY.
 *
 *   GET  /api/store/:seller_id            → { seller, listings, account, fee_bps, payments }
 *   POST /api/store/:seller_id/connect    → { url } Stripe-hosted onboarding (creates the connected account if needed)
 *   POST /api/store/:seller_id/payouts    → { url } the seller's Stripe Express dashboard
 *   POST /api/store/:seller_id/capture    { payment_intent_id, code } → buyer showed up: capture the hold
 *   POST /api/store/:seller_id/release    { payment_intent_id }       → no-show: release the hold
 *
 * Money logic lives in @sa/payments (connect.ts); this file only routes. No sign-in yet: the dashboard runs locally
 * for the seller, like /console.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PickupResult, SellerAccount, SellerPayment } from "@sa/payments";

export interface StoreListing { id: string; title: string; list_price_cents: number; floor_price_cents: number | null; in_stock: boolean }
export interface StoreView {
  seller: { id: string; name: string };
  listings: StoreListing[];
  account: SellerAccount | null;
  fee_bps: number;
  payments: SellerPayment[];
  /** set when Stripe can't be reached, so the page still shows listings */
  stripe_error?: string;
}

/** What the routes need; injected so tests can fake Stripe and the DB. */
export interface StoreDeps {
  seller(seller_id: string): Promise<{ id: string; name: string } | null>;
  listings(seller_id: string): Promise<StoreListing[]>;
  payments: {
    sellerAccount(seller_id: string, o?: { fresh?: boolean }): Promise<SellerAccount | null>;
    ensureSellerAccount(seller_id: string, o?: { name?: string }): Promise<SellerAccount>;
    onboardingLink(account_id: string, urls: { return_url: string; refresh_url: string }): Promise<string>;
    dashboardLink(account_id: string): Promise<string>;
    sellerPayments(seller_id: string): Promise<SellerPayment[]>;
    capturePickup(pi: string, seller_id: string, code: string): Promise<PickupResult>;
    releaseHold(pi: string, seller_id: string): Promise<PickupResult>;
    feeBps(): number;
  };
}

const MAX_BODY = 16 * 1024;
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) throw new Error("body too large"); }
  return raw ? JSON.parse(raw) : {};
}
function send(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(data));
}
const str = (v: unknown) => (typeof v === "string" ? v : "");

export async function storeView(deps: StoreDeps, seller_id: string): Promise<StoreView | null> {
  const seller = await deps.seller(seller_id);
  if (!seller) return null;
  const listings = await deps.listings(seller_id);
  try {
    const [account, payments] = await Promise.all([deps.payments.sellerAccount(seller_id, { fresh: true }), deps.payments.sellerPayments(seller_id)]);
    return { seller, listings, account, fee_bps: deps.payments.feeBps(), payments };
  } catch (e) {
    return { seller, listings, account: null, fee_bps: deps.payments.feeBps(), payments: [], stripe_error: (e as Error).message };
  }
}

/** Connect-style middleware. Calls next() for anything outside /api/store. */
export function storeApi(deps: StoreDeps) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/api/store/")) return next();
    try {
      const [, , , rawId, action] = url.pathname.split("/"); // "", api, store, seller_id, action
      const seller_id = decodeURIComponent(rawId ?? "");
      if (!seller_id) return send(res, 400, { error: "seller id missing" });
      if (req.method === "GET" && !action) {
        const v = await storeView(deps, seller_id);
        return v ? send(res, 200, v) : send(res, 404, { error: `Unknown seller ${seller_id}` });
      }
      if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
      const seller = await deps.seller(seller_id);
      if (!seller) return send(res, 404, { error: `Unknown seller ${seller_id}` });
      // Links come back to the page the seller is on (the dev server's own origin).
      const origin = `http://${req.headers.host ?? "localhost"}`;
      const page = `${origin}/store?seller=${encodeURIComponent(seller_id)}`;
      if (action === "connect") {
        const acct = await deps.payments.ensureSellerAccount(seller_id, { name: seller.name });
        return send(res, 200, { url: await deps.payments.onboardingLink(acct.id, { return_url: `${page}&onboarded=1`, refresh_url: page }) });
      }
      if (action === "payouts") {
        const acct = await deps.payments.sellerAccount(seller_id, { fresh: true });
        if (!acct) return send(res, 409, { error: "Connect payouts first." });
        return send(res, 200, { url: await deps.payments.dashboardLink(acct.id) });
      }
      if (action === "capture" || action === "release") {
        const b = await body(req);
        const pi = str(b.payment_intent_id);
        if (!/^pi_[A-Za-z0-9_]+$/.test(pi)) return send(res, 400, { ok: false, reason: "payment_intent_id missing" });
        const r = action === "capture" ? await deps.payments.capturePickup(pi, seller_id, str(b.code)) : await deps.payments.releaseHold(pi, seller_id);
        return send(res, r.ok ? 200 : 409, r);
      }
      return send(res, 404, { error: "Not found" });
    } catch (e) {
      return send(res, 500, { error: (e as Error).message });
    }
  };
}
