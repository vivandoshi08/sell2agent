/**
 * S2-owned. Presentational deal card: props in, markup out. No host calls here, so it can be
 * restyled freely and previewed with fixtures. Wiring to the host lives in view.tsx.
 *
 * Runs inside the chat host's sandboxed frame: system fonts only (no external loads), both themes,
 * phone width. Every number shown comes from the stored deal; nothing here is invented.
 *
 * Look: an always-dark "screen" header band (flowing dashes, contour lines, circuit traces with pulses)
 * above a calm body that follows the host theme. Numbers and labels use the system monospace face.
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

/** Decorative header band: an always-dark "screen" with flowing dashes, contour lines and circuit traces.
 * Carries no information; hidden from assistive tech. */
const BAND_FIELD = "#27c96f", BAND_HOT = "#c4ffdc", BAND_CONTOUR = "#35d982", BAND_TRACE = "#25a865";

function WaveBand({ motion }: { motion: Motion }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const speed = motion === "busy" ? 3 : 1;
    let raf = 0, t = 7, last = 0, w = 0, h = 0, clock = 0;
    type Pt = [number, number];
    let traces: { pts: Pt[]; seg: number[]; len: number; off: number; v: number }[] = [];

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Fixed circuit layout along the right side of the band, scaled to its width.
      const R = w - 8;
      const raw: Pt[][] = [
        [[R - 150, h + 2], [R - 150, h - 22], [R - 132, h - 40], [R - 60, h - 40], [R - 44, h - 56], [R - 44, -2]],
        [[R - 210, -2], [R - 210, 14], [R - 194, 30], [R - 96, 30], [R - 80, 46], [R - 80, h + 2]],
        [[w * 0.32, h + 2], [w * 0.32, h - 14], [w * 0.32 + 14, h - 28], [w * 0.5, h - 28]],
      ];
      traces = raw.map((pts, i) => {
        const seg = pts.slice(1).map((p, k) => Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1]));
        return { pts, seg, len: seg.reduce((x, y) => x + y, 0), off: i * 57, v: 36 + i * 14 };
      });
    };
    const height = (x: number, y: number) =>
      (Math.sin(x * 0.021 + t * 0.5) * Math.cos(y * 0.09 - t * 0.3) + Math.sin((x * 0.6 + y) * 0.03 + t * 0.7) * 0.6 + 1.6) / 3.2;
    const at = (tr: (typeof traces)[number], d: number): Pt => {
      let r = ((d % tr.len) + tr.len) % tr.len;
      for (let i = 0; i < tr.seg.length; i++) {
        if (r <= tr.seg[i]) { const f = r / tr.seg[i], a = tr.pts[i], b = tr.pts[i + 1]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; }
        r -= tr.seg[i];
      }
      return tr.pts[tr.pts.length - 1];
    };
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      // contour lines (marching squares)
      const C = 8, cols = Math.ceil(w / C) + 1, rows = Math.ceil(h / C) + 1;
      const g = new Float32Array(cols * rows);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) g[j * cols + i] = height(i * C, j * C);
      ctx.strokeStyle = BAND_CONTOUR; ctx.lineWidth = 1;
      [0.42, 0.56, 0.7].forEach((lv, li) => {
        ctx.globalAlpha = 0.16 + li * 0.08;
        ctx.beginPath();
        for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
          const a = g[j * cols + i], b = g[j * cols + i + 1], c = g[(j + 1) * cols + i + 1], d = g[(j + 1) * cols + i];
          const k = (a > lv ? 8 : 0) | (b > lv ? 4 : 0) | (c > lv ? 2 : 0) | (d > lv ? 1 : 0);
          if (k === 0 || k === 15) continue;
          const x = i * C, y = j * C;
          const T: Pt = [x + C * ((lv - a) / (b - a)), y], Rt: Pt = [x + C, y + C * ((lv - b) / (c - b))];
          const B: Pt = [x + C * ((lv - d) / (c - d)), y + C], L: Pt = [x, y + C * ((lv - a) / (d - a))];
          const s = (p: Pt, q: Pt) => { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); };
          if (k === 1 || k === 14) s(L, B); else if (k === 2 || k === 13) s(B, Rt); else if (k === 3 || k === 12) s(L, Rt);
          else if (k === 4 || k === 11) s(T, Rt); else if (k === 6 || k === 9) s(T, B); else if (k === 7 || k === 8) s(L, T);
          else if (k === 5) { s(L, T); s(B, Rt); } else { s(T, Rt); s(L, B); }
        }
        ctx.stroke();
      });
      // flow dashes
      ctx.lineCap = "round";
      const G = 10;
      for (let y = G / 2; y < h + G; y += G) for (let x = G / 2; x < w + G; x += G) {
        const v = height(x, y), p = v * v * v;
        const ang = Math.atan2(height(x, y + 4) - v, height(x + 4, y) - v) + Math.PI / 2;
        const len = 1.5 + p * 6;
        ctx.globalAlpha = 0.08 + p * 0.6;
        ctx.strokeStyle = p > 0.45 ? BAND_HOT : BAND_FIELD;
        ctx.lineWidth = 1 + p * 0.8;
        const ux = Math.cos(ang) * len * 0.5, uy = Math.sin(ang) * len * 0.5;
        ctx.beginPath(); ctx.moveTo(x - ux, y - uy); ctx.lineTo(x + ux, y + uy); ctx.stroke();
      }
      // circuit traces + pulses
      ctx.strokeStyle = BAND_TRACE; ctx.fillStyle = BAND_TRACE; ctx.lineWidth = 1.3; ctx.lineJoin = "round"; ctx.globalAlpha = 0.7;
      for (const tr of traces) {
        ctx.beginPath(); tr.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
        for (let i = 1; i < tr.pts.length - 1; i += 2) { ctx.beginPath(); ctx.arc(tr.pts[i][0], tr.pts[i][1], 2, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.fillStyle = BAND_HOT;
      for (const tr of traces) for (let k = 0; k < 5; k++) {
        const [px, py] = at(tr, tr.off + clock * tr.v * speed - k * 4);
        ctx.globalAlpha = 0.95 * (1 - k / 5);
        ctx.beginPath(); ctx.arc(px, py, k ? 1.4 : 2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 40) return; // ~25 fps is plenty for ambience
      const dt = Math.min(now - last, 100) / 1000;
      t += dt * speed; clock += dt; last = now;
      draw();
    };
    size(); draw();
    if (motion !== "still" && !reduce) { last = performance.now(); raf = requestAnimationFrame(loop); }
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { size(); draw(); }) : null;
    ro?.observe(canvas);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); };
  }, [motion]);
  return <canvas ref={ref} className="dc-wave" aria-hidden="true" />;
}

const FONT = `ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif`;
const MONO = `ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace`;

const CSS = `
.dc{--bg:#f7faf8;--ink:#0c1f17;--muted:#4f6359;--line:rgba(14,58,38,.14);
  --accent:#0f6a43;--accent-ink:#fff;--accent-glow:rgba(15,106,67,.28);--total:#0c1f17;--total-glow:transparent;--save:#0f6a43;--save-bg:rgba(15,106,67,.1);
  --warn:#8a530b;--warn-bg:#fbf0dd;--bad:#a8261c;--bad-bg:#fbe8e5;--ok:#0f6a43;--ok-bg:#e1f1e8;
  font:14px/1.45 ${FONT};color:var(--ink);background:var(--bg);color-scheme:light;
  border:1px solid var(--line);border-radius:16px;max-width:440px;overflow:hidden;box-sizing:border-box;
  box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px -20px rgba(12,31,23,.35)}
.dc[data-theme=dark]{--bg:#07100c;--ink:#e2f2e8;--muted:#90a89a;--line:rgba(120,230,160,.14);
  --accent:#46f28c;--accent-ink:#03120a;--accent-glow:rgba(70,242,140,.45);--total:#46f28c;--total-glow:rgba(70,242,140,.5);--save:#6ff5a6;--save-bg:rgba(78,240,143,.12);
  --warn:#f2c06b;--warn-bg:rgba(242,192,107,.12);--bad:#ff8f84;--bad-bg:rgba(255,110,96,.13);--ok:#6ff5a6;--ok-bg:rgba(78,240,143,.1);
  color-scheme:dark;box-shadow:0 12px 32px -20px rgba(0,0,0,.8)}
.dc *{box-sizing:border-box}
.dc-band{position:relative;height:84px;background:radial-gradient(120% 140% at 0% 0%,#0b1c14,#030806 70%);border-bottom:1px solid rgba(110,240,160,.18)}
.dc-wave{position:absolute;inset:0;width:100%;height:100%;display:block}
.dc-band-row{position:absolute;inset:0;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:12px 14px}
.dc-chip{font:600 11px/1 ${MONO};letter-spacing:.06em;padding:6px 9px;border-radius:999px;background:rgba(3,8,6,.78);color:#dcf5e6;
  border:1px solid rgba(110,240,160,.22);white-space:nowrap;font-variant-numeric:tabular-nums;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
.dc-chip.seller{text-transform:uppercase;max-width:60%;overflow:hidden;text-overflow:ellipsis}
.dc-chip.soon{color:#f4c46c;border-color:rgba(244,196,108,.45)}
.dc-chip.done{color:#6ff5a6;text-shadow:0 0 8px rgba(70,242,140,.6)}
.dc-body{padding:16px 16px 14px;display:grid;gap:14px}
.dc-title{font:600 16px/1.3 ${FONT};margin:0;letter-spacing:-.005em;text-transform:none;opacity:1;color:var(--ink);text-wrap:balance}
.dc-qty{font:500 12px/1.3 ${MONO};color:var(--muted);margin-top:3px}
.dc-price{display:grid;gap:4px}
.dc-total{font:700 34px/1 ${MONO};letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:var(--total);text-shadow:0 0 18px var(--total-glow)}
.dc-was{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font:12.5px/1.3 ${MONO};color:var(--muted);font-variant-numeric:tabular-nums}
.dc-was s{text-decoration-thickness:1px}
.dc-save{font-weight:600;color:var(--save);background:var(--save-bg);padding:3px 8px;border-radius:999px}
.dc-inc{display:grid;gap:7px;padding-top:12px;border-top:1px dashed var(--line)}
.dc-inc-h{font:600 10.5px/1 ${MONO};letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.dc-levers{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.dc-levers li{display:flex;gap:9px;align-items:center}
.dc-levers li::before{content:"";width:12px;height:12px;flex:none;border-radius:3px;
  background:radial-gradient(circle,var(--accent) 1.2px,transparent 1.6px) 0 0/4px 4px;opacity:.9}
.dc-status{border-radius:12px;padding:11px 12px;font-size:13px;display:grid;gap:3px}
.dc-status b{font:700 13.5px/1.3 ${MONO}}
.dc-status .why{color:var(--ink);opacity:.86}
.dc-status .ref{font:500 11.5px/1.35 ${MONO};color:var(--ink);opacity:.7;overflow-wrap:anywhere}
.dc-status.ok{background:var(--ok-bg);color:var(--ok)}
.dc-status.warn{background:var(--warn-bg);color:var(--warn)}
.dc-status.bad{background:var(--bad-bg);color:var(--bad)}
.dc-status.big b{font-size:15.5px}
.dc-act{display:grid;gap:8px}
.dc-commit{font:11.5px/1.3 ${MONO};color:var(--muted);text-align:center;font-variant-numeric:tabular-nums}
.dc-btn{appearance:none;border:0;border-radius:12px;padding:13px 14px;font:700 14px/1.2 ${MONO};letter-spacing:.01em;cursor:pointer;width:100%;
  background:var(--accent);color:var(--accent-ink);box-shadow:0 6px 18px -8px var(--accent-glow);
  display:flex;justify-content:center;align-items:center;gap:9px;font-variant-numeric:tabular-nums}
.dc-btn.quiet{background:transparent;color:var(--ink);border:1px solid var(--line);box-shadow:none}
.dc-btn:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.dc-btn[disabled]{cursor:default}
.dc-btn.busy{opacity:.85}
.dc-spin{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent}
.dc-foot{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;font-size:11.5px;color:var(--muted);
  padding-top:10px;border-top:1px solid var(--line)}
.dc-test{display:inline-flex;align-items:center;gap:6px;font:600 11px/1.2 ${MONO};color:var(--ink);opacity:.8}
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
        <WaveBand motion={motion} />
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
