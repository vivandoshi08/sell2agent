// The gateway's public catalog, read from Supabase: the same source E1's exchange reads (#69), so search and
// negotiation always see the same products. Mirrors E1's SupabaseCatalog: cached for GATEWAY_CATALOG_TTL_MS
// (default 5 s), a load slower than 3 s or a failed load serves the last good snapshot (the code seed if none),
// and GATEWAY_CATALOG=static forces the code seed. get() never throws.
//
// Public data only: products + sellers, and from seller_policies just the extras' ids and buyer values
// (v2 lever_menu[].id/.lever, else v1 allowed_concessions). Floors, costs, margins and lever costs are never read.
import { LeverName, Product } from "@sa/shared";
import { LEVERS_OFFERED, PRODUCTS, SELLERS } from "./catalog.js";

export type PublicSeller = { id: string; name: string };

export type CatalogSnapshot = {
  products: Product[];
  sellers: PublicSeller[];
  /** extras each product's seller can include, by id */
  levers: Record<string, string[]>;
  /** buyer value per extra id, from lever_menu when present */
  leverValue: Record<string, LeverName>;
  source: "supabase" | "static";
};

export const STATIC_SNAPSHOT: CatalogSnapshot = {
  products: PRODUCTS,
  sellers: SELLERS.map(({ id, name }) => ({ id, name })),
  levers: LEVERS_OFFERED,
  leverValue: {},
  source: "static",
};

// The slice of the Supabase client this uses (structural, so tests can pass a fake).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from(table: string): any };
type Row = Record<string, unknown>;

const str = (s: unknown): s is string => typeof s === "string" && s.length > 0;

// Only what the gateway may show; floors, costs and margins are never even loaded into gateway memory.
// lever_menu exists from contract v2 (0002); before it's applied, fall back to the v1 column alone.
const POLICY_COLUMNS = "product_id,allowed_concessions,lever_menu";
const POLICY_COLUMNS_V1 = "product_id,allowed_concessions";

/** Build a public snapshot from raw rows; bad product rows are skipped. Exported for tests. */
export function toSnapshot(products: Row[], sellers: Row[], policies: Row[], warn: (m: string) => void = () => {}): CatalogSnapshot {
  const prods: Product[] = [];
  for (const row of products) {
    const r = Product.safeParse(row);
    if (r.success) prods.push(r.data);
    else warn(`skipping product ${String(row.id)}: ${r.error.issues[0]?.message}`);
  }
  const sel = sellers.filter((s) => str(s.id) && str(s.name)).map((s) => ({ id: s.id as string, name: s.name as string }));
  const known = new Set(sel.map((s) => s.id));
  const levers: Record<string, string[]> = {};
  const leverValue: Record<string, LeverName> = {};
  for (const p of policies) {
    if (!str(p.product_id)) continue;
    const menu = Array.isArray(p.lever_menu) ? (p.lever_menu as Row[]).filter((m) => str(m?.id)) : [];
    for (const m of menu) {
      const v = LeverName.safeParse(m.lever);
      if (v.success) leverValue[m.id as string] = v.data;
    }
    const ids = menu.length ? menu.map((m) => m.id as string) : Array.isArray(p.allowed_concessions) ? (p.allowed_concessions as unknown[]).filter(str) : [];
    levers[p.product_id] = ids;
  }
  return { products: prods.filter((p) => known.has(p.seller_id)), sellers: sel, levers, leverValue, source: "supabase" };
}

export class SupabaseCatalogSource {
  private snap: { s: CatalogSnapshot; at: number } | null = null;
  private inflight: Promise<void> | null = null;
  private failing = false;
  private warned = new Set<string>();

  constructor(
    private db: () => Promise<Db>,
    private opts: { ttl_ms?: number; timeout_ms?: number; now?: () => number } = {},
  ) {}

  private get ttl() { return this.opts.ttl_ms ?? (Number(process.env.GATEWAY_CATALOG_TTL_MS) || 5000); }
  private get now() { return this.opts.now ?? Date.now; }

  async get(): Promise<CatalogSnapshot> {
    if (!this.snap || this.now() - this.snap.at >= this.ttl) await (this.inflight ??= this.load().finally(() => { this.inflight = null; }));
    return this.snap!.s;
  }

  private warn = (m: string) => {
    if (this.warned.has(m)) return;
    this.warned.add(m);
    console.warn(`[gateway catalog] ${m}`);
  };

  private v1 = false;

  /** seller_policies, public columns only; retries without lever_menu (and remembers) until 0002 is applied. */
  private async policies(db: Db) {
    if (!this.v1) {
      const r = await db.from("seller_policies").select(POLICY_COLUMNS);
      if (!r?.error || !/lever_menu/.test(r.error.message ?? "")) return r;
      this.v1 = true;
      this.warn("seller_policies has no lever_menu yet (0002 not applied); reading allowed_concessions only");
    }
    return db.from("seller_policies").select(POLICY_COLUMNS_V1);
  }

  private async load(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const db = await this.db();
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${this.opts.timeout_ms ?? 3000} ms`)), this.opts.timeout_ms ?? 3000); });
      const res = await Promise.race([
        Promise.all([db.from("products").select("*"), db.from("sellers").select("id,name"), this.policies(db)]),
        timeout,
      ]);
      for (const [t, r] of [["products", res[0]], ["sellers", res[1]], ["seller_policies", res[2]]] as const) if (r?.error) throw new Error(`${t}: ${r.error.message}`);
      const s = toSnapshot(res[0].data ?? [], res[1].data ?? [], res[2].data ?? [], this.warn);
      if (!s.products.length) throw new Error("no valid products");
      this.snap = { s, at: this.now() };
      this.failing = false;
    } catch (e) {
      if (!this.failing) console.warn(`[gateway catalog] load failed, serving ${this.snap ? "last snapshot" : "code seed"}: ${(e as Error).message}`);
      this.failing = true;
      this.snap = { s: this.snap?.s ?? STATIC_SNAPSHOT, at: this.now() }; // retry after another ttl, not on every call
    } finally {
      clearTimeout(timer);
    }
  }
}

let source: SupabaseCatalogSource | undefined;

/** Current catalog: Supabase when SUPABASE_URL is set (and GATEWAY_CATALOG isn't "static"), else the code seed. */
export async function catalog(): Promise<CatalogSnapshot> {
  if (!process.env.SUPABASE_URL || process.env.GATEWAY_CATALOG === "static") return STATIC_SNAPSHOT;
  source ??= new SupabaseCatalogSource(async () => (await import("@sa/shared/db")).db);
  return source.get();
}
