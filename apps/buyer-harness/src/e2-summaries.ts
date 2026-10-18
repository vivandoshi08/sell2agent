/**
 * E2 · summary-line dry run (contract v3 P0, the Instinct demo): every line a text-only buyer agent would relay.
 *   pnpm e2:summaries [--n 30]                                   scripted buyers, 3 strategies × extras off/on
 *   pnpm e2:summaries --models claude --n 10 --strategies negotiating --extras on   real Claude buyers (costs tokens)
 *
 * Scripted buyers (no LLM, no cost) shop through E1's REAL exchange in-process for static / negotiating / balanced,
 * with buyer extras off and on. Every `summary` is checked, both on what the buyer receives (ExchangeResponse) and
 * on what the seller's Live view logs (event payloads):
 *   - ≤ 280 characters, every dollar figure is the offer price, the list price or the deal total (checkSummary)
 *   - never the product's floor or unit cost in any form, never floor/cost/margin talk
 *   - present on every live offer and every locked deal
 * Exits 1 on any failure; prints a sample of real lines so a human can judge how they read as a text message.
 */
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { SEED_PRODUCTS } from "@sa/seller-mcp/exchange";
import { checkSummary, usd } from "@sa/seller-mcp/sellers";
import { makeBuyers, type BuyerModel } from "./agents/personas";
import { ExchangeGateway, type Strategy } from "./gateway/exchange";
import { runAll, RUNS_DIR } from "./run-all";

const { values: f } = parseArgs({ options: { n: { type: "string", default: "30" }, seed: { type: "string", default: "7" },
  models: { type: "string", default: "scripted" }, strategies: { type: "string", default: "static,negotiating,balanced" }, extras: { type: "string", default: "off,on" } } });
try { process.loadEnvFile(resolve(import.meta.dirname, "../../../.env")); } catch { /* optional */ }
const byId = new Map(SEED_PRODUCTS.map((p) => [p.product_id, p]));
const buyers = makeBuyers({ n: Number(f.n), models: f.models.split(",") as BuyerModel[], seed: Number(f.seed), adversarial_share: 0.1 });

interface Line { where: "response" | "event"; run: string; product_id: string; text: string; allowed: number[] }
const lines: Line[] = [];
const missing: string[] = [];

for (const extras of f.extras.split(",") as ("off" | "on")[]) {
  process.env.E2_BUYER_EXTRAS = extras; // read when the gateway is constructed
  for (const strategy of f.strategies.split(",") as Strategy[]) {
    const run_id = `summaries_${strategy}_extras_${extras}`;
    const gw = new ExchangeGateway(strategy, null);
    const handle = gw.exchange.handle.bind(gw.exchange);
    // what the buyer agent receives: wrap the exchange and record every response
    gw.exchange.handle = async (m) => {
      const r = await handle(m);
      const pid = (m as { product_id?: string }).product_id ?? r.deal?.product_id ?? "";
      const p = byId.get(pid);
      const hasOffer = !!r.standing_offer && r.state !== "walked_away";
      if (r.ok && (hasOffer || r.deal)) {
        if (!r.summary) missing.push(`${run_id} ${m.kind} ${pid}: no summary on ${r.deal ? "deal" : "offer"}`);
        else lines.push({ where: "response", run: run_id, product_id: pid, text: r.summary,
          allowed: [r.standing_offer?.price_cents, r.deal?.total_cents, r.deal?.unit_price_cents, p?.list_price_cents].filter((x): x is number => typeof x === "number") });
      }
      return r;
    };
    rmSync(resolve(RUNS_DIR, `${run_id}.events.jsonl`), { force: true }); // the event log appends; start clean
    await runAll({ run_id, label: strategy, buyers, gateway: gw, concurrency: 4 });
    // what the seller's Live view logs
    for (const raw of readFileSync(resolve(RUNS_DIR, `${run_id}.events.jsonl`), "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(raw);
      const s = e.payload?.summary;
      if (typeof s !== "string") continue;
      const p = byId.get(e.product_id);
      lines.push({ where: "event", run: run_id, product_id: e.product_id, text: s,
        allowed: [e.price_cents, e.payload?.total_cents, p?.list_price_cents].filter((x): x is number => typeof x === "number") });
    }
  }
}

const failures: string[] = [...missing];
for (const l of lines) {
  const p = byId.get(l.product_id);
  const problems = checkSummary(l.text, l.allowed);
  if (p) for (const c of [p.floor_price_cents, p.unit_cost_cents]) {
    if (l.text.includes(usd(c)) || l.text.includes(`$${(c / 100).toFixed(2)}`)) problems.push(`names private figure ${usd(c)}`);
  }
  if (problems.length) failures.push(`${l.where} ${l.run}: "${l.text}" → ${problems.join("; ")}`);
}

const uniq = [...new Set(lines.map((l) => l.text))];
console.log(`\n${lines.length} summary lines checked (${lines.filter((l) => l.where === "response").length} buyer responses, ${lines.filter((l) => l.where === "event").length} seller events), ${uniq.length} distinct.`);
console.log(`Longest: ${Math.max(...lines.map((l) => l.text.length))} chars.\n\nSample (as Instinct would text them):`);
const sample = [...uniq.filter((t) => t.startsWith("Deal")).slice(0, 3), ...uniq.filter((t) => / with /.test(t)).slice(0, 3),
  ...uniq.filter((t) => /Final offer/.test(t)).slice(0, 2), ...uniq.filter((t) => /accepts/.test(t)).slice(0, 2), ...uniq.slice(0, 3)];
for (const t of [...new Set(sample)].slice(0, 12)) console.log(`  ${t}`);
console.log(failures.length ? `\nFAIL: ${failures.length}\n  ${failures.slice(0, 20).join("\n  ")}` : "\nPASS: every line is ≤ 280 chars, uses only offer/list/total figures, never floor or cost, and every offer and deal has one.");
process.exit(failures.length ? 1 : 0);
