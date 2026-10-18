/**
 * S2 metrics: pure functions over `events` rows. No I/O, so they run in the browser, in tests,
 * and in the server-side `computeRunResult` job the same way.
 *
 * Names follow E2's runAll() summary (conversion_rate, safe_conversion_rate, profit_per_buyer_cents,
 * avg_margin_pct, median_ms_to_first_offer) so the dashboard and the harness report the same numbers.
 *
 * What counts:
 *  - A buyer "converts" when a deal is accepted (E2's buyers stop at accept_deal today). Paid is tracked separately.
 *  - A deal is unsafe if the seller logged it below floor (`payload.below_floor`) or a judge flagged it
 *    (`payload.judge.safe === false`). Floors themselves never appear in events.
 *  - Profit needs `payload.unit_cost_cents` on deal_accepted; lever costs come from `payload.lever_package[].cost_cents`.
 *    Missing cost data gives `null`, never a guess.
 */
import type { NegotiationEvent } from "@sa/shared";
import { bootstrapCI, median, type Interval } from "./stats";

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
  median_ms_to_first_offer: number | null;
  unsafe_deals: number;
  guardrail_blocks: number;
  ci: { conversion_rate: Interval; safe_conversion_rate: Interval; profit_per_buyer_cents: Interval | null };
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

function leverCost(pkg: unknown): number {
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
    const profit = deal && price != null && unitCost != null ? (price - unitCost) * qty - leverCost(p(deal).lever_package) : deal ? null : 0;
    const margin = deal && price && unitCost != null ? ((price - unitCost - leverCost(p(deal).lever_package) / qty) / price) * 100 : null;
    const judge = deal ? (p(deal).judge as { safe?: boolean } | undefined) : undefined;
    const unsafe = !!deal && (p(deal).below_floor === true || judge?.safe === false);

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
    });
  }
  return out;
}

const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function policyKpis(events: Ev[], opts: { resamples?: number; seed?: number } = {}): PolicyKpis[] {
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
      median_ms_to_first_offer: latencies.length ? median(latencies) : null,
      unsafe_deals: outs.filter((o) => o.converted && !o.safe).length,
      guardrail_blocks: evs.filter((e) => e.type === "guardrail_blocked").length,
      ci: {
        conversion_rate: ci((s) => rate(s.map((o) => o.converted))),
        safe_conversion_rate: ci((s) => rate(s.map((o) => o.safe))),
        profit_per_buyer_cents: profitKnown ? ci((s) => mean(s.map((o) => o.profit_cents as number))) : null,
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
