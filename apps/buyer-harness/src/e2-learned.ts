/**
 * E2 · `learned` vs the fixed policies on the SAME buyers, through E1's real exchange in-process, scored with 95% CIs.
 *
 *   pnpm e2:learned --id b3A --n 100 --seed 42 --models claude                 # learned (current file) + negotiating + balanced
 *   pnpm e2:learned --id b3A --policies learned --epsilon 0.3 --reuse negotiating=run_x,balanced=run_y   # pair with runs already made
 *   pnpm e2:learned --id b3B --seed 4242 --policy-file ../seller-mcp/learned_policy.json --gate        # held-out gate → written into that file
 *   pnpm e2:learned --id b3B --score-only [--gate]                                                      # re-score saved runs, no model calls
 *
 * --policy-file pins that policy for the `learned` run whatever its gate says (scoring a fresh retrain before it has
 * one); --epsilon overrides its exploration rate for this run. Keep SUPABASE_URL= empty to stay off the live dashboard.
 *
 * --gate writes the verdict into the policy file: `passed` = learned beats negotiating (the fallback) with a paired 95%
 * CI above 0 and 0 deals below floor; `beats_best_fixed` = the same against the best fixed policy on these buyers,
 * the bar for offering `learned` as a default. Nothing flips a default; the report says what the numbers support.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { usd, type LearnedPolicy } from "@sa/seller-mcp/sellers";
import { setLearnedPolicy } from "@sa/seller-mcp/exchange";
import { makeBuyers, type BuyerModel } from "./agents/personas";
import { ExchangeGateway, type Strategy } from "./gateway/exchange";
import { runAll, RUNS_DIR } from "./run-all";
import { buyerScores, paired, readEvents, sessions, wilson, ci95, mean, type BuyerScore } from "./learned-logs";

try { process.loadEnvFile(resolve(import.meta.dirname, "../../../.env")); } catch { /* optional */ }

const { values: f } = parseArgs({ options: {
  id: { type: "string" }, n: { type: "string", default: "100" }, seed: { type: "string", default: "42" }, models: { type: "string", default: "claude" },
  policies: { type: "string", default: "learned,negotiating,balanced" }, concurrency: { type: "string", default: "8" }, adversarial: { type: "string", default: "0.1" },
  "policy-file": { type: "string" }, epsilon: { type: "string" }, reuse: { type: "string" }, "score-only": { type: "boolean" }, gate: { type: "boolean" },
} });
if (!f.id) throw new Error("--id <eval id> is required");
if (process.env.SUPABASE_URL) console.warn("  SUPABASE_URL is set: events will ALSO stream to the live dashboard. Run with SUPABASE_URL= to keep this offline.");

const policies = f.policies!.split(","); // static | negotiating | balanced | learned
const reuse = Object.fromEntries((f.reuse ?? "").split(",").filter(Boolean).map((kv) => kv.split("=") as [string, string]));
const runIds: Record<string, string> = Object.fromEntries([...policies.map((p) => [p, `${f.id}_${p}`]), ...Object.entries(reuse)]);
const policyFile = f["policy-file"] ? resolve(process.cwd(), f["policy-file"]) : resolve(import.meta.dirname, "../../seller-mcp/learned_policy.json");

if (!f["score-only"]) {
  const models = f.models!.split(",") as BuyerModel[];
  const buyers = makeBuyers({ n: Number(f.n), models, seed: Number(f.seed), adversarial_share: Number(f.adversarial) });
  for (const policy of policies) {
    if (policy === "learned" && (f["policy-file"] || f.epsilon)) {
      const lp = JSON.parse(readFileSync(policyFile, "utf8")) as LearnedPolicy;
      setLearnedPolicy({ ...lp, ...(f.epsilon ? { epsilon: Number(f.epsilon) } : {}) });
      console.log(`  learned: pinned v${lp.version} from ${policyFile}, ε=${f.epsilon ?? lp.epsilon}`);
    }
    const gw = new ExchangeGateway(policy as Strategy, null); // "learned" goes straight to the exchange catalog. Template seller voice: same guards, no seller-side model cost
    let done = 0;
    const t0 = Date.now();
    const { summary } = await runAll({ run_id: runIds[policy], label: policy, buyers, gateway: gw, concurrency: Number(f.concurrency),
      on_outcome: () => { if (++done % 20 === 0) process.stdout.write(`  ${policy}: ${done}/${buyers.length}\r`); } });
    writeFileSync(resolve(RUNS_DIR, `${runIds[policy]}.json`), JSON.stringify({ summary, buyers }, null, 2));
    console.log(`  ${policy}: ${buyers.length} buyers in ${((Date.now() - t0) / 1000).toFixed(0)} s, tokens in ${summary.tokens.input} / out ${summary.tokens.output}`);
    setLearnedPolicy(undefined);
  }
}

// ---- score: per-buyer seller profit from the exchange's deal_accepted (extras' cost included), paired on buyer_id
const all = Object.keys(runIds);
const scores: Record<string, Map<string, BuyerScore>> = {};
const tokens: Record<string, { input: number; output: number } | null> = {};
for (const p of all) {
  scores[p] = buyerScores(readEvents(runIds[p]));
  const sf = resolve(RUNS_DIR, `${runIds[p]}.json`);
  tokens[p] = existsSync(sf) ? (JSON.parse(readFileSync(sf, "utf8")).summary?.tokens ?? null) : null;
}
const common = [...scores[all[0]].keys()].filter((id) => all.every((p) => scores[p].has(id)));
const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
const money = (c: number) => usd(Math.round(c));
console.log(`\n${f.id}: ${common.length} buyers common to ${all.join(", ")}\n`);
console.log("policy        bought (95% CI)       profit/buyer (95% CI)          below floor   tokens in/out");
const row: Record<string, { conv: number; ppb: number; below: number }> = {};
for (const p of all) {
  const s = common.map((id) => scores[p].get(id)!);
  const k = s.filter((x) => x.closed).length, below = s.filter((x) => x.below_floor).length, prof = s.map((x) => x.profit_cents);
  const [cl, ch] = wilson(k, s.length), [pl, ph] = ci95(prof);
  row[p] = { conv: k / s.length, ppb: mean(prof), below };
  console.log(`${p.padEnd(13)} ${pct(k / s.length).padStart(4)} [${pct(cl)}–${pct(ch)}]`.padEnd(36) + `${money(mean(prof)).padStart(8)} [${money(pl)}–${money(ph)}]`.padEnd(31) +
    `${String(below).padStart(11)}   ${tokens[p] ? `${tokens[p]!.input}/${tokens[p]!.output}` : "—"}`);
}
const fixed = all.filter((p) => p !== "learned");
if (all.includes("learned") && fixed.length) {
  const pick = (a: string) => new Map(common.map((id) => [id, scores[a].get(id)!]));
  console.log("\nPaired, same buyers (learned − fixed), profit per buyer:");
  const diffs: Record<string, ReturnType<typeof paired>> = {};
  for (const p of fixed) {
    diffs[p] = paired(pick("learned"), pick(p));
    console.log(`  vs ${p.padEnd(12)} ${diffs[p].mean >= 0 ? "+" : ""}${money(diffs[p].mean)}  95% CI [${money(diffs[p].ci[0])}, ${money(diffs[p].ci[1])}]  (n=${diffs[p].n})`);
  }
  const learnedSessions = sessions(readEvents(runIds.learned));
  const armCount: Record<string, Record<string, number>> = {};
  for (const s of learnedSessions) ((armCount[s.context] ??= {})[s.arm ?? "none"] = (armCount[s.context][s.arm ?? "none"] ?? 0) + 1);
  console.log(`\nArms the learned seller drew (${learnedSessions.length} negotiations):`);
  for (const [ctx, arms] of Object.entries(armCount).sort()) console.log(`  ${ctx.padEnd(9)} ${Object.entries(arms).map(([a, n]) => `${a} ${n}`).join("   ")}`);

  const best = fixed.reduce((a, p) => (row[p].ppb > row[a].ppb ? p : a), fixed[0]);
  const below = all.reduce((s, p) => s + row[p].below, 0);
  const vsNeg = diffs.negotiating;
  const passed = !!vsNeg && vsNeg.ci[0] > 0 && below === 0;
  const beatsBest = diffs[best].ci[0] > 0 && below === 0;
  console.log(`\nBest fixed policy on these buyers: ${best} (${money(row[best].ppb)}/buyer). Deals below floor (all runs): ${below}.`);
  console.log(`Gate vs negotiating (fallback): ${passed ? "PASS" : "FAIL"}.  Offer learned as a default (beats ${best}, CI > 0): ${beatsBest ? "YES" : "NO"}.`);
  if (f.gate) {
    const lp = JSON.parse(readFileSync(policyFile, "utf8")) as LearnedPolicy;
    lp.gate = { passed, best_fixed_policy: best, learned_minus_best_fixed_cents: Math.round(diffs[best].mean), holdout_buyers: common.length,
      diff_vs_negotiating_cents: Math.round(vsNeg?.mean ?? 0), ci95_cents: (vsNeg?.ci ?? [0, 0]).map(Math.round) as [number, number], below_floor: below,
      ci95_vs_best_fixed_cents: diffs[best].ci.map(Math.round) as [number, number], beats_best_fixed: beatsBest,
      source: `held-out ${f.models === "claude" && process.env.BUYER_CLAUDE_MODEL ? process.env.BUYER_CLAUDE_MODEL : f.models} buyers, seed ${f.seed}, runs ${all.map((p) => runIds[p]).join(", ")}` };
    writeFileSync(policyFile, JSON.stringify(lp, null, 2) + "\n");
    console.log(`Wrote gate into ${policyFile} (passed = ${passed}, beats_best_fixed = ${beatsBest}).`);
  }
}
