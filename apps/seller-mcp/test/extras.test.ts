// The shared extras map (@sa/seller-mcp/extras) covers every extra the exchange can price or sell, and stays public.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LeverName, LeverPackage } from "@sa/shared";
import { EXTRAS, extraLabel, extraLever, extraPhrase, extrasPackage, isExtra } from "@sa/seller-mcp/extras";
import { DEFAULT_LEVER_COSTS, SEED_PRODUCTS } from "../src/exchange";

test("every extra the exchange prices or sells is in the shared map", () => {
  for (const id of Object.keys(DEFAULT_LEVER_COSTS)) assert.ok(isExtra(id), `DEFAULT_LEVER_COSTS has ${id}`);
  for (const p of SEED_PRODUCTS) for (const id of p.allowed_levers) assert.ok(isExtra(id), `${p.product_id} sells ${id}`);
});

test("entries are valid, unique and public (no cost fields)", () => {
  assert.equal(new Set(EXTRAS.map((e) => e.id)).size, EXTRAS.length);
  for (const e of EXTRAS) {
    assert.ok(LeverName.safeParse(e.lever).success, e.id);
    assert.deepEqual(Object.keys(e).sort(), ["id", "label", "lever", "phrase"]);
    assert.ok(e.label && e.phrase && e.phrase === e.phrase.toLowerCase());
  }
});

test("decisions: free_shipping → delivery, bundle_discount → price", () => {
  assert.equal(extraLever("free_shipping"), "delivery");
  assert.equal(extraLever("bundle_discount"), "price");
  assert.equal(extraLever("gift_wrap"), undefined);
});

test("labels, phrases and the contract LeverPackage", () => {
  assert.equal(extraLabel("extended_warranty"), "Extended warranty");
  assert.equal(extraLabel("gift_wrap"), "Gift wrap");
  assert.equal(extraPhrase("free_shipping"), "free shipping");
  const pkg = extrasPackage(["free_shipping", "gift_wrap"]);
  assert.deepEqual(pkg, [{ id: "free_shipping", lever: "delivery", label: "Free shipping" }]);
  assert.ok(LeverPackage.safeParse(pkg).success);
});
