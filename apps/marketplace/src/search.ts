// search_products logic: drop products that miss a hard need, rank the rest by fit, return a short list.
// Fit = the buyer's lever profile (price, quality, delivery, warranty, trust, convenience; weights 0..1) against
// each product's public facts and the extras its seller can offer. No profile: rank by query matches, then price.
// Buyer agents phrase things loosely ("keyboard", "quiet typing"), so matching is word-based
// with synonyms, and an empty result falls back to the closest options with the misses stated.
import { Listing, type LeverName, type LeverProfile, type Product } from "@sa/shared";
import { PRODUCTS } from "./catalog.js";
import { STATIC_SNAPSHOT, type CatalogSnapshot } from "./catalog-source.js";
import { leverLabel } from "./deal/card.js";

export const MAX_RESULTS = 5; // Magentic: buyer agents do worse with long lists

/** Categories in the code seed (tool descriptions); a live catalog may add more, see categoriesOf. */
export const CATEGORIES = [...new Set(PRODUCTS.map((p) => p.category))];
export const categoriesOf = (cat: CatalogSnapshot) => [...new Set(cat.products.map((p) => p.category))];

export type SearchInput = {
  q?: string;
  category?: string;
  max_price_cents?: number;
  must_have?: string[];
  preferences?: LeverProfile;
};

/** Extras the seller can include, public names only (never costs). */
export type OfferedLever = { id: string; lever: LeverName; label: string };

export type SearchResult = {
  listing: Listing;
  fit_note: string;
  /** 0..1 fit to the buyer's lever profile; absent when no profile was given */
  fit_score?: number;
  levers_offered: OfferedLever[];
};

export type SearchOutput = {
  results: SearchResult[];
  /** true when nothing met every need and the results are the closest options instead */
  relaxed: boolean;
  note?: string;
};

type CatalogProduct = Product;

const SYNONYMS: Record<string, string[]> = {
  quiet: ["quiet", "silent"],
  silent: ["silent", "quiet"],
  wireless: ["wireless", "bluetooth"],
  bluetooth: ["bluetooth", "wireless"],
  noise: ["anc", "noise"],
  cancelling: ["anc", "cancelling"],
  canceling: ["anc", "cancelling"],
  earbuds: ["earbuds", "in-ear"],
  compact: ["compact", "65%", "75%", "tkl", "tenkeyless"],
  tenkeyless: ["tenkeyless", "tkl"],
  tkl: ["tkl", "tenkeyless"],
};

// Words that describe the request rather than the product.
const STOPWORDS = new Set([
  "a", "an", "and", "the", "for", "with", "under", "below", "less", "than", "max", "budget",
  "cheap", "best", "good", "great", "want", "need", "looking", "find", "me", "my", "i",
  "typing", "work", "office", "home", "one", "some", "something", "that", "is", "to", "of", "in", "or",
]);

/** Lowercased text a buyer's terms can match: title, description, and spec keys/values. */
function haystack(p: CatalogProduct): string {
  // A false flag (wireless: false) must not match "wireless".
  const specs = Object.entries(p.specs)
    .filter(([, v]) => v !== false)
    .map(([k, v]) => (v === true ? k : `${k} ${v}`));
  return [p.title, p.description, p.category, ...specs].join(" ").toLowerCase().replace(/_/g, " ");
}

/** Meaningful words in a phrase: no stopwords, no prices ("$150", "150"). */
function terms(s: string | undefined): string[] {
  return (s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9%-]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function singular(t: string): string {
  return t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t;
}

function termMatches(t: string, text: string): boolean {
  const options = SYNONYMS[t] ?? [t, singular(t)];
  return options.some((o) => text.includes(o));
}

/** "keyboard" → mechanical_keyboard, "headphone" → headphones; unknown → undefined (no filter). */
export function resolveCategory(category: string | undefined, categories: string[] = CATEGORIES): string | undefined {
  if (!category) return undefined;
  const words = category.toLowerCase().split(/[^a-z]+/).filter(Boolean).map(singular);
  return categories.find((c) => {
    const catWords = c.split("_").map(singular);
    return c === category || words.some((w) => catWords.includes(w));
  });
}

// Which buyer value each extra serves, when the catalog's lever_menu doesn't say (v1 schema).
const LEVER_OF: Record<string, LeverName> = {
  free_shipping: "convenience",
  extended_warranty: "warranty",
  bundle_discount: "price",
  volume_discount: "price",
};

const valueOf = (id: string, cat: CatalogSnapshot): LeverName => cat.leverValue[id] ?? LEVER_OF[id] ?? "convenience";

export function leversOffered(product_id: string, cat: CatalogSnapshot = STATIC_SNAPSHOT): OfferedLever[] {
  return (cat.levers[product_id] ?? []).map((id) => ({ id, lever: valueOf(id, cat), label: leverLabel({ name: id }) }));
}

const QUALITY_FLAGS = ["hot_swap", "wireless", "anc"];
function qualityPoints(p: CatalogProduct): number {
  const flags = QUALITY_FLAGS.filter((f) => p.specs[f] === true).length;
  const battery = Number(p.specs.battery_hours ?? 0) >= 100 ? 1 : 0;
  const build = /aluminum|gasket|premium/i.test(p.description) ? 1 : 0;
  return flags + battery + build;
}

const span = (v: number, lo: number, hi: number) => (hi === lo ? 1 : (v - lo) / (hi - lo));

/**
 * Per-lever scores 0..1 for each product, relative to the others in the pool (so "cheap" means cheap among these).
 * trust: no seller ratings yet, so every seller scores the same and trust never changes the order.
 */
function leverScores(pool: CatalogProduct[], cat: CatalogSnapshot): Map<string, Record<LeverName, number>> {
  const prices = pool.map((p) => p.list_price_cents), days = pool.map((p) => p.shipping_days), q = pool.map(qualityPoints);
  const [pLo, pHi, dLo, dHi, qLo, qHi] = [Math.min(...prices), Math.max(...prices), Math.min(...days), Math.max(...days), Math.min(...q), Math.max(...q)];
  return new Map(pool.map((p) => {
    const offers = new Set((cat.levers[p.id] ?? []).map((l) => valueOf(l, cat)));
    const priceExtra = offers.has("price") ? 0.1 : 0;
    return [p.id, {
      price: Math.min(1, 1 - span(p.list_price_cents, pLo, pHi) + priceExtra),
      quality: span(qualityPoints(p), qLo, qHi),
      delivery: 1 - span(p.shipping_days, dLo, dHi),
      warranty: offers.has("warranty") ? 1 : 0.2,
      trust: 0.5,
      convenience: offers.has("convenience") ? 1 : 0.3,
    }];
  }));
}

/** Weighted fit, plus the levers that carry it (score ≥ 0.7 on a lever the buyer weights ≥ 0.5). */
function fitFor(scores: Record<LeverName, number>, prefs: LeverProfile): { score: number; strong: LeverName[] } {
  const entries = (Object.entries(prefs) as [LeverName, number][]).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (!total) return { score: 0, strong: [] };
  const score = entries.reduce((s, [l, w]) => s + w * scores[l], 0) / total;
  const strong = entries.filter(([l, w]) => w >= 0.5 && scores[l] >= 0.7 && l !== "trust").sort((a, b) => b[1] - a[1]).map(([l]) => l);
  return { score: Math.round(score * 100) / 100, strong };
}

function toResult(p: CatalogProduct, fit_note: string, mcpUrl: string, cat: CatalogSnapshot, fit_score?: number): SearchResult {
  const seller = cat.sellers.find((s) => s.id === p.seller_id) ?? { name: p.seller_id };
  // Listing.parse strips anything not in the public contract (e.g. inventory).
  const listing = Listing.parse({ ...p, seller_name: seller.name, mcp_url: mcpUrl, in_stock: p.inventory > 0 });
  return { listing, fit_note, ...(fit_score === undefined ? {} : { fit_score }), levers_offered: leversOffered(p.id, cat) };
}

/** One product's public listing (get_listing), or null if unknown. Same public fields as search results. */
export function getListing(product_id: string, mcpUrl: string, cat: CatalogSnapshot = STATIC_SNAPSHOT): Listing | null {
  const p = cat.products.find((x) => x.id === product_id);
  return p ? toResult(p, "", mcpUrl, cat).listing : null;
}

export function searchProducts(input: SearchInput, mcpUrl: string, cat: CatalogSnapshot = STATIC_SNAPSHOT): SearchOutput {
  const categories = categoriesOf(cat);
  const category = resolveCategory(input.category, categories);
  const needs = (input.must_have ?? []).map((m) => ({ phrase: m, words: terms(m) })).filter((n) => n.words.length);
  const queryTerms = terms(input.q);

  const prefs = input.preferences && Object.values(input.preferences).some((w) => (w ?? 0) > 0) ? input.preferences : undefined;
  const inScope = cat.products.filter((p) => p.inventory > 0)
    .filter((p) => !category || p.category === category)
    .filter((p) => input.max_price_cents === undefined || p.list_price_cents <= input.max_price_cents);
  const scores = leverScores(inScope, cat);

  const pool = inScope.map((p) => {
    const text = haystack(p);
    const missed = needs.filter((n) => !n.words.every((w) => termMatches(w, text))).map((n) => n.phrase);
    const matched = queryTerms.filter((t) => termMatches(t, text));
    const fit = prefs ? fitFor(scores.get(p.id)!, prefs) : undefined;
    return { p, missed, matched, fit };
  });

  // With a lever profile, fit leads and query matches break ties; without one, matches lead, then price.
  const byFit = (a: (typeof pool)[number], b: (typeof pool)[number]) =>
    (prefs ? b.fit!.score - a.fit!.score : 0) || b.matched.length - a.matched.length || a.p.list_price_cents - b.p.list_price_cents;
  const strongNote = (fit?: { strong: LeverName[] }) => (fit?.strong.length ? ` Strong on ${fit.strong.join(", ")}.` : "");

  const exact = pool
    .filter(({ missed, matched }) => missed.length === 0 && (queryTerms.length === 0 || matched.length > 0))
    .sort(byFit)
    .slice(0, MAX_RESULTS);

  const categoryNote =
    input.category && !category ? `Unknown category "${input.category}"; available: ${categories.join(", ")}.` : undefined;

  if (exact.length) {
    const results = exact.map(({ p, matched, fit }) => {
      const fits = [...needs.map((n) => n.phrase), ...matched];
      const base = fits.length ? `Matches: ${[...new Set(fits)].join(", ")}.` : "In the requested category.";
      return toResult(p, base + strongNote(fit), mcpUrl, cat, fit?.score);
    });
    return { results, relaxed: false, note: categoryNote };
  }

  // Nothing met every need: show the closest options (fewest misses) and say exactly what each misses.
  const closest = pool.sort((a, b) => a.missed.length - b.missed.length || byFit(a, b)).slice(0, MAX_RESULTS);
  const results = closest.map(({ p, missed, matched, fit }) =>
    toResult(
      p,
      ([missed.length ? `Does not meet: ${missed.join(", ")}.` : "", matched.length ? `Matches: ${matched.join(", ")}.` : ""]
        .filter(Boolean)
        .join(" ") || "Closest option in this category and budget.") + strongNote(fit),
      mcpUrl,
      cat,
      fit?.score,
    ),
  );
  const note = [
    results.length ? "No product meets every need; these are the closest options." : "No products in this category and budget.",
    categoryNote,
  ]
    .filter(Boolean)
    .join(" ");
  return { results, relaxed: true, note };
}
