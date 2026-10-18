/**
 * E2 · Contextual bandit over seller policies (FINAL_ARCHITECTURE §10 "Learning", core version).
 *
 * Context = the buyer's strongest lever (price, quality, delivery, warranty, trust, … or "unknown").
 * Arms    = vetted policies (every one already guardrail-checked in code): negotiating, balanced, lever_policy, plus
 *           lever packages `pkg:<extra id>`: balanced pricing that offers that one extra (free shipping, extended
 *           warranty, bundle discount) instead of a price cut. A package arm is only drawn on a listing that offers that
 *           extra, so the bandit learns which extra wins for which buyer type, not just which concession curve.
 * Reward  = the seller's goal for the session in cents (objectiveReward: the console's margin vs conversion weights
 *           blend profit and revenue; 0 when the buyer walks).
 * Choice  = highest mean reward per context (UCB1 while learning); in deployment a small ε of random
 *           choices, with the probability of the chosen arm logged (so outcomes stay unbiased to evaluate).
 * Output  = learned_policy.json (versioned), loaded by the exchange as the `learned` strategy (exchange/learned.ts).
 *
 * Retraining from logged outcomes (pnpm e2:retrain) weights each session by 1/propensity (IPS; with several logging
 * policies, the mixture propensity), so arms the deployed policy rarely picked still get an unbiased mean. `n`/`sum`/
 * `sumSq` stay raw counts and sums (what the dashboard shows); `w`/`wsum` hold the weighted totals the choice uses.
 * Files without `w` are unweighted. `min_sessions`: an arm needs that many logged sessions in a context before the
 * greedy choice trusts it (a lucky 3-session arm doesn't take over a context).
 */
import type { SellerObjective } from "@sa/shared";
import type { BuyerLeverProfile, PolicyName } from "./types";

export type BaseArm = Exclude<PolicyName, "static" | "learned">;
/** A lever package: balanced pricing plus this one extra in place of a price cut. */
export type PackageArm = `pkg:${string}`;
export type Arm = BaseArm | PackageArm;
export const BASE_ARMS: BaseArm[] = ["negotiating", "balanced", "lever_policy"];
/** Extras the bandit can learn to lead with (volume_discount needs quantity > 1, so it isn't an arm). */
export const PACKAGE_EXTRAS = ["free_shipping", "extended_warranty", "bundle_discount"] as const;
export const PACKAGE_ARMS: PackageArm[] = PACKAGE_EXTRAS.map((x) => `pkg:${x}` as const);
export const ARMS: Arm[] = [...BASE_ARMS, ...PACKAGE_ARMS];
export const DEFAULT_ARM: Arm = "negotiating";

export const isArm = (a: unknown): a is Arm => typeof a === "string" && (ARMS as string[]).includes(a);
/** The extra a package arm leads with; null for a base arm. */
export const armExtra = (a: Arm): string | null => (a.startsWith("pkg:") ? a.slice(4) : null);
/** Arms this listing can play: every base arm, and a package arm only when the listing offers its extra. */
export function armsFor(allowed_levers: readonly string[], arms: readonly Arm[] = ARMS): Arm[] {
  return arms.filter((a) => { const x = armExtra(a); return !x || allowed_levers.includes(x); });
}

/**
 * The seller's goal for one negotiation, in cents: a blend of profit and revenue set by the console's objective weights.
 * margin → profit (price − cost − extras); conversion + clear_stock → revenue (any closed sale counts, even a thinner one).
 * Default weights (0.5 / 0.5) = half profit, half revenue. No weights at all → profit. 0 when nothing sold.
 */
export function objectiveReward(profitCents: number, revenueCents: number, objective?: Partial<SellerObjective> | null): number {
  const m = objective?.margin ?? 0.5, c = (objective?.conversion ?? 0.5) + (objective?.clear_stock ?? 0);
  if (m + c <= 0) return profitCents;
  return Math.round((m * profitCents + c * revenueCents) / (m + c));
}
/** Human-readable reward formula for the dashboard: "70% profit + 30% revenue". */
export function objectiveFormula(objective?: Partial<SellerObjective> | null): string {
  const m = objective?.margin ?? 0.5, c = (objective?.conversion ?? 0.5) + (objective?.clear_stock ?? 0);
  if (m + c <= 0) return "100% profit";
  const pm = Math.round((100 * m) / (m + c));
  return `${pm}% profit + ${100 - pm}% revenue`;
}

export interface ArmStats { n: number; sum: number; sumSq: number; w?: number; wsum?: number }
/** Held-out verdict. `passed` = beats `negotiating` (the fallback) with a paired 95% CI above 0 and 0 deals below floor. */
export interface LearnedGate {
  passed: boolean;
  best_fixed_policy: string;
  learned_minus_best_fixed_cents: number;
  holdout_buyers: number;
  diff_vs_negotiating_cents: number;
  ci95_cents: [number, number];
  below_floor: number;
  /** Logged-outcome gates only: paired 95% CI of learned − best fixed, and whether that clears 0 (the "offer as default" bar). */
  ci95_vs_best_fixed_cents?: [number, number];
  beats_best_fixed?: boolean;
  source?: string;
}
export interface LearnedPolicy {
  version: number;
  trained_at: string;
  arms: Arm[];
  epsilon: number;
  /** context → arm → stats */
  stats: Record<string, Record<string, ArmStats>>;
  /** context → chosen arm (greedy) */
  choice: Record<string, Arm>;
  /** Arms with fewer sessions than this in a context aren't chosen there (when some arm has enough). */
  min_sessions?: number;
  curve?: { epoch: number; bandit: number; negotiating: number; balanced?: number }[];
  gate?: LearnedGate;
  /** Where the training sessions came from ("scripted" | "logged:<run ids>"), and how many. */
  trained_on?: { source: string; sessions: number; runs?: string[]; previous_version?: number;
    /** real = live marketplace traffic (run_id "live": ChatGPT, Claude, Armature testers); sim = simulated LLM buyers. */
    by_source?: { real: number; sim: number };
    /** The reward each session was scored with, e.g. "50% profit + 50% revenue" (from the sellers' console goals). */
    reward?: string;
    /** Sessions per context per source, for the dashboard. */
    contexts?: Record<string, { real: number; sim: number }>;
    /** "listing": stats are goal value minus the listing's average (arms compared like for like); else raw goal value. */
    baseline?: "listing" | "none" };
}

/** The buyer's strongest non-trivial lever; ties broken by a fixed order. */
export function contextOf(profile?: BuyerLeverProfile): string {
  if (!profile) return "unknown";
  const order = ["price", "quality", "delivery", "warranty", "trust", "convenience"] as const;
  let best = "unknown", bw = 0;
  for (const k of order) { const w = profile[k] ?? 0; if (w > bw) { best = k; bw = w; } }
  return best;
}

export class Bandit {
  stats: LearnedPolicy["stats"] = {};
  constructor(public arms: Arm[] = BASE_ARMS, public epsilon = 0.1, public minSessions = 0) {}

  private s(ctx: string, arm: Arm): ArmStats {
    this.stats[ctx] ??= {};
    return (this.stats[ctx][arm] ??= { n: 0, sum: 0, sumSq: 0 });
  }

  /** IPS-weighted mean when weights were logged, else the plain mean. */
  mean(ctx: string, arm: Arm) {
    const s = this.stats[ctx]?.[arm];
    if (!s || !s.n) return 0;
    return s.w ? (s.wsum ?? 0) / s.w : s.sum / s.n;
  }

  /** UCB1 while training: try every arm once, then mean + exploration bonus (reward scale in dollars). */
  chooseTraining(ctx: string): Arm {
    const total = this.arms.reduce((t, a) => t + (this.stats[ctx]?.[a]?.n ?? 0), 0);
    for (const a of this.arms) if (!(this.stats[ctx]?.[a]?.n)) return a;
    let best = this.arms[0], bv = -Infinity;
    for (const a of this.arms) {
      const s = this.s(ctx, a);
      const v = s.sum / s.n / 100 + 20 * Math.sqrt((2 * Math.log(total)) / s.n);
      if (v > bv) { bv = v; best = a; }
    }
    return best;
  }

  greedy(ctx: string): Arm {
    const n = (a: Arm) => this.stats[ctx]?.[a]?.n ?? 0;
    const trusted = this.arms.some((a) => n(a) >= Math.max(1, this.minSessions));
    let best: Arm = DEFAULT_ARM, bv = -Infinity;
    for (const a of this.arms) {
      if (!n(a) || (trusted && n(a) < this.minSessions)) continue;
      const m = this.mean(ctx, a);
      if (m > bv) { bv = m; best = a; }
    }
    return best;
  }

  /** `weight` = 1/propensity for logged sessions (IPS); omit for on-policy training. */
  update(ctx: string, arm: Arm, rewardCents: number, weight?: number) {
    const s = this.s(ctx, arm);
    s.n++; s.sum += rewardCents; s.sumSq += rewardCents * rewardCents;
    if (weight !== undefined) { s.w = (s.w ?? 0) + weight; s.wsum = (s.wsum ?? 0) + weight * rewardCents; }
  }

  export(version: number): LearnedPolicy {
    const choice: Record<string, Arm> = {};
    for (const ctx of Object.keys(this.stats)) choice[ctx] = this.greedy(ctx);
    return { version, trained_at: new Date().toISOString(), arms: this.arms, epsilon: this.epsilon, stats: this.stats, choice,
      ...(this.minSessions ? { min_sessions: this.minSessions } : {}) };
  }
}

/**
 * Deployment choice from a learned policy: greedy per context, with ε random exploration.
 * Returns the arm, the probability it had of being picked (log it as payload.propensity), and every arm's probability
 * (payload.arm_probs: lets retraining compute mixture propensities across logging policies).
 * `rand` is injectable for tests; contexts never seen fall back to the default arm.
 */
export function chooseArm(lp: LearnedPolicy | null, profile?: BuyerLeverProfile, rand = Math.random, available?: readonly Arm[]): { arm: Arm; propensity: number; context: string; probs: Partial<Record<Arm, number>> } {
  const context = contextOf(profile);
  if (!lp) return { arm: DEFAULT_ARM, propensity: 1, context, probs: { [DEFAULT_ARM]: 1 } };
  const arms = lp.arms.filter((a) => !available || available.includes(a));
  if (!arms.length) return { arm: DEFAULT_ARM, propensity: 1, context, probs: { [DEFAULT_ARM]: 1 } };
  // the learned choice if this listing can play it, else the best-scoring arm it can play (by the policy's own stats)
  let greedy = lp.choice[context] ?? lp.choice.unknown ?? DEFAULT_ARM;
  if (!arms.includes(greedy)) {
    const st = lp.stats[context] ?? lp.stats.unknown ?? {};
    const m = (a: Arm) => { const x = st[a]; return x?.n ? (x.w ? (x.wsum ?? 0) / x.w : x.sum / x.n) : -Infinity; };
    greedy = arms.reduce((b, a) => (m(a) > m(b) ? a : b), arms.includes(DEFAULT_ARM) ? DEFAULT_ARM : arms[0]);
  }
  const k = arms.length, eps = lp.epsilon;
  const probs = Object.fromEntries(arms.map((a) => [a, eps / k + (a === greedy ? 1 - eps : 0)])) as Partial<Record<Arm, number>>;
  const arm = rand() < eps ? arms[Math.floor(rand() * k)] ?? greedy : greedy;
  return { arm, propensity: probs[arm] ?? 1, context, probs };
}
