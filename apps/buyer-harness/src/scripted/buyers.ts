/**
 * E2 · 10 scripted buyers (deterministic, no LLM). The mock E2 builds against until real
 * LLM buyers exist (BUILD_PLAN: "E2 scripted buyers").
 *
 * Behavior (experiments/e11_nash_ideas README, "Scripted buyers"):
 *   - open at 78–88% of their private walk-away
 *   - each round, close 25–50% of the remaining gap to their walk-away
 *   - accept the seller's ask if it's at or below the bid they'd make next
 *   - bid their walk-away in the last round, then get one final turn to accept
 *   - walk if the final ask is still above their walk-away
 *
 * Walk-aways are spread on purpose (position w in the seller's list–floor gap: 0 = floor, 1 = list),
 * NOT tuned to make our seller win: one can't afford the floor, two would pay full list.
 */
import { byId, CATALOG } from "./catalog";
import type { BuyerLeverProfile } from "@sa/seller-mcp/sellers";

export interface ScriptedBuyer {
  buyer_id: string;
  persona: "price_first" | "quality_first" | "speed_first" | "trust_first" | "balanced";
  profile: BuyerLeverProfile;
  product_id: string;
  walkaway_cents: number; // PRIVATE max price
  open_frac: number; // first bid = open_frac · walk-away
  concede: number; // fraction of the remaining gap closed per round
  questions: string[]; // asked before haggling
}

const PERSONA_PROFILE: Record<ScriptedBuyer["persona"], BuyerLeverProfile> = {
  price_first: { price: 1, quality: 0.3 },
  quality_first: { quality: 1, warranty: 0.8, price: 0.3 },
  speed_first: { delivery: 1, price: 0.5 },
  trust_first: { trust: 1, warranty: 0.6, price: 0.5 },
  balanced: { price: 0.6, quality: 0.6, delivery: 0.5 },
};

//              w      persona          open   concede  questions
const SPEC: [number, ScriptedBuyer["persona"], number, number, string[]][] = [
  [-0.2, "price_first", 0.78, 0.25, ["How much is it?"]],
  [0.05, "price_first", 0.80, 0.30, ["Is it wireless?"]],
  [0.2, "balanced", 0.82, 0.35, ["What layout is it?", "Does it come with a carrying case?"]],
  [0.35, "speed_first", 0.84, 0.40, ["How fast does it ship?"]],
  [0.5, "trust_first", 0.86, 0.45, ["What warranty does it come with?"]],
  [0.65, "quality_first", 0.88, 0.50, ["Are the switches hot-swappable?", "Is it quiet?"]],
  [0.8, "balanced", 0.80, 0.30, ["What's the battery life?"]],
  [0.95, "quality_first", 0.84, 0.40, ["Does it work with a Mac?"]],
  [1.1, "trust_first", 0.86, 0.25, ["Is it wired or wireless?"]],
  [1.3, "quality_first", 0.88, 0.50, ["What switches does it use?"]],
];

export const SCRIPTED_BUYERS: ScriptedBuyer[] = SPEC.map(([w, persona, open_frac, concede, questions], i) => {
  const product = CATALOG[i % CATALOG.length].terms;
  const gap = product.list_price_cents - product.floor_price_cents;
  return {
    buyer_id: `sb_${String(i + 1).padStart(2, "0")}`,
    persona,
    profile: PERSONA_PROFILE[persona],
    product_id: product.product_id,
    walkaway_cents: Math.round((product.floor_price_cents + w * gap) / 100) * 100,
    open_frac,
    concede,
    questions,
  };
});

/** The bid this buyer makes in a given round (1-based), never above its walk-away. */
export function bidFor(b: ScriptedBuyer, round: number, maxRounds: number): number {
  if (round >= maxRounds) return b.walkaway_cents;
  let bid = b.open_frac * b.walkaway_cents;
  for (let r = 1; r < round; r++) bid += b.concede * (b.walkaway_cents - bid);
  return Math.min(b.walkaway_cents, Math.round(bid / 100) * 100);
}

export { byId };
