import { test } from "node:test";
import assert from "node:assert/strict";
import { searchProducts, resolveCategory, warrantyYears, MAX_RESULTS } from "../src/search.js";

const URL = "http://localhost:3002/mcp";
const ids = (out: ReturnType<typeof searchProducts>) => out.results.map((r) => r.listing.id);

// Seller-private fields (SellerPolicy) and internal stock counts must never reach a buyer.
const PRIVATE_KEYS = [
  "floor_price_cents",
  "unit_cost_cents",
  "target_margin_pct",
  "max_rounds",
  "allowed_concessions",
  "inventory",
  "objective",
];

function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

test("no private fields in any search result, exact or relaxed", () => {
  const queries = [
    {},
    { category: "mechanical_keyboard" },
    { q: "quiet wireless" },
    { category: "headphones" },
    { must_have: ["usb hub"] }, // relaxed path
  ];
  for (const q of queries) {
    const keys = allKeys(searchProducts(q, URL));
    for (const k of PRIVATE_KEYS) assert.ok(!keys.has(k), `leaked ${k} for ${JSON.stringify(q)}`);
  }
});

test("returns at most MAX_RESULTS", () => {
  assert.ok(searchProducts({}, URL).results.length <= MAX_RESULTS);
});

test("hard needs and budget filter out misses", () => {
  const out = searchProducts({ category: "mechanical_keyboard", max_price_cents: 13000, must_have: ["silent"] }, URL);
  assert.equal(out.relaxed, false);
  assert.deepEqual(ids(out), ["kb_hushline_96", "kb_keyforge_quiet75"]); // TypeWell ($139) is over budget
});

test("a false spec flag does not match its name", () => {
  const out = searchProducts({ category: "mechanical_keyboard", must_have: ["wireless"] }, URL);
  assert.ok(!ids(out).includes("kb_clackco_tkl"), "wired keyboard matched 'wireless'");
});

test("loose categories resolve", () => {
  assert.equal(resolveCategory("keyboard"), "mechanical_keyboard");
  assert.equal(resolveCategory("Keyboards"), "mechanical_keyboard");
  assert.equal(resolveCategory("headphone"), "headphones");
  assert.equal(resolveCategory("toaster"), undefined);
});

// Regression: the exact call ChatGPT made on 2026-10-17 returned nothing, so it fell back to web shopping.
test("ChatGPT's phrasing finds the quiet keyboards", () => {
  const out = searchProducts(
    { q: "quiet keyboard under $150", category: "keyboard", max_price_cents: 15000, must_have: ["quiet typing"] },
    URL,
  );
  assert.equal(out.relaxed, false);
  assert.deepEqual(new Set(ids(out)), new Set(["kb_keyforge_quiet75", "kb_typewell_65", "kb_hushline_96"]));
});

test("quiet matches silent", () => {
  const out = searchProducts({ q: "quiet", category: "mechanical_keyboard" }, URL);
  assert.ok(ids(out).includes("kb_typewell_65"));
});

test("an unmet need returns the closest options and says what they miss", () => {
  const out = searchProducts({ category: "mechanical_keyboard", must_have: ["usb hub"] }, URL);
  assert.equal(out.relaxed, true);
  assert.ok(out.results.length > 0);
  for (const r of out.results) assert.match(r.fit_note, /Does not meet: usb hub/);
});

test("an unknown category doesn't hide everything", () => {
  const out = searchProducts({ category: "toaster", q: "quiet" }, URL);
  assert.ok(out.results.length > 0);
  assert.match(out.note ?? "", /Unknown category/);
});

// ---- Bridge 2: lever-profile ranking ----
const KB = { category: "mechanical_keyboard" };

test("price-first buyer: cheapest keyboard first", () => {
  const out = searchProducts({ ...KB, preferences: { price: 1 } }, URL);
  assert.equal(ids(out)[0], "kb_clackco_tkl");
  assert.ok(out.results.every((r) => typeof r.fit_score === "number"));
});

test("delivery-first buyer: fastest shipping first", () => {
  assert.equal(ids(searchProducts({ ...KB, preferences: { delivery: 1 } }, URL))[0], "kb_typewell_65");
});

test("quality + warranty buyer: the one with an extended warranty and premium features first", () => {
  const out = searchProducts({ ...KB, preferences: { quality: 1, warranty: 0.8, price: 0.1 } }, URL);
  assert.deepEqual(ids(out).slice(0, 2), ["kb_typewell_65", "kb_keyforge_quiet75"]);
  assert.match(out.results[0].fit_note, /Strong on .*warranty/);
});

test("same products, different buyers, different order", () => {
  const cheap = ids(searchProducts({ ...KB, preferences: { price: 1 } }, URL));
  const premium = ids(searchProducts({ ...KB, preferences: { quality: 1, warranty: 1 } }, URL));
  assert.notDeepEqual(cheap, premium);
});

test("hard needs still filter before ranking", () => {
  const out = searchProducts({ ...KB, must_have: ["wireless"], preferences: { price: 1 } }, URL);
  assert.ok(!ids(out).includes("kb_clackco_tkl"), "wired keyboard ranked despite a wireless hard need");
});

test("no preferences: no fit_score, previous ordering", () => {
  const out = searchProducts({ q: "quiet", ...KB }, URL);
  assert.ok(out.results.every((r) => r.fit_score === undefined));
  assert.equal(ids(out)[0], "kb_hushline_96"); // all match "quiet" (silent); cheapest first
});

test("levers offered are public labels only, never costs", () => {
  const out = searchProducts({ ...KB, preferences: { warranty: 1 } }, URL);
  const tw = out.results.find((r) => r.listing.id === "kb_typewell_65")!;
  assert.deepEqual(tw.levers_offered.map((l) => l.id).sort(), ["extended_warranty", "free_shipping"]);
  assert.ok(tw.levers_offered.every((l) => l.label && l.lever));
  // E1's shared extras map (#73): free shipping serves delivery, labels match the console and deal card.
  assert.deepEqual(tw.levers_offered.find((l) => l.id === "free_shipping"), { id: "free_shipping", lever: "delivery", label: "Free shipping" });
  const json = JSON.stringify(out);
  for (const k of ["cost_cents", "floor_price_cents", "unit_cost_cents", "objective"]) assert.ok(!json.includes(k), `leaked ${k}`);
});

// Regression: in the production bundle @sa/shared runs on zod 4, where LeverProfile needs every lever.
test("a partial lever profile filled with zeros ranks the same as the partial one", () => {
  const partial = searchProducts({ ...KB, preferences: { quality: 1, warranty: 0.8 } }, URL);
  const filled = searchProducts({ ...KB, preferences: { price: 0, quality: 1, delivery: 0, warranty: 0.8, trust: 0, convenience: 0 } }, URL);
  assert.deepEqual(ids(filled), ids(partial));
  assert.deepEqual(filled.results.map((r) => r.fit_score), partial.results.map((r) => r.fit_score));
});

// ---- Catalog expansion: four competing keyboard sellers, each states a warranty ----
test("four keyboard sellers compete, and every keyboard states a warranty", () => {
  const out = searchProducts(KB, URL);
  assert.equal(new Set(out.results.map((r) => r.listing.seller_id)).size, 4);
  for (const r of out.results) assert.ok(warrantyYears(r.listing) >= 1, `${r.listing.id} states no warranty`);
});

test("warranty buyer: extended-warranty extra first, then the longest stated warranty", () => {
  const out = ids(searchProducts({ ...KB, preferences: { warranty: 1 } }, URL));
  assert.equal(out[0], "kb_typewell_65");
  assert.equal(out.at(-1), "kb_keyforge_quiet75"); // 1 year, no extra
});

test("warrantyYears reads loose phrasings", () => {
  assert.equal(warrantyYears({ specs: { warranty: "2 years" } }), 2);
  assert.equal(warrantyYears({ specs: { warranty: "1-year limited" } }), 1);
  assert.equal(warrantyYears({ specs: { warranty: "18 months" } }), 1.5);
  assert.equal(warrantyYears({ specs: {} }), 0);
});
