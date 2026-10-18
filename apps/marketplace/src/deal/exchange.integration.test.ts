// S2 deal card + pay_deal against E1's REAL exchange (in-memory store, seed catalog, scripted voice).
// Run: node --import tsx --test apps/marketplace/src/deal/exchange.integration.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NegotiationEvent } from "@sa/shared";
import type { Deal } from "@sa/payments";
import { Exchange } from "../../../seller-mcp/src/exchange/index";
import { createDealModule, fromExchange } from "./index";

async function lockedDeal(ex: Exchange, buyer_id = "b_s2_int") {
  const ctx = { run_id: "s2-test-int", buyer_id, buyer_model: "scripted" };
  const offer: any = await ex.handle({ kind: "offer", ctx, product_id: "kb_keyforge_quiet75", offer_price_cents: 12_900 } as any);
  assert.ok(offer.ok, `offer failed: ${JSON.stringify(offer)}`);
  const so = offer.standing_offer;
  const acc: any = await ex.handle({ kind: "accept", ctx, negotiation_id: offer.negotiation_id, offer_id: so?.offer_id ?? offer.offer_id } as any);
  if (!acc.ok) throw new Error(`accept failed: ${JSON.stringify(acc)}\noffer was: ${JSON.stringify(offer)}`);
  return { ctx, deal_id: acc.deal.deal_id as string, total: acc.deal.total_cents as number };
}

function setup(ex: Exchange) {
  const charges: Deal[] = [];
  const events: NegotiationEvent[] = [];
  const mod = createDealModule({
    deals: fromExchange(ex as any),
    payDeal: async (deal) => { charges.push(deal); return { status: "succeeded", deal_id: deal.deal_id, amount_cents: deal.amount_cents, mode: "test_card", payment_intent_id: `pi_test_${charges.length}` }; },
    logEvent: async (e) => { events.push(e); },
    defaultCredential: () => ({ test_card: "pm_card_visa" }),
  });
  return { mod, charges, events };
}

test("real exchange: card from a locked deal, pay once, exchange marks it paid", async () => {
  const ex = new Exchange();
  const { ctx, deal_id, total } = await lockedDeal(ex);
  const { mod, charges, events } = setup(ex);

  const card = await mod.reviewDeal(deal_id);
  assert.equal(card.status, "ready");
  assert.equal(card.product.title, "KeyForge Quiet 75");
  assert.equal(card.total_cents, total);
  assert.equal(card.seller_name, "Keyforge");

  const r = await mod.payApprovedDeal(deal_id, undefined, { buyer: ctx });
  assert.equal(r.status, "succeeded");
  assert.equal(charges.length, 1);
  assert.equal(charges[0].amount_cents, total);
  assert.equal(events.at(-1)?.type, "payment_succeeded");
  assert.equal((await ex.deals.getLockedDeal(deal_id))?.status, "paid");
  assert.equal((await mod.reviewDeal(deal_id)).status, "paid");

  // A fresh handler (e.g. after a gateway restart) still won't charge again: the exchange says already_paid.
  const again = await setup(ex).mod.payApprovedDeal(deal_id, undefined, { buyer: ctx });
  assert.equal(again.already_paid, true);
  assert.equal(again.payment_intent_id, "pi_test_1");
});

test("real exchange: wrong or missing buyer is refused before any charge", async () => {
  const ex = new Exchange();
  const { deal_id } = await lockedDeal(ex);
  const { mod, charges } = setup(ex);
  const wrong = await mod.payApprovedDeal(deal_id, undefined, { buyer: { buyer_id: "someone_else" } });
  assert.equal(wrong.code, "wrong_buyer");
  const missing = await mod.payApprovedDeal(deal_id);
  assert.equal(missing.code, "wrong_buyer");
  assert.match(missing.fix ?? "", /buyer_id/);
  assert.equal(charges.length, 0);
});

test("real exchange: approve-link payment (no run_id) logs the negotiation's run_id and buyer_model, not live", async () => {
  const ex = new Exchange();
  const { deal_id } = await lockedDeal(ex, "b_link");
  const { mod, events } = setup(ex);
  // What approvePay passes: just the buyer_id from the signed token.
  const r = await mod.payApprovedDeal(deal_id, undefined, { buyer: { buyer_id: "b_link" } });
  assert.equal(r.status, "succeeded");
  const e = events.at(-1)!;
  assert.equal(e.type, "payment_succeeded");
  assert.equal(e.run_id, "s2-test-int");
  assert.equal(e.buyer_model, "scripted");

  // A caller-supplied run_id can't relabel the deal's run either.
  const ex2 = new Exchange();
  const d2 = await lockedDeal(ex2, "b_tool");
  const s2 = setup(ex2);
  await s2.mod.payApprovedDeal(d2.deal_id, undefined, { buyer: { buyer_id: "b_tool", run_id: "relabel" }, run_id: "relabel" });
  assert.equal(s2.events.at(-1)?.run_id, "s2-test-int");
});

test("payment events fall back to the caller's run_id, then live, when the negotiation can't be found", async () => {
  const pay = async (ctx: { buyer: { buyer_id: string }; run_id?: string }) => {
    const ex = new Exchange();
    const { deal_id } = await lockedDeal(ex, ctx.buyer.buyer_id);
    const gone = { deals: ex.deals, markPaid: (d: string, pi: string) => ex.markPaid(d, pi), store: { getNegotiation: async () => null } };
    const { mod, events } = setup(gone as unknown as Exchange);
    await mod.payApprovedDeal(deal_id, undefined, ctx);
    assert.equal(events.at(-1)?.type, "payment_succeeded");
    return events.at(-1)!;
  };
  assert.equal((await pay({ buyer: { buyer_id: "b_gone" } })).run_id, "live");
  assert.equal((await pay({ buyer: { buyer_id: "b_gone2" }, run_id: "caller_run" })).run_id, "caller_run");
});
