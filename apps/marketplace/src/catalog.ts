// Code-seed fallback: public product data mirrored from supabase/seed.sql. The live catalog is read from
// Supabase (catalog-source.ts); this serves when that load fails or GATEWAY_CATALOG=static. The gateway never
// holds seller_policies (floor, cost, margin) — those stay inside the exchange.
import type { Product, Seller } from "@sa/shared";

export const SELLERS: Pick<Seller, "id" | "name" | "strategy">[] = [
  { id: "s_keyforge", name: "KeyForge", strategy: "negotiating" },
  { id: "s_clackco", name: "ClackCo", strategy: "negotiating" },
  { id: "s_typewell", name: "TypeWell", strategy: "negotiating" },
  { id: "s_hushline", name: "Hushline", strategy: "negotiating" },
];

export const PRODUCTS: Product[] = [
  {
    id: "kb_keyforge_quiet75",
    seller_id: "s_keyforge",
    category: "mechanical_keyboard",
    title: "KeyForge Quiet 75",
    description: "75% layout, silent linear switches, hot-swap, wireless.",
    specs: { layout: "75%", switch: "silent linear", hot_swap: true, wireless: true, battery_hours: 200, warranty: "1 year" },
    list_price_cents: 12900,
    inventory: 40,
    shipping_days: 3,
  },
  {
    id: "kb_clackco_tkl",
    seller_id: "s_clackco",
    category: "mechanical_keyboard",
    title: "ClackCo TKL Pro",
    description: "Tenkeyless, tactile switches, aluminum case, wired.",
    specs: { layout: "TKL", switch: "tactile", hot_swap: false, wireless: false, warranty: "2 years" },
    list_price_cents: 11500,
    inventory: 25,
    shipping_days: 5,
  },
  {
    id: "kb_typewell_65",
    seller_id: "s_typewell",
    category: "mechanical_keyboard",
    title: "TypeWell 65 Silent",
    description: "65% compact, silent tactile switches, wireless, hot-swap.",
    specs: { layout: "65%", switch: "silent tactile", hot_swap: true, wireless: true, battery_hours: 120, warranty: "1 year" },
    list_price_cents: 13900,
    inventory: 60,
    shipping_days: 2,
  },
  {
    id: "kb_hushline_96",
    seller_id: "s_hushline",
    category: "mechanical_keyboard",
    title: "Hushline 96 Silent",
    description: "96% layout with numpad, silent linear switches, hot-swap, wireless.",
    specs: { layout: "96%", switch: "silent linear", hot_swap: true, wireless: true, battery_hours: 90, numpad: true, warranty: "2 years" },
    list_price_cents: 12400,
    inventory: 35,
    shipping_days: 6,
  },
  {
    id: "hp_keyforge_anc",
    seller_id: "s_keyforge",
    category: "headphones",
    title: "KeyForge ANC Over-Ear",
    description: "Active noise cancelling, 40h battery, USB-C.",
    specs: { anc: true, battery_hours: 40, wireless: true, warranty: "1 year" },
    list_price_cents: 19900,
    inventory: 30,
    shipping_days: 3,
  },
  {
    id: "hp_clackco_studio",
    seller_id: "s_clackco",
    category: "headphones",
    title: "ClackCo Studio Wired",
    description: "Open-back studio headphones, wired, 250 ohm.",
    specs: { anc: false, wireless: false, impedance_ohm: 250, warranty: "2 years" },
    list_price_cents: 14900,
    inventory: 15,
    shipping_days: 4,
  },
  {
    id: "hp_typewell_buds",
    seller_id: "s_typewell",
    category: "headphones",
    title: "TypeWell ANC Buds",
    description: "In-ear ANC earbuds, 8h battery, wireless charging case.",
    specs: { anc: true, battery_hours: 8, wireless: true, warranty: "1 year" },
    list_price_cents: 12900,
    inventory: 80,
    shipping_days: 2,
  },
];

// Extras each seller can include (public: which levers exist, never what they cost). Mirrors
// seller_policies.allowed_concessions in supabase/seed.sql and the exchange's allowed_levers.
export const LEVERS_OFFERED: Record<string, string[]> = {
  kb_keyforge_quiet75: ["free_shipping", "volume_discount"],
  kb_clackco_tkl: ["free_shipping"],
  kb_typewell_65: ["free_shipping", "extended_warranty"],
  kb_hushline_96: ["free_shipping", "bundle_discount"],
  hp_keyforge_anc: ["free_shipping", "extended_warranty"],
  hp_clackco_studio: ["free_shipping"],
  hp_typewell_buds: ["free_shipping", "bundle_discount"],
};
