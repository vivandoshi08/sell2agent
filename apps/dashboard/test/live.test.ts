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

// Signed eval runs (eval_<eval_id>_<policy>.<sig>): the smoke tests through the gateway never log a run_started,
// so evalRunIds() doesn't see them; they must still stay out of "real buyers".
const signed = (run_id: string, policy: string | null, buyers: number, planned: number | null, minute: number) => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 18, 8, minute, s)).toISOString();
  const rows: NegotiationEvent[] = [];
  if (policy) rows.push(ev(run_id, "run_started", { actor: "harness" as any, buyer_id: null, negotiation_id: null, ts: at(0) }, { policy, ...(planned != null ? { buyers: planned } : {}) }));
  for (let i = 0; i < buyers; i++) {
    const b = `b${i}`, n = `n_${run_id}_${i}`;
    rows.push(ev(run_id, "offer_made", { actor: "buyer", buyer_id: b, negotiation_id: n, price_cents: 10000, ts: at(1 + i) }));
    if (i % 2 === 0) rows.push(ev(run_id, "deal_accepted", { buyer_id: b, negotiation_id: n, price_cents: 11000, ts: at(1 + i) }, { deal_id: `d_${run_id}_${i}`, total_cents: 11000, list_price_cents: 12900, unit_cost_cents: 7000 }));
  }
  return rows;
};

test("eval_ runs never count as live traffic, with or without a run_started; tests stay out unless asked", () => {
  const smoke = [...signed("eval_e1-test-smoke-013211-static.74dcfd42cf5f4176", null, 2, null, 30), ...signed("eval_s1-prodcheck-1792311574357.8ad7ab5b0d5b87dc", null, 1, null, 31)];
  const full = [...signed("eval_b2dep_haiku100_static.ba8171f3e84da354", "static", 4, 4, 40), ...signed("eval_b2dep_haiku100_negotiating.65edf002461dcaad", "negotiating", 4, 4, 41)];
  const tests = [...signed("s1-unsigned", null, 1, null, 32), ...signed("verify_s1", null, 1, null, 33), ...signed("s2-test-realtime", null, 1, null, 34)];
  const all = [...live, ...smoke, ...full, ...tests];

  const l = liveTraffic(all);
  assert.deepEqual(l.run_ids, ["live"]);
  assert.equal(l.deals, 2);
  // ?tests shows teammates' test runs on the Live view; eval runs still never.
  assert.deepEqual(liveTraffic(all, { includeTests: true }).run_ids.sort(), ["live", "s1-test-pay-1", "s1-unsigned", "s2-test-realtime", "verify_s1"]);

  // Eval runs that logged run_started with a policy are still what the KPIs compare; the smoke runs aren't policy arms.
  const kpis = policyKpis(all, { resamples: 20 });
  assert.deepEqual(kpis.map((k) => [k.policy, k.buyers, k.run_ids]), [
    ["static", 4, ["eval_b2dep_haiku100_static.ba8171f3e84da354"]],
    ["negotiating", 4, ["eval_b2dep_haiku100_negotiating.65edf002461dcaad"]],
  ]);
});

test("default comparison: the latest complete eval, proof-sized (≥ 50 buyers/arm) over smoke checks; ?eval pins one", async () => {
  const { defaultSelection, listRuns, evalIdOf } = await import("../src/data/runs");
  assert.equal(evalIdOf("eval_b2dep_haiku100_static.ba8171f3e84da354", "static"), "b2dep_haiku100");
  assert.equal(evalIdOf("eval_run_202610180924_negotiating.11979f7956640be7", "negotiating"), "run_202610180924");
  assert.equal(evalIdOf("live", "live"), null);

  const runs = listRuns([
    ...signed("eval_b2dep_haiku100_static.ba8171f3e84da354", "static", 50, 50, 10),
    ...signed("eval_b2dep_haiku100_negotiating.65edf002461dcaad", "negotiating", 49, 50, 11),
    // Later: an eval whose negotiating arm died after 1 of 50 buyers, a lone negotiating arm with no static,
    // an unsigned smoke run, and a complete but smoke-sized eval (5 buyers per arm).
    ...signed("eval_b2dep_claude100_static.221ba3e36c06c5d8", "static", 50, 50, 12),
    ...signed("eval_b2dep_claude100_negotiating.584803cc7a9d7d93", "negotiating", 1, 50, 13),
    ...signed("eval_run_202610180924_negotiating.11979f7956640be7", "negotiating", 20, 20, 14),
    ...signed("eval_e1smoke_0130_static.bd441653cd2fe52d", null, 3, null, 15),
    ...signed("eval_run_202610180942_static.a74549c7cc2d94b6", "static", 5, 5, 16),
    ...signed("eval_run_202610180942_negotiating.c767fd59d031b064", "negotiating", 5, 5, 17),
    ...live,
  ]);
  assert.deepEqual(defaultSelection(runs).sort(), ["eval_b2dep_haiku100_negotiating.65edf002461dcaad", "eval_b2dep_haiku100_static.ba8171f3e84da354"]);
  assert.deepEqual(defaultSelection(runs, "b2dep_claude100").sort(), ["eval_b2dep_claude100_negotiating.584803cc7a9d7d93", "eval_b2dep_claude100_static.221ba3e36c06c5d8"]);
  // An unknown pin falls back to the default.
  assert.deepEqual(defaultSelection(runs, "nope").sort(), defaultSelection(runs).sort());
  // With only smoke-sized evals complete, the latest of those.
  const small = runs.filter((r) => !r.eval_id?.startsWith("b2dep_haiku100"));
  assert.deepEqual(defaultSelection(small).sort(), ["eval_run_202610180942_negotiating.c767fd59d031b064", "eval_run_202610180942_static.a74549c7cc2d94b6"]);
});
