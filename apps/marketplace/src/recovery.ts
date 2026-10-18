// Walk-away recovery: when a buyer agent says what blocked a deal, suggest up to two products that fit better,
// or say plainly that nothing here does. Pure logic over the public catalog; no prices are set here.
//
// Rules (docs/live/recovery.md), all enforced in code:
//  - never the product the buyer just walked away from (a walk must never unlock a better price on it: E11);
//  - never pricier than that product's list price, unless the buyer states a higher budget (no upsell);
//  - must meet every need the buyer still states (same word matching as search_products' hard needs);
//  - a delivery blocker only returns products that ship faster;
//  - at most two options (Magentic: agents do worse with long lists), from any seller (the gateway is neutral);
//  - nothing fits → an honest "nothing here fits better", never a closest-but-wrong option dressed up as a fit.
// A suggested product is negotiated from scratch under its own seller policy; this module never touches prices.
import type { LeverProfile, Product } from "@sa/shared";
import { searchProducts, warrantyYears } from "./search.js";
import type { CatalogSnapshot } from "./catalog-source.js";

export const BLOCKERS = ["price", "missing_feature", "delivery", "trust", "other"] as const;
export type Blocker = (typeof BLOCKERS)[number];

export const MAX_ALTERNATIVES = 2;

export type RecoveryInput = {
  /** The product the buyer walked away from (or is about to). */
  from_product_id: string;
  blocker: Blocker;
  /** Features the buyer still needs, as short phrases ("silent", "wireless"). Matched like search hard needs. */
  still_need?: string[];
  /** The buyer's budget per unit, in cents, when it states one. Only ever raises the price ceiling, never lowers it. */
  max_price_cents?: number;
  /** One line in the buyer's words, for the seller's records. Never used to choose or price anything. */
  need?: string;
};

export type Alternative = {
  product_id: string;
  title: string;
  seller_id: string;
  seller_name: string;
  list_price_cents: number;
  shipping_days: number;
  /** Why this fits, in the buyer's own terms. */
  why: string;
};

export type Recovery = {
  from_product_id: string;
  from_title: string;
  blocker: Blocker;
  still_need: string[];
  alternatives: Alternative[];
  /** true when nothing in the marketplace fits better. */
  honest_no: boolean;
  /** One line an agent can relay verbatim. */
  summary: string;
};

const BLOCKER_WORDS: Record<Blocker, string> = {
  price: "price",
  missing_feature: "a missing feature",
  delivery: "delivery time",
  trust: "trust in the seller",
  other: "something else",
};
export const blockerWords = (b: Blocker) => BLOCKER_WORDS[b];

// What to rank by once the hard filters pass: the blocker says what the buyer cares about now.
const RANK_BY: Record<Blocker, LeverProfile> = {
  price: { price: 1, quality: 0.2 } as LeverProfile,
  missing_feature: { quality: 0.6, price: 0.4 } as LeverProfile,
  delivery: { delivery: 1, price: 0.3 } as LeverProfile,
  trust: { warranty: 1, trust: 0.5, price: 0.2 } as LeverProfile,
  other: { price: 0.5, quality: 0.5 } as LeverProfile,
};

const usd = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

function why(alt: Product, from: Product, input: RecoveryInput): string {
  const parts: string[] = [];
  if (alt.list_price_cents < from.list_price_cents) parts.push(`lists at ${usd(alt.list_price_cents)} vs ${usd(from.list_price_cents)}`);
  else parts.push(`lists at ${usd(alt.list_price_cents)}`);
  const needs = (input.still_need ?? []).filter(Boolean);
  if (needs.length) parts.push(`still ${needs.join(", ")}`);
  if (input.blocker === "delivery") parts.push(`ships in ${alt.shipping_days} days vs ${from.shipping_days}`);
  if (input.blocker === "trust" && alt.specs.warranty) parts.push(`${alt.specs.warranty} warranty`);
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ". Negotiable.";
}

function summaryOf(r: Omit<Recovery, "summary">): string {
  if (r.honest_no) {
    const needs = r.still_need.length ? ` that is ${r.still_need.join(", ")}` : "";
    return `Nothing here fits better than ${r.from_title}${needs} for ${blockerWords(r.blocker)}. That's the honest answer.`;
  }
  const opts = r.alternatives.map((a) => `${a.title} by ${a.seller_name} (${usd(a.list_price_cents)} list)`).join(" or ");
  return `Since ${blockerWords(r.blocker)} was the problem: ${opts} may fit better.`.slice(0, 280);
}

/**
 * Up to MAX_ALTERNATIVES products that fit the buyer better than `from_product_id`, or an honest no.
 * Returns null when the product is unknown.
 */
export function findAlternatives(input: RecoveryInput, cat: CatalogSnapshot, mcpUrl: string): Recovery | null {
  const from = cat.products.find((p) => p.id === input.from_product_id);
  if (!from) return null;
  const still_need = (input.still_need ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 8);

  // Never pricier than the walked product, unless the buyer states a higher budget. A price blocker means strictly cheaper.
  const ceiling = Math.max(from.list_price_cents, input.max_price_cents ?? 0);
  const eligible = cat.products.filter((p) =>
    p.id !== from.id &&
    p.category === from.category &&
    (input.blocker === "price" ? p.list_price_cents < from.list_price_cents : p.list_price_cents <= ceiling) &&
    (input.blocker !== "delivery" || p.shipping_days < from.shipping_days) &&
    // Not trusting the seller: another seller, with at least the same stated warranty.
    (input.blocker !== "trust" || (p.seller_id !== from.seller_id && warrantyYears(p) >= warrantyYears(from))),
  );

  const out = searchProducts(
    { category: from.category, must_have: still_need, preferences: RANK_BY[input.blocker] },
    mcpUrl,
    { ...cat, products: eligible },
  );
  // relaxed = nothing met every stated need; those are not fits, so they are not offered.
  const fits = out.relaxed ? [] : out.results.slice(0, MAX_ALTERNATIVES);
  const sellerName = (id: string) => cat.sellers.find((s) => s.id === id)?.name ?? id;
  const alternatives: Alternative[] = fits.map(({ listing }) => {
    const p = eligible.find((x) => x.id === listing.id)!;
    return {
      product_id: p.id,
      title: p.title,
      seller_id: p.seller_id,
      seller_name: sellerName(p.seller_id),
      list_price_cents: p.list_price_cents,
      shipping_days: p.shipping_days,
      why: why(p, from, input),
    };
  });
  const base = { from_product_id: from.id, from_title: from.title, blocker: input.blocker, still_need, alternatives, honest_no: alternatives.length === 0 };
  return { ...base, summary: summaryOf(base) };
}

/** Text for the model: the summary, one line per option with how to continue, or the honest no. */
export function recoveryText(r: Recovery): string {
  if (r.honest_no) return r.summary;
  return [
    r.summary,
    ...r.alternatives.map((a) => `- ${a.title} by ${a.seller_name} (id ${a.product_id}): ${a.why}`),
    "To try one, start a new make_offer on its id (same buyer_id). It's negotiated from scratch under that seller's own terms.",
  ].join("\n");
}
