// S2 deal-card + pay_deal tests. Offline: no Stripe, no Supabase.
// Run: node --import tsx --test apps/marketplace/src/deal/deal.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NegotiationEvent } from "@sa/shared";
import type { Deal, PaymentCredential, PaymentResult } from "@sa/payments";
import { assertPublic, createDealModule, createMockCatalog, createMockExchange, dealSummary, fixtureDeals, PRIVATE_KEYS, toDealCard } from "./index";

function setup(opts: { payStatus?: PaymentResult["status"] } = {}) {
  const charges: { deal: Deal; cred: PaymentCredential }[] = [];
  const events: NegotiationEvent[] = [];
  const exchange = createMockExchange();
  const mod = createDealModule({
    deals: exchange,
    catalog: createMockCatalog(),
    payDeal: async (deal, cred) => {
      charges.push({ deal, cred });
      await new Promise((r) => setTimeout(r, 5));
      return { status: opts.payStatus ?? "succeeded", deal_id: deal.deal_id, amount_cents: deal.amount_cents, mode: "test_card",
        payment_intent_id: `pi_test_${charges.length}`, card: "test card" };
    },
    logEvent: async (e) => { events.push(e); },
    defaultCredential: () => ({ test_card: "pm_card_visa" }),
  });
  return { mod, charges, events, exchange };
}

test("card shows list vs negotiated price, savings and every lever", async () => {
  const { mod } = setup();
  const c = await mod.reviewDeal("deal_demo_ready");
  assert.equal(c.status, "ready");
  assert.equal(c.list_total_cents, 14_900);
  assert.equal(c.total_cents, 11_900);
  assert.equal(c.savings_cents, 3_000);
  assert.deepEqual(c.levers.map((l) => l.label), ["Extended warranty · 2 years", "Free shipping · 2-day"]);
  assert.equal(c.test_mode, true);
  assert.match(dealSummary(c), /\$119\.00 \(list \$149\.00, save \$30\.00\)/);
});

test("card states: paid and expired", async () => {
  const { mod } = setup();
  assert.equal((await mod.reviewDeal("deal_demo_paid")).status, "paid");
  assert.equal((await mod.reviewDeal("deal_demo_expired")).status, "expired");
});

test("no private field can reach the card", () => {
  const leaky = { ...fixtureDeals()[0], floor_price_cents: 9_000, unit_cost_cents: 5_000 } as never;
  const card = toDealCard(leaky, { product_id: "kb_quietpro_75", title: "Q", list_price_cents: 14_900, seller_name: "K" });
  assert.doesNotThrow(() => assertPublic(card));
  const text = JSON.stringify(card);
  for (const k of PRIVATE_KEYS) assert.ok(!text.includes(k), `${k} leaked`);
  assert.throws(() => assertPublic({ a: { floor_price_cents: 1 } }), /private field/);
});

test("unknown deal gives an actionable error", async () => {
  const { mod } = setup();
  await assert.rejects(mod.reviewDeal("nope"), /accept_deal first/);
});

test("pays exactly the stored total, never a caller-supplied amount", async () => {
  const { mod, charges, events } = setup();
  const tampered = { deal_id: "deal_demo_ready", amount_cents: 1 } as never; // extra fields are ignored: only deal_id is read
  const r = await mod.payApprovedDeal((tampered as { deal_id: string }).deal_id);
  assert.equal(r.status, "succeeded");
  assert.equal(charges.length, 1);
  assert.equal(charges[0].deal.amount_cents, 11_900);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "payment_succeeded");
  assert.equal(events[0].price_cents, 11_900);
  assert.equal(events[0].payload.deal_id, "deal_demo_ready");
});

test("second click returns the first result, even with a different card", async () => {
  const { mod, charges } = setup();
  const first = await mod.payApprovedDeal("deal_demo_ready");
  const again = await mod.payApprovedDeal("deal_demo_ready", { test_card: "pm_card_mastercard" });
  assert.equal(charges.length, 1);
  assert.equal(again.payment_intent_id, first.payment_intent_id);
  assert.equal(again.already_paid, true);
});

test("concurrent double-click charges once", async () => {
  const { mod, charges } = setup();
  const [a, b] = await Promise.all([mod.payApprovedDeal("deal_demo_ready"), mod.payApprovedDeal("deal_demo_ready")]);
  assert.equal(charges.length, 1);
  assert.equal(a.payment_intent_id, b.payment_intent_id);
});

test("exchange refusals come back with a reason and a fix, and nothing is charged", async () => {
  const { mod, charges, events } = setup();
  const paid = await mod.payApprovedDeal("deal_demo_paid");
  assert.equal(paid.status, "succeeded");
  assert.equal(paid.already_paid, true);
  for (const [id, code] of [["deal_demo_expired", "expired"], ["nope", "unknown_deal"]] as const) {
    const r = await mod.payApprovedDeal(id);
    assert.equal(r.status, "refused");
    assert.equal(r.code, code);
    assert.ok(r.fix && r.reasons?.length);
  }
  const wrong = await mod.payApprovedDeal("deal_demo_ready", undefined, { buyer: { buyer_id: "someone_else" } });
  assert.equal(wrong.code, "wrong_buyer");
  assert.equal(charges.length, 0);
  assert.ok(events.every((e) => e.type === "payment_failed"));
});

test("a declined card is logged as payment_failed and can be retried", async () => {
  const { mod, charges, events } = setup({ payStatus: "declined" });
  const r = await mod.payApprovedDeal("deal_demo_ready");
  assert.equal(r.status, "declined");
  assert.equal(events.at(-1)?.type, "payment_failed");
  await mod.payApprovedDeal("deal_demo_ready", { test_card: "pm_card_visa" });
  assert.equal(charges.length, 2);
});

test("processing is not logged as a success yet", async () => {
  const { mod, events } = setup({ payStatus: "processing" });
  await mod.payApprovedDeal("deal_demo_ready");
  assert.equal(events.length, 0);
});

test("no credential and no test mode: refused with how to fix it", async () => {
  const mod = createDealModule({ deals: createMockExchange(), catalog: createMockCatalog(),
    payDeal: async () => { throw new Error("must not be called"); }, logEvent: async () => {}, defaultCredential: () => null });
  const r = await mod.payApprovedDeal("deal_demo_ready");
  assert.equal(r.status, "refused");
  assert.match(r.fix ?? "", /Shared Payment Token/);
});
