/**
 * Which runs the dashboard compares. Live Supabase holds many runs (evals, ChatGPT traffic, sample data), so
 * KPIs must be computed over a chosen set, not everything at once. Default: the latest complete eval (both
 * policy arms of one `eval_<eval_id>_<policy>.<sig>` run, each with the buyers its run_started planned), preferring
 * proof-sized ones over smoke checks; `?eval=<eval_id>` pins one; with no complete eval, the latest run of each policy.
 */
import { useMemo, useState } from "react";
import type { NegotiationEvent } from "@sa/shared";
import { evalRunIds, isTestRun } from "../metrics/kpis";

export interface RunInfo {
  run_id: string; policy: string; started: string; buyers: number; events: number; eval: boolean;
  /** Buyers the harness planned (run_started payload.buyers), if it said. */
  planned: number | null;
  /** The eval both policy arms share: "b2dep_haiku100" for eval_b2dep_haiku100_static.<sig>. null for unsigned runs. */
  eval_id: string | null;
}

/** eval_<eval_id>_<policy>.<sig> → eval_id. */
export function evalIdOf(run_id: string, policy: string): string | null {
  if (!run_id.startsWith("eval_")) return null;
  const base = run_id.slice(5).replace(/\.[0-9a-f]+$/, "");
  return base.endsWith(`_${policy}`) ? base.slice(0, -policy.length - 1) : base;
}

export function listRuns(events: NegotiationEvent[]): RunInfo[] {
  const evals = evalRunIds(events);
  const m = new Map<string, { policy?: string; planned?: number; started?: string; buyers: Set<string>; events: number }>();
  for (const e of events) {
    const r = m.get(e.run_id) ?? m.set(e.run_id, { buyers: new Set(), events: 0 }).get(e.run_id)!;
    r.events++;
    if (e.buyer_id) r.buyers.add(e.buyer_id);
    const pl = e.payload as Record<string, unknown> | undefined;
    if (!r.policy && typeof pl?.policy === "string") r.policy = pl.policy;
    if (e.type === "run_started" && typeof pl?.buyers === "number") r.planned = pl.buyers;
    if (e.ts && (!r.started || e.ts < r.started)) r.started = e.ts;
  }
  return [...m.entries()]
    .map(([run_id, r]) => {
      const policy = r.policy ?? run_id;
      return { run_id, policy, started: r.started ?? "", buyers: r.buyers.size, events: r.events, eval: evals.has(run_id), planned: r.planned ?? null, eval_id: evalIdOf(run_id, policy) };
    })
    .sort((a, b) => b.started.localeCompare(a.started));
}

const usable = (r: RunInfo) => r.buyers > 0 && !isTestRun(r.run_id) && r.run_id !== "exchange_state";
/** Every buyer the harness planned showed up (90%, so one buyer erroring out doesn't drop the whole eval). */
const complete = (r: RunInfo) => r.eval && usable(r) && (r.planned == null || r.buyers >= 0.9 * r.planned);

/** Latest run per policy within `pool` (runs are sorted newest first). */
function latestPerPolicy(pool: RunInfo[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of pool) if (!seen.has(r.policy) && usable(r)) { seen.add(r.policy); out.push(r.run_id); }
  return out;
}

/** Smaller evals are smoke checks; the proof is ≥ 50 simulated buyers per policy (DONE.md, Stage 2). */
export const PROOF_BUYERS = 50;

/** The latest eval whose static and negotiating-side arms are both complete, preferring ones with ≥ PROOF_BUYERS
 *  buyers per arm; or `pin` (`?eval=<eval_id>`) if given and present. */
export function defaultSelection(runs: RunInfo[], pin: string | null = null): string[] {
  if (pin) {
    const pinned = latestPerPolicy(runs.filter((r) => r.eval_id === pin));
    if (pinned.length) return pinned;
  }
  const pairs: RunInfo[][] = [];
  for (const id of new Set(runs.filter((r) => r.eval_id && complete(r)).map((r) => r.eval_id))) {
    const arms = runs.filter((x) => x.eval_id === id && complete(x)); // newest first, like runs
    if (arms.some((x) => x.policy === "static") && arms.some((x) => x.policy !== "static")) pairs.push(arms);
  }
  const best = pairs.find((arms) => arms.every((x) => (x.planned ?? x.buyers) >= PROOF_BUYERS)) ?? pairs[0];
  if (best) return latestPerPolicy(best);
  // No complete eval: latest run of each policy. Once eval runs exist, only those (live traffic has its own panel).
  return latestPerPolicy(runs.some((r) => r.eval) ? runs.filter((r) => r.eval) : runs);
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
  const pin = useMemo(() => new URLSearchParams(location.search).get("eval"), []);
  const fallback = useMemo(() => defaultSelection(runs, pin), [runs, pin]);
  const selected = chosen ?? fallback;
  const filtered = useMemo(() => {
    const set = new Set(selected);
    return filterByModel(events.filter((e) => set.has(e.run_id)), model);
  }, [events, selected, model]);
  return { runs, selected, setSelected: setChosen, filtered, isDefault: chosen === null, models, model, setModel };
}
