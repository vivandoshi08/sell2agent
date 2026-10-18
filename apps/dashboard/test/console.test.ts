// Merchant console: validation, mapping to E1's catalog, and "the next negotiation uses the edit" on the real exchange.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SellerPolicy } from "@sa/shared";
import { Exchange, MemorySink, SEED_PRODUCTS, SupabaseCatalog } from "@sa/seller-mcp/exchange";
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

// A tiny stand-in for the Supabase client over the v1 seller_policies table (what the shared DB has today).
function fakeV1Db() {
  const rows = new Map([[PID, { product_id: PID, floor_price_cents: 11_000, allowed_concessions: ["free_shipping", "extended_warranty"] }]]);
  const q = (cols: string) => {
    let ids: string[] | null = null;
    const run = () => cols.includes("lever_menu")
      ? { data: null, error: { message: "column seller_policies.lever_menu does not exist" } }
      : { data: [...rows.values()].filter((r) => !ids || ids.includes(r.product_id)), error: null };
    const b: any = { limit: () => b, in: (_c: string, v: string[]) => { ids = v; return b; }, then: (res: any) => Promise.resolve(run()).then(res) };
    return b;
  };
  const db: any = { from: () => ({
    select: q,
    update: (patch: Record<string, unknown>) => ({ eq: async (_c: string, id: string) => {
      const r = rows.get(id);
      if (!r) return { error: null, count: 0 };
      if (Object.keys(patch).some((k) => !(k in r))) return { error: { message: "column does not exist" }, count: null };
      Object.assign(r, patch); return { error: null, count: 1 };
    } }),
  }) };
  return { db, rows };
}

test("Supabase store on the v1 table: saves floor + enabled levers, keeps the rest in memory, says so", async () => {
  const { supabaseStore } = await import("../src/console/store");
  const { db, rows } = fakeV1Db();
  const store = supabaseStore(db);
  assert.equal(await store.schema(), "v1");
  assert.match((await store.notice())!, /contract v2/);
  const p = (await store.get(PID))!;
  const r = await store.save({ ...p, floor_price_cents: 11_500, policy: "balanced", levers: p.levers.map((l) => (l.id === "extended_warranty" ? { ...l, enabled: false } : l)) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(rows.get(PID)!.allowed_concessions, ["free_shipping"]);
  assert.equal(rows.get(PID)!.floor_price_cents, 11_500);
  const back = (await store.get(PID))!;
  assert.equal(back.policy, "balanced");
  assert.equal(back.levers.find((l) => l.id === "extended_warranty")!.enabled, false);
});

// Contract v2 (0002): one fake Supabase serving both the console store and E1's SupabaseCatalog (what the gateway runs).
function fakeV2Db() {
  const tables: Record<string, Record<string, any>[]> = {
    products: SEED_PRODUCTS.map((p) => ({ id: p.product_id, seller_id: p.seller_id, category: "x", title: p.title, description: "", specs: {},
      list_price_cents: p.list_price_cents, inventory: 10, shipping_days: 3 })),
    // As 0002 leaves the live rows: lever_menu [], objective null, policy 'negotiating'; allowed_concessions from seed.sql.
    seller_policies: SEED_PRODUCTS.map((p) => ({ product_id: p.product_id, floor_price_cents: p.floor_price_cents, unit_cost_cents: p.unit_cost_cents,
      target_margin_pct: 35, max_rounds: 4, allowed_concessions: [...p.allowed_levers], lever_menu: [], objective: null, policy: "negotiating", min_margin_after_levers_pct: null })),
  };
  const db: any = { from: (t: string) => ({
    select: () => {
      let ids: string[] | null = null;
      const b: any = { limit: () => b, in: (_c: string, v: string[]) => { ids = v; return b; },
        then: (res: any) => Promise.resolve({ data: structuredClone(tables[t]!.filter((r) => !ids || ids.includes(r.product_id))), error: null }).then(res) };
      return b;
    },
    update: (patch: Record<string, unknown>) => ({ eq: async (_c: string, id: string) => {
      const r = tables[t]!.find((x) => x.product_id === id);
      if (!r) return { error: null, count: 0 };
      if (Object.keys(patch).some((k) => !(k in r))) return { error: { message: "column does not exist" }, count: null };
      Object.assign(r, structuredClone(patch)); return { error: null, count: 1 };
    } }),
  }) };
  return { db, row: (id: string) => tables.seller_policies!.find((r) => r.product_id === id)! };
}

test("contract v2: console saves lever_menu + objective, the gateway's catalog offers the new lever, floor + lever cost hold", async () => {
  const { supabaseStore } = await import("../src/console/store");
  const { db, row } = fakeV2Db();
  const TKL = "kb_clackco_tkl"; // seed: free_shipping only, floor $95, list $115, unit cost $55
  const store = supabaseStore(db);
  assert.equal(await store.schema(), "v2");
  assert.equal(await store.notice(), null);
  const p = (await store.get(TKL))!;
  assert.deepEqual(p.levers.filter((l) => l.enabled).map((l) => l.id), ["free_shipping"], "fresh v2 row: allowed_concessions says which levers are on");

  const ex = new Exchange({ catalog: new SupabaseCatalog(db, { ttl_ms: 0 }), llm: null, sink: new MemorySink().sink });
  const ask = async (buyer: string) => (await ex.handle({ kind: "offer", ctx: { run_id: "s2-test-console", buyer_id: buyer, buyer_model: "scripted" },
    product_id: TKL, offer_price_cents: 9_000, levers: ["extended_warranty"] } as any)) as any;
  assert.equal((await ask("b_before")).error?.code, "bad_lever", "not on the menu yet");

  const edit = { ...p, objective: { ...p.objective, margin: 0.8 }, levers: p.levers.map((l) => (l.id === "extended_warranty" ? { ...l, enabled: true } : l)) };
  assert.equal((await store.save(edit)).ok, true);
  assert.deepEqual(row(TKL).lever_menu.map((m: any) => m.id), ["free_shipping", "extended_warranty"]);
  assert.equal(row(TKL).lever_menu[1].cost_cents, 1_200);
  assert.equal(row(TKL).objective.margin, 0.8);
  assert.deepEqual(row(TKL).allowed_concessions, ["free_shipping", "extended_warranty"], "v1 readers still see the menu");
  assert.equal((await store.get(TKL))!.objective.margin, 0.8);

  let r = await ask("b_after");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.standing_offer.levers, ["extended_warranty"]);
  for (let i = 0; i < 8 && r.ok && !r.standing_offer?.final; i++) {
    r = (await ex.handle({ kind: "offer", ctx: { run_id: "s2-test-console", buyer_id: "b_after", buyer_model: "scripted" },
      negotiation_id: r.negotiation_id, offer_price_cents: 9_000 } as any)) as any;
    assert.ok(!r.ok || r.standing_offer.price_cents >= 9_500 + 1_200, `price ${r.standing_offer?.price_cents} is under floor + warranty cost`);
  }

  // A row priced past the room between floor and list (console refuses; tampered row): the exchange won't offer it.
  row(TKL).lever_menu[1].cost_cents = 5_000;
  assert.match((await ask("b_tampered")).error?.message ?? "", /can't be offered/);

  // Every lever off writes both columns empty: console and gateway agree there are none.
  assert.equal((await store.save({ ...edit, levers: edit.levers.map((l) => ({ ...l, enabled: false })) })).ok, true);
  assert.deepEqual(row(TKL).lever_menu, []);
  assert.deepEqual((await store.get(TKL))!.levers.filter((l) => l.enabled), []);
  assert.equal((await ask("b_off")).error?.code, "bad_lever");
});
