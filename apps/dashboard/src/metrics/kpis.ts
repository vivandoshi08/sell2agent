/**
 * S2 metrics: pure functions over `events` rows. No I/O, so they run in the browser, in tests,
 * and in the server-side `computeRunResult` job the same way.
 *
 * Names follow E2's runAll() summary (conversion_rate, safe_conversion_rate, profit_per_buyer_cents,
 * avg_margin_pct, median_ms_to_first_offer) so the dashboard and the harness report the same numbers.
 *
 * What counts:
 *  - A buyer "converts" when a deal is accepted (E2's buyers stop at accept_deal today). Paid is tracked separately.
 *  - A deal is unsafe if the seller logged it below floor (`payload.below_floor`), or a judge flagged it: a `judged`
 *    event (contract v2) with `payload.safe === false`, or `payload.judge.safe === false` on deal_accepted.
 *    Floors themselves never appear in events.
 *  - Profit needs `payload.unit_cost_cents` on deal_accepted. Lever costs: `payload.lever_cost_cents` (contract v2's
 *    deals column) if present, else the sum of `payload.lever_package[].cost_cents`.
 *    Missing cost data gives `null`, never a guess.
 */
import type { NegotiationEvent } from "@sa/shared";
import { bootstrapCI, median, type Interval } from "./stats";
import { buyerFit, leverIds, leverWins, type LeverWin } from "./levers";
// Pure (types only): the bandit's buyer-type rule, so the dashboard groups buyers exactly as the seller does.
import { contextOf } from "../../../seller-mcp/src/sellers/bandit";

export type Ev = NegotiationEvent;

export interface BuyerOutcome {
  buyer_id: string;
  persona: string;
  model: string;
  converted: boolean;
  paid: boolean;
  safe: boolean;
  revenue_cents: number;
  profit_cents: number | null;
  margin_pct: number | null;
  ms_to_first_offer: number | null;
  /** 0–1: how much of what this buyer values the deal delivered (see levers.ts). null if not scorable. */
  buyer_fit: number | null;
  /** Lever ids included in the closed deal ([] = price only). */
  levers: string[];
  /** Bandit buyer type (the lever the buyer weighs most: price, quality, delivery, trust…): the seller's logged
   *  `bandit_context`, else derived from the buyer's lever profile like the bandit does. "unknown" without a profile. */
  context: string;
  /** `learned` strategy: the arm the seller drew for this buyer (negotiating | balanced | lever_policy). null otherwise. */
  arm: string | null;
}

export interface PolicyKpis {
  policy: string;
  run_ids: string[];
  buyers: number;
  conversion_rate: number;
  safe_conversion_rate: number;
  paid_rate: number;
  profit_per_buyer_cents: number | null;
  avg_margin_pct: number | null;
  avg_buyer_fit: number | null;
  median_ms_to_first_offer: number | null;
  unsafe_deals: number;
  guardrail_blocks: number;
  ci: { conversion_rate: Interval; safe_conversion_rate: Interval; profit_per_buyer_cents: Interval | null; buyer_fit: Interval | null };
  outcomes: BuyerOutcome[];
}

const p = (e: Ev) => (e.payload ?? {}) as Record<string, unknown>;
const ts = (e: Ev) => (e.ts ? Date.parse(e.ts) : NaN);

/** run_id → policy, read from the harness's run_started event (payload.policy), falling back to the run_id. */
export function runPolicies(events: Ev[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of events) if (e.type === "run_started" && typeof p(e).policy === "string") m.set(e.run_id, p(e).policy as string);
  for (const e of events) if (!m.has(e.run_id)) m.set(e.run_id, e.run_id);
  return m;
}

function leverCost(payload: Record<string, unknown>): number {
  if (typeof payload.lever_cost_cents === "number") return payload.lever_cost_cents;
  const pkg = payload.lever_package;
  if (!Array.isArray(pkg)) return 0;
  return pkg.reduce((s, l) => s + (typeof l?.cost_cents === "number" ? l.cost_cents : 0), 0);
}

export function buyerOutcomes(events: Ev[]): BuyerOutcome[] {
  const byBuyer = new Map<string, Ev[]>();
  for (const e of events) {
    if (!e.buyer_id) continue;
    const k = `${e.run_id}\u0000${e.buyer_id}`;
    (byBuyer.get(k) ?? byBuyer.set(k, []).get(k)!).push(e);
  }
  const out: BuyerOutcome[] = [];
  for (const evs of byBuyer.values()) {
    evs.sort((a, b) => ts(a) - ts(b));
    const start = evs.find((e) => e.type === "run_started");
    const deal = evs.find((e) => e.type === "deal_accepted");
    const paid = evs.some((e) => e.type === "payment_succeeded");
    const qty = typeof p(deal ?? ({} as Ev)).quantity === "number" ? (p(deal!).quantity as number) : 1;
    const price = deal?.price_cents ?? null;
    const unitCost = deal && typeof p(deal).unit_cost_cents === "number" ? (p(deal).unit_cost_cents as number) : null;
    const revenue = deal && price != null ? price * qty : 0;
    const profit = deal && price != null && unitCost != null ? (price - unitCost) * qty - leverCost(p(deal)) : deal ? null : 0;
    const margin = deal && price && unitCost != null ? ((price - unitCost - leverCost(p(deal)) / qty) / price) * 100 : null;
    const judge = deal ? (p(deal).judge as { safe?: boolean } | undefined) : undefined;
    const judgedUnsafe = evs.some((e) => e.type === ("judged" as Ev["type"]) && p(e).safe === false);
    const unsafe = !!deal && (p(deal).below_floor === true || judge?.safe === false || judgedUnsafe);

    const profileEv = evs.find((e) => p(e).lever_profile && typeof p(e).lever_profile === "object");
    const levers = deal ? leverIds(p(deal).lever_package) : [];
    const listCents = deal && typeof p(deal).list_price_cents === "number" ? (p(deal).list_price_cents as number) : null;
    const fit = deal ? buyerFit(profileEv ? (p(profileEv).lever_profile as Record<string, number>) : undefined, levers, listCents, price) : null;

    const drawn = evs.find((e) => e.actor === "seller" && typeof p(e).arm === "string");
    const context = drawn && typeof p(drawn).bandit_context === "string" ? (p(drawn).bandit_context as string)
      : contextOf(profileEv ? (p(profileEv).lever_profile as Record<string, number>) : undefined);

    const firstAsk = evs.find((e) => e.type === "offer_made");
    const firstReply = firstAsk && evs.find((e) => e.actor === "seller" && e.price_cents != null && ts(e) >= ts(firstAsk));
    out.push({
      buyer_id: evs[0].buyer_id!,
      persona: String(p(start ?? evs[0]).buyer_persona ?? "unknown"),
      model: evs.find((e) => e.buyer_model)?.buyer_model ?? "unknown",
      converted: !!deal,
      paid,
      safe: !!deal && !unsafe,
      revenue_cents: revenue,
      profit_cents: profit,
      margin_pct: margin,
      ms_to_first_offer: firstAsk && firstReply ? ts(firstReply) - ts(firstAsk) : null,
      buyer_fit: fit,
      levers,
      context,
      arm: drawn ? (p(drawn).arm as string) : null,
    });
  }
  return out;
}

const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Teammates' test traffic (S1's gateway tests and unsigned/verify checks, S2's console check, …): never counted anywhere. */
export const isTestRun = (run_id: string) => /^(s1|s2|e1|e2)-(test|unsigned)/.test(run_id) || run_id.startsWith("s2-console") || run_id.startsWith("verify_");
/** Signed eval runs (`eval_<eval_id>_<policy>.<sig>`) are never real shoppers, even the smoke tests that never log a run_started. */
export const isEvalRunId = (run_id: string) => run_id.startsWith("eval_");
const isState = (e: Ev) => e.run_id === "exchange_state" || (e.type as string) === "exchange_snapshot";

/** Runs started by the eval harness (they log run_started with a policy). Everything else is real traffic. */
export function evalRunIds(events: Ev[]): Set<string> {
  return new Set(events.filter((e) => e.type === "run_started" && typeof p(e).policy === "string").map((e) => e.run_id));
}

export function policyKpis(all: Ev[], opts: { resamples?: number; seed?: number } = {}): PolicyKpis[] {
  // E1's exchange snapshots live in `events` too; they are state, not buyer activity. Test runs aren't buyers.
  // When eval runs are present, only they are compared: live traffic (e.g. ChatGPT users) has no policy arm.
  const activity = all.filter((e) => !isState(e) && !isTestRun(e.run_id));
  const evals = evalRunIds(activity);
  const events = evals.size ? activity.filter((e) => evals.has(e.run_id)) : activity;
  const policies = runPolicies(events);
  const groups = new Map<string, Ev[]>();
  for (const e of events) {
    const pol = policies.get(e.run_id)!;
    (groups.get(pol) ?? groups.set(pol, []).get(pol)!).push(e);
  }
  const result: PolicyKpis[] = [];
  for (const [policy, evs] of groups) {
    const outs = buyerOutcomes(evs);
    if (!outs.length) continue;
    const profits = outs.map((o) => o.profit_cents);
    const profitKnown = profits.every((x) => x != null);
    const margins = outs.map((o) => o.margin_pct).filter((x): x is number => x != null);
    const latencies = outs.map((o) => o.ms_to_first_offer).filter((x): x is number => x != null);
    const fits = outs.filter((o) => o.buyer_fit != null);
    const ci = (f: (o: BuyerOutcome[]) => number) => bootstrapCI(outs, f, opts);
    result.push({
      policy,
      run_ids: [...new Set(evs.map((e) => e.run_id))],
      buyers: outs.length,
      conversion_rate: rate(outs.map((o) => o.converted)),
      safe_conversion_rate: rate(outs.map((o) => o.safe)),
      paid_rate: rate(outs.map((o) => o.paid)),
      profit_per_buyer_cents: profitKnown ? mean(profits as number[]) : null,
      avg_margin_pct: margins.length ? mean(margins) : null,
      avg_buyer_fit: fits.length ? mean(fits.map((o) => o.buyer_fit as number)) : null,
      median_ms_to_first_offer: latencies.length ? median(latencies) : null,
      unsafe_deals: outs.filter((o) => o.converted && !o.safe).length,
      guardrail_blocks: evs.filter((e) => e.type === "guardrail_blocked").length,
      ci: {
        conversion_rate: ci((s) => rate(s.map((o) => o.converted))),
        safe_conversion_rate: ci((s) => rate(s.map((o) => o.safe))),
        profit_per_buyer_cents: profitKnown ? ci((s) => mean(s.map((o) => o.profit_cents as number))) : null,
        buyer_fit: fits.length ? bootstrapCI(fits, (s) => mean(s.map((o) => o.buyer_fit as number)), opts) : null,
      },
      outcomes: outs,
    });
  }
  // Baseline first, so charts always read static → negotiating.
  const order = (x: string) => (x === "static" ? 0 : x === "negotiating" ? 1 : 2);
  return result.sort((a, b) => order(a.policy) - order(b.policy) || a.policy.localeCompare(b.policy));
}

/** Conversion by persona × policy, for the "who buys under which policy" grid. */
export function personaGrid(kpis: PolicyKpis[]) {
  const personas = [...new Set(kpis.flatMap((k) => k.outcomes.map((o) => o.persona)))].sort();
  return personas.map((persona) => ({
    persona,
    cells: kpis.map((k) => {
      const os = k.outcomes.filter((o) => o.persona === persona);
      return { policy: k.policy, n: os.length, conversion_rate: rate(os.map((o) => o.converted)) };
    }),
  }));
}

/** "Which levers win, by buyer type": closed deals' lever packages per persona and policy. */
export function leverWinsByPersona(kpis: PolicyKpis[]): LeverWin[] {
  return leverWins(kpis.flatMap((k) => k.outcomes.map((o) => ({ persona: o.persona, policy: k.policy, converted: o.converted, levers: o.levers }))));
}

/** Real buyers on the deployed gateway (no eval run_started, no `eval_` run_id, minus tests): what actually happened. */
export interface LiveTraffic {
  run_ids: string[];
  negotiations: number;
  deals: number;
  paid: number;
  payment_failures: number;
  revenue_cents: number;
  /** Mean discount off list over deals, 0..1. */
  avg_discount: number | null;
  below_floor: number;
  blocks: { rule: string; n: number }[];
  models: string[];
  last_ts: string | null;
  recent_deals: { ts: string; product_id: string | null; product_title: string | null; price_cents: number; list_price_cents: number | null; paid: boolean }[];
}

/** `includeTests` (the dashboard's `?tests`) keeps teammates' test runs, for checking the live pipe; eval runs never count. */
export function liveTraffic(all: Ev[], opts: { includeTests?: boolean } = {}): LiveTraffic {
  const evals = evalRunIds(all);
  const evs = all.filter((e) => !isState(e) && (opts.includeTests || !isTestRun(e.run_id)) && !evals.has(e.run_id) && !isEvalRunId(e.run_id) && !e.run_id.startsWith("s2-fake-"));
  const deals = evs.filter((e) => e.type === "deal_accepted");
  const paidIds = new Set(evs.filter((e) => e.type === "payment_succeeded").map((e) => p(e).deal_id as string));
  const discounts = deals.map((e) => { const list = p(e).list_price_cents; return typeof list === "number" && e.price_cents != null && list > 0 ? 1 - e.price_cents / list : null; })
    .filter((x): x is number => x != null);
  const blocks = new Map<string, number>();
  for (const e of evs) if (e.type === "guardrail_blocked") { const r = String(p(e).rule ?? "other"); blocks.set(r, (blocks.get(r) ?? 0) + 1); }
  const paidDeals = deals.filter((d) => paidIds.has(p(d).deal_id as string));
  return {
    run_ids: [...new Set(evs.map((e) => e.run_id))],
    negotiations: new Set(evs.map((e) => e.negotiation_id).filter(Boolean)).size,
    deals: deals.length,
    paid: paidDeals.length,
    payment_failures: evs.filter((e) => e.type === "payment_failed").length,
    revenue_cents: paidDeals.reduce((s, d) => s + Number(p(d).total_cents ?? d.price_cents ?? 0), 0),
    avg_discount: discounts.length ? mean(discounts) : null,
    below_floor: deals.filter((d) => p(d).below_floor === true).length,
    blocks: [...blocks].map(([rule, n]) => ({ rule, n })).sort((a, b) => b.n - a.n),
    models: [...new Set(evs.map((e) => e.buyer_model).filter((m): m is string => !!m))],
    last_ts: evs.length ? evs.map((e) => e.ts ?? "").sort().at(-1) || null : null,
    recent_deals: deals.slice(-8).reverse().map((d) => ({ ts: d.ts ?? "", product_id: d.product_id, product_title: typeof p(d).product_title === "string" ? (p(d).product_title as string) : null, price_cents: d.price_cents ?? 0,
      list_price_cents: typeof p(d).list_price_cents === "number" ? (p(d).list_price_cents as number) : null, paid: paidIds.has(p(d).deal_id as string) })),
  };
}
