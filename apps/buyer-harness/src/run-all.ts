/**
 * runAll(config): run a batch of simulated buyers through a gateway and score it (BUILD_PLAN E2 · H6–H8).
 * S2's eval runner calls this with policy "static" then "negotiating" and compares.
 * Events go to Supabase when SUPABASE_URL is set, and always to apps/buyer-harness/runs/<run_id>.events.jsonl.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { NegotiationEvent } from "@sa/shared";
import { brainFor } from "./agents/brains";
import { runBuyer, type BuyerOutcome, type Emit } from "./agents/buyer";
import type { LlmBuyerTask } from "./agents/personas";
import type { Gateway } from "./gateway/types";

export interface RunAllConfig {
  run_id: string;
  label: string; // e.g. "negotiating"
  buyers: LlmBuyerTask[];
  gateway: Gateway;
  concurrency?: number; // default 4
  max_steps?: number; // per buyer, default 30
  on_outcome?: (o: BuyerOutcome) => void;
}

export interface Summary {
  run_id: string;
  label: string;
  buyers: number;
  conversions: number;
  conversion_rate: number;
  safe_conversions: number; // closed, not below floor, not over the buyer's cap
  safe_conversion_rate: number;
  revenue_cents: number;
  profit_cents: number;
  profit_per_buyer_cents: number;
  avg_margin_pct: number;
  avg_offers: number;
  below_floor_deals: number;
  wallet_blocks: number;
  unfinished: number; // ran out of steps / errored
  errors: number;
  median_ms_to_first_offer: number | null;
  tokens: { input: number; output: number };
  by_persona: Record<string, { buyers: number; conversions: number; profit_cents: number }>;
  by_model: Record<string, { buyers: number; conversions: number; profit_cents: number }>;
}

export const RUNS_DIR = resolve(import.meta.dirname, "../runs");

/** Event sink: local JSONL always; Supabase too if configured (lazy import so no env is needed offline). */
export async function makeEmit(run_id: string): Promise<{ emit: Emit; flush: () => Promise<void> }> {
  mkdirSync(RUNS_DIR, { recursive: true });
  const file = resolve(RUNS_DIR, `${run_id}.events.jsonl`);
  const pending: Promise<void>[] = [];
  let log: ((e: NegotiationEvent) => Promise<void>) | null = null;
  if (process.env.SUPABASE_URL) log = (await import("@sa/shared/db")).logEvent;
  const emit: Emit = (e) => {
    appendFileSync(file, JSON.stringify({ ...e, ts: new Date().toISOString() }) + "\n");
    if (log) pending.push(log(e).catch((err) => console.error("[events]", err.message)));
  };
  return { emit, flush: async () => void (await Promise.all(pending)) };
}

export function summarize(run_id: string, label: string, os: BuyerOutcome[]): Summary {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const deals = os.filter((o) => o.closed);
  const safe = deals.filter((o) => o.below_floor !== true);
  const profit = sum(deals.map((o) => o.profit_cents ?? 0));
  const revenue = sum(deals.map((o) => o.price_cents ?? 0));
  const ttfo = os.map((o) => o.ms_to_first_offer).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const group = (key: (o: BuyerOutcome) => string) => {
    const g: Summary["by_persona"] = {};
    for (const o of os) {
      const k = key(o);
      g[k] ??= { buyers: 0, conversions: 0, profit_cents: 0 };
      g[k].buyers++;
      if (o.closed) { g[k].conversions++; g[k].profit_cents += o.profit_cents ?? 0; }
    }
    return g;
  };
  return {
    run_id, label, buyers: os.length, conversions: deals.length, conversion_rate: os.length ? deals.length / os.length : 0,
    safe_conversions: safe.length, safe_conversion_rate: os.length ? safe.length / os.length : 0,
    revenue_cents: revenue, profit_cents: profit, profit_per_buyer_cents: os.length ? Math.round(profit / os.length) : 0,
    avg_margin_pct: revenue ? (100 * profit) / revenue : 0,
    avg_offers: os.length ? sum(os.map((o) => o.offers_made)) / os.length : 0,
    below_floor_deals: deals.filter((o) => o.below_floor === true).length,
    wallet_blocks: sum(os.map((o) => o.wallet_blocks)),
    unfinished: os.filter((o) => o.ran_out_of_steps || o.error).length,
    errors: os.filter((o) => o.error).length,
    median_ms_to_first_offer: ttfo.length ? ttfo[Math.floor(ttfo.length / 2)] : null,
    tokens: { input: sum(os.map((o) => o.input_tokens)), output: sum(os.map((o) => o.output_tokens)) },
    by_persona: group((o) => (o.adversary ? `adversary:${o.adversary}` : o.persona)),
    by_model: group((o) => o.buyer_model),
  };
}

export async function runAll(cfg: RunAllConfig): Promise<{ summary: Summary; outcomes: BuyerOutcome[] }> {
  const { emit, flush } = await makeEmit(cfg.run_id);
  emit({ run_id: cfg.run_id, buyer_id: null, buyer_model: null, seller_id: null, product_id: null, negotiation_id: null,
    actor: "harness", type: "run_started", price_cents: null, payload: { label: cfg.label, policy: cfg.label, buyers: cfg.buyers.length, gateway: cfg.gateway.kind } });

  const outcomes: BuyerOutcome[] = new Array(cfg.buyers.length);
  let next = 0;
  const worker = async () => {
    while (next < cfg.buyers.length) {
      const i = next++;
      const t = cfg.buyers[i];
      outcomes[i] = await runBuyer(t, brainFor(t.buyer_model), cfg.gateway, cfg.run_id, emit, cfg.max_steps ?? 30, cfg.label);
      cfg.on_outcome?.(outcomes[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency ?? 4, cfg.buyers.length) }, worker));

  const summary = summarize(cfg.run_id, cfg.label, outcomes);
  emit({ run_id: cfg.run_id, buyer_id: null, buyer_model: null, seller_id: null, product_id: null, negotiation_id: null,
    actor: "harness", type: "run_finished", price_cents: null, payload: { summary } });
  await flush();
  return { summary, outcomes };
}
