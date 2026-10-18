/** Offline: builds signed `checkout.session.completed` payloads with the stripe SDK test helper. No network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { Deals, lockDeal } from "../../apps/seller-mcp/src/exchange/deals";
import { MemoryStore } from "../../apps/seller-mcp/src/exchange/store";
import type { Catalog, LockedDeal } from "../../apps/seller-mcp/src/exchange/types";
import { checkoutParams, handleStripeEvent, type WebhookDeps } from "./checkout";

const SECRET = "whsec_spike_local";
const stripe = new Stripe("sk_test_offline_dummy");
const catalog: Catalog = { get: async () => ({ product_id: "p1", seller_id: "s1", title: "Aeron", list_price_cents: 4500,
  floor_price_cents: 3000, unit_cost_cents: 2000, max_rounds: 6, allowed_levers: [], strategy: "negotiating" }) };

async function setup(now = Date.now()) {
  const store = new MemoryStore();
  let clock = now;
  const deals = new Deals(store, catalog, () => clock);
  const deal = lockDeal({ negotiation_id: "n1", offer_id: "o1", buyer_id: "b1", seller_id: "s1", product_id: "p1", title: "Aeron",
    quantity: 1, unit_price_cents: 3600, list_price_cents: 4500, levers: [] }, now);
  await store.putDeal(deal);
  const events: any[] = [], refunds: string[] = [];
  const deps: WebhookDeps = { stripe, webhookSecret: SECRET, deals, logEvent: async (e) => { events.push(e); },
    refund: async (pi, why) => { refunds.push(`${pi}:${why}`); } };
  return { store, deals, deal, deps, events, refunds, advance: (ms: number) => { clock += ms; } };
}

function signed(deal: LockedDeal, o: { pi?: string; amount?: number; livemode?: boolean; paid?: boolean; type?: string } = {}) {
  const payload = JSON.stringify({ id: "evt_test", object: "event", type: o.type ?? "checkout.session.completed", livemode: o.livemode ?? false,
    data: { object: { id: "cs_test_1", object: "checkout.session", amount_total: o.amount ?? deal.total_cents, currency: "usd",
      payment_status: o.paid === false ? "unpaid" : "paid", payment_intent: o.pi ?? "pi_1", client_reference_id: deal.deal_id,
      metadata: { deal_id: deal.deal_id, buyer_id: deal.buyer_id } } } });
  return { payload, sig: stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }) };
}

test("checkoutParams: amount from deal, no buyer knobs", async () => {
  const { deal } = await setup();
  const p = checkoutParams(deal, "https://x/ok");
  assert.equal(p.line_items![0].price_data!.unit_amount, 3600);
  assert.equal(p.line_items![0].adjustable_quantity, undefined);
  assert.equal(p.allow_promotion_codes, false);
  assert.equal(p.metadata!.deal_id, deal.deal_id);
});

test("completed + paid → markPaid + payment_succeeded; retry is a no-op", async () => {
  const { deal, deps, events, store, refunds } = await setup();
  const { payload, sig } = signed(deal);
  assert.deepEqual(await handleStripeEvent(payload, sig, deps), { status: 200, result: "paid", deal_id: deal.deal_id });
  assert.equal((await store.getDeal(deal.deal_id))!.status, "paid");
  assert.equal(events[0].type, "payment_succeeded");
  assert.equal((await handleStripeEvent(payload, sig, deps) as any).result, "duplicate");
  assert.equal(events.length, 1);
  assert.equal(refunds.length, 0);
});

test("bad signature → 400, nothing happens", async () => {
  const { deal, deps, events } = await setup();
  const { payload } = signed(deal);
  assert.equal((await handleStripeEvent(payload, "t=1,v1=deadbeef", deps)).status, 400);
  assert.equal(events.length, 0);
});

test("amount mismatch → refund + guardrail_blocked", async () => {
  const { deal, deps, events, refunds } = await setup();
  const { payload, sig } = signed(deal, { amount: 100 });
  assert.equal((await handleStripeEvent(payload, sig, deps) as any).code, "amount_mismatch");
  assert.deepEqual(refunds, ["pi_1:amount_mismatch"]);
  assert.equal(events[0].type, "guardrail_blocked");
});

test("second session paid for same deal → refund (one charge per deal)", async () => {
  const { deal, deps, refunds } = await setup();
  const a = signed(deal, { pi: "pi_1" }), b = signed(deal, { pi: "pi_2" });
  await handleStripeEvent(a.payload, a.sig, deps);
  assert.equal((await handleStripeEvent(b.payload, b.sig, deps) as any).code, "already_paid");
  assert.deepEqual(refunds, ["pi_2:already_paid"]);
});

test("paid after deal expiry → refund", async () => {
  const { deal, deps, refunds, advance } = await setup();
  advance(31 * 60_000);
  const { payload, sig } = signed(deal);
  assert.equal((await handleStripeEvent(payload, sig, deps) as any).code, "expired");
  assert.equal(refunds.length, 1);
});

test("livemode event refused; unpaid and other events ignored", async () => {
  const { deal, deps } = await setup();
  const live = signed(deal, { livemode: true });
  assert.equal((await handleStripeEvent(live.payload, live.sig, deps) as any).code, "livemode_refused");
  const unpaid = signed(deal, { paid: false });
  assert.equal((await handleStripeEvent(unpaid.payload, unpaid.sig, deps) as any).result, "ignored");
  const other = signed(deal, { type: "payment_intent.created" });
  assert.equal((await handleStripeEvent(other.payload, other.sig, deps) as any).result, "ignored");
});

test("forged deal_id (unknown) → refund", async () => {
  const { deal, deps } = await setup();
  const { payload, sig } = signed({ ...deal, deal_id: "deal_forged" });
  assert.equal((await handleStripeEvent(payload, sig, deps) as any).code, "unknown_deal");
});
