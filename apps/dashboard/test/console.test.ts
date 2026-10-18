// Merchant console: validation, mapping to E1's catalog, and "the next negotiation uses the edit" on the real exchange.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SellerPolicy } from "@sa/shared";
import { toCatalogPatch, toSellerPolicyRow, validate } from "../src/console/policy";
import { memoryStore } from "../src/console/store";
import { tryPolicy } from "../src/console/api";

const PID = "kb_typewell_65"; // seed: free_shipping + extended_warranty allowed, floor $110, list $139

test("console starts from what the exchange runs now", async () => {
  const p = (await memoryStore().get(PID))!;
  assert.equal(p.floor_price_cents, 11_000);
  assert.deepEqual(p.levers.filter((l) => l.enabled).map((l) => l.id), ["free_shipping", "extended_warranty"]);
  assert.deepEqual(validate(p), []);
});

test("verify (DONE.md): disallow extended warranty, the next negotiation never offers it", async () => {
  const store = memoryStore();
  const before = (await tryPolicy(store, PID))!;
  assert.equal(before.levers.find((l) => l.id === "extended_warranty")?.offered, true, JSON.stringify(before.levers));

  const p = (await store.get(PID))!;
  p.levers = p.levers.map((l) => (l.id === "extended_warranty" ? { ...l, enabled: false } : l));
  assert.equal((await store.save(p)).ok, true);

  const after = (await tryPolicy(store, PID))!;
  const w = after.levers.find((l) => l.id === "extended_warranty")!;
  assert.equal(w.offered, false);
  assert.match(w.reason, /Off in your menu/);
  assert.equal(after.levers.find((l) => l.id === "free_shipping")?.offered, true);
});

test("raising the floor moves the seller's best price, never below it", async () => {
  const store = memoryStore();
  const p = (await store.get(PID))!;
  assert.equal((await store.save({ ...p, floor_price_cents: 12_500 })).ok, true);
  const r = (await tryPolicy(store, PID))!;
  assert.ok(r.best_offer_cents != null && r.best_offer_cents >= 12_500, `best ${r.best_offer_cents}`);
});

test("refuses unsafe edits: floor under cost or above list, lever that can never fit", async () => {
  const store = memoryStore();
  const p = (await store.get(PID))!;
  const low = await store.save({ ...p, floor_price_cents: 1_000 });
  assert.equal(low.ok, false);
  const high = await store.save({ ...p, floor_price_cents: 20_000 });
  assert.equal(high.ok, false);
  const pricey = await store.save({ ...p, levers: p.levers.map((l) => (l.id === "free_shipping" ? { ...l, cost_cents: 5_000 } : l)) });
  assert.equal(pricey.ok, false);
  assert.equal((await store.get(PID))!.floor_price_cents, 11_000, "nothing saved");
});

test("product facts can't be edited through the console", async () => {
  const store = memoryStore();
  const p = (await store.get(PID))!;
  const r = await store.save({ ...p, list_price_cents: 99_999, unit_cost_cents: 1 });
  assert.equal(r.ok, true);
  assert.equal((await store.get(PID))!.list_price_cents, 13_900);
});

test("maps to E1's catalog patch and to a contract-v2 seller_policies row", async () => {
  const p = (await memoryStore().get(PID))!;
  const patch = toCatalogPatch(p);
  assert.deepEqual(patch.allowed_levers, ["free_shipping", "extended_warranty"]);
  assert.equal(patch.lever_costs?.extended_warranty, 1200);
  const row = toSellerPolicyRow(p);
  // The row's v2 fields parse with the shared schema (other columns come from the existing row).
  const parsed = SellerPolicy.parse({ ...row, unit_cost_cents: 6500, target_margin_pct: 35, allowed_concessions: [] });
  assert.equal(parsed.lever_menu.length, 2);
  assert.ok(!("enabled" in parsed.lever_menu[0]));
});
