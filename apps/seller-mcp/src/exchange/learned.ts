/**
 * E2 · The `learned` strategy's policy file, for the exchange (Node only: reads apps/seller-mcp/learned_policy.json).
 *
 * Per negotiation the exchange calls chooseArm(policy, buyer_profile) once and keeps that arm (negotiating, balanced or
 * lever_policy) for every turn. Every arm is an already-vetted policy and goes through the same decision guard, jitter
 * and output guard as a fixed strategy, so floors and the concession cap don't depend on what was learned.
 *
 * Fallback: no file, an unreadable file, or a file whose held-out gate didn't pass → null, and the exchange uses
 * `negotiating` (logged as `learned_fallback`). Evals and tests can pin a policy with setLearnedPolicy().
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ARMS, type Arm, type LearnedPolicy, type Lever } from "../sellers";
import { extrasPackage } from "./extras";
import { leverCost } from "./probing";
import type { ProductConfig } from "./types";

export const LEARNED_POLICY_FILE = resolve(import.meta.dirname, "../../learned_policy.json");

export type LearnedLoad = { policy: LearnedPolicy; fallback?: undefined } | { policy: null; fallback: "no_policy" | "gate_failed" | "bad_policy" };

/** Parse + sanity-check a policy file. Never throws. */
export function readLearnedPolicy(file = process.env.LEARNED_POLICY_PATH || LEARNED_POLICY_FILE): LearnedLoad {
  if (!existsSync(file)) return { policy: null, fallback: "no_policy" };
  try {
    const lp = JSON.parse(readFileSync(file, "utf8")) as LearnedPolicy;
    const ok = Array.isArray(lp.arms) && lp.arms.length > 0 && lp.arms.every((a) => ARMS.includes(a))
      && typeof lp.epsilon === "number" && lp.epsilon >= 0 && lp.epsilon <= 1
      && Object.values(lp.choice ?? {}).every((a) => ARMS.includes(a));
    if (!ok) return { policy: null, fallback: "bad_policy" };
    if (lp.gate?.passed !== true) return { policy: null, fallback: "gate_failed" };
    return { policy: lp };
  } catch {
    return { policy: null, fallback: "bad_policy" };
  }
}

let pinned: LearnedLoad | undefined;
let cached: LearnedLoad | undefined;

/** The policy the exchange uses now (file read once per process, or the pinned one). */
export function learnedPolicy(): LearnedLoad {
  return pinned ?? (cached ??= readLearnedPolicy());
}

/**
 * Evals/tests: pin a policy regardless of its gate (e.g. score a freshly retrained file on held-out buyers before it
 * has a gate). `null` = behave as if no file; `undefined` = back to the file.
 */
export function setLearnedPolicy(lp: LearnedPolicy | null | undefined) {
  pinned = lp === undefined ? undefined : lp ? { policy: lp } : { policy: null, fallback: "no_policy" };
  cached = undefined;
}

/** lever_policy's menu from what this listing offers: public label + which buyer value it serves + seller cost. */
export function leverMenu(p: ProductConfig): Lever[] {
  return extrasPackage(p.allowed_levers).map((x) => ({ ...x, cost_cents: leverCost([x.id], p.lever_costs) }));
}

export type { Arm };
