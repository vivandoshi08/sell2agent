/**
 * Randomized lever-profile buyers + one-session simulator, for training and gating the bandit.
 * Same buyer model as e2-lever-gate.ts: extras are valued by the lever profile; the walk-away is a HARD limit.
 */
import { decide, type BuyerLeverProfile, type PolicyName, type ProposedMove, type SellerState } from "@sa/seller-mcp/sellers";
import { CATALOG, LEVER_MENU, type CatalogItem } from "./catalog";

export const PROFILES: Record<string, BuyerLeverProfile> = {
  price_first: { price: 1, quality: 0.3 },
  quality_first: { quality: 1, warranty: 0.8, price: 0.3 },
  speed_first: { delivery: 1, price: 0.5 },
  trust_first: { trust: 1, warranty: 0.6, price: 0.5 },
  balanced: { price: 0.6, quality: 0.6, delivery: 0.5 },
};

export interface SimBuyer {
  persona: string;
  profile: BuyerLeverProfile;
  product: CatalogItem;
  walkaway: number; // cents, hard limit
  open: number; // first bid = open × walk-away
  concede: number; // share of remaining gap closed per round
}

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Walk-aways span −10% … 120% of the list–floor gap: some unwinnable, some would pay list. */
export function makeSimBuyers(n: number, seed: number): SimBuyer[] {
  const r = rng(seed);
  const personas = Object.keys(PROFILES);
  return Array.from({ length: n }, () => {
    const persona = personas[Math.floor(r() * personas.length)];
    const product = CATALOG[Math.floor(r() * CATALOG.length)];
    const { list_price_cents: list, floor_price_cents: floor } = product.terms;
    const w = -0.1 + r() * 1.3;
    return { persona, profile: PROFILES[persona], product, walkaway: Math.round((floor + w * (list - floor)) / 100) * 100,
      open: 0.78 + r() * 0.1, concede: 0.25 + r() * 0.25 };
  });
}

const perceived = (b: SimBuyer, m: ProposedMove) =>
  (m.lever_package ?? []).reduce((s, l) => s + (b.profile[l.lever] ?? 0) * (LEVER_MENU.find((x) => x.id === l.id)?.buyer_value_cents ?? 0), 0);

function bidFor(b: SimBuyer, round: number, max: number) {
  if (round >= max) return b.walkaway;
  let bid = b.open * b.walkaway;
  for (let k = 1; k < round; k++) bid += b.concede * (b.walkaway - bid);
  return Math.min(b.walkaway, Math.round(bid / 100) * 100);
}

export interface SessionResult { closed: boolean; price: number; profit: number; belowFloor: boolean }

export function simulate(b: SimBuyer, policy: PolicyName): SessionResult {
  const { terms } = b.product;
  const pol = { name: policy, lever_menu: LEVER_MENU };
  const history: SellerState["history"] = [];
  let standing: ProposedMove | undefined;
  const close = (m: ProposedMove, price: number): SessionResult => {
    const lc = m.lever_cost_cents ?? 0;
    return { closed: true, price, profit: price - terms.unit_cost_cents - lc, belowFloor: price < terms.floor_price_cents + lc };
  };
  const ok = (m: ProposedMove, cap: number) => m.price_cents <= b.walkaway && m.price_cents - perceived(b, m) <= cap;
  for (let round = 1; round <= terms.max_rounds; round++) {
    const next = bidFor(b, round, terms.max_rounds);
    if (standing && ok(standing, next)) return close(standing, standing.price_cents);
    const bid = Math.min(next, standing?.price_cents ?? Infinity);
    const m = decide({ round, terms, history: [...history], buyer_offer_cents: bid }, pol, b.profile);
    history.push({ by: "buyer", round, price_cents: bid });
    if (m.action === "accept") return close(m, m.price_cents);
    history.push({ by: "seller", round, price_cents: m.price_cents, levers: m.lever_package?.map((l) => l.id) });
    standing = m;
  }
  if (standing && ok(standing, b.walkaway)) return close(standing, standing.price_cents);
  return { closed: false, price: 0, profit: 0, belowFloor: false };
}
