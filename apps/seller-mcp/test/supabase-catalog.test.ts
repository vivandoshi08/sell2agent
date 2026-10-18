// SupabaseCatalog against a fake client (products + seller_policies, v1 and v2 rows). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SEED_PRODUCTS } from "../src/exchange/catalog";
import { SupabaseCatalog } from "../src/exchange/supabase-catalog";

type Row = Record<string, any>;
const KB = "kb_keyforge_quiet75";
const seedOf = (id: string) => SEED_PRODUCTS.find((p) => p.product_id === id)!;

/** Rows as supabase/seed.sql writes them on the live (v1) schema: max_rounds 3–4, no lever_menu/policy. */
function v1Rows() {
  const products: Row[] = SEED_PRODUCTS.map((p) => ({ id: p.product_id, seller_id: p.seller_id, category: "x", title: p.title, description: "", specs: {},
    list_price_cents: p.list_price_cents, inventory: 10, shipping_days: 3 }));
  const seller_policies: Row[] = SEED_PRODUCTS.map((p) => ({ product_id: p.product_id, floor_price_cents: p.floor_price_cents, unit_cost_cents: p.unit_cost_cents,
    target_margin_pct: 35, max_rounds: 3, allowed_concessions: [...p.allowed_levers] }));
  return { products, seller_policies };
}

function fakeDb(rows = v1Rows()) {
  const s = { ...rows, mode: "ok" as "ok" | "error" | "throw" | "hang", loads: 0 };
  const db = {
    from: (t: "products" | "seller_policies") => ({
      select: (_cols: string) => {
        if (t === "products") s.loads++;
        if (s.mode === "error") return Promise.resolve({ data: null, error: { message: "boom" } });
        if (s.mode === "throw") return Promise.reject(new Error("network down"));
        if (s.mode === "hang") return new Promise(() => {});
        return new Promise((res) => setTimeout(() => res({ data: structuredClone(s[t]), error: null }), 1));
      },
    }),
  };
  const policy = (id: string) => s.seller_policies.find((r) => r.product_id === id)!;
  return { db, s, policy };
}

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("v1 row: allowed_concessions and a console floor change reach get()", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { db, policy } = fakeDb();
  Object.assign(policy(KB), { floor_price_cents: 11000, allowed_concessions: ["free_shipping"] });
  const p = await new SupabaseCatalog(db, { ttl_ms: 5000 }).get(KB);
  assert.equal(p!.floor_price_cents, 11000);
  assert.deepEqual(p!.allowed_levers, ["free_shipping"]);
  assert.equal(p!.strategy, "negotiating", "no policy column on v1: seed strategy");
  assert.equal(p!.lever_costs, undefined, "no lever_menu on v1: default lever costs apply");
  assert.equal(p!.title, "KeyForge Quiet 75");
});

test("v2 row: lever_menu ids + costs and policy → strategy; empty menu falls back to allowed_concessions", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { db, policy } = fakeDb();
  Object.assign(policy(KB), { policy: "balanced", objective: { margin: 0.7 }, allowed_concessions: ["extended_warranty"],
    lever_menu: [{ id: "extended_warranty", lever: "warranty", label: "Extended warranty", cost_cents: 900, max_per_deal: 1 }] });
  Object.assign(policy("kb_clackco_tkl"), { policy: "aggressive", lever_menu: [], allowed_concessions: [] });
  const cat = new SupabaseCatalog(db, { ttl_ms: 5000 });
  const p = await cat.get(KB);
  assert.deepEqual(p!.allowed_levers, ["extended_warranty"]);
  assert.deepEqual(p!.lever_costs, { extended_warranty: 900 });
  assert.equal(p!.strategy, "balanced");
  const q = await cat.get("kb_clackco_tkl");
  assert.deepEqual(q!.allowed_levers, [], "merchant switched every lever off");
  assert.equal(q!.strategy, "negotiating", "unknown policy name: seed strategy");
});

test("max_rounds always comes from the seed (DB says 3); DB-only products need both rows and get 6", async (t) => {
  t.mock.method(console, "warn", () => {});
  const rows = v1Rows();
  rows.products.push({ id: "kb_new", seller_id: "s_new", title: "New Board", list_price_cents: 9900 },
    { id: "kb_orphan", seller_id: "s_new", title: "No Policy", list_price_cents: 9900 });
  rows.seller_policies.push({ product_id: "kb_new", floor_price_cents: 8000, unit_cost_cents: 4000, target_margin_pct: 30, max_rounds: 3, allowed_concessions: ["free_shipping"] });
  const cat = new SupabaseCatalog(fakeDb(rows).db, { ttl_ms: 5000 });
  for (const s of SEED_PRODUCTS) assert.equal((await cat.get(s.product_id))!.max_rounds, s.max_rounds);
  assert.deepEqual(await cat.get("kb_new"), { product_id: "kb_new", seller_id: "s_new", title: "New Board", list_price_cents: 9900, floor_price_cents: 8000,
    unit_cost_cents: 4000, max_rounds: 6, allowed_levers: ["free_shipping"], strategy: "negotiating" });
  assert.equal(await cat.get("kb_orphan"), null);
});

test("floor below unit cost is clamped up to unit cost", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const { db, policy } = fakeDb();
  policy(KB).floor_price_cents = 5000; // unit cost 6000
  const p = await new SupabaseCatalog(db, { ttl_ms: 5000 }).get(KB);
  assert.equal(p!.floor_price_cents, 6000);
  assert.equal(warn.mock.callCount(), 1);
});

test("invalid row (floor > list, non-integer) falls back to the seed and warns once per product", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const rows = v1Rows();
  rows.products.push({ id: "kb_bad", seller_id: "s_new", title: "Bad", list_price_cents: 9900 });
  rows.seller_policies.push({ product_id: "kb_bad", floor_price_cents: 9999.5, unit_cost_cents: 4000, allowed_concessions: [] });
  const { db, policy } = fakeDb(rows);
  Object.assign(policy(KB), { floor_price_cents: 20000, allowed_concessions: ["extended_warranty"] }); // list 12900
  const c = clock();
  const cat = new SupabaseCatalog(db, { ttl_ms: 5000, now: c.now });
  assert.deepEqual(await cat.get(KB), seedOf(KB));
  assert.equal(await cat.get("kb_bad"), null, "not in the seed: not served");
  c.advance(5000);
  assert.deepEqual(await cat.get(KB), seedOf(KB));
  assert.equal(warn.mock.callCount(), 2, "one warning per product across refreshes");
});

test("TTL: an edit is picked up after ttl_ms and not before; concurrent gets share one load", async () => {
  const { db, s, policy } = fakeDb();
  const c = clock();
  const cat = new SupabaseCatalog(db, { ttl_ms: 5000, now: c.now });
  const first = await Promise.all(Array.from({ length: 5 }, () => cat.get(KB)));
  assert.equal(s.loads, 1);
  assert.ok(first.every((p) => p!.floor_price_cents === 10500));
  policy(KB).floor_price_cents = 11500;
  c.advance(4999);
  assert.equal((await cat.get(KB))!.floor_price_cents, 10500);
  assert.equal(s.loads, 1);
  c.advance(1);
  const after = await Promise.all([cat.get(KB), cat.get(KB), cat.get("hp_keyforge_anc")]);
  assert.equal(after[0]!.floor_price_cents, 11500);
  assert.equal(s.loads, 2);
});

test("a failed load keeps the last good snapshot and retries after ttl, not on every call", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const { db, s, policy } = fakeDb();
  policy(KB).floor_price_cents = 11000;
  const c = clock();
  const cat = new SupabaseCatalog(db, { ttl_ms: 5000, now: c.now });
  assert.equal((await cat.get(KB))!.floor_price_cents, 11000);
  s.mode = "error";
  c.advance(5000);
  assert.equal((await cat.get(KB))!.floor_price_cents, 11000, "last snapshot, not the seed's 10500");
  assert.equal((await cat.get(KB))!.floor_price_cents, 11000);
  assert.equal(s.loads, 2);
  s.mode = "throw";
  c.advance(5000);
  assert.equal((await cat.get(KB))!.floor_price_cents, 11000);
  assert.equal(warn.mock.callCount(), 1, "warns when it starts failing, not on every retry");
  s.mode = "ok";
  policy(KB).floor_price_cents = 11200;
  c.advance(5000);
  assert.equal((await cat.get(KB))!.floor_price_cents, 11200, "recovers");
});

test("error, throw or timeout with no snapshot yet → seed; get() never throws", async (t) => {
  t.mock.method(console, "warn", () => {});
  for (const mode of ["error", "throw", "hang"] as const) {
    const { db, s } = fakeDb();
    s.mode = mode;
    const cat = new SupabaseCatalog(db, { ttl_ms: 5000, timeout_ms: 20 });
    assert.deepEqual(await cat.get(KB), seedOf(KB), mode);
    assert.equal(await cat.get("nope"), null, mode);
  }
});

test("unknown product → null; returned configs are copies", async () => {
  const cat = new SupabaseCatalog(fakeDb().db, { ttl_ms: 5000 });
  assert.equal(await cat.get("does_not_exist"), null);
  const p = await cat.get(KB);
  p!.allowed_levers.push("hacked");
  p!.floor_price_cents = 1;
  const again = await cat.get(KB);
  assert.deepEqual(again!.allowed_levers, ["free_shipping", "volume_discount"]);
  assert.equal(again!.floor_price_cents, 10500);
});

test("a tampered row can't take a seed product below the seed's unit cost", async () => {
  const { db } = fakeDb({ ...v1Rows(), seller_policies: [{ product_id: "kb_keyforge_quiet75", floor_price_cents: 1, unit_cost_cents: 1, target_margin_pct: 0, max_rounds: 4, allowed_concessions: [] }] });
  const c = new SupabaseCatalog(db);
  const p = (await c.get("kb_keyforge_quiet75"))!;
  assert.equal(p.unit_cost_cents, 6000);
  assert.equal(p.floor_price_cents, 6000);
});
