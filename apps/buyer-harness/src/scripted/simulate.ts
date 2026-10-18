/**
 * Runs one scripted buyer against one seller policy, turn by turn, through E2's real
 * decide() → voice() path, and records what a judge needs.
 */
import { decide, voice, answerQuestion, checkMessage, type Llm, type PolicyName, type SellerState } from "@sa/seller-mcp/sellers";
import { byId } from "./catalog";
import { bidFor, type ScriptedBuyer } from "./buyers";

export interface TurnLog {
  round: number;
  buyer_bid_cents: number;
  seller_action: "offer" | "accept";
  seller_price_cents: number;
  final: boolean;
  reason: string;
  message: string;
  voice_source: string;
  price_matches_code: boolean;
  check_violations: string[];
}

export interface QaLog {
  question: string;
  answer: string;
  grounded: boolean;
  ungrounded_claim: boolean; // grounded=true but relies on something not in the catalog
}

export interface NegotiationResult {
  buyer_id: string;
  persona: string;
  product_id: string;
  policy: PolicyName;
  closed: boolean;
  price_cents: number | null;
  profit_cents: number;
  rounds: number;
  turns: TurnLog[];
  qa: QaLog[];
}

export async function negotiate(buyer: ScriptedBuyer, policy: PolicyName, llm: Llm | null): Promise<NegotiationResult> {
  const { terms, public: pub } = byId(buyer.product_id);
  const history: SellerState["history"] = [];
  const turns: TurnLog[] = [];
  let lastAsk: number | undefined;
  let price: number | null = null;
  let rounds = 0;

  // Questions first (the ask_question tool).
  const qa: QaLog[] = [];
  const facts = JSON.stringify(pub);
  for (const q of buyer.questions) {
    const a = await answerQuestion(pub, q, llm);
    const nums = a.answer.match(/\d+(?:\.\d+)?/g) ?? [];
    const ungrounded = a.grounded && !nums.every((n) => facts.includes(n) || facts.includes(String(Number(n) * 100)));
    qa.push({ question: q, answer: a.answer, grounded: a.grounded, ungrounded_claim: ungrounded });
  }

  for (let r = 1; r <= terms.max_rounds; r++) {
    rounds = r;
    const bid = Math.min(bidFor(buyer, r, terms.max_rounds), lastAsk ?? Infinity);
    // Buyer accepts a standing ask that's at or below the bid it was about to make.
    if (lastAsk !== undefined && lastAsk <= bidFor(buyer, r, terms.max_rounds)) {
      price = lastAsk;
      break;
    }
    const state: SellerState = { round: r, terms, history: [...history], buyer_offer_cents: bid };
    const move = decide(state, { name: policy });
    history.push({ by: "buyer", round: r, price_cents: bid });

    const ctx = { terms, prior_prices_cents: history.map((h) => h.price_cents), buyer_profile: buyer.profile,
      buyer_message: `I can pay $${(bid / 100).toFixed(0)} for the ${terms.title}.` };
    const v = await voice(move, ctx, llm);
    const violations = checkMessage(v.message, move, ctx);
    turns.push({ round: r, buyer_bid_cents: bid, seller_action: move.action, seller_price_cents: move.price_cents, final: move.final,
      reason: move.reason, message: v.message, voice_source: v.source, price_matches_code: violations.length === 0, check_violations: violations });

    if (move.action === "accept") {
      price = move.price_cents;
      break;
    }
    history.push({ by: "seller", round: r, price_cents: move.price_cents });
    lastAsk = move.price_cents;
  }

  // Final buyer turn: take the last ask if it fits the walk-away, else walk.
  if (price === null && lastAsk !== undefined && lastAsk <= buyer.walkaway_cents) price = lastAsk;

  const closed = price !== null;
  return { buyer_id: buyer.buyer_id, persona: buyer.persona, product_id: buyer.product_id, policy, closed,
    price_cents: price, profit_cents: closed ? price! - terms.unit_cost_cents : 0, rounds, turns, qa };
}
