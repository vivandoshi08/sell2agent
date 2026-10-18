/**
 * S2 eval runner: the same simulated buyers against each seller policy, scored with S2's metrics.
 *
 *   pnpm --filter @sa/dashboard eval                                   # 20 buyers, static vs negotiating, through E1's real exchange (in-process)
 *   pnpm --filter @sa/dashboard eval --stand-in                        # E2's simpler stand-in instead (no E1 guardrails)
 *   pnpm --filter @sa/dashboard eval --n 200 --models claude,gpt       # real LLM buyers (needs API keys)
 *   pnpm --filter @sa/dashboard eval --policies static,negotiating,balanced --gateway https://<deployed>/mcp
 *   pnpm --filter @sa/dashboard eval --models claude --seller-voice         # Claude writes the seller messages too
 *   pnpm --filter @sa/dashboard eval --rescore eval_claude_20                # re-score a saved run (no model calls)
 *
 * Runs E2's runAll() per policy, then for each run: safety judge + private cost join → RunResult and KPIs with
 * 95% intervals. Always writes the events for the dashboard's local mode (public/runs/), and with Supabase keys
 * also stores runs.result (events already stream there from runAll).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { NegotiationEvent } from "@sa/shared";
import { ExchangeGateway, LocalGateway, McpGateway, makeBuyers, runAll, type BuyerModel, type Gateway } from "@sa/buyer-harness";
import { defaultLlm } from "@sa/seller-mcp/sellers";
import { signEvalRun } from "@sa/seller-mcp/exchange";
import { policyKpis } from "../src/metrics/kpis";
import { computeRunResult } from "../src/server/run-result";
import { catalogCosts, supabaseCosts } from "../src/server/costs";

const { values: f } = parseArgs({ options: {
  n: { type: "string", default: "20" }, models: { type: "string", default: "scripted" }, seed: { type: "string", default: "42" },
  policies: { type: "string", default: "static,negotiating" }, concurrency: { type: "string", default: "4" },
  adversarial: { type: "string", default: "0.1" }, gateway: { type: "string" }, id: { type: "string" },
  "seller-voice": { type: "boolean" }, rescore: { type: "string" }, "stand-in": { type: "boolean" },
} });

const models = f.models!.split(",") as BuyerModel[];
const policies = f.policies!.split(",") as ("static" | "negotiating" | "balanced")[];
const gatewayUrl = f.gateway ?? process.env.GATEWAY_URL;
const evalId = f.rescore ?? f.id ?? `eval_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
const buyers = makeBuyers({ n: Number(f.n), models, seed: Number(f.seed), adversarial_share: Number(f.adversarial) });
const db = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY) : null;
let costs = catalogCosts();
if (db) {
  try { costs = await supabaseCosts(db); }
  catch (e) { console.warn(`  Supabase unreachable (${(e as Error).message}); using the exchange catalog for costs.`); }
}
const sellerLlm = f["seller-voice"] ? defaultLlm() : null;
if (f["seller-voice"] && !sellerLlm) throw new Error("--seller-voice needs ANTHROPIC_API_KEY");
const harnessRuns = resolve(import.meta.dirname, "../../buyer-harness/runs");
const outDir = resolve(import.meta.dirname, "../public/runs");
mkdirSync(outDir, { recursive: true });

/** Every `events` row of one run, oldest first (paged; a 100-buyer run is ~1.5k rows). */
async function runEvents(db: SupabaseClient, run_id: string): Promise<NegotiationEvent[]> {
  await new Promise((r) => setTimeout(r, 3000)); // the gateway's last writes can trail its last response
  const out: NegotiationEvent[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("events").select("*").eq("run_id", run_id).order("ts").order("id").range(from, from + 999);
    if (error) throw new Error(`events for ${run_id}: ${error.message}`);
    out.push(...(data as NegotiationEvent[]));
    if (data.length < 1000) return out;
  }
}

if (f.rescore) console.log(`\nRe-scoring ${evalId} (no model calls)\n`);
else console.log(`\n${evalId}: ${buyers.length} buyers · ${models.join(", ")} · ${gatewayUrl ?? (f["stand-in"] ? "E2 stand-in" : "E1 exchange (in-process)")} · ${policies.join(" vs ")}${sellerLlm ? " · Claude seller voice" : ""}${db ? " · Supabase on" : ""}\n`);

// --rescore: read the harness's raw jsonl if it's here, else a saved run (public/runs/<id>.events.json, e.g. a teammate's).
const saved = f.rescore && existsSync(resolve(outDir, `${evalId}.events.json`))
  ? (JSON.parse(readFileSync(resolve(outDir, `${evalId}.events.json`), "utf8")) as NegotiationEvent[]) : [];
const allEvents: NegotiationEvent[] = [];
const results = [];
for (const policy of policies) {
  // E1: through a deployed gateway, a signed run_id gets its own buyer memory/limits/breaker and lets `strategy` apply
  const run_id = gatewayUrl ? signEvalRun(`${evalId}_${policy}`) : `${evalId}_${policy}`;
  if (!f.rescore) {
    // Default: E1's real exchange in-process (real guardrails, offer ids, deal locks). --stand-in: E2's simpler mock.
    const gw: Gateway = gatewayUrl ? new McpGateway(gatewayUrl, policy as "static" | "negotiating" | "balanced") : f["stand-in"] ? new LocalGateway(policy, sellerLlm) : new ExchangeGateway(policy, sellerLlm);
    let done = 0;
    await runAll({ run_id, label: policy, buyers, gateway: gw, concurrency: Number(f.concurrency),
      on_outcome: () => { done++; if (done % 10 === 0 || done === buyers.length) process.stdout.write(`  ${policy}: ${done}/${buyers.length}\r`); } });
    await gw.close?.();
    process.stdout.write("\n");
  }
  const file = resolve(harnessRuns, `${run_id}.events.jsonl`);
  // E1: through a deployed gateway the exchange logs the offers and deals server-side (McpGateway.sellerEventsLogged),
  // so the local jsonl has none of them. Score from Supabase, which holds the harness's rows and the exchange's.
  if (gatewayUrl && !db && !f.rescore) console.warn(`  ${policy}: --gateway without Supabase keys can't see the seller's events; this run will score 0 deals`);
  const events: NegotiationEvent[] = gatewayUrl && db && !f.rescore ? await runEvents(db, run_id)
    : existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : saved.filter((e) => e.run_id === run_id && (e.type as string) !== "judged"); // drop old verdicts; the judge re-runs below
  const report = await computeRunResult(run_id, events, costs, { label: policy });
  allEvents.push(...report.events);
  results.push(report);
  if (db) {
    const { error } = await db.from("runs").upsert({ id: run_id, label: policy, seller_strategy: policy, config: { eval_id: evalId, n: buyers.length, models, seed: Number(f.seed) }, result: report.result, finished_at: new Date().toISOString() });
    if (error) console.error(`  runs.${run_id}: ${error.message}`);
  }
}

// Same metric code as the dashboard, with intervals, over all runs of this eval.
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const kpis = policyKpis(allEvents, { resamples: 1000 });
console.log("\npolicy        buyers  bought        safe          profit/buyer (95% CI)        unsafe  blocks");
for (const r of results) {
  const k = kpis.find((x) => x.run_ids.includes(r.result.run_id));
  const ppb = r.result.buyers ? r.result.profit_cents / r.result.buyers : 0;
  console.log(`${r.result.label.padEnd(13)} ${String(r.result.buyers).padStart(6)}  ${pct(r.result.conversion_rate).padStart(4)} ${k ? `[${pct(k.ci.conversion_rate.lo)}–${pct(k.ci.conversion_rate.hi)}]` : ""}`.padEnd(42) +
    `${pct(r.result.safe_conversion_rate).padStart(4)}  ${usd(ppb).padStart(9)}${k?.ci.profit_per_buyer_cents ? ` [${usd(k.ci.profit_per_buyer_cents.lo)}–${usd(k.ci.profit_per_buyer_cents.hi)}]` : ""}`.padEnd(40) +
    `${String(r.judgements.filter((j) => !j.safe).length).padStart(6)}  ${String(k?.guardrail_blocks ?? 0).padStart(6)}`);
}
for (const r of results) for (const j of r.judgements.filter((x) => !x.safe).slice(0, 5))
  console.log(`  ${r.result.label} unsafe ${j.negotiation_id}: ${j.findings.map((x) => `${x.rule} (${x.detail})`).join("; ")}`);

if (!allEvents.length) {
  // Never overwrite a saved run with nothing (e.g. --rescore with a wrong id).
  console.error(`\nNo events found for ${policies.map((p) => `${evalId}_${p}`).join(", ")}; nothing written.`);
  process.exit(1);
}
writeFileSync(resolve(outDir, `${evalId}.events.json`), JSON.stringify(allEvents));
writeFileSync(resolve(outDir, `${evalId}.results.json`), JSON.stringify(results.map((r) => ({ result: r.result, unsafe: r.judgements.filter((j) => !j.safe) })), null, 2));
writeFileSync(resolve(outDir, "latest.json"), JSON.stringify({ eval_id: evalId, events: `${evalId}.events.json`, results: `${evalId}.results.json`, policies,
  buyers: f.rescore ? Math.max(0, ...kpis.map((k) => k.buyers)) : buyers.length,
  models: f.rescore ? [...new Set(allEvents.map((e) => e.buyer_model).filter(Boolean))] : models }));
console.log(`\nSaved apps/dashboard/public/runs/${evalId}.*  →  open the dashboard with ?local to view this run`);
