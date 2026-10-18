/**
 * E2 · Logged outcomes → bandit sessions and per-buyer scores (shared by e2-learned.ts and e2-retrain.ts).
 *
 * A session = one negotiation. Its arm + propensity come from the exchange's seller events: `payload.arm` /
 * `payload.propensity` for the `learned` strategy, else the fixed policy from rule_refs `policy:<name>` with
 * propensity 1 (a fixed policy always plays its arm). Context = payload.bandit_context, else contextOf() of the
 * buyer's lever_profile from the harness events. Reward = seller profit on the session's deal (price − unit cost −
 * extras' cost, × quantity), 0 when it didn't close. Profit comes from the exchange's deal_accepted, so extras count.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NegotiationEvent } from "@sa/shared";
import { ARMS, contextOf, type Arm, type BuyerLeverProfile } from "@sa/seller-mcp/sellers";
import { RUNS_DIR } from "./run-all";

export type Ev = NegotiationEvent & { ts?: string };

/** A run id (apps/buyer-harness/runs/<id>.events.jsonl) or a path to a .jsonl / .json event file. */
export function readEvents(ref: string): Ev[] {
  const file = existsSync(ref) ? ref : resolve(RUNS_DIR, `${ref}.events.jsonl`);
  if (!existsSync(file)) throw new Error(`no events for ${ref} (looked for ${file})`);
  const text = readFileSync(file, "utf8");
  return file.endsWith(".json") ? (JSON.parse(text) as Ev[]) : text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev);
}

export interface Session {
  run_id: string;
  negotiation_id: string;
  buyer_id: string;
  ts: string;
  arm: Arm | null; // null: static or unknown (not a bandit arm)
  propensity: number;
  context: string;
  reward_cents: number;
  closed: boolean;
  below_floor: boolean;
  policy_version: number | null;
}

const dealProfit = (e: Ev) => {
  const p = e.payload as Record<string, number>;
  const q = p.quantity ?? 1;
  return ((e.price_cents ?? 0) - (p.unit_cost_cents ?? 0)) * q - (p.lever_cost_cents ?? 0) * q;
};

export function sessions(events: Ev[]): Session[] {
  const profileOf = new Map<string, BuyerLeverProfile>();
  for (const e of events) {
    const lp = (e.payload as { lever_profile?: BuyerLeverProfile } | null)?.lever_profile;
    if (e.buyer_id && lp && !profileOf.has(`${e.run_id}|${e.buyer_id}`)) profileOf.set(`${e.run_id}|${e.buyer_id}`, lp);
  }
  const by = new Map<string, Ev[]>();
  for (const e of events) if (e.negotiation_id && e.buyer_id) (by.get(e.negotiation_id) ?? by.set(e.negotiation_id, []).get(e.negotiation_id)!).push(e);
  const out: Session[] = [];
  for (const [nid, es] of by) {
    const seller = es.filter((e) => e.actor === "seller");
    if (!seller.length) continue;
    const learned = seller.find((e) => typeof (e.payload as { arm?: unknown }).arm === "string");
    const fixed = seller.flatMap((e) => ((e.payload as { rule_refs?: string[] }).rule_refs ?? [])).find((r) => r.startsWith("policy:"))?.slice(7);
    const lp = learned?.payload as { arm: Arm; propensity: number; bandit_context?: string; policy_version?: number | null } | undefined;
    const armName = lp?.arm ?? fixed;
    const arm = ARMS.includes(armName as Arm) ? (armName as Arm) : null;
    const deal = es.find((e) => e.type === "deal_accepted");
    const first = es[0];
    out.push({
      run_id: first.run_id, negotiation_id: nid, buyer_id: first.buyer_id!, ts: first.ts ?? "",
      arm, propensity: lp?.propensity ?? 1,
      context: lp?.bandit_context ?? contextOf(profileOf.get(`${first.run_id}|${first.buyer_id}`)),
      reward_cents: deal ? dealProfit(deal) : 0, closed: !!deal, below_floor: (deal?.payload as { below_floor?: boolean } | undefined)?.below_floor === true,
      policy_version: lp?.policy_version ?? null,
    });
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

export interface BuyerScore { buyer_id: string; persona: string; profit_cents: number; closed: boolean; below_floor: boolean }

/** Every buyer in the run (from harness events), with the seller profit on what it bought (0 if nothing). */
export function buyerScores(events: Ev[]): Map<string, BuyerScore> {
  const out = new Map<string, BuyerScore>();
  for (const e of events) {
    if (!e.buyer_id || out.has(e.buyer_id)) continue;
    const p = e.payload as { buyer_persona?: string; adversary?: string | null } | null;
    if (p?.buyer_persona) out.set(e.buyer_id, { buyer_id: e.buyer_id, persona: p.buyer_persona, profit_cents: 0, closed: false, below_floor: false });
  }
  for (const e of events.filter((x) => x.type === "deal_accepted" && x.buyer_id)) {
    const b = out.get(e.buyer_id!) ?? { buyer_id: e.buyer_id!, persona: "?", profit_cents: 0, closed: false, below_floor: false };
    b.profit_cents += dealProfit(e); b.closed = true; b.below_floor ||= (e.payload as { below_floor?: boolean }).below_floor === true;
    out.set(b.buyer_id, b);
  }
  return out;
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export function sd(xs: number[]) { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) : 0; }
/** Normal-approx 95% CI of a mean. */
export const ci95 = (xs: number[]): [number, number] => { const m = mean(xs), h = (1.96 * sd(xs)) / Math.sqrt(Math.max(1, xs.length)); return [m - h, m + h]; };
/** Wilson 95% interval for a proportion. */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n, c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
}
/** Paired difference a − b over the buyers both runs share. */
export function paired(a: Map<string, BuyerScore>, b: Map<string, BuyerScore>) {
  const ids = [...a.keys()].filter((id) => b.has(id));
  const d = ids.map((id) => a.get(id)!.profit_cents - b.get(id)!.profit_cents);
  return { n: ids.length, mean: mean(d), ci: ci95(d) };
}
