/**
 * E2 step-1 gate (docs/BUILD_PLAN.md, E2 · H1–H5). Run: pnpm e2:gate   (add --llm to voice with Claude)
 *
 * "Against 10 scripted buyers: stated price matches code 100%, 0 ungrounded answers,
 *  profit per buyer ≥ the static seller."
 * Also reported: 0 deals below the hard floor, conversion, and a `balanced` policy for comparison.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultLlm, usd, type PolicyName } from "@sa/seller-mcp/sellers";
import { SCRIPTED_BUYERS } from "./scripted/buyers";
import { byId } from "./scripted/catalog";
import { negotiate, type NegotiationResult } from "./scripted/simulate";

try {
  process.loadEnvFile(resolve(import.meta.dirname, "../../../.env"));
} catch {
  /* no .env is fine */
}

const useLlm = process.argv.includes("--llm");
const llm = useLlm ? defaultLlm() : null;
if (useLlm && !llm) console.warn("--llm given but ANTHROPIC_API_KEY is not set; using templates.");

const POLICIES: PolicyName[] = ["static", "negotiating", "balanced"];
const results: Record<string, NegotiationResult[]> = {};
for (const p of POLICIES) results[p] = await Promise.all(SCRIPTED_BUYERS.map((b) => negotiate(b, p, llm)));

const n = SCRIPTED_BUYERS.length;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const stats = (rs: NegotiationResult[]) => {
  const turns = rs.flatMap((r) => r.turns);
  const qa = rs.flatMap((r) => r.qa);
  const deals = rs.filter((r) => r.closed);
  return {
    conversion: deals.length / n,
    profit_per_buyer: sum(rs.map((r) => r.profit_cents)) / n,
    revenue: sum(deals.map((r) => r.price_cents!)),
    margin: deals.length ? sum(deals.map((r) => r.profit_cents)) / sum(deals.map((r) => r.price_cents!)) : 0,
    price_match: turns.filter((t) => t.price_matches_code).length / Math.max(1, turns.length),
    seller_messages: turns.length,
    llm_messages: turns.filter((t) => t.voice_source !== "template").length,
    ungrounded: qa.filter((q) => q.ungrounded_claim).length,
    honest_unknowns: qa.filter((q) => !q.grounded).length,
    questions: qa.length,
    below_floor: deals.filter((r) => r.price_cents! < byId(r.product_id).terms.floor_price_cents).length,
    avg_rounds: sum(rs.map((r) => r.rounds)) / n,
  };
};
const S = Object.fromEntries(POLICIES.map((p) => [p, stats(results[p])])) as Record<PolicyName, ReturnType<typeof stats>>;

// ---- per-buyer table
console.log(`\nE2 gate: ${n} scripted buyers × ${POLICIES.length} seller policies   (voice: ${llm ? "Claude" : "templates"})\n`);
console.log("buyer  persona        product               walk-away  " + POLICIES.map((p) => p.padEnd(16)).join(""));
for (let i = 0; i < n; i++) {
  const b = SCRIPTED_BUYERS[i];
  const cells = POLICIES.map((p) => {
    const r = results[p][i];
    return (r.closed ? `${usd(r.price_cents!)} (r${r.rounds})` : "walked").padEnd(16);
  });
  console.log(`${b.buyer_id}  ${b.persona.padEnd(14)} ${b.product_id.padEnd(21)} ${usd(b.walkaway_cents).padStart(9)}  ${cells.join("")}`);
}

// ---- KPI table
console.log("\npolicy        conversion  profit/buyer  margin  avg rounds  price match  ungrounded  below floor");
for (const p of POLICIES) {
  const s = S[p];
  console.log(`${p.padEnd(13)} ${(s.conversion * 100).toFixed(0).padStart(8)}%  ${usd(Math.round(s.profit_per_buyer)).padStart(12)}  ${(s.margin * 100).toFixed(0).padStart(5)}%  ${s.avg_rounds.toFixed(1).padStart(10)}  ${(s.price_match * 100).toFixed(0).padStart(10)}%  ${String(s.ungrounded).padStart(10)}  ${String(s.below_floor).padStart(11)}`);
}

// ---- gate
const neg = S.negotiating, stat = S.static;
const gates: [string, boolean, string][] = [
  ["Stated price matches code 100%", neg.price_match === 1 && stat.price_match === 1, `${neg.seller_messages + stat.seller_messages} seller messages checked (${neg.llm_messages + stat.llm_messages} written by Claude)`],
  ["0 ungrounded answers", neg.ungrounded === 0 && stat.ungrounded === 0, `${neg.questions} questions per policy; ${neg.honest_unknowns} answered "I don't know"`],
  ["Profit per buyer ≥ static", neg.profit_per_buyer >= stat.profit_per_buyer, `negotiating ${usd(Math.round(neg.profit_per_buyer))} vs static ${usd(Math.round(stat.profit_per_buyer))}`],
  ["0 deals below the hard floor", POLICIES.every((p) => S[p].below_floor === 0), "all policies"],
];
console.log("\nGate");
for (const [name, ok, detail] of gates) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(32)} ${detail}`);

const out = resolve(import.meta.dirname, "../runs");
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, `e2_gate${llm ? "_llm" : ""}.json`), JSON.stringify({ voice: llm ? "claude" : "template", stats: S, results }, null, 2));
console.log(`\nFull transcripts: apps/buyer-harness/runs/e2_gate${llm ? "_llm" : ""}.json`);
process.exit(gates.every((g) => g[1]) ? 0 : 1);
