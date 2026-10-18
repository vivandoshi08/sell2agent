/** S2-owned. Builds the deal card from a stored deal + public catalog facts. Copies fields by name only. */
import type { DealCard, DealLever, ProductFacts, StoredDeal } from "./types";

const LEVER_LABELS: Record<string, string> = {
  free_shipping: "Free shipping",
  fast_shipping: "Faster delivery",
  extended_warranty: "Extended warranty",
  bundle_discount: "Bundle",
  volume_discount: "Volume discount",
  setup: "Setup included",
};

/** "extended_warranty" + "2 years" → "Extended warranty · 2 years". Unknown levers get a readable fallback. */
export function leverLabel(l: DealLever): string {
  const base = LEVER_LABELS[l.name] ?? l.name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  return l.detail ? `${base} · ${l.detail}` : base;
}

export function cardStatus(deal: StoredDeal, now: Date): DealCard["status"] {
  if (deal.state === "PAID") return "paid";
  if (deal.state === "EXPIRED" || Date.parse(deal.expires_at) <= now.getTime()) return "expired";
  if (deal.state !== "AGREED") return "unavailable";
  return "ready";
}

export function toDealCard(deal: StoredDeal, product: ProductFacts, now: Date = new Date()): DealCard {
  const listTotal = product.list_price_cents * deal.quantity;
  return {
    deal_id: deal.deal_id,
    seller_name: product.seller_name,
    product: { id: product.product_id, title: product.title },
    quantity: deal.quantity,
    list_unit_price_cents: product.list_price_cents,
    unit_price_cents: deal.unit_price_cents,
    list_total_cents: listTotal,
    total_cents: deal.total_cents,
    // Never show negative savings: the seller never charges above list (E2 guarantee), but don't trust it here.
    savings_cents: Math.max(0, listTotal - deal.total_cents),
    levers: deal.levers.map((l) => ({ name: l.name, label: leverLabel(l) })),
    expires_at: deal.expires_at,
    status: cardStatus(deal, now),
    test_mode: true,
  };
}

/** Keys that must never reach a buyer-facing payload. Used by the tests and by `assertPublic` at runtime. */
export const PRIVATE_KEYS = [
  "floor_price_cents",
  "unit_cost_cents",
  "target_margin_pct",
  "min_margin_pct",
  "objective",
  "objective_weights",
  "cost_cents",
  "lever_costs",
] as const;

/** Throws if any private key appears anywhere in a payload. Cheap insurance before returning to a buyer. */
export function assertPublic(payload: unknown, path = "card"): void {
  if (payload === null || typeof payload !== "object") return;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if ((PRIVATE_KEYS as readonly string[]).includes(k)) throw new Error(`private field ${path}.${k} in buyer-facing payload`);
    assertPublic(v, `${path}.${k}`);
  }
}
