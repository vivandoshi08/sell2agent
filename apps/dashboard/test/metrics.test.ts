// Run: pnpm --filter @sa/dashboard test
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NegotiationEvent } from "@sa/shared";
import { buyerOutcomes, personaGrid, policyKpis } from "../src/metrics/kpis";
import { bootstrapCI, median } from "../src/metrics/stats";
import { fakeComparison, FAKE_PREFIX } from "../src/data/fake";

let clock = Date.parse("2026-10-17T21:00:00Z");
function ev(run_id: string, buyer_id: string | null, type: NegotiationEvent["type"], extra: Partial<NegotiationEvent> = {}): NegotiationEvent {
  clock += 1000;
  return { run_id, buyer_id, buyer_model: buyer_id ? "claude" : null, seller_id: "s", product_id: "p", negotiation_id: buyer_id ? `n-${buyer_id}` : null,
    actor: extra.actor ?? "buyer", type, price_cents: null, payload: {}, ts: new Date(clock).toISOString(), ...extra };
}

// Hand-counted fixture: 4 buyers on "negotiating".
//  b1: accepted 100 @ cost 60, paid, warranty lever cost 5 → profit 35
//  b2: accepted 90 @ cost 60, not paid → profit 30
//  b3: walked → profit 0
//  b4: accepted 80 @ cost 60 but logged below floor → unsafe, profit 20
const R = "r1";
const fixture: NegotiationEvent[] = [
  ev(R, null, "run_started", { actor: "harness", payload: { policy: "negotiating" } }),
  ev(R, "b1", "run_started", { actor: "harness", payload: { buyer_persona: "quality_first" } }),
  ev(R, "b1", "offer_made", { price_cents: 70 }),
  ev(R, "b1", "offer_countered", { actor: "seller", price_cents: 100 }),
  ev(R, "b1", "deal_accepted", { actor: "seller", price_cents: 100, payload: { unit_cost_cents: 60, lever_package: [{ lever: "extended_warranty", cost_cents: 5 }] } }),
  ev(R, "b1", "payment_succeeded", { actor: "seller", price_cents: 100 }),
  ev(R, "b2", "run_started", { actor: "harness", payload: { buyer_persona: "price_first" } }),
  ev(R, "b2", "offer_made", { price_cents: 70 }),
  ev(R, "b2", "offer_countered", { actor: "seller", price_cents: 95 }),
  ev(R, "b2", "deal_accepted", { actor: "seller", price_cents: 90, payload: { unit_cost_cents: 60 } }),
  ev(R, "b3", "run_started", { actor: "harness", payload: { buyer_persona: "price_first" } }),
  ev(R, "b3", "offer_made", { price_cents: 50 }),
  ev(R, "b3", "buyer_walked_away"),
  ev(R, "b4", "run_started", { actor: "harness", payload: { buyer_persona: "balanced" } }),
  ev(R, "b4", "deal_accepted", { actor: "seller", price_cents: 80, payload: { unit_cost_cents: 60, below_floor: true } }),
  ev(R, null, "guardrail_blocked", { actor: "seller", payload: { rule: "below_soft_floor" } }),
];

test("KPIs match a hand count", () => {
  const [k] = policyKpis(fixture, { resamples: 200 });
  assert.equal(k.policy, "negotiating");
  assert.equal(k.buyers, 4);
  assert.equal(k.conversion_rate, 3 / 4);
  assert.equal(k.safe_conversion_rate, 2 / 4);
  assert.equal(k.paid_rate, 1 / 4);
  assert.equal(k.profit_per_buyer_cents, (35 + 30 + 0 + 20) / 4);
  assert.equal(k.unsafe_deals, 1);
  assert.equal(k.guardrail_blocks, 1);
  assert.equal(k.median_ms_to_first_offer, 1000); // offer_made → seller counter, 1 s apart, for b1 and b2
});

test("missing cost data gives null profit, not a guess", () => {
  const noCost = fixture.map((e) => (e.type === "deal_accepted" && e.buyer_id === "b2" ? { ...e, payload: {} } : e));
  const [k] = policyKpis(noCost, { resamples: 50 });
  assert.equal(k.profit_per_buyer_cents, null);
  assert.equal(k.ci.profit_per_buyer_cents, null);
});

test("contract v2 shapes: lever_cost_cents and judged events", () => {
  const v2 = [
    ev("r2", null, "run_started", { actor: "harness", payload: { policy: "negotiating" } }),
    ev("r2", "c1", "deal_accepted", { actor: "seller", price_cents: 100, payload: { unit_cost_cents: 60, lever_cost_cents: 12 } }),
    ev("r2", "c2", "deal_accepted", { actor: "seller", price_cents: 100, payload: { unit_cost_cents: 60 } }),
    ev("r2", "c2", "judged" as NegotiationEvent["type"], { actor: "harness", payload: { safe: false, reasons: ["false claim"] } }),
  ];
  const [k] = policyKpis(v2, { resamples: 50 });
  assert.equal(k.profit_per_buyer_cents, (28 + 40) / 2);
  assert.equal(k.safe_conversion_rate, 1 / 2);
});

test("exchange snapshot rows are ignored", () => {
  const snap = { ...fixture[1], run_id: "exchange_state", type: "exchange_snapshot" as NegotiationEvent["type"], buyer_id: "b9" };
  const [k] = policyKpis([...fixture, snap], { resamples: 50 });
  assert.equal(k.buyers, 4);
});

test("per-buyer outcome fields", () => {
  const b1 = buyerOutcomes(fixture).find((o) => o.buyer_id === "b1")!;
  assert.deepEqual([b1.persona, b1.converted, b1.paid, b1.safe, b1.profit_cents], ["quality_first", true, true, true, 35]);
});

test("bootstrap interval brackets the point estimate and is deterministic", () => {
  const xs = Array.from({ length: 50 }, (_, i) => i % 3 === 0);
  const f = (s: boolean[]) => s.filter(Boolean).length / s.length;
  const a = bootstrapCI(xs, f), b = bootstrapCI(xs, f);
  assert.deepEqual(a, b);
  assert.ok(a.lo <= f(xs) && f(xs) <= a.hi && a.lo < a.hi);
  assert.equal(median([3, 1, 2, 10]), 2.5);
});

test("sample data: two policies, prefixed run ids, negotiating ahead on profit", () => {
  const evs = fakeComparison(60);
  assert.ok(evs.every((e) => e.run_id.startsWith(FAKE_PREFIX)));
  const ks = policyKpis(evs, { resamples: 200 });
  assert.deepEqual(ks.map((k) => k.policy), ["static", "negotiating"]);
  assert.ok(ks.every((k) => k.buyers === 60));
  assert.ok(ks[1].profit_per_buyer_cents! > ks[0].profit_per_buyer_cents!);
  const grid = personaGrid(ks);
  assert.equal(grid.length, 5);
});

test("buyer fit: weighted by what the buyer values; null when not scorable", async () => {
  const { buyerFit, leverWins } = await import("../src/metrics/levers");
  // price-first buyer, 10% off list → price half served (full credit at 20%).
  assert.equal(buyerFit({ price: 1 }, [], 10_000, 9_000), 0.5);
  // quality+warranty buyer gets the warranty, no discount: warranty fully served, price/quality not scorable → 1.
  assert.equal(buyerFit({ quality: 1, warranty: 0.8 }, ["extended_warranty"], 10_000, 10_000), 1);
  // delivery buyer without shipping lever, list price: 0.
  assert.equal(buyerFit({ delivery: 1, price: 0.5 }, [], 10_000, 10_000), 0);
  assert.equal(buyerFit(undefined, [], 10_000, 9_000), null);
  assert.equal(buyerFit({ quality: 1 }, [], 10_000, 9_000), null);
  const wins = leverWins([
    { persona: "quality_first", policy: "negotiating", converted: true, levers: ["extended_warranty"] },
    { persona: "quality_first", policy: "negotiating", converted: true, levers: [] },
    { persona: "quality_first", policy: "negotiating", converted: false, levers: [] },
  ]);
  assert.deepEqual(wins.map((w) => [w.package, w.deals, w.share]), [["extended_warranty", 1, 0.5], ["price only", 1, 0.5]]);
});
