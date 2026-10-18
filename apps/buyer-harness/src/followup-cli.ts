/**
 * pnpm followups [flags]   (Bridge 3: what follow-ups are worth; see src/followup-sim.ts)
 *   --n <count>          buyers (default 100)
 *   --models <m>         scripted | claude (default scripted). Claude buyers shop AND reply with BUYER_CLAUDE_MODEL.
 *   --model <id>         Claude model for buyers + replies (default claude-haiku-5-5)
 *   --replier <r>        scripted | claude (default: same as --models)
 *   --seed <n>           personas + consent draws (default 42)
 *   --consent <share>    walk-aways who opt in to one follow-up (default 0.5)
 *   --repeat <share>     opted-in buyers who walk a 2nd product the same day (weekly-cap check, default 0.2)
 *   --probers <k>        paired walk-away probers per keyboard (default 8; 0 = skip)
 *   --adversarial <s>    red-team share of buyers (default 0.1)
 *   --concurrency <n>    parallel buyers (default 4)
 *   --id <name>          result name (default followups_<models>_<n>)
 *   --out <dir>          where the JSON goes (default docs/results/followups)
 *   --live               keep SUPABASE_URL (events reach the live dashboard). Off by default.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { usd } from "@sa/seller-mcp/sellers";
import { makeBuyers, type BuyerModel } from "./agents/personas";
import { ClaudeReplier, ScriptedReplier } from "./agents/replier";
import { runFollowupSim, runProbers, type Money, type Rate } from "./followup-sim";

try { process.loadEnvFile(resolve(import.meta.dirname, "../../../.env")); } catch { /* optional */ }

const { values: f } = parseArgs({ options: {
  n: { type: "string", default: "100" }, models: { type: "string", default: "scripted" }, model: { type: "string", default: "claude-haiku-5-5" },
  replier: { type: "string" }, seed: { type: "string", default: "42" }, consent: { type: "string", default: "0.5" }, repeat: { type: "string", default: "0.2" },
  probers: { type: "string", default: "8" }, adversarial: { type: "string", default: "0.1" },
  concurrency: { type: "string", default: "4" }, id: { type: "string" }, out: { type: "string" }, live: { type: "boolean" }, quiet: { type: "boolean" },
} });

if (!f.live) delete process.env.SUPABASE_URL; // keep simulated follow-ups off the live dashboard
const model = f.models as BuyerModel;
if (model !== "scripted" && model !== "claude") throw new Error("--models scripted | claude");
const replierKind = f.replier ?? model;
if (model === "claude" || replierKind === "claude") {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Claude buyers need ANTHROPIC_API_KEY in .env");
  process.env.BUYER_CLAUDE_MODEL = f.model;
}
const seed = Number(f.seed), n = Number(f.n);
const id = f.id ?? `followups_${model}_${n}`;
const outDir = resolve(import.meta.dirname, "../../..", f.out ?? "docs/results/followups");

// Anthropic list prices, $ per million tokens (claude-api skill table, cached 2026-10-06).
const PRICE: Record<string, [number, number]> = { "claude-haiku-5-5": [0.1, 0.5], "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20] };
const cost = (t: { input: number; output: number }) => {
  const p = PRICE[f.model!];
  return p ? (t.input * p[0] + t.output * p[1]) / 1e6 : null;
};

const buyers = makeBuyers({ n, models: [model], seed, adversarial_share: Number(f.adversarial) });
const replier = replierKind === "claude" ? new ClaudeReplier() : new ScriptedReplier({ seed });
console.log(`\n${n} ${model === "claude" ? f.model : "scripted"} buyers · replier ${replier.model} · seed ${seed} · consent ${f.consent} · ` +
  `seller negotiating · E1 exchange in-process · ${f.live ? "LIVE events" : "events local only"}\n`);

const t0 = Date.now();
const res = await runFollowupSim({ run_id: `run_${id}`, buyers, replier, consent_rate: Number(f.consent), repeat_share: Number(f.repeat), seed,
  concurrency: Number(f.concurrency), log: f.quiet ? undefined : (l) => console.log(l) });
const probe = Number(f.probers) > 0 ? await runProbers({ run_id: `run_${id}_probe`, per_product: Number(f.probers) }) : null;
const secs = Math.round((Date.now() - t0) / 1000);

const pct = (r: Rate) => `${(100 * r.rate).toFixed(0)}% [${(100 * r.ci95[0]).toFixed(0)}–${(100 * r.ci95[1]).toFixed(0)}%]`;
const money = (m: Money) => `${usd(m.mean_cents)} [${usd(m.ci95_cents[0])} – ${usd(m.ci95_cents[1])}]`;
const s = res.safety, w = res.winback;
console.log("\narm   bought                 revenue     profit     profit/buyer  margin  below floor");
for (const a of [res.off, res.on])
  console.log(`${a.label.padEnd(5)} ${pct(a.conversions).padEnd(22)} ${usd(a.revenue_cents).padStart(10)} ${usd(a.profit_cents).padStart(10)} ${usd(a.profit_per_buyer_cents).padStart(14)} ${a.avg_margin_pct.toFixed(0).padStart(6)}%  ${a.below_floor_deals}`);
console.log(`\nWalk-aways ${w.walkaways} · reachable ${w.reachable} · opted in ${w.consented} · follow-ups sent ${w.sent} · won back ${w.recovered} (accept ${w.via_accept}, counter ${w.via_counter})`);
console.log(`Unreachable walk-aways: ${Object.entries(w.unreachable).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} · walked from an offer they could pay: ${w.affordable_walkaways} (won back ${w.affordable_recovered})`);
if (w.unreachable.deal_locked_unconfirmed) console.log(`  locked deals the buyer never confirmed: ${w.unreachable.deal_locked_unconfirmed}, profit ${money(w.locked_unconfirmed_profit_per_buyer)} per buyer if a deal-expiry reminder won them all back (not sent today)`);
console.log(`Win-back: ${pct(w.of_consented)} of opted-in walk-aways · ${pct(w.of_walkaways)} of all walk-aways (at ${f.consent} consent)`);
console.log(`Lift (on − off, same buyers): +${pct(res.lift.conversions)} bought · profit ${money(res.lift.profit_per_buyer)} per buyer · ${money(res.lift.profit_per_100_buyers)} per 100 buyers · revenue ${money(res.lift.revenue_per_buyer)} per buyer`);
console.log(`\nHard safety ${s.passed ? "PASS" : "FAIL"}: below floor ${s.below_floor_deals} · over walk-away ${s.over_walkaway_deals} · follow-up below pre-walk price ${s.followup_below_prewalk} · ` +
  `follow-up below floor+levers ${s.followup_below_policy} · max follow-ups per buyer in 7 days ${s.max_followups_per_buyer_7d} · cap blocks ${s.cap_blocks} for ${s.repeat_walkers} same-day repeat walkers · sends after the first drain ${s.sends_after_first_drain} · misrouted replies ${s.misrouted_replies} · inbound events ${s.inbound_events}/${s.inbound_replies}`);
console.log(`No new concession ${s.no_new_concession && (!probe || probe.walk_cheaper === 0) ? "PASS" : "FAIL"}: walked at the cap, then offered below the pre-walk price ${s.postcap_offer_below_prewalk} (max ${usd(s.postcap_offer_below_prewalk_max_cents)})` +
  (probe ? ` · probers cheaper by walking ${probe.walk_cheaper}/${probe.probers} (max ${usd(probe.paired_gain_cents.max)})` : ""));
console.log(`  resumed haggling (walked before the cap): ${s.resumed_offer_below_prewalk} threads went below the pre-walk price (max ${usd(s.resumed_offer_below_prewalk_max_cents)}) · ` +
  `won-back deals below pre-walk price ${s.recovered_below_prewalk} (${usd(s.recovered_below_prewalk_cents)} total)`);
console.log(`  re-packaged follow-ups (lever added at the same price) ${s.followups_with_added_lever} · won back with one ${s.recovered_with_added_lever} · seller lever cost ${usd(s.added_lever_cost_cents)}`);
console.log(`Inbound never guesses ${s.decline_read_as_move ? "FAIL" : "PASS"}: replies that decline but parsed as ACCEPT/COUNTER ${s.decline_read_as_move}` +
  s.decline_read_as_move_examples.slice(0, 3).map((x) => `\n    ${x.buyer_id} (${x.intent}): "${x.text.slice(0, 140).replace(/\s+/g, " ")}"`).join(""));
console.log(`  questions answered from the catalog ${s.questions_answered} (grounded ${s.questions_answered_grounded})`);
console.log(`  inbound replies ${s.inbound_replies}: ${Object.entries(s.intents).map(([k, v]) => `${k} ${v}`).join(", ")}`);
const tk = res.tokens;
const c1 = cost(tk.first_pass), c2 = cost(tk.replies);
if (tk.first_pass.input + tk.replies.input > 0)
  console.log(`\nTokens: shopping ${tk.first_pass.input} in / ${tk.first_pass.output} out${c1 !== null ? ` ($${c1.toFixed(3)})` : ""} · follow-up replies ${tk.replies.input} in / ${tk.replies.output} out${c2 !== null ? ` ($${c2.toFixed(4)})` : ""} · model ${f.model}`);
console.log(`Took ${secs}s`);

mkdirSync(outDir, { recursive: true });
const file = resolve(outDir, `${id}.json`);
writeFileSync(file, JSON.stringify({ id, command: `pnpm --filter @sa/buyer-harness followups ${process.argv.slice(2).join(" ")}`.trim(),
  ran_at: new Date().toISOString(), seconds: secs, cost_usd: { shopping: c1, replies: c2, price_per_mtok: PRICE[f.model!] ?? null, model: model === "claude" || replierKind === "claude" ? f.model : null },
  ...res, probe }, null, 2) + "\n");
console.log(`Wrote ${file}`);
