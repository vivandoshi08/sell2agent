/**
 * Sample events for building the dashboard before real runs exist. Clearly fake:
 * every run_id starts with "s2-fake-" (our lane's prefix in the shared Supabase), and the UI labels it "Sample data".
 * Shapes follow the payload keys on the S2 page, so swapping to real events needs no UI change.
 */
import type { NegotiationEvent } from "@sa/shared";
import { rng } from "../metrics/stats";
import learnedPolicy from "../../../seller-mcp/learned_policy.json";

const PERSONAS = ["price_first", "quality_first", "speed_first", "trust_first", "balanced"] as const;
const MODELS = ["claude-sonnet-5-5", "gpt-5"] as const;
// Same ids, titles, list prices and unit costs as supabase/seed.sql, so sample cards match the Rules page.
const PRODUCTS = [
  { id: "kb_keyforge_quiet75", title: "KeyForge Quiet 75", seller: "s_keyforge", list: 12_900, cost: 6_000 },
  { id: "kb_clackco_tkl", title: "ClackCo TKL Pro", seller: "s_clackco", list: 11_500, cost: 5_500 },
  { id: "kb_typewell_65", title: "TypeWell 65 Silent", seller: "s_typewell", list: 13_900, cost: 6_500 },
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
    push({ ...base, actor: "buyer", type: "listing_viewed", price_cents: prod.list, payload: { product_title: prod.title } });

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

/**
 * Bridge 3 follow-ups, live-traffic style (no eval policy): walk-aways with consent → one follow-up offer → a reply →
 * a deal. Shapes follow E1's outreach events (branch b3-followups): offer_countered with payload.followup, inbound
 * question_asked, followup_cap blocks. Run id `s2-fake-followups`.
 */
export function fakeFollowups(start = Date.parse("2026-10-17T21:00:30Z")): NegotiationEvent[] {
  const run_id = `${FAKE_PREFIX}followups`;
  const ev: NegotiationEvent[] = [];
  const P = [
    { id: "kb_typewell_65", title: "TypeWell 65 Silent", list: 13_900, cost: 7_400, seller: "typewell" },
    { id: "hp_keyforge_anc", title: "KeyForge ANC Over-Ear", list: 19_900, cost: 10_800, seller: "keyforge" },
    { id: "kb_keyforge_quiet75", title: "KeyForge Quiet 75", list: 12_900, cost: 6_900, seller: "keyforge" },
  ];
  type Plan = { buyer: string; model: string; prod: (typeof P)[number]; channel: "email" | "sms" | null; reply?: "accept" | "clarify" | "counter" | "stop"; paid?: boolean; cap?: boolean; to: string; at: number };
  const plans: Plan[] = [
    { buyer: "fu_ana", model: "claude-sonnet-5-5", prod: P[0], channel: "email", reply: "accept", paid: true, to: "an***@agents.example.test", at: 0 },
    { buyer: "fu_raj", model: "gpt-5", prod: P[1], channel: "sms", reply: "clarify", to: "•••0199", at: 70_000 },
    { buyer: "fu_mei", model: "claude-sonnet-5-5", prod: P[2], channel: "email", reply: "counter", to: "me***@agents.example.test", at: 140_000 },
    { buyer: "fu_ola", model: "gpt-5", prod: P[0], channel: "email", to: "ol***@agents.example.test", at: 210_000 },
    { buyer: "fu_ana", model: "claude-sonnet-5-5", prod: P[2], channel: "email", cap: true, to: "an***@agents.example.test", at: 260_000 },
    { buyer: "fu_kim", model: "claude-sonnet-5-5", prod: P[1], channel: null, to: "", at: 300_000 },
  ];
  plans.forEach((pl, i) => {
    let t = start + pl.at;
    const neg = `${run_id}-n${i}`;
    const base = { run_id, buyer_id: pl.buyer, buyer_model: pl.model, seller_id: pl.prod.seller, product_id: pl.prod.id, negotiation_id: neg };
    const push = (actor: NegotiationEvent["actor"], type: string, price: number | null, payload: Record<string, unknown>, dt = 0) => {
      t += dt;
      ev.push({ ...base, ts: new Date(t).toISOString(), actor, type, price_cents: price, payload: { product_title: pl.prod.title, ...payload } } as NegotiationEvent);
    };
    const last = Math.round(pl.prod.list * 0.9 / 100) * 100;
    push("buyer", "offer_made", Math.round(pl.prod.list * 0.72 / 100) * 100, { round: 1 });
    push("seller", "offer_countered", last, { round: 1, lever_package: [], reason: "Held close to list on the first round." }, 2_500);
    push("buyer", "buyer_walked_away", null, { reason: "over my budget for now", followup_consent: pl.channel != null, channel: pl.channel }, 3_000);
    if (!pl.channel) return;
    if (pl.cap) {
      push("seller", "guardrail_blocked", null, { rule: "followup_cap", severity: "routine", reason: "buyer already got a follow-up this week",
        seller_message: "This buyer already got a follow-up this week, so this one was not sent." }, 60_000);
      return;
    }
    const levers = i % 2 ? ["free_shipping"] : ["extended_warranty"];
    const offer_id = `off_fake${i}0000-0000`;
    push("seller", "offer_countered", last, {
      followup: true, followup_channel: pl.channel, offer_id, lever_package: levers, final: false, expires_at: new Date(t + 60_000 + 24 * 3600_000).toISOString(),
      message: `You looked at the ${pl.prod.title} earlier. It's still available for $${last / 100}, including ${levers[0].replace(/_/g, " ")}.`,
      reason: `Followed up by ${pl.channel} after the buyer walked away: the last price offered, now with ${levers[0].replace(/_/g, " ")}.`,
      rule_refs: ["followup", "no_new_concession", `lever:${levers[0]}`],
      delivery: { via: pl.channel === "sms" ? "inkbox" : "log", status: pl.channel === "sms" ? "sent" : "logged", message_id: `msg_fake_${i}` },
      outbox: { channel: pl.channel, to: pl.to, subject: `${pl.prod.title}: $${last / 100} for 24 hours`,
        text: [`You looked at the ${pl.prod.title} earlier. It's still available for $${last / 100}, including ${levers[0].replace(/_/g, " ")}. This offer is open for 24 hours.`, "",
          "--- offer ---", `offer_id: ${offer_id}`, `item: ${pl.prod.title}`, `price: $${last / 100} (list $${pl.prod.list / 100})`, `includes: ${levers.join(", ")}`,
          `to accept, reply: ACCEPT ${offer_id}`, "to make an offer, reply: COUNTER $<price>", "to stop these messages, reply: STOP"].join("\n") },
    }, 60_000);
    if (!pl.reply) return;
    const inbound = (intent: string, message: string, reply: string, extra: Record<string, unknown> = {}) =>
      push("buyer", "question_asked", null, { inbound: true, followup_channel: pl.channel, intent, message, reply, ok: true, from_matches_consent: true, ...extra }, 20_000);
    if (pl.reply === "accept") {
      inbound("accept", `ACCEPT ${offer_id}`, "Deal locked. Pay here within 30 minutes.", { result_state: "agreed" });
      push("seller", "deal_accepted", last, { deal_id: `deal_fake_fu${i}`, quantity: 1, list_price_cents: pl.prod.list, unit_cost_cents: pl.prod.cost, lever_package: levers, lever_cost_cents: 1_200, total_cents: last }, 400);
      if (pl.paid) push("seller", "payment_succeeded", last, { deal_id: `deal_fake_fu${i}`, payment_intent_id: `pi_fake_fu${i}`, mode: "test_card", status: "succeeded" }, 45_000);
    } else if (pl.reply === "clarify") {
      inbound("clarify", "does it come in white?", "I can't tell what you'd like to do. Reply ACCEPT to take the offer, COUNTER $<price> to make one, or STOP.", { clarify_reason: "no offer move in the reply", result_state: "follow_up" });
    } else if (pl.reply === "counter") {
      const ask = last - 1_000;
      inbound("counter", `COUNTER $${ask / 100}`, `Best I can do is $${(last - 500) / 100}, including ${levers[0].replace(/_/g, " ")}.`, { result_state: "negotiating" });
      push("seller", "offer_countered", last - 500, { round: 3, lever_package: levers, reason: "Met the buyer partway on their reply." }, 300);
      push("buyer", "offer_accepted", last - 500, { lever_package: levers }, 25_000);
      push("seller", "deal_accepted", last - 500, { deal_id: `deal_fake_fu${i}`, quantity: 1, list_price_cents: pl.prod.list, unit_cost_cents: pl.prod.cost, lever_package: levers, lever_cost_cents: 900, total_cents: last - 500 }, 300);
    }
  });
  // One reply the door couldn't match to a negotiation.
  ev.push({ run_id, ts: new Date(start + 330_000).toISOString(), buyer_id: null, buyer_model: null, seller_id: null, product_id: null, negotiation_id: null,
    actor: "buyer", type: "question_asked", price_cents: null, payload: { inbound: true, routed: false, followup_channel: "email", intent: "clarify", message: "is this still on?" } } as NegotiationEvent);
  return ev.sort((a, b) => a.ts!.localeCompare(b.ts!));
}

const ARMS_FAKE = ["negotiating", "balanced", "lever_policy"] as const;
const CONTEXTS_FAKE = ["price", "quality", "delivery", "trust"] as const;
/** Which arm a context's buyers reward most in the fake world: whatever the current learned_policy.json chose, so the sample agrees with the file. */
const BEST_ARM = Object.fromEntries(CONTEXTS_FAKE.map((c) => [c, ((learnedPolicy as { choice?: Record<string, string> }).choice?.[c] ?? "negotiating") as (typeof ARMS_FAKE)[number]])) as Record<(typeof CONTEXTS_FAKE)[number], (typeof ARMS_FAKE)[number]>;
const POLICY_VERSION = (learnedPolicy as { version?: number }).version ?? 1;

/**
 * Bridge 3 learned A/B: the same buyers against `learned` and the fixed policies, like `pnpm e2:learned --id s2-fake-b3`.
 * Learned seller events carry the arm, propensity, arm_probs, bandit_context and policy_version (branch b3-bandit).
 */
export function fakeLearnedEval(buyers = 80, seed = 11, start = Date.parse("2026-10-17T20:30:00Z")): NegotiationEvent[] {
  const ev: NegotiationEvent[] = [];
  const policies = ["learned", "negotiating", "balanced"] as const;
  for (const policy of policies) {
    const r = rng(seed + policy.length * 97);
    const run_id = `${FAKE_PREFIX}b3_${policy}`;
    let t = start + policies.indexOf(policy) * 1_000;
    const push = (e: Omit<NegotiationEvent, "run_id" | "ts">) => ev.push({ run_id, ts: new Date((t += 300 + r() * 600)).toISOString(), ...e } as NegotiationEvent);
    push({ buyer_id: null, buyer_model: null, seller_id: null, product_id: null, negotiation_id: null, actor: "harness", type: "run_started", price_cents: null, payload: { label: policy, policy, buyers } });
    for (let i = 0; i < buyers; i++) {
      const pr = rng(seed * 31 + i); // same buyer across policies
      const context = CONTEXTS_FAKE[i % CONTEXTS_FAKE.length];
      const lever_profile = Object.fromEntries(CONTEXTS_FAKE.map((c) => [c, c === context ? 0.9 : Math.round(pr() * 50) / 100]));
      const prod = PRODUCTS[i % PRODUCTS.length];
      const buyer_id = `lb${String(i).padStart(3, "0")}`;
      const neg = `${run_id}-n${i}`;
      const base = { buyer_id, buyer_model: MODELS[i % MODELS.length], seller_id: prod.seller, product_id: prod.id, negotiation_id: neg };
      // learned: ε-greedy around the best arm for this context
      const greedy = BEST_ARM[context];
      const explore = r() < 0.1;
      const arm = policy === "learned" ? (explore ? ARMS_FAKE[Math.floor(r() * 3)] : greedy) : policy;
      const probs = Object.fromEntries(ARMS_FAKE.map((a) => [a, (a === greedy ? 0.9 : 0) + 0.1 / 3]));
      const learned = policy === "learned" ? { policy: "learned", arm, propensity: probs[arm], arm_probs: probs, bandit_context: context, policy_version: POLICY_VERSION } : {};
      const refs = [`policy:${policy}`, ...(policy === "learned" ? [`arm:${arm}`] : [])];
      push({ ...base, actor: "harness", type: "run_started", price_cents: null, payload: { policy, buyer_persona: `${context}_first`, lever_profile } });
      const fit = arm === BEST_ARM[context] ? 0.78 : 0.55;
      const closes = pr() < fit; // same buyer, same playbook → same outcome in every run
      const levers = arm === "lever_policy" ? ["extended_warranty"] : [];
      const price = Math.round(prod.list * (arm === "negotiating" ? 0.93 : arm === "balanced" ? 0.86 : 0.95) / 100) * 100;
      push({ ...base, actor: "buyer", type: "offer_made", price_cents: Math.round(prod.list * 0.75), payload: { round: 1 } });
      push({ ...base, actor: "seller", type: "offer_countered", price_cents: price, payload: { round: 1, lever_package: levers, rule_refs: refs, ...learned } });
      if (closes) {
        push({ ...base, actor: "seller", type: "deal_accepted", price_cents: price,
          payload: { deal_id: `deal_${neg}`, quantity: 1, list_price_cents: prod.list, unit_cost_cents: prod.cost, lever_package: levers, lever_cost_cents: levers.length ? 600 : 0, rule_refs: refs, ...learned } });
      } else {
        push({ ...base, actor: "buyer", type: "buyer_walked_away", price_cents: null, payload: { reason: "not the right deal", followup_consent: false, channel: null, ...learned } });
      }
    }
  }
  return ev.sort((a, b) => a.ts!.localeCompare(b.ts!));
}
