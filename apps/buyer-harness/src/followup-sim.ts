/**
 * Bridge 3 · What are follow-ups worth? (FINAL_ARCHITECTURE §5, BUILD_PLAN E1 H10–H13)
 *
 * One shopping pass through E1's real exchange (in-process), then two arms on the SAME buyers:
 *   off: the buyers who walked away stay lost (today's behaviour without outreach).
 *   on : each walk-away opts in to one follow-up at `consent_rate`; a fake clock passes the follow-up delay,
 *        `exchange.outreach.runDue()` sends through a capturing sender, the buyer's replier (scripted or Claude)
 *        reads the message and answers in plain text, and every answer goes through `exchange.inbound()`.
 * The first pass is identical for both arms, so the difference is the follow-up alone (paired).
 *
 * Hard safety checks (all from the exchange's own records, not the buyer's view; `safety.passed`):
 *   - no deal below floor + lever cost, none above the buyer's walk-away (wallet, enforced in this harness)
 *   - no follow-up offer below the lowest price the seller offered that buyer before the walk, or below floor + levers
 *   - at most one follow-up per buyer per week (some buyers walk a second product the same day); nothing sent later
 *   - every inbound reply parses to one structured move or a clarifying question (counted by intent)
 * "No new concession" (`safety.no_new_concession`): nothing a walk-away gets that staying couldn't. A buyer who walked
 *   at the round cap must not be offered less than the pre-walk price in the follow-up thread; paired probers check
 *   that walking + countering never beats the same bid made before walking. Buyers who walked BEFORE the cap resume
 *   the seller's schedule at the same round when they reply (reported as `resumed_*`, not a failure).
 */
import { decide as e2decide, usd, type Llm, type ProposedMove } from "@sa/seller-mcp/sellers";
import { FOLLOWUP_DELAY_MS, SEED_PRODUCTS, leverCost, parseInbound, type Decider, type Exchange, type ExchangeResponse,
  type InboundIntent, type OutboundMessage } from "@sa/seller-mcp/exchange";
import type { BuyerContext, NegotiationEvent } from "@sa/shared";
import { ExchangeGateway, type Strategy } from "./gateway/exchange";
import type { Gateway, GwAcceptResult, GwOfferArgs, GwOfferResult } from "./gateway/types";
import { keyedRng, type Replier, type ReplyTurn } from "./agents/replier";
import type { LlmBuyerTask } from "./agents/personas";
import type { BuyerOutcome } from "./agents/buyer";
import { runAll, type RunAllConfig, type Summary } from "./run-all";

export const T0 = Date.parse("2026-10-18T17:00:00Z"); // fake clock start (reproducible offer expiries)
const DAY = 24 * 3600_000;

export interface FollowupSimConfig {
  run_id: string;
  buyers: LlmBuyerTask[];
  replier: Replier;
  strategy?: Strategy; // seller policy for every product (default negotiating)
  consent_rate?: number; // share of walk-aways who opt in (default 0.5)
  repeat_share?: number; // share of opted-in walk-aways who also walk a 2nd product the same day (weekly-cap check; default 0.2)
  seed?: number; // consent / repeat draws (default 42)
  hold_at_cap?: boolean; // proposed exchange fix: past the round cap the seller holds its last price (see holdAtCap)
  max_reply_turns?: number; // buyer replies per follow-up thread (default 4)
  concurrency?: number;
  max_steps?: number;
  seller_llm?: Llm | null;
  brain_for?: RunAllConfig["brain_for"]; // shopping brains (default: by buyer_model)
  log?: (line: string) => void;
}

export interface DealScore {
  deal_id: string;
  product_id: string;
  price_cents: number;
  levers: string[];
  lever_cost_cents: number;
  profit_cents: number;
  below_floor: boolean;
}

export interface ThreadTurn {
  buyer: string;
  intent: InboundIntent["kind"] | "wallet_blocked";
  clarify_reason?: string;
  seller: string;
}

export interface BuyerRow {
  buyer_id: string;
  persona: string;
  adversary: string | null;
  buyer_model: string;
  walkaway_cents: number;
  first_deal: DealScore | null;
  walked: boolean;
  walked_reason: string | null;
  negotiation_id: string | null; // the negotiation the buyer walked from (latest one they offered on)
  product_id: string | null;
  reachable: boolean; // walked with a negotiation the exchange let them walk from
  unreachable: "no_offer" | "deal_locked_unconfirmed" | "other" | null; // walked, but no follow-up could be scheduled
  locked_deal: DealScore | null; // deal_locked_unconfirmed: the deal the seller locked at the buyer's own bid, never confirmed
  consent: boolean;
  repeat_negotiation_id: string | null; // 2nd same-day walk (cap check), never counted as a sale
  prewalk_seller_cents: number | null; // lowest price the seller offered before the walk
  prewalk_rounds: number | null;
  prewalk_levers: string[];
  walked_at_cap: boolean | null; // walked after the seller's final-round offer (vs. before the round cap)
  followup: { offer_id: string; price_cents: number; levers: string[]; subject: string } | null;
  thread: ThreadTurn[];
  thread_min_offer_cents: number | null; // lowest seller offer made in the follow-up thread (follow-up or a later counter)
  recovered: DealScore | null;
  recovered_via: "accept" | "counter" | null;
  wallet_blocks: number;
  reply_tokens: { input: number; output: number };
}

export interface Rate {
  k: number;
  n: number;
  rate: number;
  ci95: [number, number];
}
export interface Money {
  mean_cents: number;
  ci95_cents: [number, number];
}
export interface ArmSummary {
  label: "off" | "on";
  buyers: number;
  conversions: Rate;
  revenue_cents: number;
  profit_cents: number;
  profit_per_buyer_cents: number;
  avg_margin_pct: number;
  below_floor_deals: number;
}

export interface SafetyReport {
  below_floor_deals: number; // both arms, first pass + recovered
  followup_below_prewalk: number; // follow-up offer under the lowest pre-walk seller offer
  followup_below_policy: number; // follow-up offer under floor + its lever cost
  over_walkaway_deals: number;
  max_followups_per_buyer_7d: number;
  cap_blocks: number; // guardrail_blocked rule followup_cap
  repeat_walkers: number; // buyers who walked a 2nd product with consent the same day
  sends_after_first_drain: number; // follow-ups sent by later runDue() calls (day +1, day +8): should be 0
  inbound_replies: number;
  intents: Record<string, number>; // structured move or clarify, per reply
  unparsed_replies: number; // replies the parser couldn't classify into any kind (must be 0)
  passed: boolean; // all hard checks above
  // "Never a guess" (E1 done-test): replies that say no ("I'll pass", "can't accept", "won't buy") but parsed as an
  // ACCEPT or COUNTER, sent or stopped by the wallet. Heuristic, for review; examples in decline_read_as_move_examples.
  decline_read_as_move: number;
  decline_read_as_move_examples: { buyer_id: string; text: string; intent: string }[];

  // "No new concession": what walking away gets that staying could not. Walked at the round cap, then the seller
  // offered under the pre-walk price in the follow-up thread = an extra final round the buyer only got by walking.
  postcap_offer_below_prewalk: number;
  postcap_offer_below_prewalk_max_cents: number;
  no_new_concession: boolean; // postcap_offer_below_prewalk === 0
  // Resumed haggling: walked BEFORE the cap; replying resumes the seller's schedule at the same round (no reset),
  // so these prices are what staying would have reached. Reported, not a failure.
  resumed_offer_below_prewalk: number;
  resumed_offer_below_prewalk_max_cents: number;
  recovered_below_prewalk: number; // recovered deals under the pre-walk price (either kind)
  recovered_below_prewalk_cents: number;
  // Re-packaging (by design): the follow-up added a lever the buyer valued at the same price, still floor + lever cost safe.
  followups_with_added_lever: number;
  recovered_with_added_lever: number;
  added_lever_cost_cents: number; // the seller's cost of those levers on recovered deals
}

export interface ProbeReport {
  probers: number;
  paired_gain_cents: { mean: number; max: number; min: number }; // control price − walk price (>0 = walking helped the prober)
  walk_cheaper: number; // probers whose walk path closed cheaper than the same bid made before walking
  below_floor: number;
  rows: { product_id: string; bid_cents: number; control_cents: number | null; walk_cents: number | null; prewalk_cents: number }[];
}

export interface FollowupSimResult {
  run_id: string;
  config: { buyers: number; strategy: Strategy; consent_rate: number; repeat_share: number; seed: number; hold_at_cap: boolean;
    replier: string; buyer_models: string[]; followup_delay_ms: number };
  first_pass: Summary;
  off: ArmSummary;
  on: ArmSummary;
  lift: { conversions: Rate; profit_per_buyer: Money; revenue_per_buyer: Money; profit_per_100_buyers: Money };
  winback: { walkaways: number; reachable: number; consented: number; sent: number; recovered: number; via_accept: number; via_counter: number;
    of_walkaways: Rate; of_consented: Rate; of_sent: Rate;
    unreachable: Record<string, number>; affordable_walkaways: number; affordable_recovered: number;
    locked_unconfirmed_profit_per_buyer: Money }; // upper bound a deal-expiry reminder could add (not sent today)
  safety: SafetyReport;
  tokens: { first_pass: { input: number; output: number }; replies: { input: number; output: number } };
  rows: BuyerRow[];
}

// ---------------------------------------------------------------- stats

/** Wilson score interval for k of n. */
export function wilson(k: number, n: number, z = 1.96): Rate {
  if (!n) return { k, n, rate: 0, ci95: [0, 0] };
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { k, n, rate: p, ci95: [Math.max(0, c - h), Math.min(1, c + h)] };
}

/** Mean with a seeded percentile-bootstrap 95% CI (sparse, skewed per-buyer gains: most buyers add 0). */
export function bootMean(xs: number[], seed = 42, B = 5000): Money {
  if (!xs.length) return { mean_cents: 0, ci95_cents: [0, 0] };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const r = keyedRng(`boot|${seed}|${xs.length}`);
  const ms: number[] = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r() * xs.length)];
    ms.push(s / xs.length);
  }
  ms.sort((a, b) => a - b);
  return { mean_cents: Math.round(mean), ci95_cents: [Math.round(ms[Math.floor(0.025 * B)]), Math.round(ms[Math.floor(0.975 * B)])] };
}

// ---------------------------------------------------------------- seller variant

/**
 * Proposed exchange fix (not in seller-mcp yet): past the round cap a follow-up counter re-runs decide() for one extra
 * final round, and its accept zone can close below the price the seller already offered. This decider holds that
 * price instead: accept a bid at or above it, otherwise repeat it as final. Rounds within the cap are unchanged.
 */
export const holdAtCap: Decider = (state, policy, profile) => {
  const m = e2decide(state, policy, profile);
  if (state.round <= state.terms.max_rounds) return m;
  const mine = state.history.filter((h) => h.by === "seller").map((h) => h.price_cents);
  if (!mine.length) return m;
  const prev = Math.min(...mine);
  const bid = state.buyer_offer_cents;
  if (bid !== undefined && bid >= prev)
    return { action: "accept", price_cents: Math.min(bid, state.terms.list_price_cents), final: true, reason: "buyer_offer_meets_ask",
      reason_text: `Your offer of ${usd(bid)} meets our price, so we accept.`, conceded_fraction: m.conceded_fraction } satisfies ProposedMove;
  return { action: "offer", price_cents: prev, final: true, reason: "final_offer",
    reason_text: `${usd(prev)} is still our best price.`, conceded_fraction: m.conceded_fraction } satisfies ProposedMove;
};

// ---------------------------------------------------------------- gateway recorder

/** Wraps the in-process gateway: remembers each buyer's negotiations and deals, and keeps the seller's events. */
export class RecordingGateway implements Gateway {
  readonly kind: Gateway["kind"];
  readonly sellerEventsLogged?: boolean;
  readonly last = new Map<string, string>(); // buyer → latest negotiation_id they offered on
  readonly deals = new Map<string, string>(); // buyer → deal_id
  readonly events: NegotiationEvent[] = [];
  private sink: ((e: NegotiationEvent) => void) | null = null;

  constructor(readonly inner: ExchangeGateway) {
    this.kind = inner.kind;
    this.sellerEventsLogged = inner.sellerEventsLogged;
    inner.attach((e) => { this.events.push(e); this.sink?.(e); });
  }
  get exchange(): Exchange { return this.inner.exchange; }
  attach(emit: (e: NegotiationEvent) => void) { this.sink = emit; }
  search(ctx: BuyerContext, query: string, max_price_cents?: number) { return this.inner.search(ctx, query, max_price_cents); }
  getListing(ctx: BuyerContext, id: string) { return this.inner.getListing(ctx, id); }
  ask(ctx: BuyerContext, id: string, q: string) { return this.inner.ask(ctx, id, q); }
  async offer(ctx: BuyerContext, a: GwOfferArgs): Promise<GwOfferResult> {
    const r = await this.inner.offer(ctx, a);
    if (r.negotiation_id) this.last.set(ctx.buyer_id, r.negotiation_id);
    return r;
  }
  async accept(ctx: BuyerContext, negotiation_id: string): Promise<GwAcceptResult> {
    const r = await this.inner.accept(ctx, negotiation_id);
    if (r.ok) this.deals.set(ctx.buyer_id, r.deal_id);
    return r;
  }
}

// ---------------------------------------------------------------- helpers

export async function scoreDeal(ex: Exchange, deal_id: string): Promise<DealScore | null> {
  const d = await ex.store.getDeal(deal_id);
  const p = d && (await ex.catalog.get(d.product_id));
  if (!d || !p) return null;
  const lc = leverCost(d.levers, p.lever_costs);
  return { deal_id, product_id: d.product_id, price_cents: d.unit_price_cents, levers: d.levers, lever_cost_cents: lc,
    profit_cents: d.unit_price_cents - p.unit_cost_cents - lc, below_floor: d.unit_price_cents - lc < p.floor_price_cents };
}

/** What the messaging door sends back to the buyer (mirrors marketplace/src/followup/door.ts replyText, PR #90). */
export function doorReply(r: ExchangeResponse & { intent: InboundIntent }): string {
  if (r.deal) return `${r.message}\ndeal_id: ${r.deal.deal_id} (approve and pay before ${r.deal.expires_at})`;
  const lines = [r.ok ? r.message : r.error?.message ?? r.message];
  const o = r.standing_offer;
  if (o && r.intent.kind === "counter" && r.allowed_actions.includes("accept"))
    lines.push("", `Current offer: ${usd(o.price_cents)}${o.levers.length ? ` incl. ${o.levers.join(", ")}` : ""}, expires ${o.expires_at}. To accept, reply: ACCEPT ${o.offer_id}`);
  return lines.join("\n");
}

const ctxOf = (run_id: string, t: LlmBuyerTask, model: string): BuyerContext =>
  ({ run_id, buyer_id: t.buyer_id, buyer_model: model, channel: "harness", agent_operator: "harness" });
const consentOf = (buyer_id: string) => ({ channel: "email" as const, reply_to: `${buyer_id}@buyers.example` });

async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (i < items.length) await f(items[i++]); }));
}

function arm(label: "off" | "on", n: number, deals: DealScore[]): ArmSummary {
  const revenue = deals.reduce((s, d) => s + d.price_cents, 0);
  const profit = deals.reduce((s, d) => s + d.profit_cents, 0);
  return { label, buyers: n, conversions: wilson(deals.length, n), revenue_cents: revenue, profit_cents: profit,
    profit_per_buyer_cents: n ? Math.round(profit / n) : 0, avg_margin_pct: revenue ? (100 * profit) / revenue : 0,
    below_floor_deals: deals.filter((d) => d.below_floor).length };
}

/** A reply that declines in words. Used to flag declines the inbound parser read as a deal move. */
export const DECLINE = /\b(i'?ll pass|i'?m passing|passing on|pass on (?:this|it|the)|can'?t accept|cannot accept|not accepting|won'?t (?:buy|accept|pay|proceed)|no thanks|not interested|i decline)\b/i;

/** Replies that decline but were read as ACCEPT or COUNTER (a wallet block means the pre-parse was one of those). */
export function declinesReadAsMoves(rows: BuyerRow[]) {
  return rows.flatMap((r) => r.thread.filter((t) => ["accept", "counter", "wallet_blocked"].includes(t.intent) && DECLINE.test(t.buyer))
    .map((t) => ({ buyer_id: r.buyer_id, text: t.buyer.slice(0, 300), intent: t.intent })));
}

// ---------------------------------------------------------------- the sim

export async function runFollowupSim(cfg: FollowupSimConfig): Promise<FollowupSimResult> {
  const log = cfg.log ?? (() => {});
  const strategy = cfg.strategy ?? "negotiating";
  const consentRate = cfg.consent_rate ?? 0.5, repeatShare = cfg.repeat_share ?? 0.2, seed = cfg.seed ?? 42;
  const clock = { t: T0 };
  const outbox: OutboundMessage[] = [];
  const gw = new RecordingGateway(new ExchangeGateway(strategy, cfg.seller_llm ?? null, {
    now: () => clock.t, send: async (m) => { outbox.push(m); }, decide: cfg.hold_at_cap ? holdAtCap : undefined }));
  const ex = gw.exchange;

  // ---- 1. shopping pass (same for both arms)
  const { summary, outcomes } = await runAll({ run_id: cfg.run_id, label: strategy, buyers: cfg.buyers, gateway: gw,
    concurrency: cfg.concurrency, max_steps: cfg.max_steps, brain_for: cfg.brain_for,
    on_outcome: (o) => log(`  [shop] ${o.buyer_id} ${o.persona.padEnd(13)} ${o.closed ? `bought at ${usd(o.price_cents!)}` : `walked: ${(o.walked_reason ?? (o.error ? `error ${o.error}` : "out of steps")).slice(0, 70)}`}`) });
  const byId = new Map(outcomes.map((o) => [o.buyer_id, o]));

  // ---- 2. walk-aways: close the negotiation in the exchange, with consent at consent_rate
  const rows: BuyerRow[] = [];
  for (const t of cfg.buyers) {
    const o = byId.get(t.buyer_id) as BuyerOutcome;
    const dealId = gw.deals.get(t.buyer_id);
    const row: BuyerRow = { buyer_id: t.buyer_id, persona: t.persona, adversary: t.adversary ?? null, buyer_model: o.buyer_model,
      walkaway_cents: t.walkaway_cents, first_deal: o.closed && dealId ? await scoreDeal(ex, dealId) : null, walked: !o.closed,
      walked_reason: o.walked_reason, negotiation_id: null, product_id: null, reachable: false, unreachable: null, consent: false,
      locked_deal: null, repeat_negotiation_id: null, prewalk_seller_cents: null, prewalk_rounds: null, prewalk_levers: [], walked_at_cap: null, followup: null, thread: [], thread_min_offer_cents: null, recovered: null, recovered_via: null,
      wallet_blocks: 0, reply_tokens: { input: 0, output: 0 } };
    rows.push(row);
    const nid = gw.last.get(t.buyer_id);
    if (o.closed) continue;
    if (!nid) { row.unreachable = "no_offer"; continue; }
    const n = (await ex.store.getNegotiation(nid))!;
    const p = await ex.catalog.get(n.product_id);
    const mine = n.history.filter((h) => h.by === "seller").map((h) => h.price_cents);
    Object.assign(row, { negotiation_id: nid, product_id: n.product_id, prewalk_seller_cents: mine.length ? Math.min(...mine) : null,
      prewalk_rounds: n.round, prewalk_levers: [...(n.levers ?? [])], walked_at_cap: !!p && n.round >= p.max_rounds });
    row.consent = keyedRng(`consent|${seed}|${t.buyer_id}`)() < consentRate;
    const ctx = ctxOf(cfg.run_id, t, o.buyer_model);
    const w = await ex.handle({ kind: "walk", ctx, negotiation_id: nid, reason: o.walked_reason ?? "walked away",
      followup: row.consent ? consentOf(t.buyer_id) : undefined });
    row.reachable = w.ok;
    if (!w.ok) {
      row.consent = false;
      row.unreachable = n.state === "agreed" ? "deal_locked_unconfirmed" : "other";
      if (n.deal_id) row.locked_deal = await scoreDeal(ex, n.deal_id);
      log(`  [walk] ${t.buyer_id} can't walk: ${w.message}`);
    }
  }

  // same-day second walk for some opted-in buyers: the weekly cap must stop the second follow-up
  clock.t += 60_000;
  const products = SEED_PRODUCTS.filter((p) => p.product_id.startsWith("kb_"));
  const opted = rows.filter((r) => r.consent);
  for (const [i, row] of opted.entries()) {
    // at least one repeat walker whenever repeat_share > 0, so the weekly-cap check always runs
    if (keyedRng(`repeat|${seed}|${row.buyer_id}`)() >= repeatShare && !(repeatShare > 0 && i === opted.length - 1 && !opted.some((r) => r.repeat_negotiation_id))) continue;
    const first = (await ex.store.getNegotiation(row.negotiation_id!))!.product_id;
    const other = products.find((p) => p.product_id !== first)!;
    const ctx = ctxOf(cfg.run_id, cfg.buyers.find((b) => b.buyer_id === row.buyer_id)!, row.buyer_model);
    const r = await ex.handle({ kind: "offer", ctx, product_id: other.product_id, offer_price_cents: Math.round((other.list_price_cents * 0.7) / 100) * 100 });
    if (!r.ok || !r.negotiation_id) continue;
    const w = await ex.handle({ kind: "walk", ctx, negotiation_id: r.negotiation_id, reason: "too expensive", followup: consentOf(row.buyer_id) });
    if (w.ok) row.repeat_negotiation_id = r.negotiation_id;
  }

  // ---- 3. the follow-up delay passes; outreach sends what's due
  clock.t += FOLLOWUP_DELAY_MS + 60_000;
  const sentFirst = await ex.outreach.runDue();
  log(`\n  [outreach] sent ${sentFirst.length} follow-ups (${rows.filter((r) => r.consent).length} opted in)`);
  clock.t += 5 * 60_000; // the buyer's agent reads it a few minutes later

  // ---- 4. buyers reply; every reply goes through exchange.inbound()
  const rowById = new Map(rows.map((r) => [r.buyer_id, r]));
  const intents: Record<string, number> = {};
  let inbound = 0, unparsed = 0;
  const maxTurns = cfg.max_reply_turns ?? 4;
  await pool(sentFirst, cfg.concurrency ?? 4, async (m) => {
    const row = rowById.get(m.buyer_id);
    if (!row || m.negotiation_id !== row.negotiation_id) return; // a repeat-walk follow-up that got through (counted below)
    const task = cfg.buyers.find((b) => b.buyer_id === m.buyer_id)!;
    const p = (await ex.catalog.get(m.offer.product_id))!;
    row.followup = { offer_id: m.offer.offer_id, price_cents: m.offer.price_cents, levers: m.offer.levers, subject: m.subject };
    let standing = { offer_id: m.offer.offer_id, price_cents: m.offer.price_cents, levers: m.offer.levers };
    row.thread_min_offer_cents = m.offer.price_cents;
    const thread: ReplyTurn[] = [{ from: "seller", text: m.text }];
    for (let turn = 0; turn < maxTurns; turn++) {
      const rep = await cfg.replier.reply({ task, title: p.title, walked_reason: row.walked_reason, thread, offer: standing });
      row.reply_tokens.input += rep.input_tokens; row.reply_tokens.output += rep.output_tokens;
      thread.push({ from: "buyer", text: rep.text });
      // the principal's wallet, in code: read the reply the way the seller will, block anything above the walk-away
      const seen = parseInbound(rep.text, { standing_offer_id: standing.offer_id, allowed_levers: p.allowed_levers });
      const over = (seen.kind === "accept" && standing.price_cents > task.walkaway_cents) || (seen.kind === "counter" && seen.price_cents > task.walkaway_cents);
      if (over) {
        row.wallet_blocks++;
        const note = "BLOCKED: that reply would commit to a price above your absolute maximum, so it was not sent.";
        thread.push({ from: "wallet", text: note });
        row.thread.push({ buyer: rep.text, intent: "wallet_blocked", seller: note });
        continue;
      }
      const r = await ex.inbound(m.negotiation_id, m.buyer_id, rep.text);
      inbound++;
      intents[r.intent.kind] = (intents[r.intent.kind] ?? 0) + 1;
      if (!["accept", "counter", "walk", "unsubscribe", "clarify"].includes(r.intent.kind)) unparsed++;
      const said = doorReply(r);
      row.thread.push({ buyer: rep.text, intent: r.intent.kind, ...(r.intent.kind === "clarify" ? { clarify_reason: r.intent.reason } : {}), seller: said });
      thread.push({ from: "seller", text: said });
      const offered = r.deal?.unit_price_cents ?? r.standing_offer?.price_cents;
      if (offered !== undefined) row.thread_min_offer_cents = Math.min(row.thread_min_offer_cents ?? offered, offered);
      if (r.deal) {
        row.recovered = await scoreDeal(ex, r.deal.deal_id);
        row.recovered_via = r.intent.kind === "accept" ? "accept" : "counter";
        break;
      }
      if (r.intent.kind === "walk" || r.intent.kind === "unsubscribe") break;
      if (r.standing_offer && r.allowed_actions.includes("accept"))
        standing = { offer_id: r.standing_offer.offer_id, price_cents: r.standing_offer.price_cents, levers: r.standing_offer.levers };
      if (r.state && ["walked_away", "expired", "paid", "agreed"].includes(r.state)) break;
    }
    log(`  [reply] ${row.buyer_id} ${row.persona.padEnd(13)} follow-up ${usd(m.offer.price_cents)}${m.offer.levers.length ? `+${m.offer.levers.join("+")}` : ""} → ` +
      `${row.thread.map((x) => x.intent).join(" → ")}${row.recovered ? `  RECOVERED at ${usd(row.recovered.price_cents)} (${row.recovered_via})` : ""}`);
  });

  // ---- 5. later drains: nothing more may go out (one follow-up per negotiation, one per buyer per week)
  clock.t += DAY;
  const later1 = await ex.outreach.runDue();
  clock.t += 7 * DAY;
  const later8 = await ex.outreach.runDue();

  // ---- score
  const allSent = [...sentFirst, ...later1, ...later8];
  const perBuyer = new Map<string, number>();
  for (const m of allSent) perBuyer.set(m.buyer_id, (perBuyer.get(m.buyer_id) ?? 0) + 1);
  const capBlocks = gw.events.filter((e) => e.type === "guardrail_blocked" && (e.payload as { rule?: string })?.rule === "followup_cap").length;
  const firstDeals = rows.flatMap((r) => (r.first_deal ? [r.first_deal] : []));
  const recovered = rows.filter((r) => r.recovered);
  const threadBelow = (r: BuyerRow) => r.thread_min_offer_cents !== null && r.prewalk_seller_cents !== null && r.thread_min_offer_cents < r.prewalk_seller_cents;
  const postcap = rows.filter((r) => threadBelow(r) && r.walked_at_cap);
  const resumed = rows.filter((r) => threadBelow(r) && !r.walked_at_cap);
  const gapMax = (rs: BuyerRow[]) => Math.max(0, ...rs.map((r) => r.prewalk_seller_cents! - r.thread_min_offer_cents!));
  const added = (r: BuyerRow) => !!r.followup && r.followup.levers.some((l) => !r.prewalk_levers.includes(l));
  const below = (r: BuyerRow) => r.recovered && r.prewalk_seller_cents !== null && r.recovered.price_cents < r.prewalk_seller_cents;
  let followupBelowPolicy = 0;
  for (const m of allSent) {
    const p = (await ex.catalog.get(m.offer.product_id))!;
    if (m.offer.price_cents - leverCost(m.offer.levers, p.lever_costs) < p.floor_price_cents) followupBelowPolicy++;
  }
  const safety: SafetyReport = {
    below_floor_deals: [...firstDeals, ...recovered.map((r) => r.recovered!)].filter((d) => d.below_floor).length,
    followup_below_prewalk: rows.filter((r) => r.followup && r.prewalk_seller_cents !== null && r.followup.price_cents < r.prewalk_seller_cents).length,
    followup_below_policy: followupBelowPolicy,
    over_walkaway_deals: [...rows.filter((r) => r.first_deal && r.first_deal.price_cents > r.walkaway_cents), ...recovered.filter((r) => r.recovered!.price_cents > r.walkaway_cents)].length,
    max_followups_per_buyer_7d: Math.max(0, ...perBuyer.values()),
    cap_blocks: capBlocks,
    repeat_walkers: rows.filter((r) => r.repeat_negotiation_id).length,
    sends_after_first_drain: later1.length + later8.length,
    inbound_replies: inbound,
    intents,
    unparsed_replies: unparsed,
    passed: false,
    decline_read_as_move: declinesReadAsMoves(rows).length,
    decline_read_as_move_examples: declinesReadAsMoves(rows).slice(0, 10),
    postcap_offer_below_prewalk: postcap.length,
    postcap_offer_below_prewalk_max_cents: gapMax(postcap),
    no_new_concession: postcap.length === 0,
    resumed_offer_below_prewalk: resumed.length,
    resumed_offer_below_prewalk_max_cents: gapMax(resumed),
    recovered_below_prewalk: recovered.filter(below).length,
    recovered_below_prewalk_cents: recovered.filter(below).reduce((s, r) => s + (r.prewalk_seller_cents! - r.recovered!.price_cents), 0),
    followups_with_added_lever: rows.filter(added).length,
    recovered_with_added_lever: recovered.filter(added).length,
    added_lever_cost_cents: recovered.filter(added).reduce((s, r) => s + leverCost(r.followup!.levers.filter((l) => !r.prewalk_levers.includes(l))), 0),
  };
  safety.passed = safety.below_floor_deals === 0 && safety.followup_below_prewalk === 0 && safety.followup_below_policy === 0 &&
    safety.over_walkaway_deals === 0 && safety.max_followups_per_buyer_7d <= 1 &&
    safety.sends_after_first_drain === 0 && safety.unparsed_replies === 0;

  const off = arm("off", rows.length, firstDeals);
  const on = arm("on", rows.length, [...firstDeals, ...recovered.map((r) => r.recovered!)]);
  const gain = rows.map((r) => r.recovered?.profit_cents ?? 0);
  const rev = rows.map((r) => r.recovered?.price_cents ?? 0);
  const walkaways = rows.filter((r) => r.walked);
  const affordable = (r: BuyerRow) => r.prewalk_seller_cents !== null && r.prewalk_seller_cents <= r.walkaway_cents; // walked from an offer they could pay
  const consented = rows.filter((r) => r.consent);
  const ppb = bootMean(gain, seed);
  const tok = rows.reduce((a, r) => ({ input: a.input + r.reply_tokens.input, output: a.output + r.reply_tokens.output }), { input: 0, output: 0 });
  return {
    run_id: cfg.run_id,
    config: { buyers: rows.length, strategy, consent_rate: consentRate, repeat_share: repeatShare, seed, hold_at_cap: !!cfg.hold_at_cap,
      replier: cfg.replier.model, buyer_models: [...new Set(rows.map((r) => r.buyer_model))], followup_delay_ms: FOLLOWUP_DELAY_MS },
    first_pass: summary,
    off, on,
    lift: { conversions: wilson(recovered.length, rows.length), profit_per_buyer: ppb, revenue_per_buyer: bootMean(rev, seed),
      profit_per_100_buyers: { mean_cents: ppb.mean_cents * 100, ci95_cents: [ppb.ci95_cents[0] * 100, ppb.ci95_cents[1] * 100] } },
    winback: { walkaways: walkaways.length, reachable: rows.filter((r) => r.reachable).length, consented: consented.length,
      sent: rows.filter((r) => r.followup).length, recovered: recovered.length,
      via_accept: recovered.filter((r) => r.recovered_via === "accept").length, via_counter: recovered.filter((r) => r.recovered_via === "counter").length,
      of_walkaways: wilson(recovered.length, walkaways.length), of_consented: wilson(recovered.length, consented.length),
      of_sent: wilson(recovered.length, rows.filter((r) => r.followup).length),
      unreachable: walkaways.reduce<Record<string, number>>((a, r) => (r.unreachable ? { ...a, [r.unreachable]: (a[r.unreachable] ?? 0) + 1 } : a), {}),
      affordable_walkaways: walkaways.filter(affordable).length, affordable_recovered: recovered.filter(affordable).length,
      locked_unconfirmed_profit_per_buyer: bootMean(rows.map((r) => r.locked_deal?.profit_cents ?? 0), seed) },
    safety,
    tokens: { first_pass: summary.tokens, replies: tok },
    rows,
  };
}

// ---------------------------------------------------------------- probing check

/**
 * Paired probers, one fresh exchange each (worst case: no shared probe breaker). For each bid b:
 *   control: lowball rounds 1…cap−1, bid b on the last round, take whatever the seller offers.
 *   walk   : lowball every round, walk with consent, get the follow-up, COUNTER b, take whatever the seller offers.
 * Gain = control price − walk price. Walking away must not get the prober a better price than the same bid did.
 */
export async function runProbers(o: { run_id: string; strategy?: Strategy; per_product?: number; hold_at_cap?: boolean }): Promise<ProbeReport> {
  const K = o.per_product ?? 8;
  const rows: ProbeReport["rows"] = [];
  let belowFloor = 0;
  for (const p of SEED_PRODUCTS.filter((x) => x.product_id.startsWith("kb_"))) {
    const gap = p.list_price_cents - p.floor_price_cents;
    const low = Math.round((p.list_price_cents * 0.6) / 100) * 100; // far under the near-miss band: trips nothing
    for (let k = 0; k < K; k++) {
      // bids from 5% of the gap under the floor up to list
      const bid = Math.round((p.floor_price_cents - 0.05 * gap + (k / (K - 1)) * 1.05 * gap) / 100) * 100;
      const one = async (walk: boolean): Promise<{ price: number | null; prewalk: number }> => {
        const clock = { t: T0 };
        const out: OutboundMessage[] = [];
        const ex = new ExchangeGateway(o.strategy ?? "negotiating", null, { now: () => clock.t, send: async (m) => { out.push(m); },
          decide: o.hold_at_cap ? holdAtCap : undefined }).exchange;
        const ctx: BuyerContext = { run_id: o.run_id, buyer_id: `probe_${p.product_id}_${k}`, buyer_model: "scripted", channel: "harness", agent_operator: "harness" };
        let nid: string | undefined;
        let r: ExchangeResponse | null = null;
        for (let round = 1; round <= p.max_rounds; round++) {
          r = await ex.handle({ kind: "offer", ctx, product_id: p.product_id, negotiation_id: nid, offer_price_cents: !walk && round === p.max_rounds ? bid : low });
          nid = r.negotiation_id;
          if (r.deal) break;
        }
        const n = await ex.store.getNegotiation(nid!);
        const prewalk = Math.min(...n!.history.filter((h) => h.by === "seller").map((h) => h.price_cents));
        if (!walk) {
          if (r!.deal) return { price: r!.deal.unit_price_cents, prewalk };
          const a = await ex.handle({ kind: "accept", ctx, negotiation_id: nid!, offer_id: r!.standing_offer!.offer_id });
          return { price: a.deal?.unit_price_cents ?? null, prewalk };
        }
        await ex.handle({ kind: "walk", ctx, negotiation_id: nid!, reason: "probing", followup: consentOf(ctx.buyer_id) });
        clock.t += FOLLOWUP_DELAY_MS + 60_000;
        const [m] = await ex.outreach.runDue();
        if (!m) return { price: null, prewalk };
        const c = await ex.inbound(nid!, ctx.buyer_id, `COUNTER ${usd(bid)}`);
        if (c.deal) return { price: c.deal.unit_price_cents, prewalk };
        const id = c.standing_offer?.offer_id ?? m.offer.offer_id;
        const a = await ex.inbound(nid!, ctx.buyer_id, `ACCEPT ${id}`);
        return { price: a.deal?.unit_price_cents ?? null, prewalk };
      };
      const control = await one(false);
      const w = await one(true);
      for (const x of [control.price, w.price]) if (x !== null && x < p.floor_price_cents) belowFloor++;
      rows.push({ product_id: p.product_id, bid_cents: bid, control_cents: control.price, walk_cents: w.price, prewalk_cents: w.prewalk });
    }
  }
  const gains = rows.filter((r) => r.control_cents !== null && r.walk_cents !== null).map((r) => r.control_cents! - r.walk_cents!);
  return { probers: rows.length,
    paired_gain_cents: { mean: gains.length ? Math.round(gains.reduce((a, b) => a + b, 0) / gains.length) : 0, max: Math.max(0, ...gains), min: Math.min(0, ...gains) },
    walk_cheaper: gains.filter((g) => g > 0).length, below_floor: belowFloor, rows };
}
