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
