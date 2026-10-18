/**
 * Seller live view: what the store owner watches while a shopper's agent (e.g. Instinct over text) negotiates.
 * One card per negotiation: who is buying, the product, each move, why the agent made it and which rule shaped it.
 * Reads optional payload keys from contract v3 (`reason`, `rule_refs`, `agent_operator`, `seller_message`) and falls
 * back to what events carry today, so it works before and after those land. No metrics are computed here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { NegotiationEvent } from "@sa/shared";
import type { LiveTraffic } from "../metrics/kpis";
import { agentName } from "../metrics/agent";
import { BLOCKER_LABEL, blockerWords, isBlocker, isRecovery, productTitles, recoveryOf, savedRecoveries, type RecoverySave } from "../metrics/recovery";
import { pct, usd } from "./Panels";

export { agentName };

type P = Record<string, unknown>;
const pl = (e: NegotiationEvent) => (e.payload ?? {}) as P;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "");

/** "kb_quietpro_75" → "Quietpro 75". Catalog titles aren't in events; this keeps the card readable. */
export function productName(id: string | null) {
  if (!id) return "";
  const s = id.replace(/^(kb|p|prod|sku)_/i, "").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const RULE_LABEL: Record<string, string> = {
  floor: "Never below floor", accept_below_floor: "Never below floor", offer_below_soft_floor: "Held above floor", below_soft_floor: "Held above floor",
  injection_flag: "Ignored instructions in buyer text", input_injection: "Ignored instructions in buyer text",
  price_in_text_mismatch: "Price matches the offer", floor_disclosure: "Never reveals the floor", unpriced_concession: "Only priced perks",
  false_final: "No fake “final offer”", stale_or_foreign_offer: "Only this buyer's live offer", tampered_payment: "Charges the locked amount", payment_refused: "Only the buyer who agreed can pay",
  recovery: "Turned a walk-away into options", recovery_honest_no: "No fake “better fit”",
};
export function ruleLabel(r: string) {
  if (r.startsWith("lever:")) return `Perk allowed: ${r.slice(6).replace(/_/g, " ")}`;
  return RULE_LABEL[r] ?? r.replace(/_/g, " ");
}

const orList = new Intl.ListFormat("en", { type: "disjunction" });

/** "price: second desk" (the gateway leads a walk-away reason with the blocker) → "Price: second desk". */
function walkReason(r?: string) {
  const m = r?.match(/^([a-z_]+)(?::\s*([\s\S]*))?$/);
  if (!m || !isBlocker(m[1])) return r;
  return m[2]?.trim() ? `${BLOCKER_LABEL[m[1]]}: ${m[2].trim()}` : BLOCKER_LABEL[m[1]];
}

export interface Move { key: string; ts?: string; who: "buyer" | "seller" | "system"; text: string; why?: string; rules: string[]; tone: "" | "win" | "warn" | "bad" }

export function toMove(e: NegotiationEvent, i: number): Move | null {
  const p = pl(e), price = e.price_cents != null ? usd(e.price_cents) : "";
  const levers = Array.isArray(p.lever_package) ? (p.lever_package as { label?: string; id?: string }[]).map((l) => l.label ?? l.id).filter(Boolean) as string[] : [];
  const plus = levers.length ? ` + ${levers.join(", ")}` : "";
  const refs = Array.isArray(p.rule_refs) ? (p.rule_refs as string[]) : [];
  const why = str(p.reason) ?? str(p.message);
  const k = `${e.negotiation_id ?? e.run_id}-${i}`;
  switch (e.type) {
    case "listing_viewed": return { key: k, ts: e.ts, who: "buyer", text: "Looked at the listing", rules: [], tone: "" };
    case "question_answered": return { key: k, ts: e.ts, who: "seller", text: p.grounded === false ? "Said “I don't know” instead of guessing" : "Answered from your catalog", why: str(p.question), rules: [], tone: "" };
    case "offer_made": return { key: k, ts: e.ts, who: "buyer", text: `Offered ${price}`, why: str(p.message), rules: [], tone: "" };
    case "offer_countered": return { key: k, ts: e.ts, who: "seller", text: `Countered ${price}${plus}`, why, rules: refs, tone: "" };
    case "offer_accepted": return { key: k, ts: e.ts, who: "seller", text: `Accepted ${price}${plus}`, why, rules: refs, tone: "win" };
    case "deal_accepted": return { key: k, ts: e.ts, who: "seller", text: `Deal agreed at ${price}${plus}`, why, rules: refs, tone: "win" };
    case "payment_succeeded": return { key: k, ts: e.ts, who: "system", text: `Paid ${price}`, why: "Charged exactly the agreed amount, once", rules: [], tone: "win" };
    case "payment_failed": return { key: k, ts: e.ts, who: "system", text: "Payment didn't go through", why: str(p.message) ?? (Array.isArray(p.reasons) ? (p.reasons as string[]).join(" ") : undefined), rules: [], tone: "bad" };
    case "guardrail_blocked": {
      // E1 tags blocks by severity; routine ones are normal price clamps, not incidents.
      const routine = p.severity === "routine";
      const held = typeof p.clamped_to_cents === "number" ? ` at ${usd(p.clamped_to_cents)}` : "";
      return { key: k, ts: e.ts, who: "seller", text: str(p.seller_message) ?? (routine ? `Held the price${held}` : "Blocked a move that broke your rules"), why: str(p.reason), rules: [String(p.rule ?? "rule")], tone: routine ? "" : "warn" };
    }
    case "buyer_walked_away": return { key: k, ts: e.ts, who: "buyer", text: "Walked away", why: walkReason(str(p.reason)), rules: [], tone: "" };
    case "search": {
      // Walk-away recovery (the gateway logs it as a search with payload.recovery). Plain searches stay off the card.
      const r = recoveryOf(e);
      if (!r) return null;
      const got = `What got in the way: ${blockerWords(r.blocker)}${r.need ? ` · “${r.need}”` : ""}`;
      return r.honest_no
        ? { key: k, ts: e.ts, who: "seller", text: "Said nothing here fits better", why: got, rules: ["recovery_honest_no"], tone: "" }
        : { key: k, ts: e.ts, who: "seller", text: `Suggested a better fit: ${orList.format(r.results.map((x) => x.title ?? productName(x.product_id)))}`, why: got, rules: ["recovery"], tone: "" };
    }
    case "offer_expired": return { key: k, ts: e.ts, who: "system", text: "Offer expired", rules: [], tone: "" };
    default: return null;
  }
}

type Status = "Negotiating" | "Agreed" | "Paid" | "Walked away" | "Saved";
function statusOf(evs: NegotiationEvent[], saved?: RecoverySave): Status {
  if (evs.some((e) => e.type === "payment_succeeded")) return "Paid";
  if (evs.some((e) => e.type === "deal_accepted")) return "Agreed";
  // The buyer walked from this product, then bought one the seller suggested instead.
  if (saved) return "Saved";
  if (evs.some((e) => e.type === "buyer_walked_away")) return "Walked away";
  return "Negotiating";
}

/** One entry per negotiation, newest first. Pure; `useNegotiations` memoises it for the Live view. */
export function groupNegotiations(events: NegotiationEvent[], limit = 6) {
  const groups = new Map<string, NegotiationEvent[]>();
  const lastNeg = new Map<string, string>(); // run|buyer|product → its latest negotiation's group id
  for (const e of events) {
    if (e.type === "run_started" || e.type === "run_finished" || e.type === "judged") continue;
    if (!e.buyer_id && !e.negotiation_id) continue;
    // A recovery logged without a negotiation_id belongs on the card of the negotiation it answered.
    const id = e.negotiation_id ?? (isRecovery(e) ? lastNeg.get(`${e.run_id}|${e.buyer_id}|${e.product_id}`) : undefined) ?? `${e.run_id}:${e.buyer_id}`;
    if (e.negotiation_id && e.product_id) lastNeg.set(`${e.run_id}|${e.buyer_id}|${e.product_id}`, id);
    const g = groups.get(id); if (g) g.push(e); else groups.set(id, [e]);
  }
  const saves = savedRecoveries(events);
  const titles = productTitles(events);
  return [...groups.entries()]
    .map(([id, evs]) => {
      const saved = evs.map((e) => saves.get(e)).find((x) => !!x);
      const pid = evs.find((e) => e.product_id)?.product_id ?? null;
      return { id, evs, last: evs.at(-1)?.ts ?? "", status: statusOf(evs, saved), saved, agent: agentName(events.filter((x) => x.buyer_id === evs[0].buyer_id && x.run_id === evs[0].run_id)), product: (pid && titles.get(pid)) || productName(pid) };
    })
    .sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
    .slice(0, limit);
}

export function useNegotiations(events: NegotiationEvent[], limit = 6) {
  return useMemo(() => groupNegotiations(events, limit), [events, limit]);
}

/** The walked card's closing line once a suggested product sells: the buyer was kept, not lost. */
function savedMove(n: { id: string; saved?: RecoverySave }): Move[] {
  const s = n.saved;
  if (!s) return [];
  return [{ key: `${n.id}-saved`, ts: s.ts ?? undefined, who: "system", text: `Bought ${s.to_title} instead at ${usd(s.price_cents)}`,
    why: `${s.paid ? "Paid" : "Agreed, not paid yet"} · a fresh negotiation, under that product's own floor`, rules: [], tone: "win" }];
}

export function NegotiationCard({ n, fresh }: { n: ReturnType<typeof useNegotiations>[number]; fresh: boolean }) {
  // The exchange logs offer_accepted and deal_accepted for the same close; show the deal once.
  const dealPrices = new Set(n.evs.filter((e) => e.type === "deal_accepted").map((e) => e.price_cents));
  const moves = [...(n.evs.filter((e) => !(e.type === "offer_accepted" && dealPrices.has(e.price_cents))).map(toMove).filter(Boolean) as Move[]), ...savedMove(n)];
  const shown = moves.slice(-6);
  return (
    <article className={`neg-card${fresh ? " fresh" : ""}`} aria-label={`${n.agent} negotiating for ${n.product}`}>
      <header className="neg-h">
        <span className="agent-av" aria-hidden="true">{n.agent.charAt(0)}</span>
        <div className="neg-who"><b>{n.agent}</b><span>{n.product ? <>buying <b>{n.product}</b></> : "browsing your catalog"}</span></div>
        <span className={`status s-${n.status.replace(" ", "-").toLowerCase()}`}>{n.status}</span>
      </header>
      <ol className="moves">
        {shown.map((m) => (
          <li key={m.key} className={`move ${m.who} ${m.tone}`}>
            <span className="dot" aria-hidden="true" />
            <div className="mv">
              <div className="mv-top"><span className="mv-text num">{m.text}</span><time className="num">{time(m.ts)}</time></div>
              {m.why && <p className="mv-why">{m.why}</p>}
              {m.rules.length > 0 && <div className="mv-rules">{m.rules.map((r) => <span key={r} className={`rule${m.tone === "warn" ? " warn" : ""}`}>{ruleLabel(r)}</span>)}</div>}
            </div>
          </li>
        ))}
      </ol>
    </article>
  );
}

/** Slides in a sale notice whenever a new payment lands. */
export function SaleToasts({ events }: { events: NegotiationEvent[] }) {
  const seen = useRef<number | null>(null);
  const [toasts, setToasts] = useState<{ id: string; title: string; body: string }[]>([]);
  useEffect(() => {
    const paid = events.filter((e) => e.type === "payment_succeeded");
    if (seen.current === null) { seen.current = paid.length; return; } // don't replay history on load
    const fresh = paid.slice(seen.current);
    seen.current = paid.length;
    if (!fresh.length) return;
    const add = fresh.map((e, i) => ({ id: `${e.negotiation_id ?? e.run_id}-${paid.length}-${i}`, title: `Sold: ${productName(e.product_id) || "an order"} for ${e.price_cents != null ? usd(e.price_cents) : ""}`, body: `To ${agentName(events.filter((x) => x.buyer_id === e.buyer_id && x.run_id === e.run_id))}'s shopper. Paid in Stripe test mode.` }));
    setToasts((t) => [...add, ...t].slice(0, 3));
    const timer = setTimeout(() => setToasts((t) => t.filter((x) => !add.some((a) => a.id === x.id))), 6000);
    return () => clearTimeout(timer);
  }, [events]);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast"><span className="toast-mk" aria-hidden="true">✓</span><div><b>{t.title}</b><span>{t.body}</span></div></div>
      ))}
    </div>
  );
}

/** Today's tally from raw events (counts and sums only, no new metrics). */
export function Tally({ events }: { events: NegotiationEvent[] }) {
  const paid = events.filter((e) => e.type === "payment_succeeded");
  const agreed = events.filter((e) => e.type === "deal_accepted");
  const blocks = events.filter((e) => e.type === "guardrail_blocked").length;
  const revenue = paid.reduce((s, e) => s + (e.price_cents ?? 0), 0);
  const live = new Set(events.filter((e) => e.type === "offer_made" || e.type === "offer_countered").map((e) => e.negotiation_id ?? `${e.run_id}:${e.buyer_id}`)).size;
  return (
    <div className="tally">
      <div><span>Sales paid</span><b className="num">{paid.length}</b></div>
      <div><span>Revenue</span><b className="num">{usd(revenue)}</b></div>
      <div><span>Deals agreed</span><b className="num">{agreed.length}</b></div>
      <div><span>Negotiations</span><b className="num">{live}</b></div>
      <div><span>Unsafe moves blocked</span><b className="num">{blocks}</b></div>
    </div>
  );
}

/** Real-buyer numbers from the S2 data session's liveTraffic() (live gateway runs only). */
export function LiveTally({ live }: { live: LiveTraffic }) {
  return (
    <div className="tally">
      <div><span>Negotiations</span><b className="num">{live.negotiations}</b></div>
      <div><span>Deals agreed</span><b className="num">{live.deals}</b></div>
      <div><span>Paid</span><b className="num">{live.paid}{live.payment_failures ? ` · ${live.payment_failures} failed` : ""}</b></div>
      <div><span>Revenue (test)</span><b className="num">{usd(live.revenue_cents)}</b></div>
      <div><span>Avg off list</span><b className="num">{live.avg_discount == null ? "—" : pct(live.avg_discount)}</b></div>
      <div><span>Below floor</span><b className={`num${live.below_floor ? " bad" : ""}`}>{live.below_floor}</b></div>
    </div>
  );
}
