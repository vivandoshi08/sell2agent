// Live traffic vs eval runs: tests and E1 state never count; real buyers get their own summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NegotiationEvent } from "@sa/shared";
import { liveTraffic, policyKpis } from "../src/metrics/kpis";
import { fakeComparison } from "../src/data/fake";

let t = 0;
const ev = (run_id: string, type: string, extra: Partial<NegotiationEvent> = {}, payload: Record<string, unknown> = {}): NegotiationEvent => ({
  run_id, type: type as any, actor: "seller", buyer_id: "b1", buyer_model: "unknown", seller_id: "s_keyforge", product_id: "kb_keyforge_quiet75",
  negotiation_id: `n_${run_id}`, price_cents: null, payload, ts: new Date(Date.UTC(2026, 9, 18, 6, 0, t++)).toISOString(), ...extra,
} as NegotiationEvent);

const live = [
  ev("live", "offer_made", { actor: "buyer", price_cents: 11000 }),
  ev("live", "guardrail_blocked", {}, { rule: "concession_cap" }),
  ev("live", "deal_accepted", { price_cents: 11200 }, { deal_id: "d1", total_cents: 11200, list_price_cents: 12900, below_floor: false }),
  ev("live", "payment_succeeded", { price_cents: 11200 }, { deal_id: "d1" }),
  ev("live", "deal_accepted", { price_cents: 12800, negotiation_id: "n2" }, { deal_id: "d2", total_cents: 12800, list_price_cents: 12900 }),
  ev("s1-test-pay-1", "deal_accepted", { price_cents: 100 }, { deal_id: "dt", total_cents: 100, list_price_cents: 12900 }),
  ev("s1-test-pay-1", "payment_succeeded", {}, { deal_id: "dt" }),
  ev("exchange_state", "exchange_snapshot"),
];

test("liveTraffic counts real buyers only: deals, paid revenue, discount, blocks", () => {
  const l = liveTraffic(live);
  assert.deepEqual(l.run_ids, ["live"]);
  assert.equal(l.deals, 2);
  assert.equal(l.paid, 1);
  assert.equal(l.revenue_cents, 11200);
  assert.ok(Math.abs(l.avg_discount! - ((1 - 11200 / 12900) + (1 - 12800 / 12900)) / 2) < 1e-9);
  assert.deepEqual(l.blocks, [{ rule: "concession_cap", n: 1 }]);
  assert.equal(l.recent_deals[0].price_cents, 12800);
  assert.equal(l.recent_deals[1].paid, true);
});

test("policy KPIs compare eval runs only once any exist; live and test runs don't become policy bars", () => {
  const evals = fakeComparison(30);
  const kpis = policyKpis([...evals, ...live], { resamples: 50 });
  const names = kpis.map((k) => k.policy);
  assert.ok(!names.includes("live") && !names.some((n) => n.startsWith("s1-test")), names.join());
  assert.deepEqual(kpis, policyKpis(evals, { resamples: 50 }));
});

test("buyer-model filter keeps whole buyers of that model, plus run-level rows", async () => {
  const { filterByModel, listModels, defaultSelection, listRuns } = await import("../src/data/runs");
  const evs = [
    ev("r1", "run_started", { buyer_id: null, buyer_model: null, actor: "harness" } as any, { policy: "negotiating" }),
    ev("r1", "offer_made", { buyer_id: "a", buyer_model: "claude-sonnet-5-5" }),
    ev("r1", "offer_countered", { buyer_id: "a", buyer_model: null } as any),
    ev("r1", "offer_made", { buyer_id: "b", buyer_model: "gpt-5" }),
  ];
  assert.deepEqual(listModels(evs).sort(), ["claude-sonnet-5-5", "gpt-5"]);
  const only = filterByModel(evs, "claude-sonnet-5-5");
  assert.deepEqual(only.map((e) => e.buyer_id), [null, "a", "a"]);
  // Test runs never become the default selection.
  // Once eval runs exist, live traffic isn't part of the default comparison either.
  assert.deepEqual(defaultSelection(listRuns([...evs, ...live])).sort(), ["r1"]);
  assert.deepEqual(defaultSelection(listRuns(live)), ["live"]);
});
