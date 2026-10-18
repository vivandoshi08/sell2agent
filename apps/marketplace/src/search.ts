// search_products logic: drop products that miss a hard need, rank the rest, return a short list.
// Provisional ranking (term matches, then price) until Neel adds the lever profile to @sa/shared.
// Buyer agents phrase things loosely ("keyboard", "quiet typing"), so matching is word-based
// with synonyms, and an empty result falls back to the closest options with the misses stated.
import { Listing } from "@sa/shared";
import { PRODUCTS, SELLERS } from "./catalog.js";

export const MAX_RESULTS = 5; // Magentic: buyer agents do worse with long lists

export const CATEGORIES = [...new Set(PRODUCTS.map((p) => p.category))];

export type SearchInput = {
  q?: string;
  category?: string;
  max_price_cents?: number;
  must_have?: string[];
};

export type SearchResult = { listing: Listing; fit_note: string };

export type SearchOutput = {
  results: SearchResult[];
  /** true when nothing met every need and the results are the closest options instead */
  relaxed: boolean;
  note?: string;
};

type CatalogProduct = (typeof PRODUCTS)[number];

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
export function resolveCategory(category: string | undefined): string | undefined {
  if (!category) return undefined;
  const words = category.toLowerCase().split(/[^a-z]+/).filter(Boolean).map(singular);
  return CATEGORIES.find((c) => {
    const catWords = c.split("_").map(singular);
    return c === category || words.some((w) => catWords.includes(w));
  });
}

function toResult(p: CatalogProduct, fit_note: string, mcpUrl: string): SearchResult {
  const seller = SELLERS.find((s) => s.id === p.seller_id)!;
  // Listing.parse strips anything not in the public contract (e.g. inventory).
  const listing = Listing.parse({ ...p, seller_name: seller.name, mcp_url: mcpUrl, in_stock: p.inventory > 0 });
  return { listing, fit_note };
}

export function searchProducts(input: SearchInput, mcpUrl: string): SearchOutput {
  const category = resolveCategory(input.category);
  const needs = (input.must_have ?? []).map((m) => ({ phrase: m, words: terms(m) })).filter((n) => n.words.length);
  const queryTerms = terms(input.q);

  const pool = PRODUCTS.filter((p) => p.inventory > 0)
    .filter((p) => !category || p.category === category)
    .filter((p) => input.max_price_cents === undefined || p.list_price_cents <= input.max_price_cents)
    .map((p) => {
      const text = haystack(p);
      const missed = needs.filter((n) => !n.words.every((w) => termMatches(w, text))).map((n) => n.phrase);
      const matched = queryTerms.filter((t) => termMatches(t, text));
      return { p, missed, matched };
    });

  const exact = pool
    .filter(({ missed, matched }) => missed.length === 0 && (queryTerms.length === 0 || matched.length > 0))
    .sort((a, b) => b.matched.length - a.matched.length || a.p.list_price_cents - b.p.list_price_cents)
    .slice(0, MAX_RESULTS);

  const categoryNote =
    input.category && !category ? `Unknown category "${input.category}"; available: ${CATEGORIES.join(", ")}.` : undefined;

  if (exact.length) {
    const results = exact.map(({ matched }, i) => {
      const fits = [...needs.map((n) => n.phrase), ...matched];
      return toResult(exact[i].p, fits.length ? `Matches: ${[...new Set(fits)].join(", ")}.` : "In the requested category.", mcpUrl);
    });
    return { results, relaxed: false, note: categoryNote };
  }

  // Nothing met every need: show the closest options (fewest misses) and say exactly what each misses.
  const closest = pool
    .sort((a, b) => a.missed.length - b.missed.length || b.matched.length - a.matched.length || a.p.list_price_cents - b.p.list_price_cents)
    .slice(0, MAX_RESULTS);
  const results = closest.map(({ p, missed, matched }) =>
    toResult(
      p,
      [missed.length ? `Does not meet: ${missed.join(", ")}.` : "", matched.length ? `Matches: ${matched.join(", ")}.` : ""]
        .filter(Boolean)
        .join(" ") || "Closest option in this category and budget.",
      mcpUrl,
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
