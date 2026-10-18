// Offline tests for the follow-up sim (no API keys). Run: pnpm --filter @sa/buyer-harness test
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBuyers, runFollowupSim, runProbers, ScriptedReplier, wilson, bootMean } from "../src";
import type { Brain, LlmBuyerTask, Replier } from "../src";

/** Walks after the seller's first counter, affordable or not (what LLM buyers sometimes do). */
const impatient: Brain = {
  model: "impatient",
  async run(task, exec) {
    const { listings } = JSON.parse(await exec("search_products", { query: "keyboard" }));
    const p = [...listings].sort((a: any, b: any) => a.list_price - b.list_price)[0];
    await exec("make_offer", { product_id: p.product_id, price: Math.min(Math.floor(p.list_price * 0.8), task.walkaway_cents / 100) });
    await exec("walk_away", { reason: "need to think about it" });
    return { steps: 3, done: true, input_tokens: 0, output_tokens: 0 };
  },
};
const task = (id: string, walk: number): LlmBuyerTask => ({ buyer_id: id, buyer_model: "scripted", persona: "balanced",
  profile: { price: 0.6, quality: 0.6, delivery: 0.5 }, goal: "keyboard", hard_needs: [], stated_budget_cents: walk - 1000, walkaway_cents: walk });
const fixed = (f: (offer_id: string) => string): Replier => ({ model: "fixed", reply: async ({ offer }) => ({ text: f(offer.offer_id), input_tokens: 0, output_tokens: 0 }) });

test("wilson and bootMean give sane intervals", () => {
  const r = wilson(5, 50);
  assert.ok(r.ci95[0] < 0.1 && r.ci95[1] > 0.1);
  assert.deepEqual(wilson(0, 0).ci95, [0, 0]);
  const m = bootMean([0, 0, 0, 100, 0, 0, 200, 0]);
  assert.equal(m.mean_cents, 38);
  assert.ok(m.ci95_cents[0] >= 0 && m.ci95_cents[1] > m.mean_cents);
});

test("a walk-away from an affordable offer is won back by ACCEPT at the pre-walk price, through exchange.inbound()", async () => {
  const buyers = [task("w1", 15000), task("w2", 15000), task("w3", 15000)];
  const r = await runFollowupSim({ run_id: "test_fu_accept", buyers, brain_for: () => impatient, consent_rate: 1, repeat_share: 0,
    replier: new ScriptedReplier({ question_share: 0 }) });
  assert.equal(r.off.conversions.k, 0);
  assert.equal(r.winback.sent, 3);
  assert.equal(r.winback.recovered, 3);
  for (const row of r.rows) {
    assert.equal(row.recovered_via, "accept");
    assert.equal(row.recovered!.price_cents, row.prewalk_seller_cents); // no new concession
    assert.ok(!row.recovered!.below_floor);
  }
  assert.equal(r.on.conversions.k, 3);
  assert.ok(r.lift.profit_per_buyer.mean_cents > 0);
  assert.equal(r.safety.passed, true);
});

test("the wallet blocks an ACCEPT above the walk-away in code; nothing is sent, no deal", async () => {
  const r = await runFollowupSim({ run_id: "test_fu_wallet", buyers: [task("poor", 9000)], brain_for: () => impatient, consent_rate: 1, repeat_share: 0,
    max_reply_turns: 2, replier: fixed((id) => `ACCEPT ${id}`) });
  const row = r.rows[0];
  assert.ok(row.followup, "follow-up sent");
  assert.equal(row.wallet_blocks, 2);
  assert.equal(row.recovered, null);
  assert.equal(r.safety.inbound_replies, 0);
});

test("STOP unsubscribes; questions get a clarifying reply, never a guessed move", async () => {
  const stop = await runFollowupSim({ run_id: "test_fu_stop", buyers: [task("s1", 15000)], brain_for: () => impatient, consent_rate: 1, repeat_share: 0,
    replier: fixed(() => "STOP") });
  assert.deepEqual(stop.safety.intents, { unsubscribe: 1 });
  assert.equal(stop.winback.recovered, 0);
  const ask = await runFollowupSim({ run_id: "test_fu_ask", buyers: [task("q1", 15000)], brain_for: () => impatient, consent_rate: 1, repeat_share: 0,
    max_reply_turns: 2, replier: fixed(() => "Does it come with a warranty?") });
  assert.deepEqual(ask.safety.intents, { clarify: 2 });
  assert.equal(ask.winback.recovered, 0);
});

test("scripted population: one follow-up per buyer per week, same-day repeat walks blocked, nothing below floor or pre-walk price", async () => {
  const buyers = makeBuyers({ n: 60, models: ["scripted"], seed: 42 });
  const r = await runFollowupSim({ run_id: "test_fu_pop", buyers, consent_rate: 1, repeat_share: 0.5, replier: new ScriptedReplier(), hold_at_cap: true });
  const s = r.safety;
  assert.ok(r.winback.sent > 0);
  assert.ok(s.repeat_walkers > 0);
  assert.equal(s.cap_blocks, s.repeat_walkers);
  assert.equal(s.max_followups_per_buyer_7d, 1);
  assert.equal(s.sends_after_first_drain, 0);
  assert.equal(s.below_floor_deals, 0);
  assert.equal(s.followup_below_prewalk, 0);
  assert.equal(s.followup_below_policy, 0);
  assert.equal(s.postcap_offer_below_prewalk, 0);
  assert.equal(s.no_new_concession, true);
  assert.ok(r.on.conversions.k >= r.off.conversions.k);
  assert.equal(r.off.profit_cents + r.rows.reduce((a, x) => a + (x.recovered?.profit_cents ?? 0), 0), r.on.profit_cents);
});

test("decline detector flags declines the parser read as moves, not plain counters", async () => {
  const { declinesReadAsMoves } = await import("../src/followup-sim");
  const row = (buyer: string, intent: string) => ({ buyer_id: "x", thread: [{ buyer, intent, seller: "" }] }) as any;
  assert.equal(declinesReadAsMoves([row("I'm passing on the TypeWell at $134.", "counter")]).length, 1);
  assert.equal(declinesReadAsMoves([row("I can't accept this one. My counter remains $106.", "counter")]).length, 1);
  assert.equal(declinesReadAsMoves([row("COUNTER $106", "counter"), row("No thanks.", "walk")]).length, 0);
});

test("probing: with hold-at-cap, walking away and countering never beats the same bid made before walking", async () => {
  const p = await runProbers({ run_id: "test_probe", per_product: 4, hold_at_cap: true });
  assert.equal(p.probers, 16);
  assert.equal(p.walk_cheaper, 0);
  assert.equal(p.below_floor, 0);
});
