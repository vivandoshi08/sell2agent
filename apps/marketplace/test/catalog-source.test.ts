import { test } from "node:test";
import assert from "node:assert/strict";
import { STATIC_SNAPSHOT, SupabaseCatalogSource, toSnapshot } from "../src/catalog-source";
import { searchProducts, getListing } from "../src/search";

const URL = "http://localhost:3002/mcp";

const product = (id: string, seller_id: string, extra: Record<string, unknown> = {}) => ({
  id, seller_id, category: "mechanical_keyboard", title: `T ${id}`, description: "Silent linear switches, wireless.",
  specs: { wireless: true, warranty_years: 2 }, list_price_cents: 12000, inventory: 5, shipping_days: 2, ...extra,
});
const sellers = [{ id: "s_a", name: "Alpha" }, { id: "s_b", name: "Beta" }];
const policies = [
  // v2 row: lever_menu carries ids, buyer values and PRIVATE costs; only ids + values may be read
  { product_id: "kb_a", floor_price_cents: 9000, unit_cost_cents: 5000, allowed_concessions: ["free_shipping"],
    lever_menu: [{ id: "warranty_2y", lever: "warranty", label: "2-year warranty", cost_cents: 600 }] },
  // v1 row: no lever_menu, falls back to allowed_concessions
  { product_id: "kb_b", floor_price_cents: 9500, unit_cost_cents: 5500, allowed_concessions: ["free_shipping"] },
];

const allKeys = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); allKeys(x, out); }
  return out;
};

test("snapshot keeps public data only: no floors, costs or lever costs", () => {
  const s = toSnapshot([product("kb_a", "s_a"), product("kb_b", "s_b")], sellers, policies);
  const keys = allKeys(s);
  for (const k of ["floor_price_cents", "unit_cost_cents", "cost_cents", "target_margin_pct", "objective"]) assert.ok(!keys.has(k), `leaked ${k}`);
  assert.deepEqual(s.levers, { kb_a: ["warranty_2y"], kb_b: ["free_shipping"] });
  assert.equal(s.leverValue.warranty_2y, "warranty");
});

test("bad product rows and products of unknown sellers are skipped", () => {
  const s = toSnapshot([product("kb_a", "s_a"), product("kb_bad", "s_a", { list_price_cents: -1 }), product("kb_x", "s_unknown")], sellers, []);
  assert.deepEqual(s.products.map((p) => p.id), ["kb_a"]);
});

test("search and get_listing work on a database snapshot, including a new seller", () => {
  const cat = toSnapshot([product("kb_a", "s_a"), product("kb_b", "s_b", { list_price_cents: 10000 })], sellers, policies);
  const out = searchProducts({ category: "keyboard", preferences: { warranty: 1 } }, URL, cat);
  assert.equal(out.results[0].listing.id, "kb_a", "the seller offering a warranty ranks first for a warranty-first buyer");
  assert.equal(out.results[0].listing.seller_name, "Alpha");
  assert.deepEqual(out.results[0].levers_offered, [{ id: "warranty_2y", lever: "warranty", label: "Warranty 2y" }]);
  assert.equal(getListing("kb_b", URL, cat)?.seller_name, "Beta");
  const keys = allKeys(out);
  for (const k of ["floor_price_cents", "unit_cost_cents", "cost_cents", "inventory"]) assert.ok(!keys.has(k), `leaked ${k}`);
});

const fakeDb = (rows: { products: unknown[]; sellers: unknown[]; seller_policies: unknown[] }, opts: { fail?: boolean; delayMs?: number } = {}) => {
  let loads = 0;
  return {
    get loads() { return loads; },
    db: async () => ({
      from: (t: keyof typeof rows) => ({
        select: async () => {
          if (t === "products") loads++;
          if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
          return opts.fail ? { data: null, error: { message: "boom" } } : { data: rows[t], error: null };
        },
      }),
    }),
  };
};

test("source caches for the ttl, then reloads", async () => {
  let now = 0;
  const f = fakeDb({ products: [product("kb_a", "s_a")], sellers, seller_policies: policies });
  const src = new SupabaseCatalogSource(f.db, { ttl_ms: 5000, now: () => now });
  assert.equal((await src.get()).source, "supabase");
  await src.get();
  assert.equal(f.loads, 1);
  now = 6000;
  await src.get();
  assert.equal(f.loads, 2);
});

test("a failing or slow database serves the code seed (never throws)", async () => {
  const failing = new SupabaseCatalogSource(fakeDb({ products: [], sellers: [], seller_policies: [] }, { fail: true }).db);
  assert.equal(await failing.get(), STATIC_SNAPSHOT);
  const slow = new SupabaseCatalogSource(fakeDb({ products: [product("kb_a", "s_a")], sellers, seller_policies: [] }, { delayMs: 200 }).db, { timeout_ms: 20 });
  assert.equal(await slow.get(), STATIC_SNAPSHOT);
});

test("an empty catalog in the database falls back to the seed rather than showing nothing", async () => {
  const src = new SupabaseCatalogSource(fakeDb({ products: [], sellers, seller_policies: [] }).db);
  assert.equal(await src.get(), STATIC_SNAPSHOT);
});

// Live DB before 0002: seller_policies has no lever_menu. Asking for it must not drop the live catalog.
test("no lever_menu column yet: retries with v1 columns, never asks for floors or costs", async () => {
  const asked: string[] = [];
  const db = async () => ({
    from: (t: string) => ({
      select: async (cols: string) => {
        asked.push(`${t}:${cols}`);
        if (t === "seller_policies" && cols.includes("lever_menu")) return { data: null, error: { message: "column seller_policies.lever_menu does not exist" } };
        if (t === "products") return { data: [product("kb_a", "s_a")], error: null };
        if (t === "sellers") return { data: sellers, error: null };
        return { data: [{ product_id: "kb_a", allowed_concessions: ["free_shipping"] }], error: null };
      },
    }),
  });
  let now = 0;
  const src = new SupabaseCatalogSource(db, { now: () => now, ttl_ms: 1 });
  const s = await src.get();
  assert.equal(s.source, "supabase", "the live catalog is served, not the code seed");
  assert.deepEqual(s.levers, { kb_a: ["free_shipping"] });
  now = 10;
  await src.get(); // second load remembers: no repeated failing query
  const policyQueries = asked.filter((q) => q.startsWith("seller_policies"));
  assert.equal(policyQueries.filter((q) => q.includes("lever_menu")).length, 1);
  for (const q of policyQueries) for (const c of ["floor_price_cents", "unit_cost_cents", "target_margin_pct", "*"]) assert.ok(!q.includes(c), `asked for ${c}: ${q}`);
});
