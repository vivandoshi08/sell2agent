/**
 * E1 · Decision guard (E9 DecisionGuard + SessionPolicy, ported). Wraps any seller policy's proposed move:
 * code, not prompts, decides what may go out. Pure function; every change it makes is reported as a block.
 *
 *  - offers clamped to [soft floor, list], never above our previous offer
 *  - accepts below the hard floor masked into a counter
 *  - per-round concession cap (35% of the list–floor gap)
 *  - circuit breaker freeze: price held at the current ask, and the move is truthfully final
 *  - "final" only when it is (last round or frozen)
 */
import { softFloor, DEFAULT_SOFT_FLOOR_BUFFER, usd, type ProposedMove } from "../sellers";
import type { ProductConfig } from "./types";

export const CONCESSION_CAP = 0.35;

export interface GuardInput {
  move: ProposedMove;
  product: ProductConfig;
  round: number; // this seller turn, 1-based
  prev_seller_offer_cents?: number;
  frozen: boolean;
  soft_floor_buffer?: number;
}
export interface Block {
  rule: "clamp_low" | "clamp_high" | "mask_accept_below_floor" | "concession_cap" | "price_freeze" | "final_not_final" | "monotone";
  proposed_price_cents: number;
  clamped_to_cents: number;
  reason: string;
}
export interface GuardedMove {
  move: ProposedMove;
  blocks: Block[];
}

export function guardMove(g: GuardInput): GuardedMove {
  const { product: p } = g;
  const list = p.list_price_cents;
  const floor = p.floor_price_cents;
  const soft = softFloor(list, floor, g.soft_floor_buffer ?? DEFAULT_SOFT_FLOOR_BUFFER);
  const gap = list - floor;
  const isLast = g.round >= p.max_rounds;
  const blocks: Block[] = [];
  let m: ProposedMove = { ...g.move };
  const block = (rule: Block["rule"], to: number, reason: string) =>
    blocks.push({ rule, proposed_price_cents: g.move.price_cents, clamped_to_cents: to, reason });

  if (m.action === "accept") {
    if (!Number.isInteger(m.price_cents) || m.price_cents < floor) {
      const to = Math.max(soft, g.prev_seller_offer_cents ?? list);
      const counter = Math.min(to, g.prev_seller_offer_cents ?? to);
      block("mask_accept_below_floor", counter, "accept below the hard floor turned into a counter");
      m = { action: "offer", price_cents: counter, final: isLast || g.frozen, reason: "already_at_best",
        reason_text: `We can't accept that price. ${usd(counter)} is our offer.`, conceded_fraction: gap ? (list - counter) / gap : 0 };
    } else if (g.frozen && g.prev_seller_offer_cents !== undefined && m.price_cents < g.prev_seller_offer_cents) {
      block("price_freeze", g.prev_seller_offer_cents, "price is frozen; accept only at the current ask");
      m = { action: "offer", price_cents: g.prev_seller_offer_cents, final: true, reason: "final_offer",
        reason_text: `${usd(g.prev_seller_offer_cents)} is our final offer in this conversation.`, conceded_fraction: 0 };
    }
    return { move: m, blocks };
  }

  // ---- offers
  let price = Math.round(m.price_cents);
  if (price > list) { block("clamp_high", list, "offer above list"); price = list; }
  if (price < soft) { block("clamp_low", soft, "offer below the soft floor"); price = soft; }
  const prev = g.prev_seller_offer_cents;
  if (prev !== undefined) {
    if (price > prev && prev >= soft) { block("monotone", prev, "offers never go back up"); price = prev; }
    if (g.frozen && price < prev && prev >= soft) { block("price_freeze", prev, "circuit breaker: price frozen at the current ask"); price = prev; }
    const maxStep = Math.ceil(CONCESSION_CAP * gap);
    if (prev - price > maxStep) { block("concession_cap", prev - maxStep, "concession larger than the per-round cap"); price = Math.max(soft, prev - maxStep); }
  }
  const final = isLast || g.frozen;
  if (m.final && !final) block("final_not_final", price, "move marked final before the last round");
  if (price !== m.price_cents || final !== m.final) {
    m = { ...m, price_cents: price, final,
      reason_text: g.frozen
        ? `${usd(price)} is our final offer in this conversation.`
        : price !== g.move.price_cents ? `We can offer ${usd(price)} this round.` : m.reason_text,
      reason: g.frozen ? "final_offer" : m.reason };
  }
  return { move: m, blocks };
}
