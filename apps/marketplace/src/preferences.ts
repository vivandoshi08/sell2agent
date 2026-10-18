// Buyer lever profile (preferences) for the seller's policy.
// search_products takes `preferences`; make_offer may send them too. The exchange reads them as `buyer_profile`, which is
// the context the `learned` seller picks its lever package by. Before this, live make_offer never carried a profile, so
// every real buyer was context "unknown" and the learned seller couldn't tell a delivery buyer from a price buyer.
//
// Order: preferences on make_offer itself → the ones this buyer_id sent to search_products in the last 30 min → none.
// In-memory only: a gateway restart forgets them, which costs a context, never a guardrail.
import { z } from "zod";

export const leverNames = ["price", "quality", "delivery", "warranty", "trust", "convenience"] as const;
export type Preferences = Partial<Record<(typeof leverNames)[number], number>>;

const weight = z.number().min(0).max(1);
export const preferencesSchema = z
  .object({
    price: weight.optional(),
    quality: weight.optional(),
    delivery: weight.optional(),
    warranty: weight.optional(),
    trust: weight.optional(),
    convenience: weight.optional(),
  })
  .describe(
    "What the buyer values, each 0..1 (1 = matters most): price, quality, delivery (speed), warranty, trust, convenience. " +
      "E.g. a quality-first buyer: { quality: 1, warranty: 0.8, price: 0.2 }. Results are ranked by fit to these.",
  );

const TTL_MS = 30 * 60_000;
const MAX = 5_000;
const seen = new Map<string, { prefs: Preferences; at: number }>();

/** Keep only known levers with a 0..1 weight; null when nothing is above 0. */
export function cleanPreferences(p: unknown): Preferences | null {
  if (!p || typeof p !== "object") return null;
  const out: Preferences = {};
  for (const l of leverNames) {
    const w = (p as Record<string, unknown>)[l];
    if (typeof w === "number" && Number.isFinite(w) && w > 0) out[l] = Math.min(1, w);
  }
  return Object.keys(out).length ? out : null;
}

export function rememberPreferences(buyer_id: string | null | undefined, p: unknown, now = Date.now()) {
  const prefs = cleanPreferences(p);
  if (!buyer_id || !prefs) return;
  if (seen.size >= MAX) seen.delete(seen.keys().next().value!);
  seen.delete(buyer_id);
  seen.set(buyer_id, { prefs, at: now });
}

/** The profile for this offer: sent now, else remembered from this buyer's search. */
export function preferencesFor(buyer_id: string | null | undefined, sent: unknown, now = Date.now()): Preferences | undefined {
  const direct = cleanPreferences(sent);
  if (direct) {
    rememberPreferences(buyer_id, direct, now);
    return direct;
  }
  if (!buyer_id) return undefined;
  const hit = seen.get(buyer_id);
  if (!hit) return undefined;
  if (now - hit.at > TTL_MS) {
    seen.delete(buyer_id);
    return undefined;
  }
  return hit.prefs;
}

/** Tests only. */
export function clearPreferences() {
  seen.clear();
}
