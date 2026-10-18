// Gateway negotiation tools → E1 exchange, driven like ChatGPT (no buyer_id on the first call).
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerNegotiationTools } from "../src/negotiate";

const tools = new Map<string, (a: any) => Promise<any>>();
registerNegotiationTools({ tool: (def: { name: string }, fn: (a: any) => Promise<any>) => tools.set(def.name, fn) });
const call = (name: string, a: any) => tools.get(name)!(a);

test("anonymous buyer: first offer mints anon_ id; later calls must echo it; accept locks a deal", async () => {
  const r1 = await call("make_offer", { product_id: "kb_keyforge_quiet75", offer_price_cents: 10000 });
  const s1 = r1.structuredContent;
  assert.match(s1.buyer_id, /^anon_/);
  assert.equal(s1.ok, true);
  assert.match(r1.content[0].text, /buyer_id anon_/);
  const r2 = await call("make_offer", { product_id: "kb_keyforge_quiet75", negotiation_id: s1.negotiation_id, offer_price_cents: 11000, buyer_id: s1.buyer_id });
  const s2 = r2.structuredContent;
  assert.equal(s2.round, 2);
  const lost = await call("make_offer", { product_id: "kb_keyforge_quiet75", negotiation_id: s1.negotiation_id, offer_price_cents: 11000 });
  assert.equal(lost.structuredContent.error.code, "wrong_buyer", "forgetting buyer_id can't hijack the negotiation");
  const acc = await call("accept_deal", { negotiation_id: s1.negotiation_id, offer_id: s2.standing_offer.offer_id, buyer_id: s1.buyer_id });
  assert.equal(acc.structuredContent.state, "agreed");
  assert.ok(acc.structuredContent.deal.total_cents >= 10500);
  const chk = await call("check_offers", { negotiation_id: s1.negotiation_id, buyer_id: s1.buyer_id });
  assert.equal(chk.structuredContent.deal.deal_id, acc.structuredContent.deal.deal_id);
});

test("walk_away with follow-up consent", async () => {
  const r = (await call("make_offer", { product_id: "kb_clackco_tkl", offer_price_cents: 9000, buyer_id: "sim-1", run_id: "e1-test-gw" })).structuredContent;
  const w = (await call("walk_away", { negotiation_id: r.negotiation_id, buyer_id: "sim-1", allow_followup_to: "agent@example.test" })).structuredContent;
  assert.equal(w.state, "walked_away");
});
