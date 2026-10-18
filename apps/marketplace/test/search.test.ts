import { test } from "node:test";
import assert from "node:assert/strict";
import { searchProducts, resolveCategory, MAX_RESULTS } from "../src/search.js";

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
  assert.deepEqual(ids(out), ["kb_keyforge_quiet75"]);
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
  assert.deepEqual(new Set(ids(out)), new Set(["kb_keyforge_quiet75", "kb_typewell_65"]));
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
