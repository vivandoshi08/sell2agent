/**
 * Keyboard catalog for the scripted E2 gate. Mirrors supabase/seed.sql (products + seller_policies)
 * so the gate runs with no database. If seed.sql changes, update this too (or load from Supabase).
 */
import type { Lever, ProductTerms, PublicProduct } from "@sa/seller-mcp/sellers";

export interface CatalogItem {
  terms: ProductTerms;
  public: PublicProduct;
}

const item = (
  product_id: string, title: string, description: string, specs: PublicProduct["specs"],
  list: number, floor: number, cost: number, shipping_days: number,
): CatalogItem => ({
  terms: { product_id, title, list_price_cents: list, floor_price_cents: floor, unit_cost_cents: cost, max_rounds: 8 },
  public: { product_id, title, description, specs, list_price_cents: list, shipping_days },
});

export const CATALOG: CatalogItem[] = [
  item("kb_keyforge_quiet75", "KeyForge Quiet 75", "75% layout, silent linear switches, hot-swap, wireless.",
    { layout: "75%", switch: "silent linear", hot_swap: true, wireless: true, battery_hours: 200 }, 12900, 10500, 6000, 3),
  item("kb_clackco_tkl", "ClackCo TKL Pro", "Tenkeyless, tactile switches, aluminum case, wired.",
    { layout: "TKL", switch: "tactile", hot_swap: false, wireless: false }, 11500, 9500, 5500, 5),
  item("kb_typewell_65", "TypeWell 65 Silent", "65% compact, silent tactile switches, wireless, hot-swap.",
    { layout: "65%", switch: "silent tactile", hot_swap: true, wireless: true, battery_hours: 120 }, 13900, 11000, 6500, 2),
];

/**
 * Lever menu each keyboard seller can offer (lever_policy). Costs are the seller's (PRIVATE);
 * buyer_value_cents is what the extra would cost a buyer separately. Same idea as E11's LEVERS, keyboard-sized.
 */
export const LEVER_MENU: Lever[] = [
  { id: "warranty_2y", lever: "warranty", label: "a 2-year warranty", cost_cents: 600, buyer_value_cents: 2000 },
  { id: "ship_2day", lever: "delivery", label: "free 2-day shipping", cost_cents: 800, buyer_value_cents: 1500 },
  { id: "keycaps", lever: "quality", label: "an extra keycap set", cost_cents: 700, buyer_value_cents: 1800 },
];

export const byId = (id: string) => {
  const c = CATALOG.find((x) => x.terms.product_id === id);
  if (!c) throw new Error(`unknown product ${id}`);
  return c;
};
