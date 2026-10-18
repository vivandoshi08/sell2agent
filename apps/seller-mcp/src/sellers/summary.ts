/**
 * E2 · summary lines (contract v3 P0): one plain sentence a text-only buyer agent (Instinct) can relay verbatim.
 *
 *   offerSummary({ title, price_cents, list_price_cents, levers, final, expires_at })
 *     → "KeyForge Quiet 75: $119 with free shipping (list $129). Offer holds 15 min."
 *   dealSummary({ title, total_cents, quantity, levers, approve_url })
 *     → "Deal locked: KeyForge Quiet 75, $119, free shipping. Approve: https://…"
 *
 * Built by code from the structured offer only. The input types hold PUBLIC fields, so floor, cost and margin
 * can't reach the text. Every dollar figure in the output is the offer price, the list price or the deal total
 * (checkSummary enforces it). Max 280 characters; the title is shortened first if needed.
 */
import { usd } from "./decide";

export const SUMMARY_MAX = 280;

/** Human wording for lever ids. Unknown ids are spelled out plainly; nothing is invented (no "2-year"). */
export const LEVER_LABELS: Record<string, string> = {
  free_shipping: "free shipping",
  expedited_shipping: "expedited shipping",
  extended_warranty: "an extended warranty",
  bundle_discount: "the accessory bundle",
  volume_discount: "a volume discount",
};
export const leverLabel = (id: string) => LEVER_LABELS[id] ?? id.replace(/[_-]+/g, " ").trim();

const joinAnd = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export interface OfferSummaryInput {
  title: string;
  price_cents: number; // unit price on the table
  list_price_cents?: number;
  quantity?: number;
  levers?: string[];
  final?: boolean;
  expires_at?: string | null;
  /** "accept" when the seller just accepted the buyer's price. */
  status?: "counter" | "accept";
}

export interface DealSummaryInput {
  title: string;
  total_cents: number;
  quantity?: number;
  unit_price_cents?: number;
  levers?: string[];
  approve_url?: string;
  paid?: boolean;
}

function minutesLeft(expires_at: string | null | undefined, now: number): number | null {
  if (!expires_at) return null;
  const ms = Date.parse(expires_at) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.floor(ms / 60_000)) : null;
}

/** Shorten the title (never the numbers) until the line fits. */
function fit(build: (title: string) => string, title: string): string {
  let t = title.trim();
  let s = build(t);
  while (s.length > SUMMARY_MAX && t.length > 12) {
    t = t.slice(0, Math.max(12, t.length - (s.length - SUMMARY_MAX) - 1)).trimEnd() + "…";
    s = build(t);
  }
  return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX - 1) + "…" : s;
}

export function offerSummary(o: OfferSummaryInput, now = Date.now()): string {
  const qty = o.quantity && o.quantity > 1 ? ` each for ${o.quantity}` : "";
  const extras = (o.levers ?? []).map(leverLabel);
  const withExtras = extras.length ? ` with ${joinAnd(extras)}` : "";
  const list = o.list_price_cents && o.list_price_cents > o.price_cents ? ` (list ${usd(o.list_price_cents)})` : "";
  const mins = minutesLeft(o.expires_at, now);
  const tail = [
    o.final ? "Final offer." : "",
    mins ? `Offer holds ${mins} min.` : "",
  ].filter(Boolean).join(" ");
  // An accept closes the haggling: "Final offer" / "Offer holds" would contradict it (the deal line carries what's next).
  return fit((t) => o.status === "accept"
    ? `${t}: the seller accepts ${usd(o.price_cents)}${qty}${withExtras}.`
    : `${t}: ${usd(o.price_cents)}${qty}${withExtras}${list}.${tail ? " " + tail : ""}`, o.title);
}

export function dealSummary(d: DealSummaryInput): string {
  const parts = [
    d.quantity && d.quantity > 1 && d.unit_price_cents ? `${d.quantity} × ${usd(d.unit_price_cents)} = ${usd(d.total_cents)}` : usd(d.total_cents),
    ...(d.levers ?? []).map(leverLabel),
  ];
  const next = d.paid ? "Paid." : d.approve_url ? `Approve: ${d.approve_url}` : "Approve and pay to complete it.";
  return fit((t) => `${d.paid ? "Bought" : "Deal locked"}: ${t}, ${parts.join(", ")}. ${next}`, d.title);
}

/**
 * Safety check for any summary (ours or someone else's): ≤ 280 chars, and every dollar figure is one we allow.
 * Returns problems; [] = safe. Used by tests, and callers can use it before relaying third-party text.
 */
export function checkSummary(text: string, allowed_cents: number[]): string[] {
  const problems: string[] = [];
  if (text.length > SUMMARY_MAX) problems.push(`longer than ${SUMMARY_MAX} characters (${text.length})`);
  const allowed = new Set(allowed_cents);
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?/g)) {
    const cents = Number(m[1].replace(/,/g, "")) * 100 + (m[2] ? Number(m[2]) : 0);
    if (!allowed.has(cents)) problems.push(`unexpected figure ${m[0]}`);
  }
  if (/\b(floor|cost|margin|minimum|lowest we)\b/i.test(text)) problems.push("mentions floor, cost or margin");
  return problems;
}
