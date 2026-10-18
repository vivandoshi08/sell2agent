/**
 * E2 · lever_policy (BUILD_PLAN E2 H9–H13, FINAL_ARCHITECTURE §2). GATED: ships only if it beats
 * `negotiating` on lever-profile buyers (pnpm e2:lever-gate).
 *
 * Same price curve as `negotiating`. One difference: when the curve says "cut the price this round", the
 * policy checks whether THIS buyer values some extra more than price, and whether that extra costs the
 * seller less than the cut. If so, it holds the price and adds the extra instead.
 *
 * E11 lesson (levers-first lost $730/session): never add extras by default, never on top of a cut, and
 * only for levers the buyer's profile values above price. Price-first buyers get plain `negotiating`.
 *
 * Guarantees (in code): price ≥ soft floor + cost of included levers (margin after levers holds);
 * a lever once offered stays in every later offer (no worse deal for staying); never above list.
 */
import { askPrice, DEFAULT_SOFT_FLOOR_BUFFER, softFloor, TACTICS, usd } from "./decide";
import type { BuyerLeverProfile, Lever, PackageItem, ProposedMove, SellerPolicy, SellerState } from "./types";

export const DEFAULT_LEVER_THRESHOLD = 0.6;

const pub = (l: Lever): PackageItem => ({ id: l.id, lever: l.lever, label: l.label });
const listLabels = (ls: Lever[]) => ls.map((l) => l.label).join(" and ");
const withLevers = (ls: Lever[]) => (ls.length ? `, including ${listLabels(ls)}` : "");

/** The extra (if any) worth offering instead of a price cut of `cut` cents. Pure; exported for tests. */
export function pickLever(menu: Lever[], included: Set<string>, profile: BuyerLeverProfile | undefined, cut: number, threshold = DEFAULT_LEVER_THRESHOLD, lead = false): Lever | null {
  if (!profile || cut <= 0) return null;
  // A learned package (lead): offer its one extra at the first concession, whatever that cut is. Without this the
  // extra only fired when the cut happened to exceed its cost, which the balanced curve's small early cuts rarely do.
  if (lead) return menu.find((l) => !included.has(l.id)) ?? null;
  const priceWeight = profile.price ?? 0.5;
  const eligible = menu.filter((l) => {
    const w = profile[l.lever] ?? 0;
    return !included.has(l.id) && w >= threshold && w > priceWeight && l.cost_cents < cut;
  });
  if (!eligible.length) return null;
  // Most valued by this buyer first; then cheapest for us.
  eligible.sort((a, b) => (profile[b.lever] ?? 0) - (profile[a.lever] ?? 0) || a.cost_cents - b.cost_cents);
  return eligible[0];
}

export function decideLever(state: SellerState, policy: SellerPolicy, profile?: BuyerLeverProfile): ProposedMove {
  const { list_price_cents: list, floor_price_cents: floor, max_rounds } = state.terms;
  const menu = policy.lever_menu ?? [];
  const buffer = policy.soft_floor_buffer ?? DEFAULT_SOFT_FLOOR_BUFFER;
  const mine = state.history.filter((o) => o.by === "seller");
  const last = mine.at(-1);
  const prev = mine.length ? Math.min(...mine.map((o) => o.price_cents)) : undefined;
  const included = menu.filter((l) => last?.levers?.includes(l.id));
  const includedCost = included.reduce((s, l) => s + l.cost_cents, 0);
  const effSoft = softFloor(list, floor, buffer) + includedCost; // margin after levers

  const { ask: curveAsk, frac } = askPrice(state, TACTICS[policy.base_tactic ?? "negotiating"], buffer);
  // Never below the floor that covers the extras already promised (and never above our last offer).
  const ask = Math.min(prev ?? list, Math.max(curveAsk, effSoft));
  const bid = state.buyer_offer_cents === undefined ? undefined : Math.min(state.buyer_offer_cents, list);
  const isFinal = state.round >= max_rounds;
  const base = { conceded_fraction: frac, lever_package: included.map(pub), lever_cost_cents: includedCost };

  if (bid !== undefined && bid >= ask) {
    return { ...base, action: "accept", price_cents: bid, final: true, reason: "buyer_offer_meets_ask",
      reason_text: `Your offer of ${usd(bid)} meets what we'd ask right now, so we accept${withLevers(included)}.` };
  }

  // The substitution: hold price, add a valued extra that costs us less than the cut we'd otherwise make.
  if (!isFinal && prev !== undefined) {
    const cut = prev - ask;
    const lever = pickLever(menu, new Set(included.map((l) => l.id)), profile, cut, policy.lever_weight_threshold, policy.lever_pitch === "offer");
    if (lever && prev >= softFloor(list, floor, buffer) + includedCost + lever.cost_cents) {
      const pkg = [...included, lever];
      return { ...base, action: "offer", price_cents: prev, final: false, reason: "lever_instead_of_cut",
        lever_package: pkg.map(pub), lever_cost_cents: includedCost + lever.cost_cents,
        reason_text: `${policy.lever_pitch === "offer" ? "Instead of lowering the price this round" : `You said ${lever.lever} matters to you, so instead of lowering the price this round`} we're adding ${lever.label}. The price stays ${usd(prev)}${pkg.length > 1 ? `, including ${listLabels(pkg)}` : ""}.` };
    }
  }

  if (isFinal) {
    return { ...base, action: "offer", price_cents: ask, final: true, reason: "final_offer",
      reason_text: `This is the last round of the negotiation, so ${usd(ask)}${withLevers(included)} is our final offer.` };
  }
  if (prev === undefined && ask === list) {
    return { ...base, action: "offer", price_cents: ask, final: false, reason: "opening_at_list",
      reason_text: `We open at our list price of ${usd(list)}. We move gradually from there over the next rounds.` };
  }
  if (ask <= effSoft || ask === prev) {
    return { ...base, action: "offer", price_cents: ask, final: false, reason: "already_at_best",
      reason_text: ask <= effSoft ? `${usd(ask)}${withLevers(included)} is the lowest price we'll offer for this package.` : `We're holding at ${usd(ask)}${withLevers(included)} this round.` };
  }
  return { ...base, action: "offer", price_cents: ask, final: false, reason: "pacing",
    reason_text: prev === undefined ? `We can offer ${usd(ask)}${withLevers(included)}. We concede gradually as the negotiation goes on.` : `We can come down from ${usd(prev)} to ${usd(ask)}${withLevers(included)} this round. We concede gradually as the negotiation goes on.` };
}
