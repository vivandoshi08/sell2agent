/**
 * E1 · The one shared extras map: what each extra (lever id) is, which buyer value it serves, and how to name it.
 *
 *   import { EXTRAS, extraLever, extraLabel, extraPhrase, extrasPackage } from "@sa/seller-mcp/extras";
 *
 * Public fields only: no Node imports and no costs, so browser code (console, deal card, dashboard) can import it.
 * Costs are seller-private and stay in the exchange (DEFAULT_LEVER_COSTS, per-product lever_costs, seller_policies).
 * Which extras a product offers comes from the catalog (seller_policies / ProductConfig.allowed_levers), not here.
 *
 * Replaces the hand-copied maps that disagreed: S1 search `LEVER_OF` (free_shipping → convenience), S2 metrics
 * `LEVER_SERVES` (bundle_discount → convenience), console `LEVER_CATALOG`, deal-card labels, E2 `LEVER_LABELS`.
 * Decisions: free_shipping serves `delivery` (console + metrics); bundle_discount serves `price` (S1 + S2, #72).
 */
import type { LeverName } from "@sa/shared";

export interface ExtraDef {
  id: string;
  /** Which buyer value it serves (LeverName): search ranking, buyer fit, lever policy. */
  lever: LeverName;
  /** Title-case label for cards, chips and the console: "Free shipping". */
  label: string;
  /** Mid-sentence phrase for text a buyer agent relays verbatim: "…$119 with free shipping". */
  phrase: string;
}

export const EXTRAS: readonly ExtraDef[] = [
  { id: "free_shipping", lever: "delivery", label: "Free shipping", phrase: "free shipping" },
  { id: "extended_warranty", lever: "warranty", label: "Extended warranty", phrase: "an extended warranty" },
  { id: "bundle_discount", lever: "price", label: "Bundle discount", phrase: "a bundle discount" },
  { id: "volume_discount", lever: "price", label: "Volume discount", phrase: "a volume discount" },
];

export const EXTRAS_BY_ID: Readonly<Record<string, ExtraDef>> = Object.fromEntries(EXTRAS.map((e) => [e.id, e]));
export const EXTRA_IDS = EXTRAS.map((e) => e.id);
export const isExtra = (id: string): boolean => id in EXTRAS_BY_ID;

/** Buyer value an extra serves. Unknown ids → undefined (callers decide; never guess a value). */
export const extraLever = (id: string): LeverName | undefined => EXTRAS_BY_ID[id]?.lever;
/** "free_shipping" → "Free shipping"; unknown ids are spelled out ("gift_wrap" → "Gift wrap"), never invented. */
export function extraLabel(id: string): string {
  if (EXTRAS_BY_ID[id]) return EXTRAS_BY_ID[id].label;
  const s = id.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** "free_shipping" → "free shipping" (mid-sentence). */
export const extraPhrase = (id: string): string => EXTRAS_BY_ID[id]?.phrase ?? id.replace(/[_-]+/g, " ").trim();

/** Contract LeverPackage (public: id, lever, label) for a list of extra ids. Unknown ids are dropped. */
export function extrasPackage(ids: readonly string[]): { id: string; lever: LeverName; label: string }[] {
  return ids.filter(isExtra).map((id) => ({ id, lever: EXTRAS_BY_ID[id].lever, label: EXTRAS_BY_ID[id].label }));
}
