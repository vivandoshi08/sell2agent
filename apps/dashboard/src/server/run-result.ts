/**
 * S2 · computeRunResult: turns a finished run's events into the contract's RunResult (written to runs.result).
 * Server-side only. It joins the private costs (unit cost from seller_policies, lever costs from E1) that are
 * deliberately kept out of `events`, judges every negotiation, then reuses the dashboard's own metric code, so
 * the numbers on screen and in runs.result can't drift apart.
 */
import { RunResult, type NegotiationEvent } from "@sa/shared";
import { policyKpis } from "../metrics/kpis";
import { judgeRun, type JudgeLlm, type Judgement } from "./judge";

export interface CostSource {
  unitCost(product_id: string): Promise<number | null>;
  /** Per-unit seller cost of a lever package (E1's leverCost). */
  leverCost(product_id: string, levers: string[]): Promise<number>;
}

export interface RunReport {
  result: RunResult;
  judgements: Judgement[];
  /** Deals whose unit cost couldn't be found; their profit is left out of profit_cents. */
  missing_cost_deals: string[];
}

const p = (e: NegotiationEvent) => (e.payload ?? {}) as Record<string, unknown>;
const leverIds = (pkg: unknown): string[] =>
  Array.isArray(pkg) ? pkg.map((x) => (typeof x === "string" ? x : String((x as { id?: string; lever?: string }).id ?? (x as { lever?: string }).lever))) : [];

export async function computeRunResult(run_id: string, all: NegotiationEvent[], costs: CostSource, opts: { label?: string; llm?: JudgeLlm } = {}): Promise<RunReport> {
  const events = all.filter((e) => e.run_id === run_id);
  const judgements = await judgeRun(events, { llm: opts.llm });
  const missing: string[] = [];

  // Enrich in memory only. Nothing private is written back to events.
  const enriched: NegotiationEvent[] = [];
  for (const e of events) {
    if (e.type !== "deal_accepted" || !e.product_id) { enriched.push(e); continue; }
    const qty = typeof p(e).quantity === "number" ? (p(e).quantity as number) : 1;
    const unit = await costs.unitCost(e.product_id);
    if (unit == null) missing.push(String(p(e).deal_id ?? e.negotiation_id));
    const lever = (await costs.leverCost(e.product_id, leverIds(p(e).lever_package))) * qty;
    enriched.push({ ...e, payload: { ...p(e), ...(unit != null ? { unit_cost_cents: unit } : {}), lever_cost_cents: lever } });
  }
  for (const j of judgements) {
    if (!j.safe) enriched.push({ run_id, buyer_id: j.buyer_id, buyer_model: null, seller_id: null, product_id: null, negotiation_id: j.negotiation_id,
      actor: "harness", type: "judged" as NegotiationEvent["type"], price_cents: null, payload: { safe: false, findings: j.findings } });
  }

  const [k] = policyKpis(enriched, { resamples: 200 });
  const outs = k?.outcomes ?? [];
  const rounds = new Map<string, number>();
  for (const e of events) if (e.type === "offer_made" && e.negotiation_id) rounds.set(e.negotiation_id, (rounds.get(e.negotiation_id) ?? 0) + 1);
  const margins = outs.map((o) => o.margin_pct).filter((x): x is number => x != null);

  const result = RunResult.parse({
    run_id,
    label: opts.label ?? k?.policy ?? run_id,
    buyers: outs.length,
    conversions: outs.filter((o) => o.converted).length,
    conversion_rate: k?.conversion_rate ?? 0,
    safe_conversions: outs.filter((o) => o.safe).length,
    safe_conversion_rate: k?.safe_conversion_rate ?? 0,
    revenue_cents: outs.reduce((s, o) => s + o.revenue_cents, 0),
    profit_cents: Math.round(outs.reduce((s, o) => s + (o.profit_cents ?? 0), 0)),
    avg_margin_pct: margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : 0,
    avg_rounds: rounds.size ? [...rounds.values()].reduce((a, b) => a + b, 0) / rounds.size : 0,
  });
  return { result, judgements, missing_cost_deals: missing };
}
