/**
 * Where private costs come from for run results. Server-side only.
 *  - catalogCosts(): E1's exchange catalog (mirrors supabase/seed.sql), for local runs with no database.
 *  - supabaseCosts(db): seller_policies (unit cost; v2 lever_menu costs when present).
 * Lever costs are per unit and fall back to E1's DEFAULT_LEVER_COSTS, the same numbers the exchange enforces.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_LEVER_COSTS, StaticCatalog, leverCost } from "@sa/seller-mcp/exchange";
import type { CostSource } from "./run-result";

export function catalogCosts(catalog = new StaticCatalog()): CostSource {
  return {
    unitCost: async (pid) => (await catalog.get(pid))?.unit_cost_cents ?? null,
    leverCost: async (pid, levers) => leverCost(levers, (await catalog.get(pid))?.lever_costs ?? {}),
  };
}

export async function supabaseCosts(db: SupabaseClient): Promise<CostSource> {
  const { data, error } = await db.from("seller_policies").select("*");
  if (error) throw new Error(`seller_policies: ${error.message}`);
  const unit = new Map<string, number>();
  const levers = new Map<string, Record<string, number>>();
  for (const r of data ?? []) {
    unit.set(r.product_id, r.unit_cost_cents);
    const menu: { id?: string; cost_cents?: number }[] = Array.isArray(r.lever_menu) ? r.lever_menu : [];
    levers.set(r.product_id, Object.fromEntries(menu.filter((m) => m?.id && typeof m.cost_cents === "number").map((m) => [m.id!, m.cost_cents!])));
  }
  const fallback = catalogCosts();
  return {
    unitCost: async (pid) => unit.get(pid) ?? (await fallback.unitCost(pid)),
    leverCost: async (pid, ls) => ls.reduce((s, l) => s + (levers.get(pid)?.[l] ?? DEFAULT_LEVER_COSTS[l] ?? 0), 0),
  };
}
