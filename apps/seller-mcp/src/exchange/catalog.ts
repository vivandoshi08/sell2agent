/**
 * E1 · Seller-private product config. Default: the committed supabase/seed.sql values (so the exchange runs
 * with no database). A Supabase-backed Catalog reads `products` + `seller_policies` + `sellers` the same way.
 *
 * max_rounds: 6 (was 3–4). E2's `negotiating` curve (t^4, hold 1) needs room to pace; at 3–4 the exchange's
 * concession_cap clamped most last-round drops. 6 = middle ground between profit and chat length (each round is a
 * tool call in ChatGPT). 9+ would remove the clamp entirely. Numbers: PR description.
 */
import type { Catalog, ProductConfig } from "./types";

const SEED: ProductConfig[] = [
  { product_id: "kb_keyforge_quiet75", seller_id: "s_keyforge", title: "KeyForge Quiet 75", list_price_cents: 12900, floor_price_cents: 10500, unit_cost_cents: 6000, max_rounds: 6, allowed_levers: ["free_shipping", "volume_discount"], strategy: "negotiating" },
  { product_id: "kb_clackco_tkl", seller_id: "s_clackco", title: "ClackCo TKL Pro", list_price_cents: 11500, floor_price_cents: 9500, unit_cost_cents: 5500, max_rounds: 6, allowed_levers: ["free_shipping"], strategy: "negotiating" },
  { product_id: "kb_typewell_65", seller_id: "s_typewell", title: "TypeWell 65 Silent", list_price_cents: 13900, floor_price_cents: 11000, unit_cost_cents: 6500, max_rounds: 6, allowed_levers: ["free_shipping", "extended_warranty"], strategy: "negotiating" },
  { product_id: "hp_keyforge_anc", seller_id: "s_keyforge", title: "KeyForge ANC Over-Ear", list_price_cents: 19900, floor_price_cents: 16000, unit_cost_cents: 9000, max_rounds: 6, allowed_levers: ["free_shipping", "extended_warranty"], strategy: "negotiating" },
  { product_id: "hp_clackco_studio", seller_id: "s_clackco", title: "ClackCo Studio Wired", list_price_cents: 14900, floor_price_cents: 12000, unit_cost_cents: 7000, max_rounds: 6, allowed_levers: ["free_shipping"], strategy: "negotiating" },
  { product_id: "hp_typewell_buds", seller_id: "s_typewell", title: "TypeWell ANC Buds", list_price_cents: 12900, floor_price_cents: 10000, unit_cost_cents: 5000, max_rounds: 6, allowed_levers: ["free_shipping", "bundle_discount"], strategy: "negotiating" },
];

export class StaticCatalog implements Catalog {
  private byId: Map<string, ProductConfig>;
  constructor(products: ProductConfig[] = SEED, overrides: Partial<ProductConfig> = {}) {
    this.byId = new Map(products.map((p) => [p.product_id, { ...p, ...overrides }]));
  }
  async get(product_id: string) {
    const p = this.byId.get(product_id);
    return p ? { ...p } : null;
  }
  /** Merchant console / tests: change a policy live (e.g. raise a floor). */
  set(product_id: string, patch: Partial<ProductConfig>) {
    const p = this.byId.get(product_id);
    if (p) this.byId.set(product_id, { ...p, ...patch });
  }
}

export const SEED_PRODUCTS = SEED;
