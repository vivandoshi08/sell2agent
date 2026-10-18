/**
 * Which runs the dashboard compares. Live Supabase holds many runs (evals, ChatGPT traffic, sample data), so
 * KPIs must be computed over a chosen set, not everything at once. Default: the latest run of each policy.
 */
import { useMemo, useState } from "react";
import type { NegotiationEvent } from "@sa/shared";

export interface RunInfo { run_id: string; policy: string; started: string; buyers: number; events: number }

export function listRuns(events: NegotiationEvent[]): RunInfo[] {
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
    .map(([run_id, r]) => ({ run_id, policy: r.policy ?? run_id, started: r.started ?? "", buyers: r.buyers.size, events: r.events }))
    .sort((a, b) => b.started.localeCompare(a.started));
}

/** Latest run per policy (static vs negotiating side by side after an eval). */
export function defaultSelection(runs: RunInfo[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of runs) if (!seen.has(r.policy) && r.buyers > 0) { seen.add(r.policy); out.push(r.run_id); }
  return out;
}

/** UI hook: the run list, the selection (null = default), and the events filtered to it. */
export function useRunSelection(events: NegotiationEvent[]) {
  const runs = useMemo(() => listRuns(events), [events]);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const selected = chosen ?? defaultSelection(runs);
  const filtered = useMemo(() => {
    const set = new Set(selected);
    return events.filter((e) => set.has(e.run_id));
  }, [events, selected]);
  return { runs, selected, setSelected: setChosen, filtered, isDefault: chosen === null };
}
