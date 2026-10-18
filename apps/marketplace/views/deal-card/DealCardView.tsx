/**
 * S2-owned. Presentational deal card: props in, markup out. No host calls here, so it can be
 * restyled freely and previewed with fixtures. Wiring to the host lives in view.tsx.
 *
 * Runs inside the chat host's sandboxed frame: system fonts only (no external loads), both themes,
 * phone width. Every number shown comes from the stored deal; nothing here is invented.
 */
import { useEffect, useState } from "react";
import type { DealCard } from "../../src/deal/types";

export type PayState =
  | { kind: "idle" }
  | { kind: "paying" }
  | { kind: "succeeded"; card?: string; payment_intent_id?: string }
  | { kind: "processing" }
  | { kind: "requires_action"; fix?: string }
  | { kind: "refused"; reasons: string[]; fix?: string }
  | { kind: "declined"; message?: string; fix?: string }
  | { kind: "error"; message?: string };

export interface DealCardViewProps {
  card: DealCard;
  pay: PayState;
  theme: "light" | "dark";
  onApprove: () => void;
  /** For previews and tests; defaults to the real clock. */
  now?: () => number;
}

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

function useCountdown(expiresAt: string, now: () => number) {
  const [left, setLeft] = useState(() => Date.parse(expiresAt) - now());
  useEffect(() => {
    const t = setInterval(() => setLeft(Date.parse(expiresAt) - now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt, now]);
  return left;
}

function formatLeft(ms: number) {
  if (ms <= 0) return "Expired";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m left` : `${m}:${String(sec).padStart(2, "0")} left`;
}

const CSS = `
.dc{--bg:#fbfcfb;--ink:#17201b;--muted:#5d6a63;--line:#dfe5e1;--accent:#1d6b52;--accent-ink:#fff;--save:#1d6b52;--save-bg:#e3f2ec;
  --warn:#9a5b0c;--warn-bg:#fbf0dd;--bad:#b02a20;--bad-bg:#fbe7e4;--ok:#1d6b52;--ok-bg:#e3f2ec;
  font:14px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--ink);background:var(--bg);
  border:1px solid var(--line);border-radius:14px;padding:16px;max-width:440px;display:grid;gap:14px;box-sizing:border-box}
.dc[data-theme=dark]{--bg:#151b18;--ink:#e6ece8;--muted:#9aa8a0;--line:#2b3530;--accent:#6fd0aa;--accent-ink:#0e1512;--save:#7fd8b3;--save-bg:#17332a;
  --warn:#f0bd6e;--warn-bg:#3a2b13;--bad:#f39c93;--bad-bg:#3b1b18;--ok:#7fd8b3;--ok-bg:#17332a}
.dc *{box-sizing:border-box}
.dc-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.dc-seller{font-size:12px;color:var(--muted);letter-spacing:.02em}
.dc-title{font:650 16px/1.25 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;margin:2px 0 0;letter-spacing:normal;text-transform:none;opacity:1;color:var(--ink)}
.dc-qty{font-size:12px;color:var(--muted)}
.dc-timer{font:600 12px/1 ui-monospace,"SF Mono",Menlo,monospace;padding:5px 8px;border-radius:999px;background:var(--warn-bg);color:var(--warn);white-space:nowrap;font-variant-numeric:tabular-nums}
.dc-timer.gone{background:var(--bad-bg);color:var(--bad)}
.dc-price{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.dc-total{font-size:30px;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.dc-list{color:var(--muted);text-decoration:line-through;font-variant-numeric:tabular-nums}
.dc-save{font-size:12px;font-weight:650;color:var(--save);background:var(--save-bg);padding:3px 8px;border-radius:999px}
.dc-each{font-size:12px;color:var(--muted);margin-top:-8px}
.dc-levers{list-style:none;margin:0;padding:10px 0 0;border-top:1px dashed var(--line);display:grid;gap:6px}
.dc-levers li{display:flex;gap:8px;align-items:center}
.dc-levers li::before{content:"";width:6px;height:6px;border-radius:2px;background:var(--accent);flex:none}
.dc-btn{appearance:none;border:0;border-radius:10px;padding:12px 14px;font:inherit;font-weight:650;font-size:15px;cursor:pointer;
  background:var(--accent);color:var(--accent-ink);width:100%}
.dc-btn:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.dc-btn[disabled]{opacity:.6;cursor:default}
.dc-note{font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.dc-status{border-radius:10px;padding:10px 12px;font-size:13px;display:grid;gap:3px}
.dc-status b{font-weight:650}
.dc-status.ok{background:var(--ok-bg);color:var(--ok)}
.dc-status.warn{background:var(--warn-bg);color:var(--warn)}
.dc-status.bad{background:var(--bad-bg);color:var(--bad)}
.dc-status span{color:var(--ink);opacity:.85}
@media (prefers-reduced-motion:no-preference){.dc-btn{transition:transform .08s}.dc-btn:active:not([disabled]){transform:scale(.99)}}
`;

function Status({ pay, cardStatus }: { pay: PayState; cardStatus: DealCard["status"] }) {
  if (pay.kind === "succeeded" || (pay.kind === "idle" && cardStatus === "paid"))
    return <div className="dc-status ok" role="status"><b>Paid</b>{pay.kind === "succeeded" && pay.card ? <span>Charged to {pay.card}. Receipt {pay.payment_intent_id}</span> : <span>This deal is already paid.</span>}</div>;
  if (pay.kind === "processing")
    return <div className="dc-status warn" role="status"><b>Payment processing</b><span>Stripe is confirming it. No need to pay again.</span></div>;
  if (pay.kind === "requires_action")
    return <div className="dc-status warn" role="alert"><b>Your bank needs a confirmation</b><span>{pay.fix ?? "Complete the check, then approve again."}</span></div>;
  if (pay.kind === "refused")
    return <div className="dc-status bad" role="alert"><b>Not charged</b><span>{pay.reasons.join(" ")}</span>{pay.fix && <span>{pay.fix}</span>}</div>;
  if (pay.kind === "declined")
    return <div className="dc-status bad" role="alert"><b>Card declined</b><span>{pay.fix ?? "Try a different payment method."}</span></div>;
  if (pay.kind === "error")
    return <div className="dc-status bad" role="alert"><b>Payment didn't go through</b><span>{pay.message ?? "Try again in a moment."}</span></div>;
  if (cardStatus === "expired")
    return <div className="dc-status bad" role="status"><b>This offer expired</b><span>Ask the seller for a new offer.</span></div>;
  if (cardStatus === "unavailable")
    return <div className="dc-status bad" role="status"><b>This deal can't be paid</b><span>Check the latest offer with the seller.</span></div>;
  return null;
}

export function DealCardView({ card, pay, theme, onApprove, now = Date.now }: DealCardViewProps) {
  const left = useCountdown(card.expires_at, now);
  const expired = card.status === "expired" || left <= 0;
  const done = card.status === "paid" || pay.kind === "succeeded" || pay.kind === "processing";
  const canPay = !expired && !done && card.status === "ready" && pay.kind !== "paying";
  const cardStatus = expired && card.status === "ready" ? "expired" : card.status;

  return (
    <section className="dc" data-theme={theme} aria-label={`Deal for ${card.product.title}`}>
      <style>{CSS}</style>
      <div className="dc-top">
        <div>
          <div className="dc-seller">{card.seller_name}</div>
          <h2 className="dc-title">{card.product.title}</h2>
          {card.quantity > 1 && <div className="dc-qty">Quantity {card.quantity}</div>}
        </div>
        {!done && <div className={`dc-timer${expired ? " gone" : ""}`}>{formatLeft(expired ? 0 : left)}</div>}
      </div>

      <div className="dc-price">
        <span className="dc-total">{usd(card.total_cents)}</span>
        {card.savings_cents > 0 && <span className="dc-list">{usd(card.list_total_cents)}</span>}
        {card.savings_cents > 0 && <span className="dc-save">You save {usd(card.savings_cents)}</span>}
      </div>
      {card.quantity > 1 && <div className="dc-each">{usd(card.unit_price_cents)} each</div>}

      {card.levers.length > 0 && (
        <ul className="dc-levers" aria-label="Included">
          {card.levers.map((l) => <li key={l.name}>{l.label}</li>)}
        </ul>
      )}

      <Status pay={pay} cardStatus={cardStatus} />

      {!done && (
        <button className="dc-btn" disabled={!canPay} onClick={onApprove}>
          {pay.kind === "paying" ? "Paying…" : pay.kind === "declined" || pay.kind === "error" ? `Try again · ${usd(card.total_cents)}` : `Approve & Pay ${usd(card.total_cents)}`}
        </button>
      )}
      <div className="dc-note">
        <span>Simulated wallet · Stripe test mode</span>
        <span>Deal {card.deal_id}</span>
      </div>
    </section>
  );
}
