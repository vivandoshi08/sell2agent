/**
 * pnpm buyers [flags]
 *   --compare                 run static, then negotiating, on the SAME buyers (default)
 *   --policy <p>              run one policy: static | negotiating | balanced
 *   --n <count>               buyers per run (default 10)
 *   --models claude,gpt       buyer models, alternated (default: whichever API keys exist, else scripted)
 *   --seed <n>                persona seed (default 42)
 *   --concurrency <n>         parallel buyers (default 4)
 *   --adversarial <share>     share of red-team buyers, 0..1 (default 0.1)
 *   --seller-voice            local gateway only: Claude writes seller messages (default: templates)
 *   --max-rounds <n>          with --exchange: override every product's round cap (seed: 3–4)
 *   --exchange                shop through E1's REAL exchange in-process (real offer_ids + guardrails); policy per run
 *   --gateway <url>           use the DEPLOYED gateway over MCP (or set GATEWAY_URL). Policy is then set server-side.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultLlm, usd, type PolicyName } from "@sa/seller-mcp/sellers";
import { makeBuyers, type BuyerModel } from "./agents/personas";
import { LocalGateway } from "./gateway/local";
import { McpGateway } from "./gateway/mcp";
import { ExchangeGateway, type Strategy } from "./gateway/exchange";
import { signEvalRun } from "@sa/seller-mcp/exchange";
import type { Gateway } from "./gateway/types";
import { runAll, RUNS_DIR, type Summary } from "./run-all";

try { process.loadEnvFile(resolve(import.meta.dirname, "../../../.env")); } catch { /* optional */ }

const { values: f } = parseArgs({ options: {
  compare: { type: "boolean" }, policy: { type: "string" }, n: { type: "string", default: "10" }, models: { type: "string" },
  seed: { type: "string", default: "42" }, concurrency: { type: "string", default: "4" }, adversarial: { type: "string", default: "0.1" },
  "seller-voice": { type: "boolean" }, gateway: { type: "string" }, exchange: { type: "boolean" }, "max-rounds": { type: "string" },
} });

const defaultModels: BuyerModel[] = [
  ...(process.env.ANTHROPIC_API_KEY ? (["claude"] as const) : []),
  ...(process.env.OPENAI_API_KEY ? (["gpt"] as const) : []),
];
const models = (f.models ? f.models.split(",") : defaultModels.length ? defaultModels : ["scripted"]) as BuyerModel[];
for (const m of models) {
  if (m === "claude" && !process.env.ANTHROPIC_API_KEY) throw new Error("--models claude needs ANTHROPIC_API_KEY in .env");
  if (m === "gpt" && !process.env.OPENAI_API_KEY) throw new Error("--models gpt needs OPENAI_API_KEY in .env");
}

const gatewayUrl = f.gateway ?? process.env.GATEWAY_URL;
const policies: PolicyName[] = f.policy ? [f.policy as PolicyName] : f.exchange ? ["static", "negotiating", "balanced"] : ["static", "negotiating"];
if (f.exchange && policies.some((p) => !["static", "negotiating", "balanced"].includes(p))) throw new Error("--exchange supports static, negotiating, balanced");
const buyers = makeBuyers({ n: Number(f.n), models, seed: Number(f.seed), adversarial_share: Number(f.adversarial) });
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

console.log(`\n${buyers.length} buyers · models: ${models.join(", ")} · gateway: ${gatewayUrl ?? (f.exchange ? "E1 exchange (in-process)" : "local stand-in")} · policies: ${policies.join(" vs ")}\n`);

const summaries: Summary[] = [];
for (const policy of policies) {
  const voiceLlm = f["seller-voice"] ? defaultLlm() : null;
  const gw: Gateway = gatewayUrl ? new McpGateway(gatewayUrl, policy === "lever_policy" ? undefined : policy)
    : f.exchange ? new ExchangeGateway(policy as Strategy, voiceLlm, { max_rounds: f["max-rounds"] ? Number(f["max-rounds"]) : undefined })
    : new LocalGateway(policy, voiceLlm);
  const raw_id = `run_${stamp}_${policy}${f["max-rounds"] ? `_r${f["max-rounds"]}` : ""}`;
  // E1: a signed eval run gets its own buyer memory, start limits and probe breaker on the shared deployed exchange
  // (needs the deploy's EXCHANGE_HMAC_SECRET in .env); in-process gateways are fresh per run anyway.
  const run_id = gatewayUrl ? signEvalRun(raw_id) : raw_id;
  const { summary, outcomes } = await runAll({
    run_id, label: policy, buyers, gateway: gw, concurrency: Number(f.concurrency),
    on_outcome: (o) => console.log(`  [${policy}] ${o.buyer_id} ${o.persona.padEnd(13)} ${(o.adversary ?? "").padEnd(11)} ${o.buyer_model.padEnd(18)} ` +
      (o.error ? `ERROR ${o.error.slice(0, 80)}` : o.closed ? `bought ${o.seller_name} at ${usd(o.price_cents!)}` : `walked${o.ran_out_of_steps ? " (out of steps)" : ""}`)),
  });
  await gw.close?.();
  writeFileSync(resolve(RUNS_DIR, `${run_id}.json`), JSON.stringify({ summary, buyers, outcomes }, null, 2));
  summaries.push(summary);
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
console.log("\npolicy        bought  safe   profit/buyer  margin  avg offers  below floor  wallet blocks  unfinished");
for (const s of summaries) {
  console.log(`${s.label.padEnd(13)} ${pct(s.conversion_rate).padStart(6)}  ${pct(s.safe_conversion_rate).padStart(4)}  ${usd(s.profit_per_buyer_cents).padStart(12)}  ${s.avg_margin_pct.toFixed(0).padStart(5)}%  ${s.avg_offers.toFixed(1).padStart(10)}  ${String(s.below_floor_deals).padStart(11)}  ${String(s.wallet_blocks).padStart(13)}  ${String(s.unfinished).padStart(10)}`);
}
for (const s of summaries) {
  console.log(`\n${s.label} by buyer type:`);
  for (const [k, v] of Object.entries(s.by_persona)) console.log(`  ${k.padEnd(22)} ${v.conversions}/${v.buyers} bought, profit ${usd(v.profit_cents)}`);
}
console.log(`\nSaved to apps/buyer-harness/runs/ (summary + per-buyer outcomes + events .jsonl)`);
