/**
 * E2 · Train the contextual bandit, draw its learning curve, and gate it on HELD-OUT buyers.
 * Run: pnpm e2:bandit   [--epochs 40] [--per-epoch 30] [--holdout 900]
 *
 * Gate (BUILD_PLAN E2 H9–H13 / FINAL_ARCHITECTURE §10): the learned policy ships only if, on buyers it never
 * trained on, its profit per buyer beats `negotiating` with a paired 95% CI above zero, and 0 deals below floor.
 * Writes apps/seller-mcp/learned_policy.json either way, with `gate` recording the verdict; the seller only
 * uses it when gate.passed is true.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { BASE_ARMS, Bandit, contextOf, usd, type PolicyName } from "@sa/seller-mcp/sellers";
import { makeSimBuyers, simulate } from "./scripted/lever-sim";

const { values: f } = parseArgs({ options: { epochs: { type: "string", default: "40" }, "per-epoch": { type: "string", default: "30" }, holdout: { type: "string", default: "900" } } });
const EPOCHS = Number(f.epochs), PER = Number(f["per-epoch"]), HOLD = Number(f.holdout);

// ---- train (UCB), and the same buyers under fixed negotiating for the curve
const bandit = new Bandit(BASE_ARMS, 0.1); // scripted sim: base arms only (package arms run through the real exchange)
const curve: { epoch: number; bandit: number; negotiating: number }[] = [];
for (let e = 0; e < EPOCHS; e++) {
  const buyers = makeSimBuyers(PER, 1000 + e);
  let sb = 0, sn = 0;
  for (const b of buyers) {
    const ctx = contextOf(b.profile);
    const arm = bandit.chooseTraining(ctx);
    const r = simulate(b, arm as PolicyName);
    bandit.update(ctx, arm, r.profit);
    sb += r.profit;
    sn += simulate(b, "negotiating").profit;
  }
  curve.push({ epoch: e + 1, bandit: sb / PER, negotiating: sn / PER });
}
const lp = bandit.export(1);

// ---- held-out evaluation: greedy learned choice vs fixed policies, same buyers (paired)
const held = makeSimBuyers(HOLD, 777_777);
const fixed: PolicyName[] = ["static", "negotiating", "balanced", "lever_policy"];
const res: Record<string, number[]> = { learned: [], ...Object.fromEntries(fixed.map((p) => [p, []])) };
const conv: Record<string, number> = {};
let below = 0;
for (const b of held) {
  const arm = (lp.choice[contextOf(b.profile)] ?? "negotiating") as PolicyName;
  const r = simulate(b, arm);
  res.learned.push(r.profit); conv.learned = (conv.learned ?? 0) + (r.closed ? 1 : 0); if (r.belowFloor) below++;
  for (const p of fixed) { const x = simulate(b, p); res[p].push(x.profit); conv[p] = (conv[p] ?? 0) + (x.closed ? 1 : 0); if (x.belowFloor) below++; }
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const diffs = res.learned.map((x, i) => x - res.negotiating[i]);
const md = mean(diffs), sd = Math.sqrt(diffs.reduce((s, d) => s + (d - md) ** 2, 0) / (diffs.length - 1));
const ci: [number, number] = [md - 1.96 * sd / Math.sqrt(diffs.length), md + 1.96 * sd / Math.sqrt(diffs.length)];
const passed = ci[0] > 0 && below === 0;

// ---- report
console.log(`\nE2 bandit: trained on ${EPOCHS * PER} sessions (${EPOCHS} epochs × ${PER}), tested on ${HOLD} held-out buyers\n`);
console.log("What it learned (per buyer type, mean profit per session in training):");
for (const [ctx, arms] of Object.entries(lp.stats)) {
  const cells = BASE_ARMS.map((a) => `${a} ${arms[a]?.n ? usd(Math.round(arms[a].sum / arms[a].n)) : "—"} (n=${arms[a]?.n ?? 0})`).join("   ");
  console.log(`  ${ctx.padEnd(9)} → ${lp.choice[ctx].padEnd(12)} | ${cells}`);
}
console.log("\nLearning curve (profit per buyer, every 5th epoch):  bandit vs fixed negotiating");
for (const c of curve.filter((c) => c.epoch % 5 === 0)) console.log(`  epoch ${String(c.epoch).padStart(2)}   ${usd(Math.round(c.bandit)).padStart(8)}   ${usd(Math.round(c.negotiating)).padStart(8)}`);
console.log("\nHeld-out buyers               bought   profit/buyer");
for (const p of ["learned", ...fixed]) console.log(`  ${p.padEnd(26)} ${((100 * conv[p]) / HOLD).toFixed(0).padStart(5)}%   ${usd(Math.round(mean(res[p]))).padStart(12)}`);
console.log(`\nLearned − negotiating: ${usd(Math.round(md))} per buyer, 95% CI [${usd(Math.round(ci[0]))}, ${usd(Math.round(ci[1]))}]   deals below floor: ${below}`);
const bestFixed = fixed.reduce((a, p) => (mean(res[p]) > mean(res[a]) ? p : a), fixed[0]);
const vsBest = mean(res.learned) - mean(res[bestFixed]);
console.log(`Gate (vs current default, negotiating): ${passed ? "PASS" : "FAIL"}`);
console.log(`Best single fixed policy on held-out: ${bestFixed} (${usd(Math.round(mean(res[bestFixed])))}); learned is ${vsBest >= 0 ? "ahead by" : "behind by"} ${usd(Math.abs(Math.round(vsBest)))} per buyer.`);
if (vsBest < 0) console.log(`Recommendation: make ${bestFixed} the default. The bandit doesn't beat it yet (under-explored contexts); keep training it on real logged outcomes.`);

const out = resolve(import.meta.dirname, "../../seller-mcp/learned_policy.json");
writeFileSync(out, JSON.stringify({ ...lp, curve, gate: { passed, best_fixed_policy: bestFixed, learned_minus_best_fixed_cents: Math.round(vsBest), holdout_buyers: HOLD, diff_vs_negotiating_cents: Math.round(md), ci95_cents: ci.map(Math.round), below_floor: below } }, null, 2) + "\n");
console.log(`Wrote apps/seller-mcp/learned_policy.json (gate.passed = ${passed})`);
