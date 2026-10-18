// Walk-away recovery: the rules in src/recovery.ts, then walk_away and find_alternatives end to end over E1's exchange.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Product } from "@sa/shared";
import { findAlternatives, MAX_ALTERNATIVES } from "../src/recovery";
import { STATIC_SNAPSHOT, type CatalogSnapshot } from "../src/catalog-source";
import { registerNegotiationTools } from "../src/negotiate";
import { registerRecoveryTools } from "../src/recovery-tools";

const URL = "http://localhost:3002/mcp";

// The code seed plus one cheaper silent keyboard, so "price" has a real answer regardless of the seed.
const BUDGET: Product = {
  id: "kb_test_60", seller_id: "s_typewell", category: "mechanical_keyboard", title: "Test 60 Silent",
  description: "60% compact, silent tactile switches, wired.", specs: { layout: "60%", switch: "silent tactile", wireless: false, warranty: "1 year" },
  list_price_cents: 9900, inventory: 10, shipping_days: 2,
};
const CAT: CatalogSnapshot = { ...STATIC_SNAPSHOT, products: [...STATIC_SNAPSHOT.products.filter((p) => p.id !== BUDGET.id), BUDGET] };
const price = (id: string, cat = CAT) => cat.products.find((p) => p.id === id)!.list_price_cents;

test("price blocker: only cheaper products that still meet the stated needs, cheapest first, never the same product", () => {
  const r = findAlternatives({ from_product_id: "kb_typewell_65", blocker: "price", still_need: ["silent"] }, CAT, URL)!;
  assert.equal(r.honest_no, false);
  assert.ok(r.alternatives.length >= 1 && r.alternatives.length <= MAX_ALTERNATIVES);
  assert.equal(r.alternatives[0].product_id, "kb_test_60");
  for (const a of r.alternatives) {
    assert.notEqual(a.product_id, "kb_typewell_65");
    assert.ok(a.list_price_cents < price("kb_typewell_65"));
    assert.match(a.title, /silent/i);
  }
  assert.match(r.summary, /price/);
});

test("never pricier than the walked product, unless the buyer states a higher budget", () => {
  const r = findAlternatives({ from_product_id: "kb_clackco_tkl", blocker: "missing_feature", still_need: ["silent"] }, CAT, URL)!;
  for (const a of r.alternatives) assert.ok(a.list_price_cents <= price("kb_clackco_tkl"));
  const roomier = findAlternatives({ from_product_id: "kb_clackco_tkl", blocker: "missing_feature", still_need: ["silent", "wireless"], max_price_cents: 13000 }, CAT, URL)!;
  assert.ok(roomier.alternatives.length > 0);
  for (const a of roomier.alternatives) assert.ok(a.list_price_cents <= 13000);
});

test("nothing fits: an honest no, never a closest-but-wrong option", () => {
  const r = findAlternatives({ from_product_id: "kb_typewell_65", blocker: "price", still_need: ["numpad", "60%"] }, CAT, URL)!;
  assert.equal(r.honest_no, true);
  assert.deepEqual(r.alternatives, []);
  assert.match(r.summary, /honest/i);
});

test("delivery blocker only returns products that ship faster; trust blocker only other sellers", () => {
  const d = findAlternatives({ from_product_id: "kb_hushline_96", blocker: "delivery" }, CAT, URL)!;
  const from = CAT.products.find((p) => p.id === "kb_hushline_96")!;
  assert.ok(d.alternatives.length > 0);
  for (const a of d.alternatives) assert.ok(a.shipping_days < from.shipping_days);
  const t = findAlternatives({ from_product_id: "kb_typewell_65", blocker: "trust" }, CAT, URL)!;
  for (const a of t.alternatives) assert.notEqual(a.seller_id, "s_typewell");
});

test("stays in the walked product's category and never exposes private fields", () => {
  const r = findAlternatives({ from_product_id: "hp_keyforge_anc", blocker: "price", still_need: ["anc"] }, CAT, URL)!;
  for (const a of r.alternatives) assert.ok(a.product_id.startsWith("hp_"));
  const keys = JSON.stringify(r);
  for (const k of ["floor_price_cents", "unit_cost_cents", "inventory", "target_margin_pct"]) assert.ok(!keys.includes(k), k);
});

test("unknown product → null", () => {
  assert.equal(findAlternatives({ from_product_id: "nope", blocker: "price" }, CAT, URL), null);
});

// ---- Tools, through E1's in-memory exchange ----
const tools = new Map<string, (a: any, rc?: any) => Promise<any>>();
const server = { tool: (def: { name: string }, fn: (a: any, rc?: any) => Promise<any>) => tools.set(def.name, fn) };
registerNegotiationTools(server, { mcpUrl: URL });
registerRecoveryTools(server, URL);
const call = (name: string, a: any) => tools.get(name)!(a);

test("walk_away with a blocker answers with better fits (code seed: Hushline and KeyForge are cheaper and silent)", async () => {
  const o = (await call("make_offer", { product_id: "kb_typewell_65", offer_price_cents: 8000, buyer_id: "rec-1", run_id: "s2-test-recovery" })).structuredContent;
  const w = await call("walk_away", { negotiation_id: o.negotiation_id, buyer_id: "rec-1", run_id: "s2-test-recovery",
    product_id: "kb_typewell_65", blocker: "price", still_need: ["silent"], need: "second desk, just needs to be quiet" });
  assert.equal(w.structuredContent.state, "walked_away");
  const r = w.structuredContent.recovery;
  assert.ok(r && r.alternatives.length > 0);
  for (const a of r.alternatives) assert.ok(a.list_price_cents < 13900 && a.product_id !== "kb_typewell_65");
  assert.match(w.content[0].text, /make_offer/);
  // The suggested product negotiates from scratch under its own policy: a fresh negotiation, round 1.
  const next = (await call("make_offer", { product_id: r.alternatives[0].product_id, offer_price_cents: 8000, buyer_id: "rec-1", run_id: "s2-test-recovery" })).structuredContent;
  assert.equal(next.ok, true);
  assert.notEqual(next.negotiation_id, o.negotiation_id);
});

test("walk_away without a blocker asks once, in the reply, and suggests nothing on its own", async () => {
  const o = (await call("make_offer", { product_id: "kb_clackco_tkl", offer_price_cents: 9000, buyer_id: "rec-2", run_id: "s2-test-recovery" })).structuredContent;
  const w = await call("walk_away", { negotiation_id: o.negotiation_id, buyer_id: "rec-2", run_id: "s2-test-recovery" });
  assert.equal(w.structuredContent.state, "walked_away");
  assert.equal(w.structuredContent.recovery, undefined);
  assert.match(w.content[0].text, /find_alternatives/);
});

test("a refused walk (wrong buyer) never runs recovery", async () => {
  const o = (await call("make_offer", { product_id: "kb_hushline_96", offer_price_cents: 9000, buyer_id: "rec-3", run_id: "s2-test-recovery" })).structuredContent;
  const w = await call("walk_away", { negotiation_id: o.negotiation_id, buyer_id: "someone-else", product_id: "kb_hushline_96", blocker: "price" });
  assert.equal(w.structuredContent.recovery, undefined);
  assert.notEqual(w.structuredContent.ok, true);
});

test("find_alternatives: read-only answer, unknown product is an error", async () => {
  const ok = await call("find_alternatives", { product_id: "kb_typewell_65", blocker: "price", still_need: ["silent"] });
  assert.equal(ok.structuredContent.ok, true);
  assert.ok(ok.structuredContent.recovery.alternatives.length > 0);
  const bad = await call("find_alternatives", { product_id: "nope", blocker: "price" });
  assert.equal(bad.isError, true);
});
