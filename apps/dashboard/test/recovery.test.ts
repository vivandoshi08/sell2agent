// Walk-away recovery: offered vs honest no, saves (deal on a suggested product after the recovery), revenue, demand signal.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NegotiationEvent } from "@sa/shared";
import { recoveryStats, savedRecoveries } from "../src/metrics/recovery";
import { groupNegotiations, toMove } from "../src/ui/Seller";
import { fakeComparison, fakeRecovery, fakeSample } from "../src/data/fake";

let t = Date.parse("2026-10-18T06:00:00Z");
const ev = (type: NegotiationEvent["type"], extra: Partial<NegotiationEvent> = {}, payload: Record<string, unknown> = {}): NegotiationEvent => ({
  run_id: "live", buyer_id: "b1", buyer_model: "instinct", seller_id: "s_typewell", product_id: "kb_typewell_65", negotiation_id: "n1",
  actor: "buyer", type, price_cents: null, payload, ts: new Date((t += 1000)).toISOString(), ...extra,
});
const rec = (payload: Record<string, unknown>, extra: Partial<NegotiationEvent> = {}) =>
  ev("search", { actor: "marketplace", ...extra }, { recovery: true, trigger: "walk_away", blocker: "price", need: null, still_need: [], from_product_id: "kb_typewell_65",
    from_title: "TypeWell 65 Silent", result_ids: [], result_titles: [], honest_no: true, summary: "", ...payload });

test("counts offered vs honest no, by blocker, and ignores plain searches", () => {
  const evs = [
    ev("search", { actor: "buyer" }, { q: "silent keyboard" }), // plain search: not a recovery
    rec({ blocker: "price", still_need: ["Silent", "wireless"], result_ids: ["kb_typewell_60"], result_titles: ["TypeWell 60 Silent"], honest_no: false }),
    rec({ blocker: "missing_feature", still_need: ["silent ", "numpad"], honest_no: true }, { buyer_id: "b2" }),
    rec({ blocker: "delivery", still_need: ["silent"], honest_no: true }, { buyer_id: "b3" }),
  ];
  const s = recoveryStats(evs);
  assert.equal(s.offered, 1);
  assert.equal(s.honestNo, 2);
  assert.deepEqual(s.byBlocker, { price: 1, missing_feature: 1, delivery: 1, trust: 0, other: 0 });
  assert.deepEqual(s.askedFor, [{ term: "silent", count: 3 }, { term: "numpad", count: 1 }, { term: "wireless", count: 1 }]);
  assert.equal(s.saved, 0);
  assert.equal(recoveryStats([ev("search", {}, { q: "x" })]).offered, 0);
});

test("a save: later deal on a suggested product, same run + buyer; revenue × quantity; paid via deal_id", () => {
  const r = rec({ result_ids: ["kb_typewell_60", "kb_hushline_96"], result_titles: ["TypeWell 60 Silent", "Hushline 96 Silent"], honest_no: false });
  const evs = [
    ev("buyer_walked_away", {}, { reason: "price: second desk" }),
    r,
    ev("deal_accepted", { actor: "seller", product_id: "kb_typewell_60", negotiation_id: "n2", price_cents: 8_200 }, { deal_id: "d2", quantity: 2 }),
    ev("payment_succeeded", { actor: "seller", product_id: "kb_typewell_60", negotiation_id: "n2", price_cents: 16_400 }, { deal_id: "d2" }),
    // Not saves: another buyer, the walked product itself, a different run.
    ev("deal_accepted", { actor: "seller", buyer_id: "b9", product_id: "kb_hushline_96", negotiation_id: "n9", price_cents: 10_000 }, { deal_id: "d9" }),
    ev("deal_accepted", { actor: "seller", product_id: "kb_typewell_65", negotiation_id: "n3", price_cents: 11_500 }, { deal_id: "d3" }),
    ev("deal_accepted", { actor: "seller", run_id: "other", product_id: "kb_typewell_60", negotiation_id: "n4", price_cents: 8_000 }, { deal_id: "d4" }),
  ];
  const s = recoveryStats(evs);
  assert.equal(s.saved, 1);
  assert.equal(s.savedRevenueCents, 16_400);
  assert.equal(s.paidSaves, 1);
  assert.deepEqual(
    [s.saves[0].buyer_id, s.saves[0].agent, s.saves[0].buyer_model, s.saves[0].from_title, s.saves[0].to_product_id, s.saves[0].to_title, s.saves[0].price_cents],
    ["b1", "Instinct", "instinct", "TypeWell 65 Silent", "kb_typewell_60", "TypeWell 60 Silent", 8_200],
  );
  assert.equal(savedRecoveries(evs).get(r)?.to_product_id, "kb_typewell_60");
});

test("a deal before the recovery, or after an honest no, is not a save; unpaid saves count but aren't paid", () => {
  const early = ev("deal_accepted", { actor: "seller", product_id: "kb_typewell_60", negotiation_id: "n0", price_cents: 9_000 }, { deal_id: "d0" });
  const r = rec({ result_ids: ["kb_typewell_60"], result_titles: ["TypeWell 60 Silent"], honest_no: false });
  assert.equal(recoveryStats([early, r]).saved, 0);
  const no = rec({ honest_no: true });
  assert.equal(recoveryStats([no, ev("deal_accepted", { actor: "seller", product_id: "kb_typewell_60", price_cents: 9_000 }, { deal_id: "dx" })]).saved, 0);
  const unpaid = recoveryStats([r, ev("deal_accepted", { actor: "seller", product_id: "kb_typewell_60", negotiation_id: "n5", price_cents: 8_500 }, { deal_id: "d5" })]);
  assert.deepEqual([unpaid.saved, unpaid.paidSaves, unpaid.savedRevenueCents], [1, 0, 8_500]);
});

test("Live view: recovery move text, walked card becomes Saved, plain search stays off the card", () => {
  const r = rec({ need: "second desk", result_ids: ["kb_typewell_60", "kb_hushline_96"], result_titles: ["TypeWell 60 Silent", "Hushline 96 Silent"], honest_no: false });
  const m = toMove(r, 0)!;
  assert.equal(m.text, "Suggested a better fit: TypeWell 60 Silent or Hushline 96 Silent");
  assert.equal(m.why, "What got in the way: price · “second desk”");
  assert.deepEqual(m.rules, ["recovery"]);
  assert.equal(toMove(rec({ blocker: "trust", honest_no: true }), 0)!.text, "Said nothing here fits better");
  assert.equal(toMove(ev("search", {}, { q: "x" }), 0), null);

  const negs = groupNegotiations(fakeRecovery());
  const walked = negs.find((n) => n.evs.some((e) => e.type === "buyer_walked_away"))!;
  const bought = negs.find((n) => n.evs.some((e) => e.type === "deal_accepted"))!;
  assert.equal(walked.status, "Saved");
  assert.equal(walked.product, "TypeWell 65 Silent");
  assert.equal(bought.status, "Paid");
  assert.notEqual(walked.id, bought.id);
});

test("sample data: the recovery scenario is in ?sample, and the comparison runs are unchanged", () => {
  const s = recoveryStats(fakeSample(60));
  assert.deepEqual([s.offered, s.honestNo, s.saved, s.savedRevenueCents, s.paidSaves], [1, 0, 1, 8_200, 1]);
  assert.equal(s.saves[0].to_title, "TypeWell 60 Silent");
  assert.equal(recoveryStats(fakeComparison(60)).offered, 0);
});
