/**
 * S2-owned. Presentational deal card: props in, markup out. No host calls here, so it can be
 * restyled freely and previewed with fixtures. Wiring to the host lives in view.tsx.
 *
 * Two places render it: inside ChatGPT/Claude (MCP App, the host's sandboxed frame) and as the hosted
 * approve page a messaging agent like Instinct links the shopper to. So: system fonts only, no external loads,
 * both themes, phone width. Every number shown comes from the stored deal; nothing here is invented.
 *
 * Look: a checkout receipt. Seller header with an honest countdown (neutral until the last 2 minutes), the
 * price with list struck through, what's included as line items, one black pay button, and the test-mode line.
 * Settled or closed deals lead with the outcome.
 */
import { useEffect, useState, type ReactNode } from "react";
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

/** The timer turns amber only in the last two minutes, so the card never manufactures urgency. */
const SOON_MS = 2 * 60_000;

function useCountdown(expiresAt: string, now: () => number) {
  const [left, setLeft] = useState(() => Date.parse(expiresAt) - now());
  useEffect(() => {
    const t = setInterval(() => setLeft(Date.parse(expiresAt) - now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt, now]);
  return left;
}

function formatLeft(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** "Extended warranty · 2 years" → ["Extended warranty", "2 years"]; "Free shipping" → ["Free shipping", "Included"]. */
function leverRow(label: string): [string, string] {
  const i = label.indexOf(" · ");
  return i > 0 ? [label.slice(0, i), label.slice(i + 3)] : [label, "Included"];
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "S";

const FONT = `ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif`;

const CSS = `
.dc{--bg:#fff;--ink:#111312;--ink2:#3c413e;--muted:#6b716d;--line:#eeefec;--edge:#e3e5e2;--btn:#111312;--btn-ink:#fff;
  --save:#0f7a52;--ok:#0f5e43;--ok-bg:#e8f2ed;--warn:#9a6200;--warn-bg:#fbf2df;--bad:#a8261c;--bad-bg:#fbecea;--av:#1d1f1e;
  font:14px/1.45 ${FONT};color:var(--ink);background:var(--bg);color-scheme:light;
  border:1px solid var(--edge);border-radius:16px;max-width:420px;overflow:hidden;box-sizing:border-box;
  box-shadow:0 1px 2px rgba(0,0,0,.04),0 18px 40px -28px rgba(17,19,18,.35);font-variant-numeric:tabular-nums}
.dc[data-theme=dark]{--bg:#17191a;--ink:#eef0ee;--ink2:#c9cdca;--muted:#9aa09c;--line:#26292a;--edge:#2e3233;--btn:#eef0ee;--btn-ink:#111312;
  --save:#5fc497;--ok:#7fd6ae;--ok-bg:#16271f;--warn:#e3b25c;--warn-bg:#2a2112;--bad:#f08a7a;--bad-bg:#2a1715;--av:#eef0ee;
  color-scheme:dark;box-shadow:0 18px 40px -28px rgba(0,0,0,.8)}
.dc[data-theme=dark] .dc-av{color:#111312}
.dc *{box-sizing:border-box}
.dc-h{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line)}
.dc-av{width:28px;height:28px;border-radius:7px;background:var(--av);color:#fff;font-weight:600;font-size:12px;display:grid;place-items:center;flex:none}
.dc-who{display:grid;line-height:1.2;min-width:0}
.dc-who b{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dc-who span{font-size:12px;color:var(--muted)}
.dc-t{margin-left:auto;font-size:12px;color:var(--muted);white-space:nowrap}
.dc-t.soon{color:var(--warn);font-weight:600}
.dc-t.done{color:var(--ok);font-weight:600}
.dc-b{padding:14px;display:grid;gap:12px}
.dc-title{margin:0;font:600 15px/1.3 ${FONT};color:var(--ink);letter-spacing:normal;text-transform:none;opacity:1;overflow-wrap:anywhere}
.dc-each{font-size:12.5px;color:var(--muted);margin-top:2px}
.dc-price{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.dc-price strong{font-size:30px;font-weight:650;letter-spacing:-.02em;line-height:1.05}
.dc-price s{color:var(--muted);font-size:14px}
.dc-price em{font-style:normal;font-size:12.5px;font-weight:600;color:var(--save)}
.dc-l{display:grid;gap:7px;padding:10px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:0}
.dc-l div{display:flex;justify-content:space-between;gap:12px;font-size:13px}
.dc-l dt{color:var(--ink)}
.dc-l dd{margin:0;color:var(--muted);text-align:right}
.dc-btn{appearance:none;border:0;border-radius:11px;height:46px;padding:0 14px;background:var(--btn);color:var(--btn-ink);
  font:600 15px/1 ${FONT};cursor:pointer;width:100%;display:flex;align-items:center;justify-content:center;gap:8px;font-variant-numeric:tabular-nums}
.dc-btn.quiet{background:transparent;color:var(--ink);border:1px solid var(--edge)}
.dc-btn:focus-visible{outline:2px solid var(--ok);outline-offset:2px}
.dc-btn[disabled]{cursor:default;opacity:.85}
.dc-spin{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent}
.dc-st{border-radius:11px;padding:11px 12px;font-size:13px;display:grid;gap:2px}
.dc-st b{font-weight:600;font-size:14px}
.dc-st .why{color:var(--ink2)}
.dc-st .ref{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.dc-st.ok{background:var(--ok-bg);color:var(--ok)}
.dc-st.warn{background:var(--warn-bg);color:var(--warn)}
.dc-st.bad{background:var(--bad-bg);color:var(--bad)}
.dc-st.big b{font-size:15.5px}
.dc-f{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:11.5px;color:var(--muted)}
.dc-f .test::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#c58a1a;margin-right:6px;vertical-align:1px}
@media (prefers-reduced-motion:no-preference){
  .dc-btn{transition:transform .1s}.dc-btn:active:not([disabled]){transform:scale(.99)}
  .dc-spin{animation:dcspin .8s linear infinite}
  .dc-st{animation:dcin .3s ease-out}
}
@keyframes dcspin{to{transform:rotate(360deg)}}
@keyframes dcin{from{opacity:0;transform:translateY(-3px)}}
`;

type Tone = "ok" | "warn" | "bad";
function Note({ tone, title, children, big, alert }: { tone: Tone; title: string; children?: ReactNode; big?: boolean; alert?: boolean }) {
  return (
    <div className={`dc-st ${tone}${big ? " big" : ""}`} role={alert ? "alert" : "status"}>
      <b>{title}</b>
      {children}
    </div>
  );
}

export function DealCardView({ card, pay, theme, onApprove, now = Date.now }: DealCardViewProps) {
  const left = useCountdown(card.expires_at, now);
  const expired = card.status === "expired" || (card.status === "ready" && left <= 0);
  const paid = card.status === "paid" || pay.kind === "succeeded";
  const done = paid || pay.kind === "processing";
  const closed = expired || card.status === "unavailable";
  const canPay = !expired && !done && card.status === "ready" && pay.kind !== "paying";
  const total = usd(card.total_cents);

  // Outcome first: once a deal is settled or closed, that's the headline.
  let top: ReactNode = null;
  if (paid)
    top = (
      <Note tone="ok" big title={`Paid ${total}`}>
        {pay.kind === "succeeded" && pay.card
          ? <span className="why">Charged once to {pay.card}.</span>
          : <span className="why">This deal is already paid. Nothing more to do.</span>}
        {pay.kind === "succeeded" && pay.payment_intent_id && <span className="ref">Receipt {pay.payment_intent_id}</span>}
      </Note>
    );
  else if (pay.kind === "processing")
    top = <Note tone="warn" big title="Payment processing"><span className="why">Stripe is confirming it. No need to pay again.</span></Note>;
  else if (expired)
    top = <Note tone="bad" big title="This offer expired"><span className="why">Nothing was charged. Ask the seller for a new offer.</span></Note>;
  else if (card.status === "unavailable")
    top = <Note tone="bad" big title="This deal can't be paid"><span className="why">Nothing was charged. Check the latest offer with the seller.</span></Note>;

  // Problems the buyer can act on sit right above the button.
  let act: ReactNode = null;
  if (pay.kind === "requires_action")
    act = <Note tone="warn" alert title="Your bank needs a confirmation"><span className="why">{pay.fix ?? "Complete the check, then approve again."}</span></Note>;
  else if (pay.kind === "refused")
    act = (
      <Note tone="bad" alert title="Not charged">
        {pay.reasons.length > 0 && <span className="why">{pay.reasons.join(" ")}</span>}
        {pay.fix && <span className="why">{pay.fix}</span>}
      </Note>
    );
  else if (pay.kind === "declined")
    act = <Note tone="bad" alert title="Card declined. Not charged."><span className="why">{pay.fix ?? "Try a different payment method."}</span></Note>;
  else if (pay.kind === "error")
    act = <Note tone="bad" alert title="Payment didn't go through"><span className="why">{pay.message ?? "Try again in a moment."}</span></Note>;

  const label =
    pay.kind === "paying" ? `Paying ${total}…`
      : pay.kind === "requires_action" ? `Approve again · ${total}`
      : pay.kind === "declined" || pay.kind === "error" || pay.kind === "refused" ? `Try again · ${total}`
      : `Approve & pay ${total}`;

  const soon = !closed && !done && left <= SOON_MS;
  const rows = card.levers.map((l) => leverRow(l.label));

  return (
    <section className="dc" data-theme={theme} aria-label={`Deal for ${card.product.title}`}>
      <style>{CSS}</style>
      <header className="dc-h">
        <span className="dc-av" aria-hidden="true">{initials(card.seller_name)}</span>
        <div className="dc-who"><b>{card.seller_name}</b><span>Seller's offer</span></div>
        {done ? <span className="dc-t done">{paid ? "Paid" : "Processing"}</span>
          : !closed && <span className={`dc-t${soon ? " soon" : ""}`} aria-live={soon ? "polite" : "off"}>Offer holds {formatLeft(left)}</span>}
      </header>

      <div className="dc-b">
        {top}

        <div>
          <h2 className="dc-title">{card.product.title}</h2>
          {card.quantity > 1 && <div className="dc-each">{usd(card.unit_price_cents)} each</div>}
        </div>

        <div className="dc-price">
          <strong>{total}</strong>
          {card.savings_cents > 0 && <><s>{usd(card.list_total_cents)}</s><em>You save {usd(card.savings_cents)}</em></>}
        </div>

        <dl className="dc-l" aria-label="What's included">
          {rows.map(([k, v], i) => <div key={card.levers[i]!.name}><dt>{k}</dt><dd>{v}</dd></div>)}
          <div><dt>Quantity</dt><dd>{card.quantity}</dd></div>
        </dl>

        {act}

        {!done && !closed && (
          <button className={`dc-btn${pay.kind === "refused" ? " quiet" : ""}`} type="button"
            disabled={!canPay} aria-busy={pay.kind === "paying"} onClick={onApprove}>
            {pay.kind === "paying" && <span className="dc-spin" aria-hidden="true" />}
            {label}
          </button>
        )}

        <div className="dc-f">
          <span className="test">Simulated wallet · Stripe test mode</span>
          <span>{done || closed ? `Ref ${card.deal_id}` : `Charged once, exactly ${total}`}</span>
        </div>
      </div>
    </section>
  );
}
