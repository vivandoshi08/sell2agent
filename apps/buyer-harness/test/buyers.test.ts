// Offline tests for the buyer harness (no API keys). Run: pnpm --filter @sa/buyer-harness test
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAll, runBuyer, makeBuyers, LocalGateway, ScriptedBrain } from "../src";
import type { Brain, LlmBuyerTask } from "../src";

const quiet = () => {};

test("makeBuyers covers all 5 personas, alternates models, includes red-team buyers", () => {
  const bs = makeBuyers({ n: 20, models: ["claude", "gpt"], seed: 1 });
  assert.equal(new Set(bs.map((b) => b.persona)).size, 5);
  assert.deepEqual([bs[0].buyer_model, bs[1].buyer_model], ["claude", "gpt"]);
  assert.ok(bs.some((b) => b.adversary));
  assert.ok(bs.every((b) => b.stated_budget_cents < b.walkaway_cents));
});

test("runAll with scripted buyers closes deals, none below floor", async () => {
  const buyers = makeBuyers({ n: 10, models: ["scripted"], seed: 7 });
  const { summary } = await runAll({ run_id: "test_run", label: "negotiating", buyers, gateway: new LocalGateway("negotiating") });
  assert.equal(summary.buyers, 10);
  assert.ok(summary.conversions > 0);
  assert.equal(summary.below_floor_deals, 0);
  assert.equal(summary.errors, 0);
});

// A "greedy" brain that ignores its budget: offers list, then tries to accept anything.
const greedy: Brain = {
  model: "greedy",
  async run(task, exec) {
    const { listings } = JSON.parse(await exec("search_products", { query: "keyboard" }));
    const p = listings.sort((a: any, b: any) => b.list_price - a.list_price)[0];
    await exec("make_offer", { product_id: p.product_id, price: p.list_price });
    await exec("make_offer", { product_id: p.product_id, price: 1 }); // gets a counter on the table
    await exec("accept_deal", { product_id: p.product_id });
    return { steps: 4, done: false, input_tokens: 0, output_tokens: 0 };
  },
};

test("wallet cap is enforced in code: an over-budget LLM can't offer or buy above its maximum", async () => {
  const task: LlmBuyerTask = { buyer_id: "poor", buyer_model: "scripted", persona: "price_first", profile: { price: 1 },
    goal: "keyboard", hard_needs: [], stated_budget_cents: 5000, walkaway_cents: 6000 };
  const o = await runBuyer(task, greedy, new LocalGateway("negotiating"), "test_wallet", quiet);
  assert.equal(o.closed, false);
  assert.ok(o.wallet_blocks >= 2, `expected blocks, got ${o.wallet_blocks}`);
});

test("scripted brain buys when the walk-away is above list", async () => {
  const task: LlmBuyerTask = { buyer_id: "rich", buyer_model: "scripted", persona: "quality_first", profile: { quality: 1 },
    goal: "keyboard", hard_needs: [], stated_budget_cents: 14000, walkaway_cents: 16000 };
  const o = await runBuyer(task, new ScriptedBrain(), new LocalGateway("static"), "test_rich", quiet);
  assert.equal(o.closed, true);
  assert.ok(o.price_cents! <= 13900);
});

// ---------------- through E1's real exchange ----------------
import { ExchangeGateway } from "../src";
import type { NegotiationEvent } from "@sa/shared";

test("scripted buyers close deals through E1's real exchange, none below floor, one offer_made per offer", async () => {
  const events: NegotiationEvent[] = [];
  const gw = new ExchangeGateway("negotiating");
  gw.attach((e) => events.push(e));
  const buyers = makeBuyers({ n: 12, models: ["scripted"], seed: 3 });
  let deals = 0;
  for (const b of buyers) {
    const o = await runBuyer(b, new ScriptedBrain(), gw, "test_exchange", (e) => events.push(e), 30, "negotiating");
    assert.equal(o.error, undefined, o.error);
    if (o.closed) { deals++; assert.equal(o.below_floor, false); }
  }
  assert.ok(deals > 0);
  const count = (t: string) => events.filter((e) => e.type === t).length;
  assert.equal(count("deal_accepted"), deals, "exactly one deal_accepted per deal (exchange logs it, harness doesn't)");
  assert.ok(count("offer_made") <= count("offer_countered") + count("offer_accepted") + 1);
});

test("accept goes by the exchange's live offer_id", async () => {
  const gw = new ExchangeGateway("static");
  const ctx = { run_id: "t", buyer_id: "b1", buyer_model: "scripted" };
  const r = await gw.offer(ctx, { product_id: "kb_clackco_tkl", offer_price_cents: 9000 });
  assert.equal(r.status, "counter");
  assert.equal(r.price_cents, 11500); // static seller: list
  const d = await gw.accept(ctx, r.negotiation_id);
  assert.ok(d.ok && d.final_price_cents === 11500);
});
