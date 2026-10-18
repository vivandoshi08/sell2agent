// review_deal / pay_deal on the gateway, wired to the same exchange as make_offer / accept_deal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerNegotiationTools } from "../src/negotiate";
import { registerDealTools } from "../src/deal-tools";

const tools = new Map<string, (a: any) => Promise<any>>();
const server = { tool: (def: { name: string }, fn: (a: any) => Promise<any>) => tools.set(def.name, fn) };
registerNegotiationTools(server);
registerDealTools(server);
const call = (name: string, a: any) => tools.get(name)!(a);

async function lockDeal(buyer_id: string) {
  const o = (await call("make_offer", { product_id: "kb_typewell_65", offer_price_cents: 13900, buyer_id, run_id: "s1-test-deal" })).structuredContent;
  const acc = (await call("accept_deal", { negotiation_id: o.negotiation_id, offer_id: o.standing_offer.offer_id, buyer_id })).structuredContent;
  return acc.deal;
}

test("review_deal shows the locked deal as a public card", async () => {
  const deal = await lockDeal("s1-test-buyer-a");
  const r = await call("review_deal", { deal_id: deal.deal_id, buyer_id: "s1-test-buyer-a" });
  const card = r.structuredContent;
  assert.equal(card.deal_id, deal.deal_id);
  assert.equal(card.total_cents, deal.total_cents);
  assert.equal(card.seller_name, "TypeWell");
  assert.equal(card.status, "ready");
  assert.match(r.content[0].text, /TypeWell 65 Silent/);
  const json = JSON.stringify(r);
  for (const k of ["floor_price_cents", "unit_cost_cents", "target_margin_pct", "signature"]) assert.ok(!json.includes(k), `leaked ${k}`);
});

test("review_deal on an unknown deal is an error the model can act on", async () => {
  const r = await call("review_deal", { deal_id: "deal_nope", buyer_id: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /accept_deal/);
});

test("pay_deal refuses a buyer who didn't accept the deal, before any charge", async () => {
  const deal = await lockDeal("s1-test-buyer-b");
  const r = (await call("pay_deal", { deal_id: deal.deal_id, buyer_id: "someone-else" })).structuredContent;
  assert.equal(r.status, "refused");
  assert.ok(!r.payment_intent_id);
});

test("pay_deal without any buyer_id (no subject) is a clear error, not a charge", async () => {
  const deal = await lockDeal("s1-test-buyer-c");
  const r = await call("pay_deal", { deal_id: deal.deal_id });
  assert.equal(r.structuredContent.error.code, "missing_buyer_id");
  assert.equal(r.isError, true);
});
