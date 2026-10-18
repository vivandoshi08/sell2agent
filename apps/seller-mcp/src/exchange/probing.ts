/**
 * E1 · Anti-probing defenses from E11 (experiments/e11_nash_ideas/xsession.py), on top of buyer memory:
 *  - jitter: ±25% noise on each concession step and a per-buyer endpoint in [soft floor, soft + 3% of the gap],
 *    so two mid-negotiation offers can't be curve-fitted to the floor
 *  - probe breaker: a near-miss deadline bid (within 10% of the gap below the hard floor) or an abandoned deal
 *    closes the final-round accept zone (hard floor..soft floor) for everyone on that product for 24 h
 *  - start limiter: 4 negotiation starts per buyer per product per 24 h
 * Anonymous buyers (gateway-minted `anon_` ids, one per chat) share one bucket per product for all three
 * (see probeId in store.ts), so opening a fresh chat never buys a better opening, endpoint or start.
 */
import { createHmac } from "node:crypto";

const SECRET = process.env.EXCHANGE_HMAC_SECRET ?? "dev-jitter-secret";
export const JITTER = 0.25;
export const ENDPOINT_SPREAD = 0.03;
export const NEAR_MISS_BAND = 0.1;
export const BREAKER_COOLDOWN_MS = 24 * 3600_000;
export const START_LIMIT = 4;
export const START_WINDOW_MS = 24 * 3600_000;

/** Deterministic pseudo-random number in [0, 1) for a key. Private: seeded with the server secret. */
export function prf(key: string): number {
  const h = createHmac("sha256", SECRET).update(key).digest();
  return h.readUInt32BE(0) / 2 ** 32;
}

/** This buyer's lowest offer on this product: soft floor plus a private per-buyer spread. */
export function buyerEndpoint(buyer_id: string, product_id: string, soft: number, list: number, floor: number): number {
  const e = soft + Math.ceil(prf(`end|${buyer_id}|${product_id}`) * ENDPOINT_SPREAD * (list - floor));
  return Math.min(list, Math.ceil(e / 100) * 100);
}

/** Jitter one concession step. Never above prev, never below the buyer's endpoint, never a bigger step than `maxStep`. */
export function jitterStep(prev: number, price: number, key: string, endpoint: number, maxStep: number): number {
  if (price >= prev) return price;
  const noise = (prf(`step|${key}`) * 2 - 1) * JITTER;
  const step = Math.min(maxStep, Math.round((prev - price) * (1 + noise)));
  const jittered = Math.ceil((prev - step) / 100) * 100;
  return Math.min(prev, Math.max(endpoint, jittered));
}

export class ProbeBreaker {
  private until = new Map<string, number>();
  constructor(private now: () => number) {}
  open(product_id: string): boolean {
    return (this.until.get(product_id) ?? 0) <= this.now();
  }
  trip(product_id: string) {
    this.until.set(product_id, this.now() + BREAKER_COOLDOWN_MS);
  }
}

export class StartLimiter {
  private starts = new Map<string, number[]>();
  constructor(private now: () => number) {}
  /** Records a start; false when over the limit. */
  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.starts.get(key) ?? []).filter((x) => t - x < START_WINDOW_MS);
    if (recent.length >= START_LIMIT) { this.starts.set(key, recent); return false; }
    recent.push(t);
    this.starts.set(key, recent);
    return true;
  }
}

// ---------- Lever packages ----------
/** What each lever costs the seller, in cents (merchant lever menu; per product overrides in ProductConfig). */
export const DEFAULT_LEVER_COSTS: Record<string, number> = {
  free_shipping: 800,
  extended_warranty: 1200,
  bundle_discount: 1500,
  volume_discount: 500,
};

export function leverCost(levers: string[], costs: Record<string, number> = {}): number {
  return levers.reduce((s, l) => s + (costs[l] ?? DEFAULT_LEVER_COSTS[l] ?? 0), 0);
}
