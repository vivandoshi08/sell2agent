/** Display names for ids that come straight from events and the contract, so no raw snake_case reaches the screen. */

const POLICY: Record<string, string> = {
  static: "Fixed price", negotiating: "Negotiating", balanced: "Balanced", lever_policy: "Lever policy", learned: "Learned",
};
const LEVER: Record<string, string> = {
  free_shipping: "Free shipping", fast_shipping: "Fast shipping", extended_warranty: "Extended warranty",
  bundle_discount: "Bundle discount", volume_discount: "Volume discount", setup: "Setup",
};

const sentence = (s: string) => { const t = s.replace(/_/g, " ").trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

export const policyLabel = (p: string) => POLICY[p] ?? sentence(p);
/** One lever id, or a package joined with " + " (as leverWins builds it). */
export const leverLabel = (pkg: string) => pkg === "price only" ? "Price only" : pkg.split(" + ").map((l) => LEVER[l] ?? sentence(l)).join(" + ");
/** "price_first" → "Price first". Sentence case everywhere, matching the rest of the UI. */
export const personaLabel = (p: string) => sentence(p);

/** One clock format for every timestamp on screen: 2:04:22 PM. */
export const clock = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "");
