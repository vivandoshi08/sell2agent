// Offline tests for the money guardrails (no Stripe calls). Run: pnpm --filter @sa/payments test
import { test } from "node:test";
import assert from "node:assert/strict";
import { precheckToken, parseCredential } from "../src/seller";
import { checkSpend, needsHumanApproval } from "../src/wallet";
import type { Deal } from "../src/types";
import { platformFee, pickupCode, splitParams } from "../src/connect";

const deal: Deal = { deal_id: "d1", amount_cents: 11900, currency: "usd", description: "x", seller_id: "s" };
const ok = { currency: "usd", max_amount: 11900, expires_at: 2_000_000_000, deactivated_reason: null };

test("token that covers the deal passes", () => assert.deepEqual(precheckToken(deal, ok, 1_000), []));
test("token cap below deal is refused", () =>
  assert.match(precheckToken(deal, { ...ok, max_amount: 5000 }, 1_000)[0], /cap 5000 < deal total 11900/));
test("revoked token is refused", () =>
  assert.match(precheckToken(deal, { ...ok, deactivated_reason: "revoked" }, 1_000)[0], /revoked/));
test("expired token is refused", () => assert.ok(precheckToken(deal, { ...ok, expires_at: 500 }, 1_000).includes("token expired")));
test("currency mismatch is refused", () => assert.equal(precheckToken(deal, { ...ok, currency: "eur" }, 1_000).length, 1));

test("credential shapes parse", () => {
  assert.deepEqual(parseCredential("spt_123"), { kind: "spt", token: "spt_123" });
  assert.deepEqual(parseCredential({ credential: { type: "stripe_payment_token", token: "spt_9" } }), { kind: "spt", token: "spt_9" });
  assert.deepEqual(parseCredential({ test_card: "pm_card_visa" }), { kind: "test_card", pm: "pm_card_visa" });
});

const req = { deal_id: "d1", amount_cents: 11900, currency: "usd", seller_name: "S", description: "x" };
test("wallet allows within cap", () => assert.deepEqual(checkSpend(req, { per_purchase_cap_cents: 12000 }, 0), []));
test("wallet blocks over per-purchase cap", () => assert.equal(checkSpend(req, { per_purchase_cap_cents: 10000 }, 0).length, 1));
test("wallet blocks over total cap", () =>
  assert.match(checkSpend(req, { per_purchase_cap_cents: 20000, total_cap_cents: 15000 }, 5000)[0], /total cap/));
test("human approval threshold", () => {
  assert.equal(needsHumanApproval(req, { per_purchase_cap_cents: 20000, auto_approve_below_cents: 10000 }), true);
  assert.equal(needsHumanApproval(req, { per_purchase_cap_cents: 20000 }), false);
});

// ── Marketplace split + pickup (connect.ts): pure parts only ─────────────────────────────────────────

test("platform fee: 5% default, integer cents", () => {
  assert.equal(platformFee(3600, 500), 180);
  assert.equal(platformFee(3333, 500), 167);
  assert.equal(platformFee(3600, 0), 0);
});

test("split params: destination + fee, manual capture only when holding", () => {
  assert.deepEqual(splitParams(null), {});
  const held = splitParams({ account_id: "acct_1", fee_cents: 180, seller_cents: 3420, hold: true });
  assert.deepEqual(held, { application_fee_amount: 180, transfer_data: { destination: "acct_1" }, capture_method: "manual" });
  const now = splitParams({ account_id: "acct_1", fee_cents: 180, seller_cents: 3420, hold: false });
  assert.equal("capture_method" in now, false);
});

test("pickup code: 6 digits, stable per payment, differs across payments", () => {
  process.env.PICKUP_SECRET = "test-secret";
  const a = pickupCode("pi_A"), b = pickupCode("pi_B");
  assert.match(a, /^\d{6}$/);
  assert.equal(a, pickupCode("pi_A"));
  assert.notEqual(a, b);
});

test("parseCredential: checkout session", () => {
  assert.deepEqual(parseCredential({ checkout_session: "cs_test_1" }), { kind: "checkout", session: "cs_test_1" });
});
