// E2 unit tests (offline, no LLM). Run: pnpm --filter @sa/seller-mcp test
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, softFloor, checkMessage, templateMessage, voice, lookupAnswer, answerQuestion } from "../src/sellers";
import type { SellerState, ProductTerms, ProposedMove, PublicProduct } from "../src/sellers";

const terms: ProductTerms = { product_id: "kb", title: "KeyForge Quiet 75", list_price_cents: 12900, floor_price_cents: 10500, unit_cost_cents: 6000, max_rounds: 8 };
const st = (round: number, history: SellerState["history"] = [], bid?: number): SellerState => ({ round, terms, history, buyer_offer_cents: bid });
const neg = { name: "negotiating" as const };

test("negotiating opens at list in round 1", () => {
  const m = decide(st(1, [], 9000), neg);
  assert.equal(m.action, "offer"); assert.equal(m.price_cents, 12900); assert.equal(m.reason, "opening_at_list"); assert.equal(m.final, false);
});

test("concedes slowly: never more than 75% of the gap, never below soft floor, never back up", () => {
  const hist: SellerState["history"] = []; let prev = Infinity;
  for (let r = 1; r <= 8; r++) {
    const m = decide(st(r, hist, 9000), neg);
    assert.equal(m.action, "offer");
    assert.ok(m.price_cents <= prev, `round ${r} went back up`);
    assert.ok(m.price_cents >= softFloor(12900, 10500), `round ${r} below soft floor`);
    assert.ok(12900 - m.price_cents <= 0.75 * (12900 - 10500) + 100, `round ${r} conceded more than 75%`);
    assert.equal(m.final, r === 8);
    hist.push({ by: "seller", round: r, price_cents: m.price_cents }); prev = m.price_cents;
  }
});

test("accepts a bid at or above the current ask", () => {
  const m = decide(st(3, [{ by: "seller", round: 1, price_cents: 12900 }], 12900), neg);
  assert.equal(m.action, "accept"); assert.equal(m.price_cents, 12900);
});

test("never charges above list, even if the buyer offers more", () => {
  for (const name of ["static", "negotiating", "balanced"] as const) {
    const m = decide(st(1, [], 15000), { name });
    assert.deepEqual([m.action, m.price_cents], ["accept", 12900], name);
  }
});

test("never accepts below hard floor, even on the final round with the accept zone", () => {
  const m = decide(st(8, [], 10400), { name: "negotiating", final_round_accept_zone: true });
  assert.equal(m.action, "offer");
  const z = decide(st(8, [], 10500), { name: "balanced", final_round_accept_zone: true });
  assert.equal(z.action, "accept");
});

test("static always offers list, final", () => {
  const m = decide(st(5, [], 12000), { name: "static" });
  assert.deepEqual([m.action, m.price_cents, m.final, m.reason], ["offer", 12900, true, "fixed_price"]);
});

const move: ProposedMove = { action: "offer", price_cents: 12500, final: false, reason: "pacing", reason_text: "We can come down from $129 to $125 this round.", conceded_fraction: 0.2 };
const ctx = { terms, prior_prices_cents: [12900] };
test("message check catches a wrong price, floor talk, and a false 'final'", () => {
  assert.deepEqual(checkMessage("I can do $125 for the KeyForge.", move, ctx), []);
  assert.ok(checkMessage("I can do $119 for you.", move, ctx).some((w) => w.includes("$119")));
  assert.ok(checkMessage("$125 is close to our floor.", move, ctx).some((w) => w.includes("floor")));
  assert.ok(checkMessage("$125 is my final offer.", move, ctx).some((w) => w.includes("final")));
  assert.deepEqual(checkMessage("$125 this round; not our final number.", move, ctx), []);
});
test("template always passes the check", () => assert.deepEqual(checkMessage(templateMessage(move, ctx), move, ctx), []));
test("voice falls back to the template when the LLM keeps lying", async () => {
  const liar = async () => "Fine, $99. Final answer.";
  const r = await voice(move, ctx, liar);
  assert.equal(r.source, "template"); assert.ok(r.violations.length >= 2);
});
test("voice keeps a good LLM message", async () => {
  const r = await voice(move, ctx, async () => "Good news: I can bring it to $125 this round.");
  assert.equal(r.source, "llm");
});

const prod: PublicProduct = { product_id: "kb", title: "KeyForge Quiet 75", description: "75% layout, silent linear switches, hot-swap, wireless.",
  specs: { layout: "75%", switch: "silent linear", hot_swap: true, wireless: true, battery_hours: 200 }, list_price_cents: 12900, shipping_days: 3 };
test("grounded lookup answers from specs", () => {
  const a = lookupAnswer(prod, "Is it wireless and how is the battery?")!;
  assert.equal(a.grounded, true); assert.match(a.answer, /wireless: yes/); assert.match(a.answer, /200/);
});
test("unknown questions get an honest I don't know", async () => {
  const a = await answerQuestion(prod, "Does it come in pink?", null);
  assert.equal(a.grounded, false); assert.match(a.answer, /don't know/);
});
test("LLM answers with numbers not in the catalog are rejected", async () => {
  const a = await answerQuestion(prod, "What's the weight?", async () => '{"grounded":true,"answer":"It weighs 850 g.","fields":["layout"]}');
  assert.equal(a.grounded, false);
});
