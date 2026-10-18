/**
 * Bridge 3 "what the seller learned": the `learned` strategy against the fixed policies, by buyer type.
 * The exchange (branch b3-bandit) draws one arm per negotiation and logs it on every seller event:
 *   payload.policy "learned", arm, propensity, arm_probs, bandit_context, policy_version, learned_fallback?
 * E2's A/B runner (`pnpm e2:learned --id <id>`) runs the same buyers as `<id>_learned`, `<id>_negotiating`, `<id>_balanced`…
 * (or `eval_<id>_<policy>.<sig>`); this pairs the latest learned run with its siblings and scores them per buyer type.
 * Profit per buyer counts unit cost and perk costs (from deal_accepted, like kpis.ts); the floor is never read.
 */
import type { NegotiationEvent } from "@sa/shared";
import { buyerOutcomes, evalRunIds, isTestRun, isEvalRunId, runPolicies, type BuyerOutcome } from "./kpis";

type Ev = NegotiationEvent;
const p = (e: Ev) => (e.payload ?? {}) as Record<string, unknown>;

/** Display order for buyer types: the four the demo talks about first, then any other, unknown last. */
const CONTEXT_ORDER = ["price", "quality", "delivery", "trust", "warranty", "convenience"];
export const orderContexts = (cs: Iterable<string>) => [...new Set(cs)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
const rank = (c: string) => (c === "unknown" ? 99 : CONTEXT_ORDER.includes(c) ? CONTEXT_ORDER.indexOf(c) : 50);

export interface Cell { n: number; wins: number; win_rate: number; profit_per_buyer_cents: number | null }
export interface ArmPick { arm: string; n: number; share: number }
export interface LearnedRow { context: string; picks: ArmPick[]; cells: Record<string, Cell> }
export interface LearnedEval {
  /** The eval the runs share, e.g. "b3A" for b3A_learned / b3A_negotiating. */
  key: string;
  run_ids: string[];
  /** "learned" first, then the fixed policies in the eval. */
  policies: string[];
  rows: LearnedRow[];
  overall: Record<string, Cell>;
  /** Policy file version(s) the learned run used. */
  versions: number[];
  /** Learned negotiations that fell back to `negotiating` (no usable policy file). */
  fallbacks: number;
}

/** `b3A_learned` → `b3A`; `eval_b3A_learned.9f2c` → `b3A`. */
export function evalKey(run_id: string, policy: string): string {
  const base = run_id.replace(/^eval_/, "").replace(/\.[0-9a-f]+$/, "");
  return base.endsWith(`_${policy}`) ? base.slice(0, -policy.length - 1) : base;
}

export function cellOf(outs: BuyerOutcome[]): Cell {
  const wins = outs.filter((o) => o.converted).length;
  const profits = outs.map((o) => o.profit_cents);
  return { n: outs.length, wins, win_rate: outs.length ? wins / outs.length : 0,
    profit_per_buyer_cents: outs.length && profits.every((x) => x != null) ? (profits as number[]).reduce((a, b) => a + b, 0) / outs.length : null };
}

export function armPicks(outs: BuyerOutcome[]): ArmPick[] {
  const n = new Map<string, number>();
  for (const o of outs) if (o.arm) n.set(o.arm, (n.get(o.arm) ?? 0) + 1);
  const total = [...n.values()].reduce((a, b) => a + b, 0);
  return [...n].map(([arm, k]) => ({ arm, n: k, share: k / total })).sort((a, b) => b.n - a.n || a.arm.localeCompare(b.arm));
}

const policyOrder = (x: string) => (x === "learned" ? 0 : x === "negotiating" ? 1 : x === "balanced" ? 2 : x === "static" ? 9 : 5);

/** The latest learned eval and its sibling fixed-policy runs, scored per buyer type. null when no learned run is logged. */
export function learnedEval(events: Ev[]): LearnedEval | null {
  const evs = events.filter((e) => !isTestRun(e.run_id));
  const evals = evalRunIds(evs);
  const policies = runPolicies(evs);
  const started = new Map<string, string>();
  for (const e of evs) if (evals.has(e.run_id) && e.ts && (!started.has(e.run_id) || e.ts < started.get(e.run_id)!)) started.set(e.run_id, e.ts);
  const learnedRuns = [...evals].filter((r) => policies.get(r) === "learned").sort((a, b) => (started.get(b) ?? "").localeCompare(started.get(a) ?? ""));
  if (!learnedRuns.length) return null;
  const key = evalKey(learnedRuns[0], "learned");
  const runs = [...evals].filter((r) => evalKey(r, policies.get(r)!) === key);
  const inEval = new Set(runs);
  const mine = evs.filter((e) => inEval.has(e.run_id));
  const byPolicy = new Map<string, BuyerOutcome[]>();
  for (const r of runs) {
    const pol = policies.get(r)!;
    // the latest run per policy, if the eval id was reused
    if (byPolicy.has(pol)) continue;
    const latest = runs.filter((x) => policies.get(x) === pol).sort((a, b) => (started.get(b) ?? "").localeCompare(started.get(a) ?? ""))[0];
    byPolicy.set(pol, buyerOutcomes(mine.filter((e) => e.run_id === latest)));
  }
  const pols = [...byPolicy.keys()].sort((a, b) => policyOrder(a) - policyOrder(b) || a.localeCompare(b));
  const contexts = orderContexts(pols.flatMap((pol) => byPolicy.get(pol)!.map((o) => o.context)));
  const rows = contexts.map((context) => ({
    context,
    picks: armPicks((byPolicy.get("learned") ?? []).filter((o) => o.context === context)),
    cells: Object.fromEntries(pols.map((pol) => [pol, cellOf(byPolicy.get(pol)!.filter((o) => o.context === context))])),
  }));
  const learnedEvs = mine.filter((e) => policies.get(e.run_id) === "learned");
  const versions = [...new Set(learnedEvs.map((e) => p(e).policy_version).filter((v): v is number => typeof v === "number"))].sort((a, b) => a - b);
  const fallbacks = new Set(learnedEvs.filter((e) => p(e).learned_fallback != null).map((e) => e.negotiation_id ?? `${e.run_id}|${e.buyer_id}`)).size;
  return {
    key, run_ids: pols.map((pol) => runs.filter((r) => policies.get(r) === pol).sort((a, b) => (started.get(b) ?? "").localeCompare(started.get(a) ?? ""))[0]),
    policies: pols, rows, overall: Object.fromEntries(pols.map((pol) => [pol, cellOf(byPolicy.get(pol)!)])), versions, fallbacks,
  };
}

/** Real shoppers on the gateway when a product runs the `learned` strategy: which arm the seller drew, per buyer type. */
export function liveArmPicks(events: Ev[]): { context: string; picks: ArmPick[] }[] {
  const evals = evalRunIds(events);
  const live = events.filter((e) => !evals.has(e.run_id) && !isEvalRunId(e.run_id) && !isTestRun(e.run_id) && !e.run_id.startsWith("s2-fake-") && e.run_id !== "exchange_state");
  const drawn = new Map<string, { context: string; arm: string }>();
  for (const e of live) {
    const pl = p(e);
    if (e.actor !== "seller" || typeof pl.arm !== "string" || !e.negotiation_id || drawn.has(e.negotiation_id)) continue;
    drawn.set(e.negotiation_id, { context: typeof pl.bandit_context === "string" ? pl.bandit_context : "unknown", arm: pl.arm });
  }
  const by = new Map<string, Map<string, number>>();
  for (const { context, arm } of drawn.values()) { const m = by.get(context) ?? by.set(context, new Map()).get(context)!; m.set(arm, (m.get(arm) ?? 0) + 1); }
  return orderContexts(by.keys()).map((context) => {
    const m = by.get(context)!, total = [...m.values()].reduce((a, b) => a + b, 0);
    return { context, picks: [...m].map(([arm, n]) => ({ arm, n, share: n / total })).sort((a, b) => b.n - a.n) };
  });
}
