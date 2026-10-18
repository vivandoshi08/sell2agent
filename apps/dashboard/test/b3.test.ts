// Bridge 3 panels: follow-up timelines + totals, and the learned-vs-fixed comparison by buyer type.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NegotiationEvent } from "@sa/shared";
import { followupSummary } from "../src/metrics/followups";
import { evalKey, learnedEval, liveArmPicks } from "../src/metrics/learned";
import { liveTraffic, policyKpis } from "../src/metrics/kpis";
import { fakeComparison, fakeFollowups, fakeLearnedEval } from "../src/data/fake";
import learnedFile from "../../seller-mcp/learned_policy.json";

test("follow-ups: consented walk-aways get a timeline; totals count sent, recovered and recovered revenue", () => {
  const s = followupSummary(fakeFollowups());
  assert.equal(s.walkaways, 6);
  assert.equal(s.consented, 5, "fu_kim walked away without consent");
  assert.equal(s.sent, 4);
  assert.equal(s.not_sent, 1, "weekly cap held the second follow-up to fu_ana");
  assert.equal(s.recovered, 2);
  assert.equal(s.recovered_paid, 1);
  assert.equal(s.unmatched_replies, 1);
  const byBuyer = (b: string, product: string) => s.threads.find((t) => t.buyer_id === b && t.product_id === product)!;
  const ana = byBuyer("fu_ana", "kb_typewell_65");
  assert.equal(ana.status, "paid");
  assert.equal(ana.sent?.channel, "email");
  assert.deepEqual(ana.sent?.levers, ["extended_warranty"]);
  assert.equal(ana.sent?.to, "an***@agents.example.test");
  assert.equal(ana.replies[0].intent, "accept");
  assert.equal(s.recovered_revenue_cents, ana.deal!.total_cents + byBuyer("fu_mei", "kb_keyforge_quiet75").deal!.total_cents);
  assert.equal(s.recovered_paid_cents, ana.deal!.total_cents);
  assert.equal(byBuyer("fu_raj", "hp_keyforge_anc").status, "replied");
  assert.equal(byBuyer("fu_ola", "kb_typewell_65").status, "sent");
  assert.equal(byBuyer("fu_ana", "kb_keyforge_quiet75").status, "not_sent");
  assert.equal(byBuyer("fu_mei", "kb_keyforge_quiet75").counters.length, 1);
  assert.ok(!s.threads.some((t) => t.buyer_id === "fu_kim"), "no consent, no thread");
});

test("follow-ups: a deal before the follow-up isn't recovered; a failed send isn't counted as sent; nothing reads floor or cost", () => {
  let t = 0;
  const ev = (type: string, extra: Partial<NegotiationEvent> = {}, payload: Record<string, unknown> = {}) => ({
    run_id: "live", type, actor: "seller", buyer_id: "b1", buyer_model: "claude", seller_id: "s", product_id: "p", negotiation_id: "n1", price_cents: null,
    payload, ts: new Date(Date.UTC(2026, 9, 18, 8, 0, t++)).toISOString(), ...extra } as NegotiationEvent);
  const s = followupSummary([
    ev("buyer_walked_away", { actor: "buyer" }, { followup_consent: true, channel: "sms" }),
    ev("offer_countered", { price_cents: 12000 }, { followup: true, followup_channel: "sms", lever_package: [], delivery: { status: "failed", error: "inkbox 500" }, outbox: { to: "•••0199" } }),
    ev("deal_accepted", { price_cents: 9000, negotiation_id: "n2" }, { deal_id: "d2" }),
  ]);
  assert.equal(s.sent, 0);
  assert.equal(s.failed, 1);
  assert.equal(s.threads[0].status, "failed");
  assert.equal(s.recovered, 0, "n2's deal has no follow-up");
  const json = JSON.stringify(followupSummary(fakeFollowups()));
  assert.ok(!/floor|unit_cost|lever_cost/.test(json), "summary carries no floor or cost fields");
});

test("follow-up rows never leak into the proof comparison or the live-traffic tally", () => {
  const all = [...fakeComparison(20), ...fakeFollowups()];
  assert.deepEqual(policyKpis(all, { resamples: 20 }).map((k) => k.policy), ["static", "negotiating"]);
  assert.equal(liveTraffic(all).negotiations, 0, "s2-fake- rows are sample data, not real shoppers");
});

test("learned eval: pairs the learned run with its fixed siblings and scores each buyer type", () => {
  const ab = learnedEval([...fakeComparison(10), ...fakeLearnedEval(80)])!;
  assert.equal(ab.key, "s2-fake-b3");
  assert.deepEqual(ab.policies, ["learned", "negotiating", "balanced"]);
  assert.deepEqual(ab.rows.map((r) => r.context), ["price", "quality", "delivery", "trust"]);
  for (const r of ab.rows) for (const pol of ab.policies) assert.equal(r.cells[pol].n, 20, `${r.context} × ${pol}`);
  const trust = ab.rows.find((r) => r.context === "trust")!;
  assert.equal(trust.picks[0].arm, learnedFile.choice.trust, "learned mostly draws the arm the policy file chose");
  assert.ok(trust.picks[0].share >= 0.75);
  assert.equal(ab.overall.learned.n, 80);
  assert.ok(ab.overall.learned.profit_per_buyer_cents != null);
  assert.deepEqual(ab.versions, [learnedFile.version]);
  assert.equal(ab.fallbacks, 0);
  assert.equal(learnedEval(fakeComparison(10)), null, "no learned run, no comparison");
});

test("learned eval keys: plain and signed run ids", () => {
  assert.equal(evalKey("b3A_learned", "learned"), "b3A");
  assert.equal(evalKey("eval_b3A_negotiating.9f2c01", "negotiating"), "b3A");
});

test("live arm picks: real shoppers on the learned strategy, one pick per negotiation; evals, tests and samples excluded", () => {
  const e = (run_id: string, negotiation_id: string, arm: string, ctx: string) =>
    ({ run_id, negotiation_id, actor: "seller", type: "offer_countered", buyer_id: "b", buyer_model: null, seller_id: "s", product_id: "p", price_cents: 100,
      payload: { policy: "learned", arm, bandit_context: ctx }, ts: "2026-10-18T08:00:00Z" }) as NegotiationEvent;
  const picks = liveArmPicks([e("gw", "n1", "balanced", "price"), e("gw", "n1", "balanced", "price"), e("gw", "n2", "negotiating", "unknown"),
    e("s1-test-x", "n3", "balanced", "price"), ...fakeLearnedEval(8)]);
  assert.deepEqual(picks, [
    { context: "price", picks: [{ arm: "balanced", n: 1, share: 1 }] },
    { context: "unknown", picks: [{ arm: "negotiating", n: 1, share: 1 }] },
  ]);
});
