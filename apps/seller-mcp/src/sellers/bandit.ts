/**
 * E2 · Contextual bandit over seller policies (FINAL_ARCHITECTURE §10 "Learning", core version).
 *
 * Context = the buyer's strongest lever (price, quality, delivery, warranty, trust, … or "unknown").
 * Arms    = vetted policies (every one already guardrail-checked in code): negotiating, balanced, lever_policy.
 * Reward  = seller profit for the session in cents (0 when the buyer walks).
 * Choice  = highest mean reward per context (UCB1 while learning); in deployment a small ε of random
 *           choices, with the probability of the chosen arm logged (so outcomes stay unbiased to evaluate).
 * Output  = learned_policy.json (versioned), loaded by the exchange as the `learned` strategy (exchange/learned.ts).
 *
 * Retraining from logged outcomes (pnpm e2:retrain) weights each session by 1/propensity (IPS), so arms the
 * deployed policy rarely picked still get an unbiased mean. `n`/`sum`/`sumSq` stay raw counts and sums (what the
 * dashboard shows); `w`/`wsum` hold the weighted totals the choice uses. Files without `w` are unweighted.
 */
import type { BuyerLeverProfile, PolicyName } from "./types";

export type Arm = Exclude<PolicyName, "static">;
export const ARMS: Arm[] = ["negotiating", "balanced", "lever_policy"];
export const DEFAULT_ARM: Arm = "negotiating";

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
  curve?: { epoch: number; bandit: number; negotiating: number; balanced?: number }[];
  gate?: LearnedGate;
  /** Where the training sessions came from ("scripted" | "logged:<run ids>"), and how many. */
  trained_on?: { source: string; sessions: number; runs?: string[]; previous_version?: number };
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
  constructor(public arms: Arm[] = ARMS, public epsilon = 0.1) {}

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
    let best: Arm = DEFAULT_ARM, bv = -Infinity;
    for (const a of this.arms) {
      if (!this.stats[ctx]?.[a]?.n) continue;
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
    return { version, trained_at: new Date().toISOString(), arms: this.arms, epsilon: this.epsilon, stats: this.stats, choice };
  }
}

/**
 * Deployment choice from a learned policy: greedy per context, with ε random exploration.
 * Returns the arm and the probability it had of being picked (log it as payload.propensity).
 * `rand` is injectable for tests; contexts never seen fall back to the default arm.
 */
export function chooseArm(lp: LearnedPolicy | null, profile?: BuyerLeverProfile, rand = Math.random): { arm: Arm; propensity: number; context: string } {
  const context = contextOf(profile);
  const greedy = lp?.choice[context] ?? DEFAULT_ARM;
  if (!lp) return { arm: greedy, propensity: 1, context };
  const k = lp.arms.length, eps = lp.epsilon;
  if (rand() < eps) {
    const arm = lp.arms[Math.floor(rand() * k)] ?? greedy;
    return { arm, propensity: eps / k + (arm === greedy ? 1 - eps : 0), context };
  }
  return { arm: greedy, propensity: 1 - eps + eps / k, context };
}
