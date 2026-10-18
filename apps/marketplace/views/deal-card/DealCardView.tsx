/**
 * S2-owned. Presentational deal card: props in, markup out. No host calls here, so it can be
 * restyled freely and previewed with fixtures. Wiring to the host lives in view.tsx.
 *
 * Runs inside the chat host's sandboxed frame: system fonts only (no external loads), both themes,
 * phone width. Every number shown comes from the stored deal; nothing here is invented.
 *
 * Look: a quiet "generative field" header band (dashes riding slow waves) above a calm, crisp body.
 * The band moves while a decision is open, speeds up while paying, and goes still once the deal is
 * settled. Reduced motion: always still.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
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
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m left` : `${m}:${String(sec).padStart(2, "0")} left`;
}

type Motion = "live" | "busy" | "still";

/** Decorative header band. Carries no information; hidden from assistive tech. */
function WaveBand({ motion, theme }: { motion: Motion; theme: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const s = getComputedStyle(canvas);
    const base = s.getPropertyValue("--wv").trim() || "#2bd97a";
    const hot = s.getPropertyValue("--wv-hot").trim() || "#b9ffd5";
    const speed = motion === "busy" ? 3 : 1;
    let raf = 0, t = 7, last = 0, w = 0, h = 0;

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const height = (x: number, y: number) =>
      (Math.sin(x * 0.021 + t * 0.5) * Math.cos(y * 0.09 - t * 0.3) + Math.sin((x * 0.6 + y) * 0.03 + t * 0.7) * 0.6 + 1.6) / 3.2;
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = "round";
      const G = 9;
      for (let y = G / 2; y < h + G; y += G) {
        for (let x = G / 2; x < w + G; x += G) {
          const v = height(x, y);
          const ang = Math.atan2(height(x, y + 4) - v, height(x + 4, y) - v) + Math.PI / 2;
          const p = v * v * v;
          const len = 1.5 + p * 7;
          ctx.globalAlpha = 0.12 + p * 0.8;
          ctx.strokeStyle = p > 0.45 ? hot : base;
          ctx.lineWidth = 1 + p;
          const ux = Math.cos(ang) * len * 0.5, uy = Math.sin(ang) * len * 0.5;
          ctx.beginPath(); ctx.moveTo(x - ux, y - uy); ctx.lineTo(x + ux, y + uy); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    };
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 40) return; // ~25 fps is plenty for ambience
      t += (Math.min(now - last, 100) / 1000) * speed; last = now;
      draw();
    };
    size(); draw();
    if (motion !== "still" && !reduce) { last = performance.now(); raf = requestAnimationFrame(loop); }
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { size(); draw(); }) : null;
    ro?.observe(canvas);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); };
  }, [motion, theme]);
  return <canvas ref={ref} className="dc-wave" aria-hidden="true" />;
}

const FONT = `ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif`;
const MONO = `ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace`;

const CSS = `
.dc{--bg:#f7faf8;--band:#dbe7df;--ink:#0c1f17;--muted:#4f6359;--line:rgba(14,58,38,.14);
  --accent:#0f6a43;--accent-ink:#fff;--accent-glow:rgba(15,106,67,.28);--wv:#1f6b48;--wv-hot:#0b4a30;
  --chip:rgba(247,250,248,.86);--save:#0f6a43;--save-bg:rgba(15,106,67,.1);
  --warn:#8a530b;--warn-bg:#fbf0dd;--bad:#a8261c;--bad-bg:#fbe8e5;--ok:#0f6a43;--ok-bg:#e1f1e8;
  font:14px/1.45 ${FONT};color:var(--ink);background:var(--bg);color-scheme:light;
  border:1px solid var(--line);border-radius:16px;max-width:440px;overflow:hidden;box-sizing:border-box;
  box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px -20px rgba(12,31,23,.35)}
.dc[data-theme=dark]{--bg:#0a1310;--band:#050b08;--ink:#e2f2e8;--muted:#90a89a;--line:rgba(120,230,160,.14);
  --accent:#4ef08f;--accent-ink:#04120a;--accent-glow:rgba(78,240,143,.35);--wv:#2bd97a;--wv-hot:#c4ffdc;
  --chip:rgba(5,11,8,.78);--save:#6ff5a6;--save-bg:rgba(78,240,143,.12);
  --warn:#f2c06b;--warn-bg:rgba(242,192,107,.12);--bad:#ff8f84;--bad-bg:rgba(255,110,96,.13);--ok:#6ff5a6;--ok-bg:rgba(78,240,143,.1);
  color-scheme:dark;box-shadow:0 12px 32px -20px rgba(0,0,0,.8)}
.dc *{box-sizing:border-box}
.dc-band{position:relative;height:64px;background:var(--band);border-bottom:1px solid var(--line)}
.dc-wave{position:absolute;inset:0;width:100%;height:100%;display:block}
.dc-band-row{position:absolute;inset:0;display:flex;justify-content:space-between;align-items:center;gap:8px;padding:0 14px}
.dc-chip{font:600 11px/1 ${MONO};letter-spacing:.06em;padding:6px 9px;border-radius:999px;background:var(--chip);color:var(--ink);
  border:1px solid var(--line);white-space:nowrap;font-variant-numeric:tabular-nums;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
.dc-chip.seller{text-transform:uppercase;max-width:60%;overflow:hidden;text-overflow:ellipsis}
.dc-chip.soon{color:var(--warn);background:var(--warn-bg)}
.dc-chip.done{color:var(--ok)}
.dc-body{padding:16px 16px 14px;display:grid;gap:14px}
.dc-title{font:650 17px/1.25 ${FONT};margin:0;letter-spacing:-.005em;text-transform:none;opacity:1;color:var(--ink);text-wrap:balance}
.dc-qty{font:500 12px/1.3 ${MONO};color:var(--muted);margin-top:3px}
.dc-price{display:grid;gap:4px}
.dc-total{font:700 34px/1 ${FONT};letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.dc-was{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}
.dc-was s{text-decoration-thickness:1px}
.dc-save{font-weight:650;color:var(--save);background:var(--save-bg);padding:3px 8px;border-radius:999px}
.dc-inc{display:grid;gap:7px;padding-top:12px;border-top:1px dashed var(--line)}
.dc-inc-h{font:600 10.5px/1 ${MONO};letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.dc-levers{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.dc-levers li{display:flex;gap:9px;align-items:center}
.dc-levers li::before{content:"";width:12px;height:12px;flex:none;border-radius:3px;
  background:radial-gradient(circle,var(--accent) 1.2px,transparent 1.6px) 0 0/4px 4px;opacity:.9}
.dc-status{border-radius:12px;padding:11px 12px;font-size:13px;display:grid;gap:3px}
.dc-status b{font-weight:650;font-size:14px}
.dc-status .why{color:var(--ink);opacity:.86}
.dc-status .ref{font:500 11.5px/1.35 ${MONO};color:var(--ink);opacity:.7;overflow-wrap:anywhere}
.dc-status.ok{background:var(--ok-bg);color:var(--ok)}
.dc-status.warn{background:var(--warn-bg);color:var(--warn)}
.dc-status.bad{background:var(--bad-bg);color:var(--bad)}
.dc-status.big b{font-size:16px}
.dc-act{display:grid;gap:8px}
.dc-commit{font-size:12px;color:var(--muted);text-align:center;font-variant-numeric:tabular-nums}
.dc-btn{appearance:none;border:0;border-radius:12px;padding:13px 14px;font:650 15px/1.2 ${FONT};cursor:pointer;width:100%;
  background:var(--accent);color:var(--accent-ink);box-shadow:0 6px 18px -8px var(--accent-glow);
  display:flex;justify-content:center;align-items:center;gap:9px;font-variant-numeric:tabular-nums}
.dc-btn.quiet{background:transparent;color:var(--ink);border:1px solid var(--line);box-shadow:none}
.dc-btn:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.dc-btn[disabled]{cursor:default}
.dc-btn.busy{opacity:.85}
.dc-spin{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent}
.dc-foot{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;font-size:11.5px;color:var(--muted);
  padding-top:10px;border-top:1px solid var(--line)}
.dc-test{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:var(--ink);opacity:.8}
.dc-test::before{content:"";width:7px;height:7px;border-radius:2px;background:var(--warn)}
.dc-ref{font:500 11px/1 ${MONO}}
@media (prefers-reduced-motion:no-preference){
  .dc-btn{transition:transform .08s,box-shadow .2s}.dc-btn:active:not([disabled]){transform:scale(.99)}
  .dc-spin{animation:dcspin .8s linear infinite}
  .dc-status{animation:dcin .25s ease-out}
}
@keyframes dcspin{to{transform:rotate(360deg)}}
@keyframes dcin{from{opacity:0;transform:translateY(-3px)}}
`;

type Tone = "ok" | "warn" | "bad";
function Note({ tone, title, children, big, alert }: { tone: Tone; title: string; children?: ReactNode; big?: boolean; alert?: boolean }) {
  return (
    <div className={`dc-status ${tone}${big ? " big" : ""}`} role={alert ? "alert" : "status"}>
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
          ? <span className="why">Charged to {pay.card}.</span>
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
      : `Approve & Pay ${total}`;

  const motion: Motion = done || closed ? "still" : pay.kind === "paying" ? "busy" : "live";
  const soon = !closed && !done && left <= SOON_MS;

  return (
    <section className="dc" data-theme={theme} aria-label={`Deal for ${card.product.title}`}>
      <style>{CSS}</style>
      <div className="dc-band">
        <WaveBand motion={motion} theme={theme} />
        <div className="dc-band-row">
          <span className="dc-chip seller">{card.seller_name}</span>
          {done ? <span className="dc-chip done">{paid ? "Paid" : "Processing"}</span>
            : !closed && <span className={`dc-chip${soon ? " soon" : ""}`} aria-live={soon ? "polite" : "off"}>{formatLeft(left)}</span>}
        </div>
      </div>

      <div className="dc-body">
        {top}

        <div>
          <h2 className="dc-title">{card.product.title}</h2>
          {card.quantity > 1 && <div className="dc-qty">Qty {card.quantity} · {usd(card.unit_price_cents)} each</div>}
        </div>

        <div className="dc-price">
          <span className="dc-total">{total}</span>
          {card.savings_cents > 0 && (
            <span className="dc-was">
              <span>List <s>{usd(card.list_total_cents)}</s></span>
              <span className="dc-save">You save {usd(card.savings_cents)}</span>
            </span>
          )}
        </div>

        {card.levers.length > 0 && (
          <div className="dc-inc">
            <span className="dc-inc-h" id={`inc-${card.deal_id}`}>Included</span>
            <ul className="dc-levers" aria-labelledby={`inc-${card.deal_id}`}>
              {card.levers.map((l) => <li key={l.name}>{l.label}</li>)}
            </ul>
          </div>
        )}

        {act}

        {!done && !closed && (
          <div className="dc-act">
            <button className={`dc-btn${pay.kind === "refused" ? " quiet" : ""}${pay.kind === "paying" ? " busy" : ""}`}
              disabled={!canPay} aria-busy={pay.kind === "paying"} onClick={onApprove}>
              {pay.kind === "paying" && <span className="dc-spin" aria-hidden="true" />}
              {label}
            </button>
            <span className="dc-commit">You're charged once, exactly {total}.</span>
          </div>
        )}

        <div className="dc-foot">
          <span className="dc-test">Simulated wallet · Stripe test mode</span>
          <span className="dc-ref">Ref {card.deal_id}</span>
        </div>
      </div>
    </section>
  );
}
