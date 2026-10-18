/**
 * S2 eval runner: the same simulated buyers against each seller policy, scored with S2's metrics.
 *
 *   pnpm --filter @sa/dashboard eval                                   # 20 buyers, static vs negotiating, local stand-in
 *   pnpm --filter @sa/dashboard eval --n 200 --models claude,gpt       # real LLM buyers (needs API keys)
 *   pnpm --filter @sa/dashboard eval --policies static,negotiating,balanced --gateway https://<deployed>/mcp
 *   pnpm --filter @sa/dashboard eval --models claude --seller-voice         # Claude writes the seller messages too
 *
 * Runs E2's runAll() per policy, then for each run: safety judge + private cost join → RunResult and KPIs with
 * 95% intervals. Always writes the events for the dashboard's local mode (public/runs/), and with Supabase keys
 * also stores runs.result (events already stream there from runAll).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import type { NegotiationEvent } from "@sa/shared";
import { LocalGateway, McpGateway, makeBuyers, runAll, type BuyerModel, type Gateway } from "@sa/buyer-harness";
import { defaultLlm } from "@sa/seller-mcp/sellers";
import { policyKpis } from "../src/metrics/kpis";
import { computeRunResult } from "../src/server/run-result";
import { catalogCosts, supabaseCosts } from "../src/server/costs";

const { values: f } = parseArgs({ options: {
  n: { type: "string", default: "20" }, models: { type: "string", default: "scripted" }, seed: { type: "string", default: "42" },
  policies: { type: "string", default: "static,negotiating" }, concurrency: { type: "string", default: "4" },
  adversarial: { type: "string", default: "0.1" }, gateway: { type: "string" }, id: { type: "string" },
  "seller-voice": { type: "boolean" },
} });

const models = f.models!.split(",") as BuyerModel[];
const policies = f.policies!.split(",") as ("static" | "negotiating" | "balanced")[];
const gatewayUrl = f.gateway ?? process.env.GATEWAY_URL;
const evalId = f.id ?? `eval_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
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

console.log(`\n${evalId}: ${buyers.length} buyers · ${models.join(", ")} · ${gatewayUrl ?? "local stand-in"} · ${policies.join(" vs ")}${sellerLlm ? " · Claude seller voice" : ""}${db ? " · Supabase on" : ""}\n`);

const allEvents: NegotiationEvent[] = [];
const results = [];
for (const policy of policies) {
  const run_id = `${evalId}_${policy}`;
  const gw: Gateway = gatewayUrl ? new McpGateway(gatewayUrl) : new LocalGateway(policy, sellerLlm);
  let done = 0;
  await runAll({ run_id, label: policy, buyers, gateway: gw, concurrency: Number(f.concurrency),
    on_outcome: () => { done++; if (done % 10 === 0 || done === buyers.length) process.stdout.write(`  ${policy}: ${done}/${buyers.length}\r`); } });
  await gw.close?.();
  process.stdout.write("\n");
  const file = resolve(harnessRuns, `${run_id}.events.jsonl`);
  const events: NegotiationEvent[] = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
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

writeFileSync(resolve(outDir, `${evalId}.events.json`), JSON.stringify(allEvents));
writeFileSync(resolve(outDir, `${evalId}.results.json`), JSON.stringify(results.map((r) => ({ result: r.result, unsafe: r.judgements.filter((j) => !j.safe) })), null, 2));
writeFileSync(resolve(outDir, "latest.json"), JSON.stringify({ eval_id: evalId, events: `${evalId}.events.json`, results: `${evalId}.results.json`, policies, buyers: buyers.length, models }));
console.log(`\nSaved apps/dashboard/public/runs/${evalId}.*  →  open the dashboard with ?local to view this run`);
