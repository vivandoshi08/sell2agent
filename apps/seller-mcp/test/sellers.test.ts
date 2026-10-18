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

test("soft floor is a whole-dollar price", () => assert.equal(softFloor(11500, 9500) % 100, 0));

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
  assert.deepEqual([m.action, m.price_cents, m.final, m.reason], ["offer", 12900, false, "fixed_price"]);
  assert.equal(decide(st(8, [], 12000), { name: "static" }).final, true);
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

// ---------------- lever_policy ----------------
import { decideLever, pickLever } from "../src/sellers";
import type { Lever, SellerPolicy } from "../src/sellers";

const MENU: Lever[] = [
  { id: "warranty_2y", lever: "warranty", label: "a 2-year warranty", cost_cents: 600, buyer_value_cents: 2000 },
  { id: "ship_2day", lever: "delivery", label: "free 2-day shipping", cost_cents: 800, buyer_value_cents: 1500 },
  { id: "keycaps", lever: "quality", label: "an extra keycap set", cost_cents: 700, buyer_value_cents: 1800 },
];
const LP: SellerPolicy = { name: "lever_policy", lever_menu: MENU };
const runRounds = (profile: Record<string, number> | undefined, policy: SellerPolicy, bid = 9000) => {
  const hist: SellerState["history"] = []; const moves: ProposedMove[] = [];
  for (let r = 1; r <= 8; r++) {
    const m = decide(st(r, hist, bid), policy, profile as any);
    moves.push(m);
    hist.push({ by: "seller", round: r, price_cents: m.price_cents, levers: m.lever_package?.map((l) => l.id) });
  }
  return moves;
};

test("lever_policy = negotiating for a price-first buyer", () => {
  const a = runRounds({ price: 1, quality: 0.3 }, LP).map((m) => [m.price_cents, m.lever_package?.length ?? 0]);
  const b = runRounds({ price: 1, quality: 0.3 }, { name: "negotiating" }).map((m) => [m.price_cents, 0]);
  assert.deepEqual(a, b);
});

test("quality/warranty buyer gets an extra instead of a cut, and keeps it", () => {
  const moves = runRounds({ quality: 1, warranty: 0.8, price: 0.3 }, LP);
  const first = moves.findIndex((m) => m.reason === "lever_instead_of_cut");
  assert.ok(first > 0, "should substitute a lever at some round");
  assert.equal(moves[first].price_cents, moves[first - 1].price_cents, "price held that round");
  for (let i = first; i < moves.length; i++) assert.ok((moves[i].lever_package?.length ?? 0) >= 1, `lever dropped at round ${i + 1}`);
});

test("price never goes below soft floor + cost of included levers", () => {
  for (const m of runRounds({ quality: 1, warranty: 0.9, delivery: 0.9, price: 0.2 }, LP, 1)) {
    assert.ok(m.price_cents >= softFloor(12900, 10500) + (m.lever_cost_cents ?? 0), `${m.price_cents} with levers ${m.lever_cost_cents}`);
  }
});

test("pickLever: never when the extra costs more than the cut, or the buyer values price more", () => {
  assert.equal(pickLever(MENU, new Set(), { warranty: 0.9, price: 0.3 }, 500), null); // $6 lever vs $5 cut
  assert.equal(pickLever(MENU, new Set(), { warranty: 0.6, price: 0.8 }, 5000), null); // price-first
  assert.equal(pickLever(MENU, new Set(), { warranty: 0.9, price: 0.3 }, 5000)?.id, "warranty_2y");
});

test("message check: an extra named in text must be in the offer", () => {
  const plain: ProposedMove = { ...move };
  assert.ok(checkMessage("$125, and I'll throw in a warranty.", plain, ctx).some((w) => w.includes("warranty")));
  const withW: ProposedMove = { ...move, lever_package: [{ id: "warranty_2y", lever: "warranty", label: "a 2-year warranty" }] };
  assert.deepEqual(checkMessage(templateMessage(withW, ctx), withW, ctx), []);
});

// ---------------- bandit ----------------
import { Bandit, chooseArm, contextOf } from "../src/sellers";

test("contextOf picks the strongest lever", () => {
  assert.equal(contextOf({ quality: 1, warranty: 0.8, price: 0.3 }), "quality");
  assert.equal(contextOf(undefined), "unknown");
});
test("bandit tries every arm, then prefers the best one", () => {
  const b = new Bandit(["negotiating", "balanced"], 0.1);
  for (let i = 0; i < 200; i++) { const a = b.chooseTraining("price"); b.update("price", a, a === "balanced" ? 5000 : 3000); }
  assert.equal(b.greedy("price"), "balanced");
  assert.ok(b.stats.price.negotiating.n >= 1);
});
test("chooseArm logs the right propensity and falls back to negotiating", () => {
  const lp = new Bandit(["negotiating", "balanced"], 0.2).export(1);
  lp.choice.price = "balanced";
  assert.deepEqual(chooseArm(lp, { price: 1 }, () => 0.9), { arm: "balanced", propensity: 0.9, context: "price" });
  assert.equal(chooseArm(null, { price: 1 }).arm, "negotiating");
  assert.equal(chooseArm(lp, { trust: 1 }, () => 0.9).arm, "negotiating");
});

// ---------------- summary lines (contract v3 P0) ----------------
import { offerSummary, dealSummary, checkSummary, SUMMARY_MAX } from "../src/sellers";

const NOW = Date.parse("2026-10-18T08:00:00Z");
const in15 = new Date(NOW + 15 * 60_000).toISOString();
test("offerSummary: price, extras, list, hold time; only allowed figures", () => {
  const s = offerSummary({ title: "KeyForge Quiet 75", price_cents: 11900, list_price_cents: 12900, levers: ["free_shipping", "extended_warranty"], expires_at: in15 }, NOW);
  assert.equal(s, "KeyForge Quiet 75: $119 with free shipping and an extended warranty (list $129). Offer holds 15 min.");
  assert.deepEqual(checkSummary(s, [11900, 12900]), []);
});
test("offerSummary: final, accept, no list when at list, expired offer has no hold time", () => {
  assert.equal(offerSummary({ title: "ClackCo TKL Pro", price_cents: 11500, list_price_cents: 11500, final: true, expires_at: new Date(NOW - 1).toISOString() }, NOW),
    "ClackCo TKL Pro: $115. Final offer.");
  assert.equal(offerSummary({ title: "TypeWell 65 Silent", price_cents: 12450, status: "accept" }, NOW), "TypeWell 65 Silent: the seller accepts $124.50.");
  // an accept never says "Final offer" or "Offer holds" (found by pnpm e2:summaries)
  assert.equal(offerSummary({ title: "ClackCo TKL Pro", price_cents: 11000, status: "accept", final: true, expires_at: in15 }, NOW), "ClackCo TKL Pro: the seller accepts $110.");
});
test("dealSummary: locked with approve link, paid, multi-unit", () => {
  assert.equal(dealSummary({ title: "KeyForge Quiet 75", total_cents: 11900, levers: ["free_shipping"], approve_url: "https://gw.example/deal/d1?t=abc" }),
    "Deal locked: KeyForge Quiet 75, $119, free shipping. Approve: https://gw.example/deal/d1?t=abc");
  assert.equal(dealSummary({ title: "KeyForge Quiet 75", total_cents: 11900, paid: true }), "Bought: KeyForge Quiet 75, $119. Paid.");
  assert.match(dealSummary({ title: "X", total_cents: 23800, quantity: 2, unit_price_cents: 11900 }), /2 × \$119 = \$238/);
});
test("summaries never exceed 280 chars; long titles are shortened, numbers kept", () => {
  const s = offerSummary({ title: "Very Long Name ".repeat(30), price_cents: 11900, list_price_cents: 12900, levers: ["free_shipping"], expires_at: in15 }, NOW);
  assert.ok(s.length <= SUMMARY_MAX); assert.match(s, /\$119 with free shipping \(list \$129\)\. Offer holds 15 min\.$/);
});
test("checkSummary flags floor talk and stray figures", () => {
  assert.ok(checkSummary("$105 is our floor", [10500]).some((p) => p.includes("floor")));
  assert.ok(checkSummary("Only $99 today", [11900]).some((p) => p.includes("$99")));
});
test("summary never states the floor, for every policy round", () => {
  const hist: SellerState["history"] = [];
  for (let r = 1; r <= 8; r++) {
    const m = decide(st(r, hist, 9000), neg);
    hist.push({ by: "seller", round: r, price_cents: m.price_cents });
    const s = offerSummary({ title: terms.title, price_cents: m.price_cents, list_price_cents: terms.list_price_cents, final: m.final, expires_at: in15 }, NOW);
    assert.deepEqual(checkSummary(s, [m.price_cents, terms.list_price_cents]), [], s);
    assert.ok(!s.includes("$105"), s);
  }
});
