import { test } from "node:test";
import assert from "node:assert/strict";
import { clearPreferences, preferencesFor, rememberPreferences } from "../src/preferences.js";

test("make_offer gets the profile the buyer sent to search_products", () => {
  clearPreferences();
  rememberPreferences("b1", { delivery: 1, price: 0.3, bogus: 9 });
  assert.deepEqual(preferencesFor("b1", undefined), { delivery: 1, price: 0.3 });
  assert.equal(preferencesFor("b2", undefined), undefined);
});

test("preferences on make_offer win and are remembered; all-zero counts as none", () => {
  clearPreferences();
  rememberPreferences("b1", { delivery: 1 });
  assert.deepEqual(preferencesFor("b1", { warranty: 0.9 }), { warranty: 0.9 });
  assert.deepEqual(preferencesFor("b1", { price: 0 }), { warranty: 0.9 });
});

test("remembered preferences expire after 30 minutes", () => {
  clearPreferences();
  rememberPreferences("b1", { quality: 1 }, 0);
  assert.equal(preferencesFor("b1", undefined, 31 * 60_000), undefined);
});
