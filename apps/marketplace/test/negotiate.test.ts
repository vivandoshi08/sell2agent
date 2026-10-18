// Gateway negotiation tools → E1 exchange, driven like ChatGPT (no buyer_id on the first call).
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerNegotiationTools } from "../src/negotiate";

const tools = new Map<string, (a: any, rc?: any) => Promise<any>>();
registerNegotiationTools({ tool: (def: { name: string }, fn: (a: any, rc?: any) => Promise<any>) => tools.set(def.name, fn) });
const call = (name: string, a: any, rc?: any) => tools.get(name)!(a, rc);
// What mcp-use hands a handler for a ChatGPT request carrying _meta["openai/subject"].
const chatgpt = (subject: string) => ({ client: { user: () => ({ subject }) } });

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
  assert.equal(lost.structuredContent.error.code, "missing_buyer_id", "forgetting buyer_id can't hijack the negotiation");
  const other = await call("make_offer", { product_id: "kb_keyforge_quiet75", negotiation_id: s1.negotiation_id, offer_price_cents: 11000, buyer_id: "anon_someone-else" });
  assert.equal(other.structuredContent.error.code, "wrong_buyer");
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

test("ChatGPT user: openai/subject becomes a stable oai_ buyer_id, no echo needed", async () => {
  const me = chatgpt("v1/user-alice-123");
  const o = (await call("make_offer", { product_id: "kb_typewell_65", offer_price_cents: 11000 }, me)).structuredContent;
  assert.match(o.buyer_id, /^oai_[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(o).includes("user-alice-123"), "raw subject must not be returned");
  // Model forgets buyer_id on the next calls: the subject still identifies the same person.
  const o2 = (await call("make_offer", { product_id: "kb_typewell_65", negotiation_id: o.negotiation_id, offer_price_cents: 12000 }, me)).structuredContent;
  assert.equal(o2.buyer_id, o.buyer_id);
  const acc = (await call("accept_deal", { negotiation_id: o.negotiation_id, offer_id: o2.standing_offer.offer_id }, me)).structuredContent;
  assert.equal(acc.state, "agreed");
  // A new chat from the same person gets the same id.
  const again = (await call("make_offer", { product_id: "hp_typewell_buds", offer_price_cents: 9000 }, me)).structuredContent;
  assert.equal(again.buyer_id, o.buyer_id);
});

test("another ChatGPT user can't touch the first user's negotiation", async () => {
  const a = (await call("make_offer", { product_id: "hp_keyforge_anc", offer_price_cents: 15000 }, chatgpt("user-a"))).structuredContent;
  const b = (await call("check_offers", { negotiation_id: a.negotiation_id }, chatgpt("user-b"))).structuredContent;
  assert.equal(b.error.code, "wrong_buyer");
});

test("an explicit buyer_id wins over openai/subject (simulated buyers)", async () => {
  const o = (await call("make_offer", { product_id: "hp_clackco_studio", offer_price_cents: 12000, buyer_id: "sim-7" }, chatgpt("user-x"))).structuredContent;
  assert.equal(o.buyer_id, "sim-7");
});

// Regression (real ChatGPT run, 2026-10-17): with shared anon_ memory every new user opened at the last user's final price.
test("a second ChatGPT user doesn't inherit the first user's price", async () => {
  const p = "kb_clackco_tkl";
  const first = chatgpt("user-first");
  let r = (await call("make_offer", { product_id: p, offer_price_cents: 9000 }, first)).structuredContent;
  for (let i = 0; i < 4 && r.ok && r.allowed_actions.includes("offer"); i++)
    r = (await call("make_offer", { product_id: p, negotiation_id: r.negotiation_id, offer_price_cents: 9000 }, first)).structuredContent;
  const firstPrice = r.standing_offer.price_cents;
  await call("accept_deal", { negotiation_id: r.negotiation_id, offer_id: r.standing_offer.offer_id }, first);
  const second = (await call("make_offer", { product_id: p, offer_price_cents: 9000 }, chatgpt("user-second"))).structuredContent;
  assert.ok(second.standing_offer.price_cents > firstPrice, `second user opened at ${second.standing_offer.price_cents}, first ended at ${firstPrice}`);
  assert.equal(second.standing_offer.final, false);
});

// Vivan's repro on #48: a client without openai/subject (e.g. Claude) that drops buyer_id got a freshly minted
// anon_ id and a misleading wrong_buyer. Now only a first make_offer mints; later calls get missing_buyer_id.
test("no subject and no buyer_id on a later call: clear missing_buyer_id, nothing minted", async () => {
  const o = (await call("make_offer", { product_id: "kb_clackco_tkl", offer_price_cents: 10000 })).structuredContent;
  assert.match(o.buyer_id, /^anon_/);
  for (const [name, args] of [
    ["accept_deal", { negotiation_id: o.negotiation_id, offer_id: o.standing_offer.offer_id }],
    ["check_offers", { negotiation_id: o.negotiation_id }],
    ["walk_away", { negotiation_id: o.negotiation_id }],
    ["make_offer", { product_id: "kb_clackco_tkl", negotiation_id: o.negotiation_id, offer_price_cents: 10500 }],
  ] as const) {
    const r = await call(name, args);
    assert.equal(r.structuredContent.error.code, "missing_buyer_id", name);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /first make_offer/);
  }
  // Sending the id back still works afterwards: the negotiation wasn't touched.
  const acc = (await call("accept_deal", { negotiation_id: o.negotiation_id, offer_id: o.standing_offer.offer_id, buyer_id: o.buyer_id })).structuredContent;
  assert.equal(acc.state, "agreed");
});

// Bridge 2 eval A/B: the gateway passes `strategy` to the exchange, which honours it only for a signed eval run_id.
test("make_offer accepts an eval strategy and an unsigned run is otherwise unchanged", async () => {
  const base = { product_id: "kb_keyforge_quiet75", offer_price_cents: 9000, run_id: "s1-test-strategy" };
  const plain = (await call("make_offer", { ...base, buyer_id: "s1-strat-a" })).structuredContent;
  const withStrategy = (await call("make_offer", { ...base, buyer_id: "s1-strat-b", strategy: "static" })).structuredContent;
  assert.equal(withStrategy.ok, true);
  assert.equal(withStrategy.standing_offer.price_cents, plain.standing_offer.price_cents, "unsigned run_id must not change the seller");
});

// Contract v3: channel + agent_operator on every exchange call.
import { buyerChannel, toCtx } from "../src/negotiate";
const client = (name: string) => ({ client: { info: () => ({ name }) } });

test("channel and agent_operator from the client's name; explicit args win", () => {
  assert.deepEqual(buyerChannel({}, client("openai-mcp")), { channel: "mcp_app", agent_operator: "chatgpt" });
  assert.deepEqual(buyerChannel({}, client("instinct-agent")), { channel: "messaging", agent_operator: "instinct" });
  assert.deepEqual(buyerChannel({}, client("connectors-manager")), { channel: "mcp_app", agent_operator: "connectors-manager" });
  assert.deepEqual(buyerChannel({ channel: "harness", agent_operator: "harness" }, client("openai-mcp")), { channel: "harness", agent_operator: "harness" });
  assert.deepEqual(buyerChannel({ channel: "bogus" }), { channel: "mcp_app", agent_operator: "unknown" });
  const ctx = toCtx({ buyer_id: "b1" }, client("instinct-agent"));
  assert.equal(ctx.channel, "messaging");
  assert.equal(ctx.agent_operator, "instinct");
  assert.equal(ctx.buyer_model, "instinct");
});

// Instinct told a person there was "no stated expiry": the locked-deal text and summary must state it.
import { expiryText } from "../src/negotiate";
test("a locked deal's text and summary state when it expires", async () => {
  const o = (await call("make_offer", { product_id: "kb_typewell_65", offer_price_cents: 13900, buyer_id: "s1-exp-1", run_id: "s1-test-exp" })).structuredContent;
  const r = await call("accept_deal", { negotiation_id: o.negotiation_id, offer_id: o.standing_offer.offer_id, buyer_id: "s1-exp-1" });
  const d = r.structuredContent.deal;
  assert.ok(d.expires_at, "deal carries expires_at");
  assert.match(r.content[0].text, new RegExp(`expires ${d.expires_at.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(in about \\d+ min\\)`));
  if (r.structuredContent.summary) {
    assert.match(r.structuredContent.summary, /Expires (in about \d+ min|now) \(\d\d:\d\d UTC\)\./);
    assert.ok(r.structuredContent.summary.length <= 280);
  }
});
test("expiryText says expired once the deadline passes", () => {
  assert.equal(expiryText("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:15:00.000Z")), "2026-01-01T00:00:00.000Z (expired)");
  assert.match(expiryText("2026-01-01T00:15:00.000Z", Date.parse("2026-01-01T00:00:00.000Z")), /in about 15 min/);
});
