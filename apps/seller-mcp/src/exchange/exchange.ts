/**
 * E1 · The exchange: `handle(move) → response`. One entry point for every buyer move.
 *
 * Per seller turn:  input guard → E2 decide() → decision guard → E2 voice() → output guard → offer/deal → events
 * Protocol: round cap with a final buyer turn (accept or walk only), offers expire, accept only by the live
 * offer_id bound to this buyer, accept is idempotent, illegal state transitions throw.
 */
import { randomUUID } from "node:crypto";
import { BuyerContext, type NegotiationEvent } from "@sa/shared";
import { decide as e2decide, voice as e2voice, type Llm, type ProposedMove, type SellerPolicy, type SellerState,
  type BuyerLeverProfile, type VoiceContext, type VoiceResult, DEFAULT_SOFT_FLOOR_BUFFER, softFloor } from "../sellers";
import { StaticCatalog } from "./catalog";
import { guardMove } from "./decision-guard";
import { Deals, lockDeal } from "./deals";
import { defaultSink, type EventSink } from "./events";
import { inspectInput } from "./input-guard";
import { checkOutput, fallbackMessage, type OutputContext } from "./output-guard";
import { allowedActions, assertTransition } from "./state";
import { MemoryStore, memoryKey, type ExchangeStore } from "./store";
import { ProbeBreaker, StartLimiter, buyerEndpoint, jitterStep, leverCost, NEAR_MISS_BAND } from "./probing";
import { CONCESSION_CAP } from "./decision-guard";
import type { AcceptMove, Catalog, ExchangeError, ExchangeResponse, Move, Negotiation, NegotiationState, OfferMove,
  ProductConfig, StandingOffer, StatusMove, WalkMove, LockedDeal } from "./types";

export const OFFER_TTL_MS = 15 * 60_000;
export const BREAKER_THRESHOLD = 2; // E9: 2 flagged buyer messages → freeze

export type Decider = (state: SellerState, policy: SellerPolicy, profile?: BuyerLeverProfile) => ProposedMove;
export type Voicer = (move: ProposedMove, ctx: VoiceContext, llm: Llm | null) => Promise<VoiceResult>;

export interface ExchangeOptions {
  store?: ExchangeStore;
  catalog?: Catalog;
  sink?: EventSink;
  llm?: Llm | null; // seller voice model; null = E2's templates (fast, free)
  decide?: Decider; // default E2 decide(); tests inject adversarial sellers here
  voice?: Voicer; // default E2 voice()
  now?: () => number;
  soft_floor_buffer?: number;
}

export class Exchange {
  readonly store: ExchangeStore;
  readonly catalog: Catalog;
  readonly deals: Deals;
  readonly breaker: ProbeBreaker;
  private limiter: StartLimiter;
  private sinkP: Promise<EventSink>;
  private llm: Llm | null;
  private decideFn: Decider;
  private voiceFn: Voicer;
  private now: () => number;
  private buffer: number;

  constructor(o: ExchangeOptions = {}) {
    this.store = o.store ?? new MemoryStore();
    this.catalog = o.catalog ?? new StaticCatalog();
    this.now = o.now ?? Date.now;
    this.breaker = new ProbeBreaker(this.now);
    this.limiter = new StartLimiter(this.now);
    this.deals = new Deals(this.store, this.catalog, this.now, (pid) => this.breaker.trip(pid));
    this.sinkP = o.sink ? Promise.resolve(o.sink) : defaultSink();
    this.llm = o.llm ?? null;
    this.decideFn = o.decide ?? e2decide;
    this.voiceFn = o.voice ?? e2voice;
    this.buffer = o.soft_floor_buffer ?? DEFAULT_SOFT_FLOOR_BUFFER;
  }

  /** Deploy default: Supabase store + events when SUPABASE_URL is set, else in-memory. */
  static async fromEnv(o: Omit<ExchangeOptions, "store"> = {}): Promise<Exchange> {
    const catalog = o.catalog ?? new StaticCatalog();
    const { supabaseStoreFromEnv } = await import("./supabase-store");
    const store = (await supabaseStoreFromEnv(catalog)) ?? new MemoryStore();
    return new Exchange({ ...o, catalog, store });
  }

  async handle(move: Move): Promise<ExchangeResponse> {
    const ctx = BuyerContext.safeParse(move?.ctx);
    if (!ctx.success) return fail("bad_request", "ctx needs run_id, buyer_id and buyer_model on every call");
    try {
      switch (move.kind) {
        case "offer": return await this.offer(move);
        case "accept": return await this.accept(move);
        case "walk": return await this.walk(move);
        case "status": return await this.status(move);
        default: return fail("bad_request", `unknown move kind`);
      }
    } catch (e) {
      return fail("not_allowed", (e as Error).message);
    }
  }

  /** S2: after payDeal() succeeds. Marks the deal paid and moves the negotiation to `paid`. */
  async markPaid(deal_id: string, payment_intent_id: string): Promise<void> {
    await this.deals.markPaid(deal_id, payment_intent_id);
    const d = await this.store.getDeal(deal_id);
    const n = d && (await this.store.getNegotiation(d.negotiation_id));
    if (n && n.state === "agreed") await this.setState(n, "paid");
  }

  // ---------------------------------------------------------------- moves

  private async offer(m: OfferMove): Promise<ExchangeResponse> {
    if (!Number.isInteger(m.offer_price_cents) || m.offer_price_cents <= 0)
      return fail("bad_request", "offer_price_cents must be a positive whole number of cents");
    const qty = m.quantity ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) return fail("bad_request", "quantity must be a whole number from 1 to 100");

    let n: Negotiation;
    let p: ProductConfig | null;
    if (!m.negotiation_id) {
      p = await this.catalog.get(m.product_id);
      if (!p) return fail("unknown_product", `no product ${m.product_id}; use search_products to find one`);
      if (!this.limiter.allow(memoryKey(m.ctx.buyer_id, p.product_id)))
        return fail("rate_limited", "too many negotiations started on this product today; continue an existing negotiation_id instead");
      n = this.newNegotiation(m, p, qty);
      // E11 buyer memory: a returning buyer resumes where they left off. Never quoted higher than before,
      // and the concession clock doesn't restart, so restarting can't bisect toward the floor.
      const mem = await this.store.getBuyerMemory(memoryKey(n.buyer_id, p.product_id));
      if (mem) {
        n.round = Math.min(mem.round, p.max_rounds - 1);
        n.frozen = mem.round >= p.max_rounds; // deadline already used: one final offer per buyer, at their best price
        n.history.push({ by: "seller", round: n.round, price_cents: mem.lowest_offer_cents });
        await this.emit(n, "guardrail_blocked", "seller", mem.lowest_offer_cents, { rule: "buyer_memory_resume", reason: "returning buyer resumes at their last offer", sessions: mem.sessions + 1 });
      }
      await this.store.putNegotiation(n);
    } else {
      const got = await this.load(m.negotiation_id, m.ctx.buyer_id);
      if ("error" in got) return got.error;
      n = got.n;
      if (m.product_id && m.product_id !== n.product_id) return fail("bad_request", `negotiation ${n.id} is for ${n.product_id}`);
      p = await this.catalog.get(n.product_id);
      if (!p) return fail("unknown_product", `product ${n.product_id} is no longer sold`);
    }

    // lever package: only levers this listing offers; price is checked against floor + lever costs
    const levers = [...new Set(m.levers ?? n.levers ?? [])];
    const bad = levers.filter((l) => !p!.allowed_levers.includes(l));
    if (bad.length) return fail("bad_lever", `${bad.join(", ")} isn't offered on this listing; available: ${p.allowed_levers.join(", ") || "none"}`);
    const cost = leverCost(levers, p.lever_costs);
    if (p.floor_price_cents + cost > p.list_price_cents) return fail("bad_lever", "that package can't be offered; try fewer extras");
    if (levers.join() !== (n.levers ?? []).join()) n.levers = levers;
    const base = p;
    p = { ...p, floor_price_cents: p.floor_price_cents + cost }; // effective floor for this package

    const standing = n.standing_offer_id ? await this.store.getOffer(n.standing_offer_id) : null;
    const atCap = n.round >= p.max_rounds;
    if (!allowedActions(n.state, atCap).includes("offer")) {
      return atCap
        ? this.respond(n, p, standing, { ok: false, error: { code: "round_cap", message: "the seller made its final offer; you can accept it by offer_id or walk away" } })
        : fail("not_allowed", `can't make an offer while the negotiation is ${n.state}`);
    }

    // input guard + circuit breaker
    const input = inspectInput(m.message ?? "");
    if (input.flagged) {
      n.attack_flags++;
      await this.emit(n, "guardrail_blocked", "seller", null, { rule: "input_injection", markers: input.markers, reason: "injected instructions removed from buyer message" });
      if (!n.frozen && n.attack_flags >= BREAKER_THRESHOLD) {
        n.frozen = true;
        await this.emit(n, "guardrail_blocked", "seller", standing?.price_cents ?? null, { rule: "circuit_breaker", reason: "price frozen after repeated injection attempts" });
      }
    }
    for (const ask of input.asks) {
      n.escalations.push(ask);
      await this.emit(n, "guardrail_blocked", "seller", null, { rule: "out_of_policy_ask", ask, reason: "logged for a human; seller declines" });
    }

    await this.emit(n, "offer_made", "buyer", m.offer_price_cents, { quantity: qty, message: input.sanitized.slice(0, 500), offer_id: standing?.offer_id ?? null });
    n.history.push({ by: "buyer", round: n.round + 1, price_cents: m.offer_price_cents });
    n.round++;

    // decide → guard
    const prevSeller = lastSeller(n);
    const proposed = this.decideFn(
      { round: n.round, terms: { product_id: p.product_id, title: p.title, list_price_cents: p.list_price_cents, floor_price_cents: p.floor_price_cents,
        unit_cost_cents: p.unit_cost_cents, max_rounds: p.max_rounds }, history: n.history.slice(0, -1), buyer_offer_cents: m.offer_price_cents },
      { name: p.strategy, soft_floor_buffer: this.buffer, final_round_accept_zone: !n.frozen && this.breaker.open(base.product_id) }, m.buyer_profile);
    let { move, blocks } = guardMove({ move: proposed, product: p, round: n.round, prev_seller_offer_cents: prevSeller, frozen: n.frozen, soft_floor_buffer: this.buffer });
    for (const b of blocks) await this.emit(n, "guardrail_blocked", "seller", move.price_cents, { ...b });

    // E11 jitter: noisy steps toward a private per-buyer endpoint (not when frozen: a frozen price is final)
    if (move.action === "offer" && !n.frozen) {
      const soft = softFloor(p.list_price_cents, p.floor_price_cents, this.buffer);
      const end = buyerEndpoint(n.buyer_id, base.product_id, soft, p.list_price_cents, p.floor_price_cents);
      const maxStep = Math.ceil(CONCESSION_CAP * (p.list_price_cents - p.floor_price_cents));
      let price = prevSeller === undefined ? Math.max(move.price_cents, end)
        : jitterStep(prevSeller, move.price_cents, `${n.buyer_id}|${base.product_id}|${n.round}`, end, maxStep);
      if (prevSeller !== undefined && prevSeller >= soft) price = Math.min(price, prevSeller);
      if (price !== move.price_cents) move = { ...move, price_cents: price, reason_text: `We can offer ${usd(price)} this round.` };
    }
    // E11 probe breaker: a deadline bid just under the floor that we refuse closes the accept zone for 24 h
    if (n.round >= p.max_rounds && move.action === "offer") {
      const gap = base.list_price_cents - base.floor_price_cents;
      if (m.offer_price_cents < p.floor_price_cents && m.offer_price_cents >= p.floor_price_cents - NEAR_MISS_BAND * gap) {
        this.breaker.trip(base.product_id);
        await this.emit(n, "guardrail_blocked", "seller", null, { rule: "probe_breaker", reason: "near-miss deadline bid; final-round accept zone closed for 24 h" });
      }
    }

    // voice → output guard
    const message = await this.speak(n, p, move, input.sanitized, m.buyer_profile, n.levers, base.floor_price_cents);

    if (move.action === "accept") {
      const offer = this.newOffer(n, move, qty, "accepted");
      await this.supersede(standing);
      await this.store.putOffer(offer);
      const deal = await this.lock(n, p, offer);
      await this.emit(n, "offer_accepted", "seller", move.price_cents, { offer_id: offer.offer_id, lever_package: offer.levers, message, final: true, expires_at: deal.expires_at });
      return this.respond(n, p, offer, { ok: true, status: "accept", message, reason: move.reason, deal });
    }

    const offer = this.newOffer(n, move, qty, "live");
    await this.supersede(standing);
    await this.store.putOffer(offer);
    n.history.push({ by: "seller", round: n.round, price_cents: move.price_cents });
    n.standing_offer_id = offer.offer_id;
    await this.setState(n, "negotiating");
    await this.remember(n, move.price_cents);
    await this.emit(n, "offer_countered", "seller", move.price_cents, { offer_id: offer.offer_id, lever_package: offer.levers, message, final: offer.final, expires_at: offer.expires_at, round: n.round });
    return this.respond(n, p, offer, { ok: true, status: "counter", message, reason: move.reason });
  }

  private async accept(m: AcceptMove): Promise<ExchangeResponse> {
    const got = await this.load(m.negotiation_id, m.ctx.buyer_id);
    if ("error" in got) return got.error;
    const n = got.n;
    const p = await this.catalog.get(n.product_id);
    if (!p) return fail("unknown_product", `product ${n.product_id} is no longer sold`);
    const o = await this.store.getOffer(m.offer_id);
    if (!o || o.negotiation_id !== n.id) return fail("unknown_offer", `offer ${m.offer_id} isn't an offer in negotiation ${n.id}`);
    if (o.buyer_id !== m.ctx.buyer_id) return fail("wrong_buyer", "that offer was made to a different buyer");

    // idempotent: accepting the same offer again returns the same deal
    const existing = await this.store.dealForOffer(o.offer_id);
    if (existing) return this.respond(n, p, o, { ok: true, status: "accept", message: "Already accepted. Here is your deal.", deal: existing });

    if (o.status === "superseded" || n.standing_offer_id !== o.offer_id)
      return this.respond(n, p, await this.standing(n), { ok: false, error: { code: "stale_offer", message: "that offer was replaced; accept the standing_offer's offer_id instead" } });
    if (o.status === "expired" || Date.parse(o.expires_at) <= this.now()) {
      await this.store.putOffer({ ...o, status: "expired" });
      return this.respond(n, p, null, { ok: false, error: { code: "offer_expired", message: "that offer expired; make a new offer to get a fresh quote" } });
    }
    if (!allowedActions(n.state, false).includes("accept")) return fail("not_allowed", `can't accept while the negotiation is ${n.state}`);
    if (o.price_cents - leverCost(o.levers, p.lever_costs) < p.floor_price_cents) { // policy re-check (floor may have moved)
      await this.emit(n, "guardrail_blocked", "seller", o.price_cents, { rule: "policy_recheck", reason: "offer no longer passes the seller's policy" });
      return fail("not_allowed", "this offer can no longer be honored; make a new offer");
    }

    const accepted: StandingOffer = { ...o, status: "accepted" };
    await this.store.putOffer(accepted);
    const deal = await this.lock(n, p, accepted);
    await this.emit(n, "offer_accepted", "buyer", o.price_cents, { offer_id: o.offer_id, lever_package: o.levers, final: o.final, expires_at: deal.expires_at });
    return this.respond(n, p, accepted, { ok: true, status: "accept", message: `Deal locked: ${p.title} at ${usd(o.price_cents)}. Approve and pay to complete.`, deal });
  }

  private async walk(m: WalkMove): Promise<ExchangeResponse> {
    const got = await this.load(m.negotiation_id, m.ctx.buyer_id);
    if ("error" in got) return got.error;
    const n = got.n;
    if (!allowedActions(n.state, false).includes("walk")) return fail("not_allowed", `can't walk away while the negotiation is ${n.state}`);
    await this.supersede(await this.standing(n));
    await this.setState(n, "walked_away");
    await this.emit(n, "buyer_walked_away", "buyer", null, { reason: (m.reason ?? "").slice(0, 300) });
    const p = await this.catalog.get(n.product_id);
    return this.respond(n, p!, null, { ok: true, status: "walked", message: "Understood. The negotiation is closed." });
  }

  private async status(m: StatusMove): Promise<ExchangeResponse> {
    const got = await this.load(m.negotiation_id, m.ctx.buyer_id);
    if ("error" in got) return got.error;
    const n = got.n;
    const p = await this.catalog.get(n.product_id);
    const deal = n.deal_id ? await this.store.getDeal(n.deal_id) : null;
    return this.respond(n, p!, await this.standing(n), { ok: true, status: "info", message: `Negotiation is ${n.state}.`, deal: deal ?? undefined });
  }

  // ---------------------------------------------------------------- helpers

  private async speak(n: Negotiation, p: ProductConfig, move: ProposedMove, buyerText: string, profile?: BuyerLeverProfile, levers: string[] = [], hardFloor = p.floor_price_cents): Promise<string> {
    const prior = n.history.map((h) => h.price_cents);
    const vctx: VoiceContext = { terms: { product_id: p.product_id, title: p.title, list_price_cents: p.list_price_cents,
      floor_price_cents: p.floor_price_cents, unit_cost_cents: p.unit_cost_cents, max_rounds: p.max_rounds },
      prior_prices_cents: prior, buyer_message: buyerText, buyer_profile: profile };
    const octx: OutputContext = { offer_price_cents: move.price_cents, allowed_prices_cents: [p.list_price_cents, ...prior.filter((x) => x >= softFloor(p.list_price_cents, p.floor_price_cents, this.buffer))],
      low_cents: softFloor(p.list_price_cents, p.floor_price_cents, this.buffer), private_cents: [hardFloor, p.floor_price_cents, p.unit_cost_cents],
      final: move.final, levers_in_offer: levers };
    let text: string;
    try { text = (await this.voiceFn(move, vctx, this.llm)).message; } catch { text = ""; }
    const findings = text ? checkOutput(text, octx) : [{ rule: "voice_error", detail: "no message" }];
    if (!findings.length) return text;
    for (const f of findings) await this.emit(n, "guardrail_blocked", "seller", move.price_cents, { rule: `output_${f.rule}`, reason: f.detail });
    return fallbackMessage(octx, p.title);
  }

  private async remember(n: Negotiation, offer_cents: number) {
    const k = memoryKey(n.buyer_id, n.product_id);
    const prev = await this.store.getBuyerMemory(k);
    await this.store.putBuyerMemory(k, { lowest_offer_cents: Math.min(offer_cents, prev?.lowest_offer_cents ?? offer_cents),
      round: Math.max(n.round, prev?.round ?? 0), sessions: (prev?.sessions ?? 0) + (n.round === 1 || !prev ? 1 : 0), updated_at: new Date(this.now()).toISOString() });
  }

  private newNegotiation(m: OfferMove, p: ProductConfig, qty: number): Negotiation {
    const t = new Date(this.now()).toISOString();
    return { id: `neg_${randomUUID()}`, run_id: m.ctx.run_id, buyer_id: m.ctx.buyer_id, buyer_model: m.ctx.buyer_model, seller_id: p.seller_id,
      product_id: p.product_id, quantity: qty, state: "open", round: 0, history: [], attack_flags: 0, frozen: false, escalations: [], levers: [], created_at: t, updated_at: t };
  }

  private newOffer(n: Negotiation, move: ProposedMove, qty: number, status: StandingOffer["status"]): StandingOffer {
    return { offer_id: `off_${randomUUID()}`, negotiation_id: n.id, buyer_id: n.buyer_id, price_cents: move.price_cents, quantity: qty, levers: [...(n.levers ?? [])],
      final: move.final, expires_at: new Date(this.now() + OFFER_TTL_MS).toISOString(), status, round: n.round };
  }

  private async lock(n: Negotiation, p: ProductConfig, o: StandingOffer): Promise<LockedDeal> {
    const deal = lockDeal({ negotiation_id: n.id, offer_id: o.offer_id, buyer_id: n.buyer_id, seller_id: n.seller_id, product_id: p.product_id,
      title: p.title, quantity: o.quantity, unit_price_cents: o.price_cents, list_price_cents: p.list_price_cents, levers: o.levers }, this.now());
    await this.store.putDeal(deal);
    n.deal_id = deal.deal_id;
    n.standing_offer_id = o.offer_id;
    await this.setState(n, "agreed");
    // Costs go on deal_accepted only, once the price is locked, so S2 can compute profit. The floor value never goes in events.
    const lever_cost_cents = leverCost(deal.levers, p.lever_costs);
    await this.emit(n, "deal_accepted", "seller", deal.unit_price_cents, { deal_id: deal.deal_id, offer_id: o.offer_id, lever_package: deal.levers,
      list_price_cents: p.list_price_cents, total_cents: deal.total_cents, quantity: deal.quantity, expires_at: deal.expires_at,
      unit_cost_cents: p.unit_cost_cents, lever_cost_cents, below_floor: deal.unit_price_cents - lever_cost_cents < p.floor_price_cents });
    return deal;
  }

  private async supersede(o: StandingOffer | null) {
    if (o && o.status === "live") await this.store.putOffer({ ...o, status: "superseded" });
  }

  private async standing(n: Negotiation) {
    return n.standing_offer_id ? this.store.getOffer(n.standing_offer_id) : null;
  }

  private async setState(n: Negotiation, to: NegotiationState) {
    if (n.state !== to) assertTransition(n.state, to);
    else if (to !== "negotiating") assertTransition(n.state, to);
    n.state = to;
    n.updated_at = new Date(this.now()).toISOString();
    await this.store.putNegotiation(n);
  }

  private async load(id: string, buyer_id: string): Promise<{ n: Negotiation } | { error: ExchangeResponse }> {
    const n = await this.store.getNegotiation(id);
    if (!n) return { error: fail("unknown_negotiation", `no negotiation ${id}; omit negotiation_id to start one`) };
    if (n.buyer_id !== buyer_id) return { error: fail("wrong_buyer", "that negotiation belongs to a different buyer") };
    return { n };
  }

  private async respond(n: Negotiation, p: ProductConfig, o: StandingOffer | null, r: Partial<ExchangeResponse>): Promise<ExchangeResponse> {
    await this.store.putNegotiation(n);
    const atCap = n.round >= p.max_rounds;
    const live = o && (o.status === "live" || o.status === "accepted") ? o : null;
    const { signature: _s, ...deal } = (r.deal ?? {}) as LockedDeal;
    return {
      ok: r.ok ?? true, negotiation_id: n.id, state: n.state, status: r.status,
      standing_offer: live ? { offer_id: live.offer_id, price_cents: live.price_cents, quantity: live.quantity, levers: live.levers, final: live.final, expires_at: live.expires_at, round: live.round } : undefined,
      deal: r.deal ? deal : undefined,
      round: n.round, rounds_left: Math.max(0, p.max_rounds - n.round),
      allowed_actions: allowedActions(n.state, atCap).filter((a) => a !== "accept" || !!(live && live.status === "live")),
      message: r.message ?? r.error?.message ?? "", reason: r.reason, error: r.error,
    };
  }

  private async emit(n: Negotiation, type: NegotiationEvent["type"], actor: NegotiationEvent["actor"], price: number | null, payload: Record<string, unknown>) {
    const sink = await this.sinkP;
    try {
      await sink({ run_id: n.run_id, buyer_id: n.buyer_id, buyer_model: n.buyer_model, seller_id: n.seller_id, product_id: n.product_id,
        negotiation_id: n.id, actor, type, price_cents: price, payload: { ...payload, state: n.state } });
    } catch (e) {
      console.error("[exchange] event sink failed", (e as Error).message);
    }
  }
}

function lastSeller(n: Negotiation): number | undefined {
  const mine = n.history.filter((h) => h.by === "seller").map((h) => h.price_cents);
  return mine.length ? Math.min(...mine) : undefined;
}

function fail(code: ExchangeError["code"], message: string): ExchangeResponse {
  return { ok: false, allowed_actions: [], message, error: { code, message } };
}

const usd = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
