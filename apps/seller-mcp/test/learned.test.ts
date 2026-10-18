// E2 `learned` strategy through E1's exchange: arm per negotiation, logged propensity, fallback, lever arm floors. Offline.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Exchange, MemorySink, MemoryStore, StaticCatalog, SEED_PRODUCTS, leverCost, setLearnedPolicy, readLearnedPolicy, LEARNED_POLICY_FILE } from "../src/exchange";
import { ARMS, Bandit, armsFor, chooseArm, objectiveFormula, objectiveReward, type LearnedPolicy, type BuyerLeverProfile } from "../src/sellers";

const QUALITY: BuyerLeverProfile = { quality: 1, warranty: 0.8, price: 0.3 };
const PRICE: BuyerLeverProfile = { price: 1, quality: 0.3 };
const TW = "kb_typewell_65"; // list 13900, floor 11000, extras free_shipping + extended_warranty
const tw = SEED_PRODUCTS.find((p) => p.product_id === TW)!;

function policy(choice: LearnedPolicy["choice"], epsilon = 0): LearnedPolicy {
  return { version: 7, trained_at: "2026-10-18T00:00:00Z", arms: ["negotiating", "balanced", "lever_policy"], epsilon, stats: {}, choice,
    gate: { passed: true, best_fixed_policy: "balanced", learned_minus_best_fixed_cents: 0, holdout_buyers: 1, diff_vs_negotiating_cents: 1, ci95_cents: [1, 2], below_floor: 0 } };
}

function setup(strategy: "learned" | "negotiating" = "learned") {
  const events = new MemorySink();
  const ex = new Exchange({ store: new MemoryStore(), catalog: new StaticCatalog(SEED_PRODUCTS, { strategy }), sink: events.sink });
  return { ex, events };
}

/** A buyer that bids `bid` every round until the seller's last offer, then stops. Returns the seller's offers. */
async function haggle(ex: Exchange, buyer_id: string, profile: BuyerLeverProfile, product_id = TW, bid = 9000) {
  const ctx = { run_id: "learned-test", buyer_id, buyer_model: "scripted" };
  const offers: { price: number; levers: string[] }[] = [];
  let neg: string | undefined;
  for (let i = 0; i < 10; i++) {
    const r = await ex.handle({ kind: "offer", ctx, product_id, negotiation_id: neg, offer_price_cents: bid, buyer_profile: profile });
    if (!r.ok) break;
    neg = r.negotiation_id;
    offers.push({ price: r.standing_offer!.price_cents, levers: r.standing_offer!.levers });
  }
  return { offers, negotiation_id: neg! };
}

afterEach(() => setLearnedPolicy(undefined));

test("learned: the drawn arm is kept for the whole negotiation and logged with its propensity on seller events", async () => {
  setLearnedPolicy(policy({ price: "balanced", quality: "negotiating" }));
  const { ex, events } = setup();
  const { negotiation_id } = await haggle(ex, "b1", PRICE);
  const seller = events.events.filter((e) => e.negotiation_id === negotiation_id && e.actor === "seller" && e.type === "offer_countered");
  assert.ok(seller.length >= 3);
  for (const e of seller) {
    assert.equal(e.payload.arm, "balanced"); assert.equal(e.payload.propensity, 1); assert.equal(e.payload.bandit_context, "price");
    assert.equal(e.payload.policy, "learned"); assert.equal(e.payload.policy_version, 7);
    assert.ok((e.payload.rule_refs as string[]).includes("arm:balanced"));
  }
});

test("learned with no usable policy falls back to negotiating, same prices, and says so", async () => {
  setLearnedPolicy(null);
  const a = setup("learned"), b = setup("negotiating");
  const la = await haggle(a.ex, "b1", PRICE), lb = await haggle(b.ex, "b1", PRICE);
  assert.deepEqual(la.offers, lb.offers);
  const e = a.events.events.find((x) => x.type === "offer_countered")!;
  assert.equal(e.payload.arm, "negotiating"); assert.equal(e.payload.propensity, 1); assert.equal(e.payload.learned_fallback, "no_policy");
});

test("learned: ε exploration logs the true probability of the arm it drew", async () => {
  setLearnedPolicy(policy({ price: "balanced" }, 0.3));
  const { ex, events } = setup();
  for (let i = 0; i < 60; i++) await ex.handle({ kind: "offer", ctx: { run_id: "eps", buyer_id: `b${i}`, buyer_model: "scripted" }, product_id: TW, offer_price_cents: 9000, buyer_profile: PRICE });
  const first = events.events.filter((e) => e.type === "offer_countered");
  assert.equal(first.length, 60);
  for (const e of first) assert.ok(Math.abs((e.payload.propensity as number) - (e.payload.arm === "balanced" ? 0.8 : 0.1)) < 1e-9, `${e.payload.arm} ${e.payload.propensity}`);
  const probs = first[0].payload.arm_probs as Record<string, number>;
  for (const [a, p] of Object.entries({ negotiating: 0.1, balanced: 0.8, lever_policy: 0.1 })) assert.ok(Math.abs(probs[a] - p) < 1e-9, `${a} ${probs[a]}`);
  assert.ok(first.some((e) => e.payload.arm !== "balanced"), "explores sometimes");
});

test("learned → lever_policy arm: adds an extra the buyer values instead of a cut; never below floor + extras' cost", async () => {
  setLearnedPolicy(policy({ quality: "lever_policy" }));
  const { ex, events } = setup();
  const { offers } = await haggle(ex, "b-quality", QUALITY);
  assert.ok(offers.some((o) => o.levers.includes("extended_warranty")), JSON.stringify(offers));
  for (const o of offers) assert.ok(o.price >= tw.floor_price_cents + leverCost(o.levers), JSON.stringify(o));
  for (let i = 1; i < offers.length; i++) {
    assert.ok(offers[i].price <= offers[i - 1].price, "never raises a price");
    for (const l of offers[i - 1].levers) assert.ok(offers[i].levers.includes(l), "an extra once offered stays");
  }
  assert.ok(events.events.some((e) => e.type === "offer_countered" && (e.payload.rule_refs as string[]).includes("lever_instead_of_cut")));
  assert.ok(events.events.filter((e) => e.type === "offer_countered").every((e) => e.payload.arm === "lever_policy"));
});

test("learned → lever_policy: a price-first buyer gets no extras (E11: never by default)", async () => {
  setLearnedPolicy(policy({ price: "lever_policy" }));
  const { ex } = setup();
  const { offers } = await haggle(ex, "b-price", PRICE);
  assert.ok(offers.every((o) => o.levers.length === 0));
});

test("learned: below-floor fuzz over many buyers, profiles and bids (every arm, with exploration)", async () => {
  setLearnedPolicy(policy({ price: "balanced", quality: "lever_policy", delivery: "lever_policy", trust: "negotiating" }, 0.5));
  const { ex, events } = setup();
  const profiles: BuyerLeverProfile[] = [PRICE, QUALITY, { delivery: 1, price: 0.5 }, { trust: 1, warranty: 0.6, price: 0.5 }, {}];
  let k = 0;
  for (const p of SEED_PRODUCTS) for (const prof of profiles) for (const bid of [5000, 9000, 11000]) await haggle(ex, `f${k++}`, prof, p.product_id, Math.min(bid, p.list_price_cents));
  for (const e of events.events.filter((x) => x.type === "offer_countered" || x.type === "offer_accepted")) {
    const p = SEED_PRODUCTS.find((x) => x.product_id === e.product_id)!;
    assert.ok(e.price_cents! >= p.floor_price_cents + leverCost((e.payload.lever_package as string[]) ?? [], p.lever_costs), `${e.product_id} ${e.price_cents} ${e.payload.lever_package}`);
  }
  assert.ok(events.events.filter((x) => x.type === "deal_accepted").every((e) => e.payload.below_floor === false));
});

test("readLearnedPolicy: missing → no_policy, failed gate → gate_failed, junk → bad_policy, committed file parses", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-"));
  assert.equal(readLearnedPolicy(join(dir, "nope.json")).fallback, "no_policy");
  const failed = { ...policy({ price: "balanced" }), gate: { ...policy({}).gate!, passed: false } };
  writeFileSync(join(dir, "f.json"), JSON.stringify(failed));
  assert.equal(readLearnedPolicy(join(dir, "f.json")).fallback, "gate_failed");
  writeFileSync(join(dir, "j.json"), JSON.stringify({ ...policy({ price: "static" as never }) }));
  assert.equal(readLearnedPolicy(join(dir, "j.json")).fallback, "bad_policy");
  writeFileSync(join(dir, "ok.json"), JSON.stringify(policy({ price: "balanced" })));
  assert.equal(readLearnedPolicy(join(dir, "ok.json")).policy?.choice.price, "balanced");
  assert.notEqual(readLearnedPolicy(LEARNED_POLICY_FILE).fallback, "bad_policy");
});

test("default policy is the bundled copy of the committed file, not a path (Manufact build looked in apps/marketplace/)", () => {
  const saved = process.env.LEARNED_POLICY_PATH;
  delete process.env.LEARNED_POLICY_PATH;
  try {
    const onDisk = JSON.parse(readFileSync(LEARNED_POLICY_FILE, "utf8"));
    const got = readLearnedPolicy();
    assert.notEqual(got.fallback, "no_policy");
    if (onDisk.gate?.passed === true) assert.deepEqual(got.policy, onDisk);
    else assert.equal(got.fallback, "gate_failed");
    const src = readFileSync(new URL("../src/exchange/learned.ts", import.meta.url), "utf8");
    assert.match(src, /import bundled from "\.\.\/\.\.\/learned_policy\.json" with \{ type: "json" \}/, "static JSON import so bundlers inline it");
  } finally {
    if (saved !== undefined) process.env.LEARNED_POLICY_PATH = saved;
  }
});

test("Bandit IPS: weighted mean uses 1/propensity weights; raw n/sum stay counts", () => {
  const b = new Bandit();
  b.update("price", "balanced", 1000, 1 / 0.8);
  b.update("price", "balanced", 0, 1 / 0.1); // a rarely-drawn zero counts more
  assert.equal(b.stats.price.balanced.n, 2); assert.equal(b.stats.price.balanced.sum, 1000);
  assert.ok(Math.abs(b.mean("price", "balanced") - (1000 * 1.25) / (1.25 + 10)) < 1e-9);
  const plain = new Bandit(); plain.update("price", "negotiating", 500); plain.update("price", "negotiating", 1500);
  assert.equal(plain.mean("price", "negotiating"), 1000);
});

test("Bandit min_sessions: a lucky arm with too few sessions doesn't take a context; alone it still counts", () => {
  const b = new Bandit(undefined, 0.1, 10);
  for (let i = 0; i < 30; i++) b.update("trust", "balanced", 2000);
  for (let i = 0; i < 3; i++) b.update("trust", "lever_policy", 6000);
  assert.equal(b.greedy("trust"), "balanced");
  for (let i = 0; i < 7; i++) b.update("trust", "lever_policy", 6000);
  assert.equal(b.greedy("trust"), "lever_policy");
  const lone = new Bandit(undefined, 0.1, 10); lone.update("price", "lever_policy", 100);
  assert.equal(lone.greedy("price"), "lever_policy");
  assert.equal(lone.export(1).min_sessions, 10);
});

test("learned: a buyer with no lever profile (every live gateway buyer) gets the policy's `unknown` choice, not negotiating", async () => {
  setLearnedPolicy(policy({ price: "negotiating", unknown: "balanced" }));
  const { ex, events } = setup();
  await haggle(ex, "b-anon", undefined as unknown as BuyerLeverProfile);
  const e = events.events.find((x) => x.type === "offer_countered")!;
  assert.equal(e.payload.bandit_context, "unknown"); assert.equal(e.payload.arm, "balanced");
  setLearnedPolicy(undefined);
  const committed = readLearnedPolicy();
  if (committed.policy) assert.ok(committed.policy.choice.unknown, "committed policy has a choice for buyers who send no profile");
});

// ---- lever packages (pkg:<extra>) and the seller's goal as reward

function pkgPolicy(choice: LearnedPolicy["choice"], epsilon = 0): LearnedPolicy {
  return { ...policy(choice, epsilon), arms: [...ARMS] };
}

test("learned → pkg:free_shipping: leads with free shipping for any buyer, holds floor + its cost, says so plainly", async () => {
  setLearnedPolicy(pkgPolicy({ price: "pkg:free_shipping" }));
  const { ex, events } = setup();
  const { offers } = await haggle(ex, "b-pkg", PRICE);
  assert.ok(offers.some((o) => o.levers.includes("free_shipping")), JSON.stringify(offers));
  // leads with it: the first seller move below list is the perk, not a price cut
  const firstMove = offers.findIndex((o, i) => i > 0 && (o.levers.length > 0 || o.price < offers[0].price));
  assert.ok(firstMove > 0 && offers[firstMove].levers.includes("free_shipping") && offers[firstMove].price === offers[firstMove - 1].price, JSON.stringify(offers));
  assert.ok(offers.every((o) => !o.levers.includes("extended_warranty")), "only the package's extra");
  for (const o of offers) assert.ok(o.price >= tw.floor_price_cents + leverCost(o.levers), JSON.stringify(o));
  const countered = events.events.filter((e) => e.type === "offer_countered");
  assert.ok(countered.every((e) => e.payload.arm === "pkg:free_shipping"));
});

test("learned: a package arm is never drawn on a listing that doesn't offer its extra; propensity is over playable arms", async () => {
  setLearnedPolicy(pkgPolicy({ price: "pkg:extended_warranty" }, 0.6));
  const { ex, events } = setup();
  // ClackCo TKL offers only free_shipping
  for (let i = 0; i < 40; i++) await ex.handle({ kind: "offer", ctx: { run_id: "pkg", buyer_id: `c${i}`, buyer_model: "scripted" }, product_id: "kb_clackco_tkl", offer_price_cents: 8000, buyer_profile: PRICE });
  const first = events.events.filter((e) => e.type === "offer_countered");
  assert.equal(first.length, 40);
  for (const e of first) {
    assert.ok(!["pkg:extended_warranty", "pkg:bundle_discount"].includes(e.payload.arm as string), String(e.payload.arm));
    const probs = e.payload.arm_probs as Record<string, number>;
    assert.ok(Math.abs(Object.values(probs).reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.equal(probs["pkg:extended_warranty"], undefined);
  }
});

test("chooseArm: an unplayable greedy choice falls back to the best playable arm by the policy's own stats", () => {
  const lp = pkgPolicy({ delivery: "pkg:extended_warranty" });
  lp.stats = { delivery: { balanced: { n: 20, sum: 20 * 4000, sumSq: 0 }, negotiating: { n: 20, sum: 20 * 3000, sumSq: 0 } } };
  const c = chooseArm(lp, { delivery: 1 }, () => 0.99, armsFor(["free_shipping"], lp.arms));
  assert.equal(c.arm, "balanced");
});

test("objectiveReward: margin weight → profit, conversion weight → revenue; default half and half", () => {
  assert.equal(objectiveReward(4000, 12000, { margin: 1, conversion: 0 }), 4000);
  assert.equal(objectiveReward(4000, 12000, { margin: 0, conversion: 1 }), 12000);
  assert.equal(objectiveReward(4000, 12000, undefined), 8000);
  assert.equal(objectiveReward(0, 0, { margin: 0.7, conversion: 0.3 }), 0);
  assert.equal(objectiveFormula({ margin: 0.7, conversion: 0.3 }), "70% profit + 30% revenue");
});

test("the console's objective is logged on the negotiation's events", async () => {
  setLearnedPolicy(pkgPolicy({ price: "balanced" }));
  const events = new MemorySink();
  const cat = new StaticCatalog(SEED_PRODUCTS.map((p) => ({ ...p, objective: { margin: 0.8, conversion: 0.2 } })), { strategy: "learned" });
  const ex = new Exchange({ store: new MemoryStore(), catalog: cat, sink: events.sink });
  await ex.handle({ kind: "offer", ctx: { run_id: "obj", buyer_id: "o1", buyer_model: "scripted" }, product_id: TW, offer_price_cents: 9000, buyer_profile: PRICE });
  assert.deepEqual(events.events.find((e) => e.type === "offer_countered")!.payload.objective, { margin: 0.8, conversion: 0.2 });
});
