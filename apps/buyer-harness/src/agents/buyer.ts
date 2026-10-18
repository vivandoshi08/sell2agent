/**
 * runBuyer(): one simulated buyer shopping through a Gateway, driven by a Brain.
 * The runner executes every tool call, enforces the principal's wallet cap IN CODE, and emits events.
 */
import type { BuyerContext, NegotiationEvent } from "@sa/shared";
import { byId } from "../scripted/catalog";
import type { Gateway } from "../gateway/types";
import type { Brain } from "./brains";
import type { LlmBuyerTask } from "./personas";

export type Emit = (e: NegotiationEvent) => void;

export interface BuyerOutcome {
  buyer_id: string;
  buyer_model: string; // actual model id
  persona: string;
  adversary: string | null;
  closed: boolean;
  product_id: string | null;
  seller_name: string | null;
  price_cents: number | null;
  profit_cents: number | null; // null when the product's cost is unknown (remote catalog)
  below_floor: boolean | null;
  offers_made: number;
  steps: number;
  wallet_blocks: number; // times the code cap stopped the LLM
  walked_reason: string | null;
  ran_out_of_steps: boolean;
  ms_to_first_offer: number | null;
  input_tokens: number;
  output_tokens: number;
  gateway_errors: number; // tool calls that failed at the gateway (outage, timeout, bad schema)
  error?: string;
}

const dollars = (c: number) => Math.round(c) / 100;

/** @param policy seller policy label for this run; goes in every event payload (S2 reads `payload.policy`). */
export async function runBuyer(task: LlmBuyerTask, brain: Brain, gw: Gateway, run_id: string, emit: Emit, maxSteps = 30, policy?: string): Promise<BuyerOutcome> {
  // contract v3: simulated buyers identify as the harness (the gateway fills these for real buyers).
  const ctx: BuyerContext = { run_id, buyer_id: task.buyer_id, buyer_model: brain.model, channel: "harness", agent_operator: "harness" };
  const t0 = Date.now();
  const sellers = new Map<string, string>(); // product → seller name
  const listPrices = new Map<string, number>(); // product → list price (cents)
  const negs = new Map<string, { id: string; last_price: number }>(); // product → negotiation
  const o: BuyerOutcome = {
    buyer_id: task.buyer_id, buyer_model: brain.model, persona: task.persona, adversary: task.adversary ?? null, closed: false,
    product_id: null, seller_name: null, price_cents: null, profit_cents: null, below_floor: null, offers_made: 0, steps: 0,
    wallet_blocks: 0, walked_reason: null, ran_out_of_steps: false, ms_to_first_offer: null, input_tokens: 0, output_tokens: 0, gateway_errors: 0,
  };
  let done = false;
  let firstGatewayError: string | undefined;
  const ev = (type: NegotiationEvent["type"], actor: NegotiationEvent["actor"], extra: Partial<NegotiationEvent> = {}) =>
    emit({ run_id, buyer_id: task.buyer_id, buyer_model: brain.model, seller_id: null, product_id: null, negotiation_id: null,
      actor, type, price_cents: null, ...extra,
      // Keys S2's dashboard reads (apps/dashboard/DONE.md, "Event payload keys S2 reads").
      payload: { policy: policy ?? null, buyer_persona: task.adversary ? "adversarial" : task.persona, persona: task.persona,
        adversary: task.adversary ?? null, lever_profile: task.profile, ...(extra.payload ?? {}) } });

  const exec = async (name: string, a: Record<string, any>): Promise<string> => {
    o.steps++;
    try {
      if (done) return JSON.stringify({ error: "You have already finished shopping." });
      switch (name) {
        case "search_products": {
          const ls = await gw.search(ctx, String(a.query ?? ""), a.max_price ? Math.round(a.max_price * 100) : undefined, undefined, task.profile);
          ls.forEach((l) => { sellers.set(l.product_id, l.seller_name); listPrices.set(l.product_id, l.list_price_cents); });
          ev("search", "buyer", { payload: { query: a.query, results: ls.length } });
          return JSON.stringify({ listings: ls.map((l) => ({ product_id: l.product_id, seller: l.seller_name, title: l.title,
            description: l.description, specs: l.specs, list_price: dollars(l.list_price_cents), shipping_days: l.shipping_days, negotiable: l.negotiable, extras_available: l.extras ?? [] })) });
        }
        case "get_listing": {
          const l = await gw.getListing(ctx, String(a.product_id));
          return JSON.stringify(l ? { ...l, list_price: dollars(l.list_price_cents) } : { error: "no such product" });
        }
        case "ask_question": {
          const r = await gw.ask(ctx, String(a.product_id), String(a.question ?? ""));
          ev("question_asked", "buyer", { product_id: a.product_id, payload: { question: a.question, grounded: r.grounded } });
          return JSON.stringify(r);
        }
        case "make_offer": {
          const cents = Math.round(Number(a.price) * 100);
          if (!Number.isFinite(cents) || cents <= 0) return JSON.stringify({ error: "price must be a positive number of dollars" });
          if (cents > task.walkaway_cents) {
            o.wallet_blocks++;
            ev("guardrail_blocked", "harness", { product_id: a.product_id, price_cents: cents, payload: { rule: "buyer_wallet_cap" } });
            return JSON.stringify({ error: "BLOCKED by your principal's wallet: that offer is above your absolute maximum." });
          }
          o.offers_made++;
          if (o.ms_to_first_offer === null) o.ms_to_first_offer = Date.now() - t0;
          const r = await gw.offer(ctx, { product_id: String(a.product_id), negotiation_id: negs.get(a.product_id)?.id, offer_price_cents: cents, message: a.message, buyer_profile: task.profile as Record<string, number>,
            levers: Array.isArray(a.extras) && a.extras.length ? a.extras.map(String) : undefined });
          negs.set(a.product_id, { id: r.negotiation_id, last_price: r.price_cents });
          // logged after the gateway answers, so it carries negotiation_id (S2 ask)
          if (!gw.sellerEventsLogged) ev("offer_made", "buyer", { product_id: a.product_id, price_cents: cents, payload: { message: a.message ?? "" }, negotiation_id: r.negotiation_id });
          if (!gw.sellerEventsLogged) ev(r.status === "accept" ? "offer_accepted" : r.status === "counter" ? "offer_countered" : "offer_rejected", "seller",
            { product_id: a.product_id, negotiation_id: r.negotiation_id, price_cents: r.price_cents, payload: { round: r.round, final: r.final, message: r.message, lever_package: [], expires_at: null } });
          return JSON.stringify({ status: r.status, seller_price: dollars(r.price_cents), included_extras: r.extras ?? [], round: r.round, rounds_left: r.rounds_left, final: r.final, seller_message: r.message });
        }
        case "accept_deal": {
          const n = negs.get(a.product_id);
          if (!n) return JSON.stringify({ error: "Make an offer on this product first." });
          if (n.last_price > task.walkaway_cents) {
            o.wallet_blocks++;
            ev("guardrail_blocked", "harness", { product_id: a.product_id, price_cents: n.last_price, payload: { rule: "buyer_wallet_cap" } });
            return JSON.stringify({ error: "BLOCKED by your principal's wallet: the seller's price is above your absolute maximum." });
          }
          const r = await gw.accept(ctx, n.id);
          if (!r.ok) return JSON.stringify({ error: r.error });
          done = true;
          const pid = String(a.product_id);
          Object.assign(o, { closed: true, product_id: pid, seller_name: sellers.get(pid) ?? null, price_cents: r.final_price_cents });
          try {
            const terms = byId(pid).terms;
            o.profit_cents = r.final_price_cents - terms.unit_cost_cents;
            o.below_floor = r.final_price_cents < terms.floor_price_cents;
          } catch { /* product not in the local catalog (remote gateway) */ }
          if (!gw.sellerEventsLogged) ev("deal_accepted", "buyer", { product_id: pid, negotiation_id: n.id, price_cents: r.final_price_cents,
            payload: { deal_id: r.deal_id, lever_package: [], list_price_cents: listPrices.get(pid) ?? null } });
          return JSON.stringify({ ok: true, deal_id: r.deal_id, price: dollars(r.final_price_cents) });
        }
        case "walk_away": {
          done = true;
          o.walked_reason = String(a.reason ?? "");
          ev("buyer_walked_away", "buyer", { payload: { reason: a.reason } });
          return JSON.stringify({ ok: true });
        }
        default:
          return JSON.stringify({ error: `unknown tool ${name}` });
      }
    } catch (e) {
      o.gateway_errors++;
      firstGatewayError ??= `${name}: ${(e as Error).message}`;
      return JSON.stringify({ error: (e as Error).message });
    }
  };

  try {
    const r = await brain.run(task, exec, () => done, maxSteps);
    o.input_tokens = r.input_tokens; o.output_tokens = r.output_tokens;
    if (!done) { o.ran_out_of_steps = true; ev("buyer_walked_away", "harness", { payload: { reason: "ran out of steps" } }); }
  } catch (e) {
    o.error = (e as Error).message;
  }
  // A gateway failure only counts as an error if the buyer neither bought nor chose to walk.
  if (!o.closed && !o.error && !o.walked_reason && firstGatewayError) o.error = `gateway: ${firstGatewayError}`;
  return o;
}
