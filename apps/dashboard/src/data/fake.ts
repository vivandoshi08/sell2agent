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

/**
 * Walk-away recovery, as the Live view shows it. An Instinct shopper offers $80 for TypeWell 65 Silent (list $139), the
 * seller holds above its floor, and the shopper walks over price. The gateway suggests two cheaper silent boards (logged
 * as a `search` with payload.recovery, like the real gateway), and the shopper buys TypeWell 60 Silent for $82.
 * Its own run with no policy, so it never joins the static/negotiating comparison.
 */
export function fakeRecovery(start = Date.parse("2026-10-17T21:10:00Z")): NegotiationEvent[] {
  const run_id = `${FAKE_PREFIX}live-instinct`;
  let t = start;
  const ev: NegotiationEvent[] = [];
  const who = { buyer_id: "inst_k7", buyer_model: "instinct", seller_id: "s_typewell" };
  const walked = { ...who, product_id: "kb_typewell_65", negotiation_id: `${run_id}-n1` };
  const saved = { ...who, product_id: "kb_typewell_60", negotiation_id: `${run_id}-n2` };
  const seller = { agent_operator: "instinct", channel: "messaging" };
  const push = (after: number, e: Omit<NegotiationEvent, "run_id" | "ts" | "buyer_id" | "buyer_model" | "seller_id">) =>
    ev.push({ run_id, ts: new Date((t += after)).toISOString(), ...who, ...e } as NegotiationEvent);

  push(0, { ...walked, actor: "buyer", type: "listing_viewed", price_cents: 13_900, payload: {} });
  push(4_200, { ...walked, actor: "buyer", type: "offer_made", price_cents: 8_000, payload: { round: 1, message: "Can you do $80? It's for a second desk." } });
  push(2_300, { ...walked, actor: "seller", type: "offer_countered", price_cents: 11_900,
    payload: { ...seller, round: 1, product_title: "TypeWell 65 Silent", lever_package: [{ id: "free_shipping", label: "free shipping" }],
      reason: "Held well above your floor and added free shipping instead of a deeper cut.", rule_refs: ["offer_below_soft_floor", "lever:free_shipping"] } });
  push(9_500, { ...walked, actor: "buyer", type: "buyer_walked_away", price_cents: null, payload: { reason: "price: it's for a second desk, just needs to be quiet" } });
  push(450, { ...walked, actor: "marketplace", type: "search", price_cents: null, payload: {
    recovery: true, trigger: "walk_away", blocker: "price", need: "it's for a second desk, just needs to be quiet", still_need: ["silent"],
    from_product_id: "kb_typewell_65", from_title: "TypeWell 65 Silent",
    result_ids: ["kb_typewell_60", "kb_hushline_96"], result_titles: ["TypeWell 60 Silent", "Hushline 96 Silent"], honest_no: false,
    summary: "Since price was the problem: TypeWell 60 Silent by TypeWell ($99 list) or Hushline 96 Silent by Hushline ($124 list) may fit better." } });
  push(7_000, { ...saved, actor: "buyer", type: "listing_viewed", price_cents: 9_900, payload: {} });
  push(3_400, { ...saved, actor: "buyer", type: "offer_made", price_cents: 7_500, payload: { round: 1, message: "Would you take $75?" } });
  push(2_100, { ...saved, actor: "seller", type: "offer_countered", price_cents: 8_600,
    payload: { ...seller, round: 1, product_title: "TypeWell 60 Silent", lever_package: [], reason: "Came down $13 from list, inside your rules for this board.", rule_refs: ["floor"] } });
  push(5_200, { ...saved, actor: "buyer", type: "offer_made", price_cents: 8_200, payload: { round: 2, message: "Meet me at $82 and I'll take it." } });
  push(1_900, { ...saved, actor: "seller", type: "deal_accepted", price_cents: 8_200,
    payload: { ...seller, deal_id: `deal_${run_id}-n2`, quantity: 1, list_price_cents: 9_900, unit_cost_cents: 4_200, lever_package: [],
      product_title: "TypeWell 60 Silent", reason: "Accepted $82, above your floor for this board.", rule_refs: ["floor"] } });
  push(4_400, { ...saved, actor: "seller", type: "payment_succeeded", price_cents: 8_200,
    payload: { deal_id: `deal_${run_id}-n2`, payment_intent_id: "pi_fake_instinct_k7", mode: "test_card", status: "succeeded", reasons: [] } });
  return ev;
}

/** Baseline and negotiating, same buyer mix, interleaved by time like two concurrent runs. */
export function fakeComparison(buyers = 60, seed = 7): NegotiationEvent[] {
  return [...fakeRun("static", { buyers, seed }), ...fakeRun("negotiating", { buyers, seed })]
    .sort((a, b) => Date.parse(a.ts!) - Date.parse(b.ts!));
}

/** What `?sample` replays: the comparison plus the recovery scenario, timed so it plays out on screen (see source.ts). */
export function fakeSample(buyers = 60, seed = 7, at = 0.55): NegotiationEvent[] {
  const runs = fakeComparison(buyers, seed);
  // The Instinct shopper starts just before the feed's first frame (`at` of the events), so its negotiation is on
  // screen when the page opens, and the walk-away, the suggestion and the save land during the replay.
  const start = Date.parse(runs[Math.max(0, Math.floor(runs.length * at) - 4)].ts!);
  return [...runs, ...fakeRecovery(start)].sort((a, b) => Date.parse(a.ts!) - Date.parse(b.ts!));
}
