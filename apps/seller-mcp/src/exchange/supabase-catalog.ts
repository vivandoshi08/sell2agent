/**
 * E1 · Supabase-backed Catalog: the merchant console's `seller_policies` edits reach live negotiations.
 *
 * Reads all `products` + `seller_policies` rows (only the policy columns below; v2 columns dropped on a v1 schema) and
 * caches the merged map for ttl_ms (EXCHANGE_CATALOG_TTL_MS, default 5 s). Per product, the code seed is the base:
 *  - products        → title, list_price_cents, seller_id
 *  - seller_policies → floor_price_cents, unit_cost_cents; allowed_levers from v2 `lever_menu` ids when non-empty,
 *                      else v1 `allowed_concessions`; lever costs from `lever_menu`; strategy from v2 `policy`
 *  - max_rounds      → ALWAYS the seed (6 for DB-only products). The DB column is stale (3–4, pre-E2 pacing) and
 *                      the console doesn't edit it; reading it would re-clamp E2's curve (see catalog.ts).
 * Safety, in code: floor is raised to unit cost (never below the seed's unit cost for seed products, beside RLS); a row with floor > list or a non-positive / non-integer number is
 * ignored for that product (seed kept, or product skipped if not in the seed) with one warning; a lever the exchange
 * can't price is never offered. A failed load keeps the last good snapshot (the seed if none). get() never throws.
 */
import { DEFAULT_LEVER_COSTS } from "./probing";
import { SEED_PRODUCTS } from "./catalog";
import type { Catalog, ProductConfig } from "./types";

/** The slice of the Supabase client this catalog uses (structural, so tests can pass a fake). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from(table: string): any };
type Row = Record<string, unknown>;

export interface SupabaseCatalogOptions {
  ttl_ms?: number;
  seed?: ProductConfig[];
  now?: () => number;
  /** A load slower than this counts as failed (the last snapshot is served). Default 3000. */
  timeout_ms?: number;
}

/** The seller_policies columns build() reads (v2 adds lever_menu + policy). */
const POLICY_COLUMNS_V1 = "product_id,floor_price_cents,unit_cost_cents,allowed_concessions";
const POLICY_COLUMNS = `${POLICY_COLUMNS_V1},lever_menu,policy`;
const V2_MISSING = /lever_menu|\.policy\b|"policy"|column policy\b/;

const STRATEGIES =["static", "negotiating", "balanced", "learned"] as const;
const DEFAULT_MAX_ROUNDS = 6;
const posInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;
const str = (s: unknown): s is string => typeof s === "string" && s.length > 0;

function problem(c: ProductConfig): string | null {
  if (!str(c.title) || !str(c.seller_id)) return "missing title or seller_id";
  if (!posInt(c.list_price_cents) || !posInt(c.floor_price_cents) || !posInt(c.unit_cost_cents)) return "prices must be positive whole cents";
  if (c.floor_price_cents > c.list_price_cents) return `floor ${c.floor_price_cents} is above list ${c.list_price_cents}`;
  if (!c.allowed_levers.every(str)) return "bad lever id";
  if (c.lever_costs && !Object.values(c.lever_costs).every((v) => Number.isInteger(v) && v >= 0)) return "lever costs must be whole cents >= 0";
  return null;
}

export class SupabaseCatalog implements Catalog {
  private ttl: number;
  private seed: ProductConfig[];
  private now: () => number;
  private timeout: number;
  private snap: { map: Map<string, ProductConfig>; at: number } | null = null;
  private inflight: Promise<void> | null = null;
  private warned = new Set<string>();
  private failing = false;

  constructor(private db: Db, opts: SupabaseCatalogOptions = {}) {
    this.ttl = opts.ttl_ms ?? (Number(process.env.EXCHANGE_CATALOG_TTL_MS) || 5000);
    this.seed = opts.seed ?? SEED_PRODUCTS;
    this.now = opts.now ?? Date.now;
    this.timeout = opts.timeout_ms ?? 3000;
  }

  async get(product_id: string): Promise<ProductConfig | null> {
    if (!this.snap || this.now() - this.snap.at >= this.ttl) await (this.inflight ??= this.load().finally(() => { this.inflight = null; }));
    const p = this.snap?.map.get(product_id);
    return p ? { ...p, allowed_levers: [...p.allowed_levers], ...(p.lever_costs ? { lever_costs: { ...p.lever_costs } } : {}) } : null;
  }

  private warn(msg: string) {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    console.warn(`[exchange catalog] ${msg}`);
  }

  private v1 = false;

  /** seller_policies, only the columns build() reads; retries without the v2 columns (and remembers) on a v1 schema. */
  private async policies() {
    if (!this.v1) {
      const r = await this.db.from("seller_policies").select(POLICY_COLUMNS);
      if (!r?.error || !V2_MISSING.test(r.error.message ?? "")) return r;
      this.v1 = true;
      this.warn("seller_policies has no lever_menu/policy yet (0002 not applied); reading v1 columns only");
    }
    return this.db.from("seller_policies").select(POLICY_COLUMNS_V1);
  }

  private async load(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${this.timeout} ms`)), this.timeout); });
      const [prods, pols] = await Promise.race([Promise.all([this.db.from("products").select("*"), this.policies()]), timeout]);
      for (const [t, r] of [["products", prods], ["seller_policies", pols]] as const) if (r?.error) throw new Error(`${t}: ${r.error.message}`);
      this.snap = { map: this.merge((prods.data ?? []) as Row[], (pols.data ?? []) as Row[]), at: this.now() };
      this.failing = false;
    } catch (e) {
      if (!this.failing) console.warn(`[exchange catalog] load failed, serving ${this.snap ? "last snapshot" : "seed"}: ${(e as Error).message}`);
      this.failing = true;
      // Retry after another ttl, not on every call.
      this.snap = { map: this.snap?.map ?? new Map(this.seed.map((p) => [p.product_id, p])), at: this.now() };
    } finally {
      clearTimeout(timer);
    }
  }

  private merge(prods: Row[], pols: Row[]): Map<string, ProductConfig> {
    const prodBy = new Map(prods.filter((r) => str(r.id)).map((r) => [r.id as string, r]));
    const polBy = new Map(pols.filter((r) => str(r.product_id)).map((r) => [r.product_id as string, r]));
    const seedBy = new Map(this.seed.map((p) => [p.product_id, p]));
    const out = new Map<string, ProductConfig>();
    for (const id of new Set([...seedBy.keys(), ...prodBy.keys()])) {
      const p = this.build(id, seedBy.get(id), prodBy.get(id), polBy.get(id));
      if (p) out.set(id, p);
    }
    return out;
  }

  private build(id: string, seed: ProductConfig | undefined, prod: Row | undefined, pol: Row | undefined): ProductConfig | null {
    if (!seed && !(prod && pol)) return null;
    const base: ProductConfig = seed ?? { product_id: id, seller_id: "", title: "", list_price_cents: 0, floor_price_cents: 0,
      unit_cost_cents: 0, max_rounds: DEFAULT_MAX_ROUNDS, allowed_levers: [], strategy: "negotiating" };

    let withProd = base;
    if (prod) {
      if (str(prod.title) && str(prod.seller_id) && posInt(prod.list_price_cents)) {
        withProd = { ...base, title: prod.title, seller_id: prod.seller_id, list_price_cents: prod.list_price_cents };
      } else this.warn(`${id}: products row has a bad title, seller_id or list price; ignoring it`);
    }
    if (!pol) return problem(withProd) ? seed ?? null : withProd;

    let floor = (pol.floor_price_cents ?? withProd.floor_price_cents) as number;
    // Defense in depth (beside RLS): for seed products the code's unit cost is a lower bound on cost and floor, so a
    // tampered row (e.g. floor and cost set to 1¢) can't sell below the seed's cost. The console never edits unit cost.
    const unit = Math.max((pol.unit_cost_cents ?? withProd.unit_cost_cents) as number, seed?.unit_cost_cents ?? 0);
    if (typeof floor === "number" && typeof unit === "number" && floor < unit) {
      this.warn(`${id}: floor ${floor} is below unit cost ${unit}; raised to ${unit}`);
      floor = unit;
    }
    const menu = Array.isArray(pol.lever_menu) && pol.lever_menu.length ? (pol.lever_menu as Row[]) : null;
    const menuCosts = menu ? Object.fromEntries(menu.filter((m) => m?.cost_cents !== undefined).map((m) => [m?.id as string, m.cost_cents as number])) : {};
    const lever_costs = menu ? { ...withProd.lever_costs, ...menuCosts } : withProd.lever_costs;
    let allowed = (menu ? menu.map((m) => m?.id) : Array.isArray(pol.allowed_concessions) ? pol.allowed_concessions : withProd.allowed_levers) as string[];
    const unpriced = allowed.filter((l) => str(l) && lever_costs?.[l] === undefined && DEFAULT_LEVER_COSTS[l] === undefined);
    if (unpriced.length) {
      this.warn(`${id}: no cost for lever(s) ${unpriced.join(", ")}; not offering them`);
      allowed = allowed.filter((l) => !unpriced.includes(l));
    }
    const full: ProductConfig = {
      ...withProd,
      floor_price_cents: floor,
      unit_cost_cents: unit,
      allowed_levers: [...new Set(allowed)],
      ...(lever_costs ? { lever_costs } : {}),
      strategy: (STRATEGIES as readonly unknown[]).includes(pol.policy) ? (pol.policy as ProductConfig["strategy"]) : withProd.strategy,
      max_rounds: base.max_rounds, // never from the DB (see header)
    };
    const bad = problem(full);
    if (!bad) return full;
    const fallback = seed ? (problem(withProd) ? seed : withProd) : null;
    this.warn(`${id}: ignoring seller_policies row (${bad}); ${fallback ? "using the seed policy" : "product not served"}`);
    return fallback;
  }
}

/** SupabaseCatalog when SUPABASE_URL is set, else null (caller falls back to StaticCatalog). */
export async function supabaseCatalogFromEnv(opts: SupabaseCatalogOptions = {}): Promise<SupabaseCatalog | null> {
  if (!process.env.SUPABASE_URL) return null;
  const { db } = await import("@sa/shared/db");
  return new SupabaseCatalog(db, opts);
}
