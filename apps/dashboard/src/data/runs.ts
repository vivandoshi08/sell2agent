/**
 * Which runs the dashboard compares. Live Supabase holds many runs (evals, ChatGPT traffic, sample data), so
 * KPIs must be computed over a chosen set, not everything at once. Default: the latest run of each policy.
 */
import { useMemo, useState } from "react";
import type { NegotiationEvent } from "@sa/shared";
import { evalRunIds, isTestRun } from "../metrics/kpis";

export interface RunInfo { run_id: string; policy: string; started: string; buyers: number; events: number; eval: boolean }

export function listRuns(events: NegotiationEvent[]): RunInfo[] {
  const evals = evalRunIds(events);
  const m = new Map<string, { policy?: string; started?: string; buyers: Set<string>; events: number }>();
  for (const e of events) {
    const r = m.get(e.run_id) ?? m.set(e.run_id, { buyers: new Set(), events: 0 }).get(e.run_id)!;
    r.events++;
    if (e.buyer_id) r.buyers.add(e.buyer_id);
    const pol = (e.payload as Record<string, unknown> | undefined)?.policy;
    if (!r.policy && typeof pol === "string") r.policy = pol;
    if (e.ts && (!r.started || e.ts < r.started)) r.started = e.ts;
  }
  return [...m.entries()]
    .map(([run_id, r]) => ({ run_id, policy: r.policy ?? run_id, started: r.started ?? "", buyers: r.buyers.size, events: r.events, eval: evals.has(run_id) }))
    .sort((a, b) => b.started.localeCompare(a.started));
}

/** Latest run per policy (static vs negotiating side by side after an eval). Once eval runs exist, only those:
 *  live traffic has its own panel and isn't a policy arm. */
export function defaultSelection(runs: RunInfo[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const pool = runs.some((r) => r.eval) ? runs.filter((r) => r.eval) : runs;
  for (const r of pool) if (!seen.has(r.policy) && r.buyers > 0 && !isTestRun(r.run_id) && r.run_id !== "exchange_state") { seen.add(r.policy); out.push(r.run_id); }
  return out;
}

/** Buyer models present in the events (e.g. claude-sonnet-5-5, gpt-…, chatgpt), most events first. */
export function listModels(events: NegotiationEvent[]): string[] {
  const n = new Map<string, number>();
  for (const e of events) if (e.buyer_model && e.buyer_model !== "unknown") n.set(e.buyer_model, (n.get(e.buyer_model) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

/** Keep one buyer model's activity. Rows without a model (run_started, harness rows) stay, so runs still resolve. */
export function filterByModel(events: NegotiationEvent[], model: string | null): NegotiationEvent[] {
  if (!model) return events;
  const buyers = new Set(events.filter((e) => e.buyer_model === model && e.buyer_id).map((e) => `${e.run_id}\u0000${e.buyer_id}`));
  return events.filter((e) => !e.buyer_id ? true : buyers.has(`${e.run_id}\u0000${e.buyer_id}`));
}

/** UI hook: the run list, the selection (null = default), the buyer-model filter, and the events filtered to both. */
export function useRunSelection(events: NegotiationEvent[]) {
  const runs = useMemo(() => listRuns(events), [events]);
  const models = useMemo(() => listModels(events), [events]);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const selected = chosen ?? defaultSelection(runs);
  const filtered = useMemo(() => {
    const set = new Set(selected);
    return filterByModel(events.filter((e) => set.has(e.run_id)), model);
  }, [events, selected, model]);
  return { runs, selected, setSelected: setChosen, filtered, isDefault: chosen === null, models, model, setModel };
}
