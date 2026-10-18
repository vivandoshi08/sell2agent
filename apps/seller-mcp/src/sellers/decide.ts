/**
 * E2 · decide(): the seller's pricing brain. Pure code, no LLM, so it's fast and testable.
 * The LLM only *voices* the move (voice.ts). E1's guardrails re-check every move afterwards.
 *
 * Concession curve (ported from experiments/e10_priorities/sellers.py):
 *   t     = clamp((round − hold_rounds) / (max_rounds − horizon_offset − hold_rounds), 0, 1)
 *   frac  = max_concession · t^exponent          (0 = list, 1 = floor)
 *   ask   = list − frac · (list − floor)
 * then: rounded to whole dollars, never below the soft floor, never above our previous offer.
 *
 * Policies:
 *   static       list price, fixed. The baseline.
 *   negotiating  E10 "profit" tactic: hold list in round 1, t^4, at most 75% of the gap.
 *                Beat the balanced Boulware by $913/session in E10. The build default.
 *   balanced     E5/E10 Boulware t^3 to the floor by the last answerable round. For comparison.
 */
import { decideLever } from "./levers";
import type { BuyerLeverProfile, PolicyName, ProposedMove, SellerPolicy, SellerState } from "./types";

interface Tactic {
  exponent: number;
  max_concession: number;
  hold_rounds: number;
  horizon_offset: number;
}

export const TACTICS: Record<"negotiating" | "balanced", Tactic> = {
  negotiating: { exponent: 4, max_concession: 0.75, hold_rounds: 1, horizon_offset: 1 },
  balanced: { exponent: 3, max_concession: 1, hold_rounds: 0, horizon_offset: 1 },
};

export const DEFAULT_SOFT_FLOOR_BUFFER = 0.03;

export const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export function concessionFraction(t: Tactic, round: number, maxRounds: number): number {
  const end = maxRounds - t.horizon_offset;
  const span = Math.max(1, end - t.hold_rounds);
  const x = Math.min(1, Math.max(0, (round - t.hold_rounds) / span));
  return t.max_concession * x ** t.exponent;
}

export function softFloor(list: number, floor: number, buffer = DEFAULT_SOFT_FLOOR_BUFFER): number {
  return Math.min(list, floor + Math.ceil(buffer * (list - floor)));
}

/** Our lowest offer so far in this negotiation (offers only ever go down). */
function lastSellerOffer(state: SellerState): number | undefined {
  const mine = state.history.filter((o) => o.by === "seller").map((o) => o.price_cents);
  return mine.length ? Math.min(...mine) : undefined;
}

/** The price we'd ask this round under a tactic, after rounding and all clamps. */
export function askPrice(state: SellerState, tactic: Tactic, buffer = DEFAULT_SOFT_FLOOR_BUFFER): { ask: number; frac: number } {
  const { list_price_cents: list, floor_price_cents: floor, max_rounds } = state.terms;
  const frac = concessionFraction(tactic, state.round, max_rounds);
  const raw = list - frac * (list - floor);
  let ask = Math.round(raw / 100) * 100; // whole dollars
  ask = Math.max(softFloor(list, floor, buffer), Math.min(list, ask));
  const prev = lastSellerOffer(state);
  if (prev !== undefined) ask = Math.min(ask, prev); // never go back up
  return { ask, frac: list === floor ? 0 : (list - ask) / (list - floor) };
}

/**
 * Signature agreed with E1 (docs/e1-asks.html n8): decide(state, sellerPolicy, buyerProfile).
 * buyerProfile is read only by lever_policy (levers.ts); static/negotiating/balanced ignore it.
 */
export function decide(state: SellerState, policy: SellerPolicy, buyerProfile?: BuyerLeverProfile): ProposedMove {
  if (policy.name === "lever_policy") return decideLever(state, policy, buyerProfile);
  const { list_price_cents: list, floor_price_cents: floor, max_rounds } = state.terms;
  // Never charge more than our own list price, even if the buyer offers more.
  const bid = state.buyer_offer_cents === undefined ? undefined : Math.min(state.buyer_offer_cents, list);
  const isFinal = state.round >= max_rounds;

  // ---- static: list price, no haggling
  if (policy.name === "static") {
    if (bid !== undefined && bid >= list) {
      return { action: "accept", price_cents: bid, final: true, reason: "buyer_offer_meets_ask",
        reason_text: `Your offer of ${usd(bid)} meets our price, so we accept.`, conceded_fraction: 0 };
    }
    return { action: "offer", price_cents: list, final: true, reason: "fixed_price",
      reason_text: `Our price is fixed at ${usd(list)}; we don't negotiate on price.`, conceded_fraction: 0 };
  }

  // ---- negotiating / balanced: slow concession curve
  const buffer = policy.soft_floor_buffer ?? DEFAULT_SOFT_FLOOR_BUFFER;
  const { ask, frac } = askPrice(state, TACTICS[policy.name as "negotiating" | "balanced"], buffer);

  if (bid !== undefined && bid >= ask) {
    return { action: "accept", price_cents: bid, final: true, reason: "buyer_offer_meets_ask",
      reason_text: `Your offer of ${usd(bid)} is at or above what we'd ask right now, so we accept.`, conceded_fraction: frac };
  }

  // Last round: a bid between the hard floor and our ask may be accepted (E11 option (b);
  // E1's probe breaker decides whether this buyer is allowed into the zone).
  if (isFinal && policy.final_round_accept_zone && bid !== undefined && bid >= floor) {
    return { action: "accept", price_cents: bid, final: true, reason: "final_round_accept",
      reason_text: `It's the last round and we'd rather close, so we accept ${usd(bid)}.`, conceded_fraction: frac };
  }

  const prev = lastSellerOffer(state);
  const atSoftFloor = ask <= softFloor(list, floor, buffer);

  if (isFinal) {
    return { action: "offer", price_cents: ask, final: true, reason: "final_offer",
      reason_text: `This is the last round of the negotiation, so ${usd(ask)} is our final offer.`, conceded_fraction: frac };
  }
  if (prev === undefined && ask === list) {
    return { action: "offer", price_cents: ask, final: false, reason: "opening_at_list",
      reason_text: `We open at our list price of ${usd(list)}. We move gradually from there over the next rounds.`, conceded_fraction: frac };
  }
  if (atSoftFloor || (prev !== undefined && ask === prev)) {
    return { action: "offer", price_cents: ask, final: false, reason: "already_at_best",
      reason_text: atSoftFloor
        ? `${usd(ask)} is the lowest price we'll offer on this item.`
        : `We're holding at ${usd(ask)} this round.`,
      conceded_fraction: frac };
  }
  return { action: "offer", price_cents: ask, final: false, reason: "pacing",
    reason_text: prev !== undefined
      ? `We can come down from ${usd(prev)} to ${usd(ask)} this round. We concede gradually as the negotiation goes on.`
      : `We can offer ${usd(ask)}. We concede gradually as the negotiation goes on.`,
    conceded_fraction: frac };
}
