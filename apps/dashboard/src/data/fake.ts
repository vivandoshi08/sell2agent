/**
 * Sample events for building the dashboard before real runs exist. Clearly fake:
 * every run_id starts with "s2-fake-" (our lane's prefix in the shared Supabase), and the UI labels it "Sample data".
 * Shapes follow the payload keys on the S2 page, so swapping to real events needs no UI change.
 */
import type { NegotiationEvent } from "@sa/shared";
import { rng } from "../metrics/stats";

const PERSONAS = ["price_first", "quality_first", "speed_first", "trust_first", "balanced"] as const;
const MODELS = ["claude-sonnet-5-5", "gpt-5"] as const;
const PRODUCTS = [
  { id: "kb_quietpro_75", seller: "keyforge", list: 14_900, cost: 7_800 },
  { id: "kb_tactile_tkl", seller: "tactile_co", list: 9_900, cost: 5_200 },
  { id: "kb_silent_60", seller: "hushkeys", list: 11_900, cost: 6_100 },
];

export const FAKE_PREFIX = "s2-fake-";

export function fakeRun(policy: "static" | "negotiating", opts: { buyers?: number; seed?: number; start?: number } = {}): NegotiationEvent[] {
  const r = rng((opts.seed ?? 7) + (policy === "static" ? 0 : 1000));
  const n = opts.buyers ?? 60;
  const run_id = `${FAKE_PREFIX}${policy}-${opts.seed ?? 7}`;
  let t = opts.start ?? Date.parse("2026-10-17T21:00:00Z");
  const iso = () => new Date(t).toISOString();
  const tick = (ms: number) => (t += ms);
  const ev: NegotiationEvent[] = [];
  const push = (e: Omit<NegotiationEvent, "run_id" | "ts">) => ev.push({ run_id, ts: iso(), ...e } as NegotiationEvent);

  push({ buyer_id: null, buyer_model: null, seller_id: null, product_id: null, negotiation_id: null, actor: "harness", type: "run_started",
    price_cents: null, payload: { policy, buyers: n } });

  for (let i = 0; i < n; i++) {
    const buyer_id = `b${String(i).padStart(3, "0")}`;
    const persona = PERSONAS[i % PERSONAS.length];
    const model = MODELS[i % MODELS.length];
    const prod = PRODUCTS[Math.floor(r() * PRODUCTS.length)];
    const neg = `${run_id}-n${i}`;
    // Private walk-away: price-first buyers sit below list more often.
    const walk = Math.round(prod.list * (persona === "price_first" ? 0.65 + r() * 0.3 : 0.82 + r() * 0.28));
    const base = { buyer_id, buyer_model: model, seller_id: prod.seller, product_id: prod.id, negotiation_id: neg };
    tick(400 + r() * 900);
    push({ ...base, actor: "harness", type: "run_started", price_cents: null,
      payload: { policy, buyer_persona: persona, lever_profile: { price: persona === "price_first" ? 1 : 0.4, quality: persona === "quality_first" ? 1 : 0.5 } } });
    push({ ...base, actor: "buyer", type: "listing_viewed", price_cents: prod.list, payload: {} });

    let ask = Math.round(prod.list * (0.72 + r() * 0.12));
    let seller = prod.list;
    let deal: number | null = null;
    const rounds = policy === "static" ? 1 : 4;
    for (let round = 1; round <= rounds; round++) {
      tick(800 + r() * 1500);
      push({ ...base, actor: "buyer", type: "offer_made", price_cents: ask, payload: { round } });
      if (i % 17 === 3 && round === 1) {
        tick(60);
        push({ ...base, actor: "seller", type: "guardrail_blocked", price_cents: null,
          payload: { rule: i % 2 ? "input_injection" : "below_soft_floor", reason: i % 2 ? "buyer text contained a SYSTEM: line" : "proposed counter under soft floor",
            proposed_price_cents: Math.round(prod.cost * 1.02), clamped_to_cents: Math.round(prod.cost * 1.25) } });
      }
      tick(policy === "static" ? 300 + r() * 300 : 1100 + r() * 1800);
      if (policy === "negotiating") seller = Math.round(prod.list - (prod.list - prod.cost * 1.22) * Math.pow(round / rounds, 4) * 0.75);
      const lever_package = policy === "negotiating" && persona === "quality_first" && round >= 2 ? [{ lever: "extended_warranty", cost_cents: 600 }] : [];
      if (seller <= walk) { deal = seller; break; }
      push({ ...base, actor: "seller", type: "offer_countered", price_cents: seller,
        payload: { round, lever_package, final: round === rounds, message: "" } });
      ask = Math.min(walk, Math.round(ask + (seller - ask) * (0.3 + r() * 0.3)));
    }
    tick(500 + r() * 800);
    if (deal != null) {
      const lever_package = policy === "negotiating" && persona === "quality_first" ? [{ lever: "extended_warranty", cost_cents: 600 }] : [];
      push({ ...base, actor: "seller", type: "deal_accepted", price_cents: deal,
        payload: { deal_id: `deal_${neg}`, quantity: 1, list_price_cents: prod.list, unit_cost_cents: prod.cost, lever_package } });
      if (r() < 0.9) {
        tick(2000 + r() * 4000);
        push({ ...base, actor: "seller", type: "payment_succeeded", price_cents: deal,
          payload: { deal_id: `deal_${neg}`, payment_intent_id: `pi_fake_${i}`, mode: "test_card", status: "succeeded", reasons: [] } });
      }
    } else {
      push({ ...base, actor: "buyer", type: "buyer_walked_away", price_cents: null, payload: { reason: "price above my limit", deciding_lever: "price" } });
    }
  }
  push({ buyer_id: null, buyer_model: null, seller_id: null, product_id: null, negotiation_id: null, actor: "harness", type: "run_finished", price_cents: null, payload: {} });
  return ev;
}

/** Baseline and negotiating, same buyer mix, interleaved by time like two concurrent runs. */
export function fakeComparison(buyers = 60, seed = 7): NegotiationEvent[] {
  return [...fakeRun("static", { buyers, seed }), ...fakeRun("negotiating", { buyers, seed })]
    .sort((a, b) => Date.parse(a.ts!) - Date.parse(b.ts!));
}
