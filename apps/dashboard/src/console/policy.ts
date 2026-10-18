/**
 * Merchant console model (FINAL_ARCHITECTURE §11, S2 Bridge 3). Pure: no I/O, safe in the browser and on the server.
 *
 * A merchant edits, per product: which levers can be offered and what each costs them, the floor, the policy,
 * and objective weights. Two outputs:
 *  - `toCatalogPatch`  → E1's ProductConfig fields (allowed_levers, lever_costs, floor, strategy). The exchange
 *                        enforces them in code (bad_lever, floor + lever costs), so the next negotiation uses them.
 *  - `toSellerPolicyRow` → contract v2 `seller_policies` columns (lever_menu, objective, policy, floor).
 */
import { LeverOption, SellerObjective, type LeverName, type PolicyName } from "@sa/shared";
// Type-only: this file also runs in the browser, which must not pull in the exchange's Node code.
import type { ProductConfig } from "@sa/seller-mcp/exchange";

/** Every lever the exchange knows, with the buyer value it serves and its public label. */
export const LEVER_CATALOG: { id: string; lever: LeverName; label: string }[] = [
  { id: "free_shipping", lever: "delivery", label: "Free shipping" },
  { id: "extended_warranty", lever: "warranty", label: "Extended warranty" },
  { id: "bundle_discount", lever: "convenience", label: "Bundle discount" },
  { id: "volume_discount", lever: "price", label: "Volume discount" },
];

export interface ConsoleLever extends LeverOption { enabled: boolean }
export type Objective = SellerObjective;
/** Policies the exchange can run today (E1's ProductConfig.strategy). */
export const CONSOLE_POLICIES = ["static", "negotiating", "balanced"] as const satisfies readonly PolicyName[];
export type ConsolePolicyName = (typeof CONSOLE_POLICIES)[number];

export interface ConsolePolicy {
  product_id: string;
  title: string;
  list_price_cents: number;
  unit_cost_cents: number;
  floor_price_cents: number;
  policy: ConsolePolicyName;
  objective: Objective;
  levers: ConsoleLever[];
  updated_at?: string;
}

export const DEFAULT_OBJECTIVE: Objective = SellerObjective.parse({});

/** The console's starting view of a product: whatever the exchange runs now. */
export function fromProductConfig(p: ProductConfig, defaultCosts: Record<string, number> = {}): ConsolePolicy {
  return {
    product_id: p.product_id, title: p.title, list_price_cents: p.list_price_cents, unit_cost_cents: p.unit_cost_cents,
    floor_price_cents: p.floor_price_cents, policy: p.strategy, objective: { ...DEFAULT_OBJECTIVE },
    levers: LEVER_CATALOG.map((l) => ({ ...l, max_per_deal: 1, cost_cents: p.lever_costs?.[l.id] ?? defaultCosts[l.id] ?? 0, enabled: p.allowed_levers.includes(l.id) })),
  };
}

export interface Problem { field: string; message: string }

/** Rules the console refuses to save. The exchange enforces the same limits again in code. */
export function validate(p: ConsolePolicy): Problem[] {
  const out: Problem[] = [];
  const int = (n: number) => Number.isInteger(n) && n >= 0;
  if (!int(p.floor_price_cents) || p.floor_price_cents <= 0) out.push({ field: "floor_price_cents", message: "Floor must be a whole number of cents above zero." });
  if (p.floor_price_cents > p.list_price_cents) out.push({ field: "floor_price_cents", message: "Floor can't be above the list price." });
  if (p.floor_price_cents < p.unit_cost_cents) out.push({ field: "floor_price_cents", message: "Floor is below unit cost: every deal at the floor would lose money." });
  if (!CONSOLE_POLICIES.includes(p.policy)) out.push({ field: "policy", message: `Policy must be one of ${CONSOLE_POLICIES.join(", ")}.` });
  for (const l of p.levers) {
    if (!LeverOption.safeParse(l).success || !int(l.cost_cents)) out.push({ field: `lever:${l.id}`, message: `${l.label}: cost must be a whole number of cents, 0 or more.` });
    if (l.enabled && p.floor_price_cents + l.cost_cents > p.list_price_cents) out.push({ field: `lever:${l.id}`, message: `${l.label} costs more than the room between floor and list, so it could never be offered.` });
  }
  if (!SellerObjective.safeParse(p.objective).success) out.push({ field: "objective", message: "Objective weights must be between 0 and 1." });
  return out;
}

/** What E1's catalog needs: `StaticCatalog.set(product_id, patch)` or a Supabase-backed catalog row. */
export function toCatalogPatch(p: ConsolePolicy): Pick<ProductConfig, "allowed_levers" | "lever_costs" | "floor_price_cents" | "strategy"> {
  return {
    allowed_levers: p.levers.filter((l) => l.enabled).map((l) => l.id),
    lever_costs: Object.fromEntries(p.levers.map((l) => [l.id, l.cost_cents])),
    floor_price_cents: p.floor_price_cents,
    strategy: p.policy,
  };
}

/** Contract v2 `seller_policies` columns (0002_contract_v2.sql). `allowed_concessions` mirrors the enabled levers for v1 readers. */
export function toSellerPolicyRow(p: ConsolePolicy) {
  const enabled = p.levers.filter((l) => l.enabled);
  return {
    product_id: p.product_id,
    floor_price_cents: p.floor_price_cents,
    policy: p.policy,
    objective: p.objective,
    lever_menu: enabled.map(({ enabled: _e, ...l }) => LeverOption.parse(l)),
    allowed_concessions: enabled.map((l) => l.id),
  };
}

/** Back from a `seller_policies` row onto the console's view of a product (unknown levers are ignored). */
export function applyRow(base: ConsolePolicy, row: { floor_price_cents?: number; policy?: string | null; objective?: unknown; lever_menu?: unknown }): ConsolePolicy {
  const menu = Array.isArray(row.lever_menu) ? (row.lever_menu as { id?: string; cost_cents?: number }[]) : null;
  const obj = SellerObjective.safeParse(row.objective ?? {});
  return {
    ...base,
    floor_price_cents: row.floor_price_cents ?? base.floor_price_cents,
    policy: (CONSOLE_POLICIES as readonly string[]).includes(row.policy ?? "") ? (row.policy as ConsolePolicyName) : base.policy,
    objective: obj.success && row.objective ? obj.data : base.objective,
    levers: menu && menu.length ? base.levers.map((l) => {
      const m = menu.find((x) => x.id === l.id);
      return m ? { ...l, enabled: true, cost_cents: m.cost_cents ?? l.cost_cents } : { ...l, enabled: false };
    }) : base.levers,
  };
}
