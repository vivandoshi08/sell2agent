/**
 * E2 · Retrain the bandit from LOGGED outcomes (real negotiations), IPS-weighted on the logged propensity.
 *
 *   pnpm e2:retrain --runs b3A_learned,b3A_negotiating,b3A_balanced          # runs/<id>.events.jsonl
 *   pnpm e2:retrain --runs eval_x_learned --from-db                           # Supabase `events` (needs SUPABASE_URL + service key)
 *   options: --epsilon 0.1  --epochs 20  --min-sessions 10  --weighting mixture|logged  --order time|interleave  --out ../seller-mcp/learned_policy.json
 *
 * Each negotiation is one session: arm + propensity from the exchange's seller events (learned: payload.arm/propensity;
 * fixed policies: rule_refs policy:<name>, propensity 1), reward = seller profit on its deal (0 if no deal).
 * Per (buyer context, arm) the policy keeps the self-normalized IPS mean Σ w·r ÷ Σ w and picks the best arm among arms
 * with at least --min-sessions sessions there.
 *   w = 1 / π(arm | context). `logged` (plain IPS): π = the propensity logged with that session. `mixture` (default,
 *   multiple-logger IPS): π = the average logging probability of that arm over every session in that context, across all
 *   runs. Logs usually mix policies (fixed A/B runs at p=1 plus an ε-greedy run where an explored arm has p=0.1); plain
 *   IPS then lets a handful of explored sessions outweigh a hundred fixed-policy ones. The mixture weight is unbiased
 *   too and has far lower variance.
 * Context `unknown` (the buyer sent no lever profile: every live make_offer through the gateway today) is learned from ALL
 * sessions pooled, i.e. the best arm when you don't know the buyer type. Without it a live `learned` seller fell back to
 * negotiating for every real buyer.
 *
 * Writes a NEW version (previous + 1) with the learning curve. Its gate starts as not passed (so the exchange falls back
 * to negotiating) until a held-out run scores it: pnpm e2:learned --policy-file <out> --gate.
 *
 * Curve: sessions in the order they were logged (--order time, default: the real history of what the seller saw), or
 * round-robin across runs (--order interleave), cut into epochs; after each epoch, the greedy policy learned so far is
 * valued per session with the all-data IPS means, next to always-negotiating and always-balanced valued the same way.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ARMS, Bandit, usd, type Arm, type LearnedPolicy } from "@sa/seller-mcp/sellers";
import { readEvents, sessions, type Ev, type Session } from "./learned-logs";

try { process.loadEnvFile(resolve(import.meta.dirname, "../../../.env")); } catch { /* optional */ }

const { values: f } = parseArgs({ options: {
  runs: { type: "string" }, "from-db": { type: "boolean" }, epsilon: { type: "string", default: "0.1" }, epochs: { type: "string", default: "20" },
  "min-sessions": { type: "string", default: "10" }, weighting: { type: "string", default: "mixture" }, order: { type: "string", default: "time" },
  out: { type: "string" },
} });
if (!f.runs) throw new Error("--runs <run id,...> is required");
const runs = f.runs.split(",").filter(Boolean);
const out = f.out ? resolve(process.cwd(), f.out) : resolve(import.meta.dirname, "../../seller-mcp/learned_policy.json");

async function dbEvents(run_id: string): Promise<Ev[]> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("--from-db needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const { db } = await import("@sa/shared/db");
  const rows: Ev[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("events").select("*").eq("run_id", run_id).order("ts", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`events for ${run_id}: ${error.message}`);
    rows.push(...((data ?? []) as Ev[]));
    if (!data || data.length < 1000) return rows;
  }
}

// ---- sessions, in logged order (or interleaved across runs)
const perRun: Session[][] = [];
for (const r of runs) perRun.push(sessions(f["from-db"] ? await dbEvents(r) : readEvents(r)).filter((s) => s.arm));
let all: Session[] = [];
if (f.order === "interleave") { for (let i = 0; perRun.some((xs) => i < xs.length); i++) for (const xs of perRun) if (i < xs.length) all.push(xs[i]); }
else all = perRun.flat().sort((a, b) => a.ts.localeCompare(b.ts));
if (!all.length) throw new Error("no bandit sessions in those runs (need seller events from the exchange)");

if (!["mixture", "logged"].includes(f.weighting!)) throw new Error("--weighting is mixture or logged");
const mix: Record<string, Partial<Record<Arm, number>>> = {}, count: Record<string, number> = {};
for (const s of all) { count[s.context] = (count[s.context] ?? 0) + 1; for (const a of ARMS) (mix[s.context] ??= {})[a] = (mix[s.context][a] ?? 0) + (s.probs[a] ?? 0); }
const mixAll: Partial<Record<Arm, number>> = {};
for (const s of all) for (const a of ARMS) mixAll[a] = (mixAll[a] ?? 0) + (s.probs[a] ?? 0);
const weight = (s: Session) => (f.weighting === "logged" ? 1 / s.propensity : count[s.context] / mix[s.context][s.arm!]!);
const weightAll = (s: Session) => (f.weighting === "logged" ? 1 / s.propensity : all.length / mixAll[s.arm!]!);
const train = (xs: Session[]) => {
  const b = new Bandit(ARMS, Number(f.epsilon), Number(f["min-sessions"]));
  for (const s of xs) {
    if (s.context !== "unknown") b.update(s.context, s.arm!, s.reward_cents, weight(s));
    b.update("unknown", s.arm!, s.reward_cents, weightAll(s)); // pooled: the choice when the buyer's type isn't known
  }
  return b;
};
const full = train(all);
const share: Record<string, number> = {};
for (const s of all) share[s.context] = (share[s.context] ?? 0) + 1 / all.length;
const value = (pick: (ctx: string) => Arm) => Object.entries(share).reduce((v, [ctx, w]) => v + w * full.mean(ctx, pick(ctx)), 0);

const E = Math.max(1, Math.min(Number(f.epochs), all.length));
const curve: NonNullable<LearnedPolicy["curve"]> = [];
for (let e = 1; e <= E; e++) {
  const b = train(all.slice(0, Math.round((e / E) * all.length)));
  curve.push({ epoch: e, bandit: Math.round(value((c) => b.greedy(c))), negotiating: Math.round(value(() => "negotiating")), balanced: Math.round(value(() => "balanced")) });
}

const prev = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as LearnedPolicy) : null;
const lp: LearnedPolicy = {
  ...full.export((prev?.version ?? 0) + 1),
  curve,
  gate: { passed: false, best_fixed_policy: "", learned_minus_best_fixed_cents: 0, holdout_buyers: 0, diff_vs_negotiating_cents: 0, ci95_cents: [0, 0], below_floor: 0,
    source: "pending: score on held-out buyers with pnpm e2:learned --policy-file <this file> --gate" },
  trained_on: { source: `logged${f["from-db"] ? " (supabase)" : ""}, ${f.weighting} IPS`, sessions: all.length, runs, ...(prev ? { previous_version: prev.version } : {}) },
};

// ---- report
console.log(`\nRetrained from ${all.length} logged negotiations in ${runs.length} runs → v${lp.version}${prev ? ` (was v${prev.version})` : ""} · ${f.weighting} IPS · min ${f["min-sessions"]} sessions per arm\n`);
console.log("Per buyer type: IPS mean profit per negotiation (sessions) → choice   (unknown = all sessions pooled: buyers who send no profile)");
for (const ctx of Object.keys(lp.stats).sort()) {
  const cells = ARMS.map((a) => { const s = lp.stats[ctx][a]; return `${a} ${s?.n ? usd(Math.round(full.mean(ctx, a))) : "—"} (${s?.n ?? 0})`; }).join("   ");
  console.log(`  ${ctx.padEnd(9)} ${(lp.choice[ctx] + (prev?.choice[ctx] && prev.choice[ctx] !== lp.choice[ctx] ? ` (was ${prev.choice[ctx]})` : "")).padEnd(28)} | ${cells}`);
}
console.log("\nLearning curve (value per negotiation, all-data IPS means):  learned · negotiating · balanced");
for (const c of curve.filter((c) => c.epoch % Math.max(1, Math.floor(E / 5)) === 0 || c.epoch === E))
  console.log(`  epoch ${String(c.epoch).padStart(2)}   ${usd(c.bandit).padStart(8)}   ${usd(c.negotiating).padStart(8)}   ${usd(c.balanced!).padStart(8)}`);
writeFileSync(out, JSON.stringify(lp, null, 2) + "\n");
console.log(`\nWrote ${out} (v${lp.version}; gate not passed until a held-out run scores it, so the exchange uses negotiating meanwhile).`);
