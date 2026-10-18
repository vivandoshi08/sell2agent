/**
 * Walk-away recovery: when a buyer agent walks away and says what blocked it, the marketplace gateway suggests up to
 * two products that fit better (never the same one, never pricier) or says honestly that nothing does.
 *
 * The contract is frozen, so a recovery is logged as a `search` event with `payload.recovery === true`
 * (actor "marketplace"; product_id / negotiation_id = the walked product / negotiation). Searches without
 * `payload.recovery` are ordinary searches and are ignored here.
 *
 * A save = a later `deal_accepted` (same run_id + buyer_id, ts after the recovery) on one of the suggested products.
 * Revenue = price_cents × (payload.quantity ?? 1). Paid = a `payment_succeeded` with the deal's payload.deal_id.
 * Pure functions over `events`, like kpis.ts.
 */
import type { NegotiationEvent } from "@sa/shared";
import { agentName } from "./agent";

type Ev = NegotiationEvent;

// Mirrors the gateway's blockers (apps/marketplace/src/recovery.ts). Not in @sa/shared while the contract is frozen.
export const BLOCKERS = ["price", "missing_feature", "delivery", "trust", "other"] as const;
export type Blocker = (typeof BLOCKERS)[number];

const WORDS: Record<Blocker, string> = {
  price: "price", missing_feature: "a missing feature", delivery: "delivery time", trust: "trust in the seller", other: "something else",
};
/** The blocker in plain lower-case words ("a missing feature"), the same words the gateway replies with. */
export const blockerWords = (b: Blocker) => WORDS[b];
/** Short labels for counts and headings. */
export const BLOCKER_LABEL: Record<Blocker, string> = {
  price: "Price", missing_feature: "Missing feature", delivery: "Delivery", trust: "Trust", other: "Other",
};
export const isBlocker = (v: unknown): v is Blocker => typeof v === "string" && (BLOCKERS as readonly string[]).includes(v);

export interface Recovery {
  trigger: string;
  blocker: Blocker;
  need: string | null;
  still_need: string[];
  from_product_id: string | null;
  from_title: string | null;
  /** Suggested products in the gateway's order (empty on an honest no). */
  results: { product_id: string; title: string | null }[];
  honest_no: boolean;
  summary: string | null;
}

export interface RecoverySave {
  run_id: string;
  buyer_id: string;
  buyer_model: string | null;
  /** Display name of the shopping assistant (Instinct, Claude, ChatGPT…). */
  agent: string;
  from_product_id: string | null;
  from_title: string;
  /** The walked negotiation (the recovery event's negotiation_id). */
  from_negotiation_id: string | null;
  to_product_id: string;
  to_title: string;
  /** The negotiation that closed on the suggested product. */
  negotiation_id: string | null;
  price_cents: number;
  quantity: number;
  revenue_cents: number;
  paid: boolean;
  ts: string | null;
}

export interface RecoveryStats {
  /** Recovery events that suggested at least one product (honest_no false). */
  offered: number;
  /** Recovery events that said nothing here fits better. */
  honestNo: number;
  saved: number;
  savedRevenueCents: number;
  paidSaves: number;
  /** Every recovery event (offered and honest no), by what got in the way. */
  byBlocker: Record<Blocker, number>;
  /** Top 5 still_need terms across recovery events, lower-cased, most asked first: the seller's demand signal. */
  askedFor: { term: string; count: number }[];
  /** In deal order (oldest first). */
  saves: RecoverySave[];
}

const pl = (e: Ev) => (e.payload ?? {}) as Record<string, unknown>;
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const tsOf = (e: Ev) => (e.ts ? Date.parse(e.ts) : NaN);
/** a happened after b: by ts when both have one, else by position in the event list. */
const later = (a: Ev, ai: number, b: Ev, bi: number) => {
  const ta = tsOf(a), tb = tsOf(b);
  return Number.isFinite(ta) && Number.isFinite(tb) ? ta > tb : ai > bi;
};

export function isRecovery(e: Ev): boolean {
  return e.type === "search" && pl(e).recovery === true;
}

/** The recovery payload, defensively parsed (null for anything that isn't a recovery event). */
export function recoveryOf(e: Ev): Recovery | null {
  if (!isRecovery(e)) return null;
  const p = pl(e);
  const ids = Array.isArray(p.result_ids) ? p.result_ids : [];
  const titles = Array.isArray(p.result_titles) ? p.result_titles : [];
  const results = ids.flatMap((id, i) => (typeof id === "string" && id.trim() ? [{ product_id: id, title: text(titles[i]) }] : []));
  return {
    trigger: text(p.trigger) ?? "walk_away",
    blocker: isBlocker(p.blocker) ? p.blocker : "other",
    need: text(p.need),
    still_need: Array.isArray(p.still_need) ? p.still_need.filter((s): s is string => typeof s === "string" && !!s.trim()) : [],
    from_product_id: text(p.from_product_id) ?? e.product_id,
    from_title: text(p.from_title),
    results,
    honest_no: typeof p.honest_no === "boolean" ? p.honest_no : results.length === 0,
    summary: text(p.summary),
  };
}

const term = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Each save with the recovery event it came from. A deal counts once, credited to the latest recovery before it. */
function matchSaves(events: Ev[]): { recovery: Ev; save: RecoverySave }[] {
  const recs = events.flatMap((e, i) => {
    const r = recoveryOf(e);
    return r && !r.honest_no && r.results.length && e.buyer_id ? [{ e, i, r }] : [];
  });
  if (!recs.length) return [];
  const paidDeals = new Set(events.filter((e) => e.type === "payment_succeeded").map((e) => text(pl(e).deal_id)).filter(Boolean));
  const seen = new Set<string>();
  const out: { recovery: Ev; save: RecoverySave }[] = [];
  events.forEach((d, i) => {
    if (d.type !== "deal_accepted" || !d.buyer_id || !d.product_id || d.price_cents == null) return;
    const dealId = text(pl(d).deal_id);
    const key = dealId ?? `${d.run_id}|${d.negotiation_id}|${d.ts}|${i}`;
    if (seen.has(key)) return;
    let best: (typeof recs)[number] | undefined;
    for (const x of recs) {
      if (x.e.run_id !== d.run_id || x.e.buyer_id !== d.buyer_id || !later(d, i, x.e, x.i)) continue;
      if (!x.r.results.some((s) => s.product_id === d.product_id)) continue;
      if (!best || later(x.e, x.i, best.e, best.i)) best = x;
    }
    if (!best) return;
    seen.add(key);
    const q = pl(d).quantity;
    const quantity = typeof q === "number" && q > 0 ? q : 1;
    // Without a deal_id, fall back to a payment on the same negotiation after the deal.
    const paid = dealId ? paidDeals.has(dealId)
      : events.some((p, j) => p.type === "payment_succeeded" && !!d.negotiation_id && p.negotiation_id === d.negotiation_id && later(p, j, d, i));
    const buyerEvs = events.filter((e) => e.run_id === d.run_id && e.buyer_id === d.buyer_id);
    out.push({
      recovery: best.e,
      save: {
        run_id: d.run_id,
        buyer_id: d.buyer_id,
        buyer_model: buyerEvs.find((e) => e.buyer_model)?.buyer_model ?? null,
        agent: agentName(buyerEvs),
        from_product_id: best.r.from_product_id,
        from_title: best.r.from_title ?? best.r.from_product_id ?? "",
        from_negotiation_id: best.e.negotiation_id,
        to_product_id: d.product_id,
        to_title: best.r.results.find((s) => s.product_id === d.product_id)?.title ?? text(pl(d).product_title) ?? d.product_id,
        negotiation_id: d.negotiation_id,
        price_cents: d.price_cents,
        quantity,
        revenue_cents: d.price_cents * quantity,
        paid,
        ts: d.ts ?? null,
      },
    });
  });
  return out;
}

/** Recovery event → the save it led to. The Live view uses it to mark a walked negotiation "Saved". */
export function savedRecoveries(events: Ev[]): Map<Ev, RecoverySave> {
  const m = new Map<Ev, RecoverySave>();
  for (const { recovery, save } of matchSaves(events)) if (!m.has(recovery)) m.set(recovery, save);
  return m;
}

export function recoveryStats(events: Ev[]): RecoveryStats {
  const recs = events.map(recoveryOf).filter((r): r is Recovery => !!r);
  const byBlocker = Object.fromEntries(BLOCKERS.map((b) => [b, 0])) as Record<Blocker, number>;
  const asked = new Map<string, number>();
  for (const r of recs) {
    byBlocker[r.blocker]++;
    for (const t of new Set(r.still_need.map(term).filter(Boolean))) asked.set(t, (asked.get(t) ?? 0) + 1);
  }
  const saves = matchSaves(events).map((m) => m.save);
  return {
    offered: recs.filter((r) => !r.honest_no).length,
    honestNo: recs.filter((r) => r.honest_no).length,
    saved: saves.length,
    savedRevenueCents: saves.reduce((s, x) => s + x.revenue_cents, 0),
    paidSaves: saves.filter((x) => x.paid).length,
    byBlocker,
    askedFor: [...asked].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([t, count]) => ({ term: t, count })),
    saves,
  };
}

/** product_id → public title, from seller events (contract v3 `product_title`) and recovery events. Cards use it over raw ids. */
export function productTitles(events: Ev[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of events) {
    const t = e.actor === "seller" || e.actor === "marketplace" ? text(pl(e).product_title) : null;
    if (e.product_id && t) m.set(e.product_id, t);
    const r = recoveryOf(e);
    if (!r) continue;
    if (r.from_product_id && r.from_title) m.set(r.from_product_id, r.from_title);
    for (const s of r.results) if (s.title) m.set(s.product_id, s.title);
  }
  return m;
}
