/**
 * Merchant console storage. SERVER-SIDE ONLY (Vite middleware, scripts, tests): the Supabase store uses the
 * service-role key, which must never reach the browser.
 *
 *  - memoryStore():        no database; policies live in the dev server's memory (and in the exchange it patches).
 *  - supabaseStore(db):    reads/writes contract v2 `seller_policies` (lever_menu, objective, policy, floor).
 *  - consoleCatalog(store): an E1 `Catalog` that serves the seed products with the console's edits applied,
 *                           so any Exchange built on it uses the merchant's latest menu on the next negotiation.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_LEVER_COSTS, SEED_PRODUCTS, type Catalog, type ProductConfig } from "@sa/seller-mcp/exchange";
import { applyRow, fromProductConfig, toCatalogPatch, toSellerPolicyRow, validate, type ConsolePolicy, type Problem } from "./policy";

export interface PolicyStore {
  readonly kind: "memory" | "supabase";
  list(): Promise<ConsolePolicy[]>;
  get(product_id: string): Promise<ConsolePolicy | null>;
  /** Validates first; returns the problems instead of saving when there are any. */
  save(p: ConsolePolicy): Promise<{ ok: true; policy: ConsolePolicy } | { ok: false; problems: Problem[] }>;
}

const seedPolicies = (products: ProductConfig[]) => products.map((p) => fromProductConfig(p, DEFAULT_LEVER_COSTS));

/** Keeps the product's fixed facts (title, list, unit cost) from the base; only editable fields come from the edit. */
function merge(base: ConsolePolicy, edit: ConsolePolicy): ConsolePolicy {
  return { ...base, floor_price_cents: edit.floor_price_cents, policy: edit.policy, objective: { ...edit.objective },
    levers: base.levers.map((l) => { const e = edit.levers.find((x) => x.id === l.id); return e ? { ...l, enabled: e.enabled, cost_cents: e.cost_cents } : l; }),
    updated_at: new Date().toISOString() };
}

export function memoryStore(products: ProductConfig[] = SEED_PRODUCTS): PolicyStore {
  const byId = new Map(seedPolicies(products).map((p) => [p.product_id, p]));
  return {
    kind: "memory",
    async list() { return [...byId.values()].map((p) => structuredClone(p)); },
    async get(id) { const p = byId.get(id); return p ? structuredClone(p) : null; },
    async save(edit) {
      const base = byId.get(edit.product_id);
      if (!base) return { ok: false, problems: [{ field: "product_id", message: `Unknown product ${edit.product_id}` }] };
      const next = merge(base, edit);
      const problems = validate(next);
      if (problems.length) return { ok: false, problems };
      byId.set(next.product_id, next);
      return { ok: true, policy: structuredClone(next) };
    },
  };
}

/**
 * Contract v2 (0002_contract_v2.sql) adds lever_menu / objective / policy to seller_policies. Until it's applied,
 * the store runs in v1 mode: it saves the floor and allowed_concessions (the enabled levers) to the database, and
 * keeps lever costs, policy and objective in this server's memory, saying so in `notice()`.
 */
export function supabaseStore(db: SupabaseClient, products: ProductConfig[] = SEED_PRODUCTS): PolicyStore & { schema(): Promise<"v1" | "v2">; notice(): Promise<string | null> } {
  const bases = new Map(seedPolicies(products).map((p) => [p.product_id, p]));
  const overlay = new Map<string, ConsolePolicy>(); // v1 mode only: fields the v1 table can't hold
  let schemaP: Promise<"v1" | "v2"> | null = null;
  const schema = () => (schemaP ??= (async () => {
    const { error } = await db.from("seller_policies").select("lever_menu").limit(1);
    if (!error) return "v2" as const;
    if (/lever_menu|column/i.test(error.message)) return "v1" as const;
    schemaP = null; // transient error: try again next time
    throw new Error(`seller_policies: ${error.message}`);
  })());

  const read = async (ids?: string[]) => {
    const v = await schema();
    let q = db.from("seller_policies").select(v === "v2" ? "product_id, floor_price_cents, policy, objective, lever_menu" : "product_id, floor_price_cents, allowed_concessions");
    if (ids) q = q.in("product_id", ids);
    const { data, error } = await q;
    if (error) throw new Error(`seller_policies: ${error.message}`);
    return new Map(((data ?? []) as unknown as Record<string, any>[]).map((r) => [r.product_id as string, r]));
  };
  const view = async (b: ConsolePolicy, row: Record<string, any> | undefined): Promise<ConsolePolicy> => {
    if (!row) return structuredClone(b);
    if ((await schema()) === "v2") return applyRow(b, row);
    const o = overlay.get(b.product_id) ?? b;
    const on = new Set<string>(Array.isArray(row.allowed_concessions) ? row.allowed_concessions : []);
    return { ...structuredClone(o), floor_price_cents: row.floor_price_cents ?? o.floor_price_cents,
      levers: o.levers.map((l) => ({ ...l, enabled: on.has(l.id) })) };
  };

  return {
    kind: "supabase",
    schema,
    async notice() {
      return (await schema()) === "v1"
        ? "The database doesn't have contract v2 yet: the floor and which levers are on are saved to Supabase; lever costs, policy and objective only last until the dashboard server restarts."
        : null;
    },
    async list() {
      const rows = await read();
      return Promise.all([...bases.values()].map((b) => view(b, rows.get(b.product_id))));
    },
    async get(id) {
      const b = bases.get(id);
      if (!b) return null;
      return view(b, (await read([id])).get(id));
    },
    async save(edit) {
      const base = bases.get(edit.product_id);
      if (!base) return { ok: false, problems: [{ field: "product_id", message: `Unknown product ${edit.product_id}` }] };
      const next = merge(base, edit);
      const problems = validate(next);
      if (problems.length) return { ok: false, problems };
      const v = await schema();
      const full = toSellerPolicyRow(next);
      const row = v === "v2" ? full : { floor_price_cents: full.floor_price_cents, allowed_concessions: full.allowed_concessions };
      // Update only: the row must already exist (seed.sql). Never create products from the console.
      const { error, count } = await db.from("seller_policies").update(row, { count: "exact" }).eq("product_id", next.product_id);
      if (error) throw new Error(`seller_policies update: ${error.message}`);
      if (!count) return { ok: false, problems: [{ field: "product_id", message: `${next.product_id} has no seller_policies row; run supabase/seed.sql first.` }] };
      if (v === "v1") overlay.set(next.product_id, structuredClone(next));
      return { ok: true, policy: next };
    },
  };
}

/** E1 Catalog with the console's edits applied on every read: the next negotiation sees the latest menu. */
export function consoleCatalog(store: PolicyStore, products: ProductConfig[] = SEED_PRODUCTS, overrides: Partial<ProductConfig> = {}): Catalog {
  const byId = new Map(products.map((p) => [p.product_id, p]));
  return {
    async get(product_id) {
      const p = byId.get(product_id);
      if (!p) return null;
      const edit = await store.get(product_id);
      return { ...p, ...overrides, ...(edit ? toCatalogPatch(edit) : {}), ...(overrides.strategy ? { strategy: overrides.strategy } : {}) };
    },
  };
}
