/**
 * Buyer fit and "which levers win" (FINAL_ARCHITECTURE §9: buyer fit shows we serve buyers, not just squeeze them).
 *
 * Buyer fit (0–1) for a closed deal = how much of what this buyer values the deal delivered, weighted by the
 * buyer's lever profile. Only values a deal can actually deliver are scored:
 *   price       → discount off list, full credit at FULL_DISCOUNT (20%) or more
 *   delivery    → free_shipping / fast_shipping included
 *   warranty    → extended_warranty included
 *   convenience → bundle_discount / setup included
 * quality and trust come from the product and seller, not the deal, so they don't count here.
 * A buyer with no scorable weights gets null (never a guess).
 */
export const FULL_DISCOUNT = 0.2;

const LEVER_SERVES: Record<string, "delivery" | "warranty" | "convenience" | "price"> = {
  free_shipping: "delivery",
  fast_shipping: "delivery",
  extended_warranty: "warranty",
  bundle_discount: "convenience",
  setup: "convenience",
  volume_discount: "price",
};

export function leverIds(pkg: unknown): string[] {
  if (!Array.isArray(pkg)) return [];
  return pkg.map((x) => (typeof x === "string" ? x : String((x as { id?: string; lever?: string })?.id ?? (x as { lever?: string })?.lever ?? ""))).filter(Boolean);
}

export function buyerFit(profile: Record<string, number> | undefined, levers: string[], listCents: number | null, priceCents: number | null): number | null {
  if (!profile) return null;
  const served: Record<string, number> = { price: 0, delivery: 0, warranty: 0, convenience: 0 };
  if (listCents && priceCents != null && listCents > 0) served.price = Math.max(0, Math.min(1, (listCents - priceCents) / listCents / FULL_DISCOUNT));
  for (const l of levers) {
    const dim = LEVER_SERVES[l];
    if (dim === "price") served.price = Math.min(1, served.price + 0.25);
    else if (dim) served[dim] = 1;
  }
  let num = 0, den = 0;
  for (const dim of Object.keys(served)) {
    const w = profile[dim];
    if (typeof w !== "number" || w <= 0) continue;
    num += w * served[dim];
    den += w;
  }
  return den > 0 ? num / den : null;
}

export interface LeverWin { persona: string; policy: string; package: string; deals: number; share: number }

/** For each buyer type and policy: which lever packages the closed deals carried ("price only" when none). */
export function leverWins(outcomes: { persona: string; policy: string; converted: boolean; levers: string[] }[]): LeverWin[] {
  const groups = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const o of outcomes) {
    if (!o.converted) continue;
    const g = `${o.persona}\u0000${o.policy}`;
    const pkg = o.levers.length ? [...o.levers].sort().join(" + ") : "price only";
    const m = groups.get(g) ?? groups.set(g, new Map()).get(g)!;
    m.set(pkg, (m.get(pkg) ?? 0) + 1);
    totals.set(g, (totals.get(g) ?? 0) + 1);
  }
  const out: LeverWin[] = [];
  for (const [g, m] of groups) {
    const [persona, policy] = g.split("\u0000");
    for (const [pkg, n] of m) out.push({ persona, policy, package: pkg, deals: n, share: n / totals.get(g)! });
  }
  return out.sort((a, b) => a.persona.localeCompare(b.persona) || a.policy.localeCompare(b.policy) || b.deals - a.deals);
}
