/**
 * 10-minute go/no-go (docs/tracks/stripe.md checklist step 3). Run: `pnpm stripe:smoke`
 * Hits the real Stripe TEST API with your sandbox key and prints which payment mode to use.
 *
 *  1. SPT happy path: wallet mints an SPT capped at the deal → seller charges it  → expect succeeded
 *  2. Over-cap:       token minted for less than the deal                        → expect refused
 *  3. Revoked:        token revoked before charge                                → expect refused
 *  4. Declined card:  token backed by pm_card_visa_chargeDeclined                → expect declined
 *  5. Wallet cap:     deal above the buyer's per-purchase cap                     → refused in code, no API call
 *  6. Fallback A:     plain test card PaymentIntent                               → expect succeeded
 */
import { resolve } from "node:path";
import { stripe } from "./client";
import { payDeal } from "./seller";
import { BuyerWallet } from "./wallet";
import type { Deal } from "./types";

try {
  process.loadEnvFile(resolve(import.meta.dirname, "../../../.env"));
} catch {
  /* fine if env already exported */
}

const run = Date.now().toString(36);
const deal = (n: number, amount = 11900): Deal => ({
  deal_id: `smoke_${run}_${n}`,
  amount_cents: amount,
  currency: "usd",
  description: `Smoke test deal ${n}`,
  seller_id: "s_smoke",
});
const req = (d: Deal) => ({ deal_id: d.deal_id, amount_cents: d.amount_cents, currency: "usd", seller_name: "Smoke Seller", description: d.description });

type Row = { name: string; expect: string; got: string; ok: boolean; detail?: string };
const rows: Row[] = [];
async function check(name: string, expect: string, fn: () => Promise<{ got: string; detail?: string }>) {
  try {
    const { got, detail } = await fn();
    rows.push({ name, expect, got, ok: got === expect, detail });
  } catch (e) {
    rows.push({ name, expect, got: "exception", ok: false, detail: (e as Error).message });
  }
}

stripe(); // fails fast on a missing or live key
process.env.STRIPE_PAYMENT_MODE = "spt";
const wallet = new BuyerWallet({ per_purchase_cap_cents: 20000 });

await check("1. SPT happy path", "succeeded", async () => {
  const d = deal(1);
  const g = await wallet.requestPaymentToken(req(d));
  if (!g.approved || !g.credential) return { got: "wallet_refused", detail: g.reasons?.join("; ") };
  const r = await payDeal(d, g.credential);
  return { got: r.status, detail: r.payment_intent_id ?? r.message ?? r.reasons?.join("; ") };
});

await check("2. Token cap below deal", "refused", async () => {
  const d = deal(2);
  const g = await wallet.requestPaymentToken({ ...req(d), amount_cents: 5000 });
  const r = await payDeal(d, g.credential!);
  return { got: r.status, detail: r.reasons?.join("; ") };
});

await check("3. Revoked token", "refused", async () => {
  const d = deal(3);
  const g = await wallet.requestPaymentToken(req(d));
  await wallet.revoke(g.credential as string);
  const r = await payDeal(d, g.credential!);
  return { got: r.status, detail: r.reasons?.join("; ") };
});

await check("4. Declined card behind token", "declined", async () => {
  const d = deal(4);
  const w = new BuyerWallet({ per_purchase_cap_cents: 20000, test_payment_method: "pm_card_visa_chargeDeclined" });
  const g = await w.requestPaymentToken(req(d));
  const r = await payDeal(d, g.credential!);
  return { got: r.status, detail: r.code ?? r.message };
});

await check("5. Over buyer cap (code, no API)", "wallet_refused", async () => {
  const d = deal(5, 25000);
  const g = await wallet.requestPaymentToken(req(d));
  return { got: g.approved ? "approved" : "wallet_refused", detail: g.reasons?.join("; ") };
});

await check("6. Fallback A: test card", "succeeded", async () => {
  const d = deal(6);
  const r = await payDeal(d, { test_card: "pm_card_visa" });
  return { got: r.status, detail: r.payment_intent_id ?? r.message };
});

console.log("\nStripe smoke test\n");
for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(34)} expected ${r.expect.padEnd(14)} got ${r.got}${r.detail ? `  (${r.detail})` : ""}`);

const sptWorks = rows[0].ok;
const cardWorks = rows[5].ok;
console.log(
  sptWorks
    ? "\n→ Shared Payment Tokens work. Set STRIPE_PAYMENT_MODE=spt in .env."
    : cardWorks
      ? "\n→ SPTs are NOT available on this sandbox. Set STRIPE_PAYMENT_MODE=test_card (Fallback A) and ask at the Stripe booth."
      : "\n→ Nothing charged. Check the key is a sandbox sk_test_ key and see the errors above.",
);
console.log("Paste any unexpected error codes into docs/tracks/stripe.md (§1 'Error behavior').");
process.exit(sptWorks || cardWorks ? 0 : 1);
