// Offline tests for the money guardrails (no Stripe calls). Run: pnpm --filter @sa/payments test
import { test } from "node:test";
import assert from "node:assert/strict";
import { precheckToken, parseCredential } from "../src/seller";
import { checkSpend, needsHumanApproval } from "../src/wallet";
import type { Deal } from "../src/types";

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
