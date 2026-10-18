/**
 * Compute (and optionally store) the RunResult for a finished run. Server-side: needs the service-role key,
 * because unit costs live in seller_policies and never in events.
 *
 *   pnpm --filter @sa/dashboard run-result <run_id> [<run_id> ...]          # print
 *   pnpm --filter @sa/dashboard run-result <run_id> --write                  # also write runs.result + judged events
 */
import { createClient } from "@supabase/supabase-js";
import { EventType, NegotiationEvent } from "@sa/shared";
import { computeRunResult } from "../src/server/run-result";
import { supabaseCosts } from "../src/server/costs";

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const args = process.argv.slice(2);
const write = args.includes("--write");
const runIds = args.filter((a) => !a.startsWith("--"));
if (!url || !key || runIds.length === 0) {
  console.error("Usage: run-result <run_id> [...] [--write]   (needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the repo-root .env)");
  process.exit(1);
}
const db = createClient(url, key);

async function loadEvents(run_id: string): Promise<NegotiationEvent[]> {
  const out: NegotiationEvent[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("events").select("*").eq("run_id", run_id).order("ts").range(from, from + 999);
    if (error) throw new Error(`events: ${error.message}`);
    out.push(...(data as NegotiationEvent[]));
    if (!data || data.length < 1000) return out;
  }
}

const costs = await supabaseCosts(db);
const canLogJudged = (EventType.options as readonly string[]).includes("judged");

for (const run_id of runIds) {
  const events = await loadEvents(run_id);
  if (!events.length) { console.log(`${run_id}: no events`); continue; }
  const { data: runRow } = await db.from("runs").select("label").eq("id", run_id).maybeSingle();
  const { result, judgements, missing_cost_deals } = await computeRunResult(run_id, events, costs, { label: runRow?.label });
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  console.log(`\n${run_id} (${result.label}): ${result.buyers} buyers`);
  console.log(`  conversion ${(result.conversion_rate * 100).toFixed(0)}%  safe ${(result.safe_conversion_rate * 100).toFixed(0)}%  revenue ${usd(result.revenue_cents)}  profit ${usd(result.profit_cents)} (${usd(result.buyers ? result.profit_cents / result.buyers : 0)}/buyer)  margin ${result.avg_margin_pct.toFixed(1)}%  rounds ${result.avg_rounds.toFixed(1)}`);
  const unsafe = judgements.filter((j) => !j.safe);
  for (const j of unsafe) console.log(`  unsafe ${j.negotiation_id}: ${j.findings.map((f) => `${f.rule} (${f.detail})`).join("; ")}`);
  if (missing_cost_deals.length) console.log(`  no unit cost for ${missing_cost_deals.length} deal(s); their profit is left out`);

  if (!write) continue;
  const upd = await db.from("runs").update({ result, finished_at: new Date().toISOString() }).eq("id", run_id).select("id");
  if (upd.error) throw new Error(`runs: ${upd.error.message}`);
  if (!upd.data?.length) {
    const ins = await db.from("runs").insert({ id: run_id, label: result.label, seller_strategy: result.label, config: {}, result });
    if (ins.error) throw new Error(`runs insert: ${ins.error.message}`);
  }
  if (canLogJudged) {
    const rows = judgements.map((j) => NegotiationEvent.parse({ run_id, buyer_id: j.buyer_id, buyer_model: null, seller_id: null, product_id: null,
      negotiation_id: j.negotiation_id, actor: "harness", type: "judged", price_cents: null, payload: { safe: j.safe, findings: j.findings } }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("events").insert(rows.slice(i, i + 500));
      if (error) throw new Error(`judged events: ${error.message}`);
    }
  }
  console.log(`  wrote runs.result${canLogJudged ? ` and ${judgements.length} judged events` : " (judged events wait for contract v2)"}`);
}
