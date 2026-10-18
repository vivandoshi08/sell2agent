/**
 * Cold open, 0:00–0:07 (no faces). Drawn entirely in code, no recordings needed:
 *   0.0–1.5  hero shot of one keyboard, slow push in
 *   1.5–3.4  the camera pulls back ("In a sea of keyboards," from 2.0 s): the hero is one board in a grid of many
 *   3.3–5.4  three agents haggling (Grok, Claude, ChatGPT), bubbles landing
 *   5.3–7.0  the hero board returns, small and ringed, over "Why did my agent pick this one?"
 * VO (Ananya): "I asked my agent for a quiet keyboard. Why did it pick this one?"
 * mode=green swaps the three chat panes for #00FF00 so real recordings can be keyed in instead.
 * Prices shown are only ones in the README ($129 list, $118, $110).
 */
import type { ReactElement } from "react";
import { W, H, easeOut, ramp } from "./segments";
import "./cold.css";

export const COLD = {
  duration: 7,
  panes: [0, 1, 2].map((i) => ({ x: 84 + i * (560 + 36), y: 150, w: 560, h: 760 })),
};

const easeInOut = (p: number) => { const x = Math.min(Math.max(p, 0), 1); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

// ---------- keyboard (original drawing, generic 75% layout) ----------
type Way = { case: string; cap: string; mod: string; accent: string; legend?: boolean };
const ROWS: number[][] = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2],
  [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5],
  [1.75, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.25],
  [2.25, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.75, 1],
  [1.25, 1.25, 1.25, 6.25, 1, 1, 1, 1, 1, 1],
];
function Keyboard({ way, id }: { way: Way; id: string }) {
  const u = 17.4, kh = 15.2, x0 = 11, y0 = 11, keys: ReactElement[] = [];
  ROWS.forEach((row, r) => {
    let x = x0;
    row.forEach((w, c) => {
      const isMod = w !== 1 || r === 0;
      const accent = (r === 0 && c === 0) || (r === 3 && c === row.length - 1);
      const fill = accent ? way.accent : isMod ? way.mod : way.cap;
      const kw = w * u - 2.4, ky = y0 + r * (kh + 2.3);
      keys.push(
        <g key={`${r}-${c}`}>
          <rect x={x} y={ky} width={kw} height={kh} rx={2.6} fill={fill} />
          <rect x={x + 1.6} y={ky + 1.1} width={kw - 3.2} height={kh - 4.2} rx={2} fill="#fff" opacity={0.09} />
        </g>,
      );
      x += w * u;
    });
  });
  return (
    <svg viewBox="0 0 300 126" className="kb" aria-hidden="true">
      <defs>
        <linearGradient id={`case-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={way.case} stopOpacity="1" />
          <stop offset="1" stopColor="#000" stopOpacity=".35" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="298" height="124" rx="11" fill={way.case} />
      <rect x="1" y="1" width="298" height="124" rx="11" fill={`url(#case-${id})`} opacity=".5" />
      <rect x="6" y="6" width="288" height="114" rx="7" fill="#000" opacity=".28" />
      {keys}
      <circle cx="283" cy="18.6" r="6.4" fill={way.mod} />
      <circle cx="283" cy="18.6" r="3.6" fill="#000" opacity=".25" />
    </svg>
  );
}

const HERO: Way = { case: "#1d201e", cap: "#e9e6dc", mod: "#b9bfbb", accent: "#5fc497" };
const WAYS: Way[] = [
  { case: "#1a1d1b", cap: "#3c413e", mod: "#2e3330", accent: "#6c726e" },
  { case: "#22262a", cap: "#5b6470", mod: "#3d444c", accent: "#8a95a3" },
  { case: "#262321", cap: "#8a7f6a", mod: "#5e574b", accent: "#b0a68f" },
  { case: "#1c1f1d", cap: "#c9cdca", mod: "#6c726e", accent: "#959b97" },
  { case: "#201e24", cap: "#5d5668", mod: "#3e3946", accent: "#857c92" },
  { case: "#1e2220", cap: "#4a504c", mod: "#2a2f2c", accent: "#e3b25c" },
];

// World: a 9×7 grid of boards; the hero is the centre one. The camera maps a world point to the screen.
const TW = 300, TH = 126, GX = 46, GY = 44, COLS = 9, ROWS_N = 7;
const HC = 4, HR = 3;
const heroCx = HC * (TW + GX) + TW / 2, heroCy = HR * (TH + GY) + TH / 2;

function Sea({ t }: { t: number }) {
  // push 0→1.5 (5.0→5.35), pull back 1.5→3.3 (→0.86); hero drifts from screen centre down to y=690
  const pull = easeInOut(ramp(t, 1.45, 1.85));
  const s = pull > 0 ? lerp(5.35, 0.86, pull) : lerp(5.0, 5.35, easeOut(ramp(t, 0, 1.5)));
  const sy = lerp(H / 2, 690, pull);
  const others = ramp(t, 1.6, 1.2);
  const ring = ramp(t, 2.9, 0.4);
  const out = ramp(t, 3.25, 0.5); // the sea recedes behind the panes
  const tiles: ReactElement[] = [];
  for (let r = 0; r < ROWS_N; r++) for (let c = 0; c < COLS; c++) {
    const hero = r === HR && c === HC;
    const way = hero ? HERO : WAYS[(r * 5 + c * 3 + (r % 2)) % WAYS.length];
    tiles.push(
      <div key={`${r}-${c}`} className={`tile${hero ? " hero" : ""}`}
        style={{ left: c * (TW + GX), top: r * (TH + GY), width: TW, height: TH, opacity: hero ? 1 : others * 0.62 }}>
        <Keyboard way={way} id={`${r}-${c}`} />
        {hero && <div className="hero-ring" style={{ opacity: ring, borderWidth: 2 / s, boxShadow: `0 0 0 ${6 / s}px rgba(95,196,151,.16), 0 0 ${40 / s}px rgba(95,196,151,.3)` }} />}
      </div>,
    );
  }
  return (
    <div className="sea" style={{ opacity: 1 - out * 0.82, filter: out > 0 ? `blur(${out * 6}px)` : undefined }}>
      <div className="spot" style={{ opacity: 1 - others * 0.6 }} />
      <div className="world" style={{ transform: `translate(${W / 2}px, ${sy}px) scale(${s}) translate(${-heroCx}px, ${-heroCy}px)` }}>
        {tiles}
      </div>
    </div>
  );
}

// ---------- three agents haggling ----------
type Msg = { who: "buyer" | "seller" | "deal"; text: string; seller?: string };
const AGENTS: { name: string; cls: string; letter: string; ask: string; msgs: Msg[] }[] = [
  {
    name: "Grok", cls: "a-grok", letter: "G", ask: "price first", msgs: [
      { who: "buyer", text: "Quiet mechanical keyboard, under $130?" },
      { who: "seller", seller: "KeyForge", text: "KeyForge Quiet 75 lists at $129. For you, $118." },
      { who: "buyer", text: "Deal at $118." },
    ],
  },
  {
    name: "Claude", cls: "a-claude", letter: "C", ask: "build quality first", msgs: [
      { who: "buyer", text: "Which board has the best warranty?" },
      { who: "seller", seller: "TypeWell", text: "TypeWell 65 Silent. I'll include an extended warranty." },
      { who: "buyer", text: "The warranty matters more. Taking it." },
    ],
  },
  {
    name: "ChatGPT", cls: "a-chatgpt", letter: "C", ask: "tough buyer", msgs: [
      { who: "buyer", text: "Would you take $110?" },
      { who: "seller", seller: "KeyForge", text: "$110 works. Locking the deal for you." },
      { who: "deal", text: "Deal locked · $110" },
    ],
  },
];

function Panes({ t, green }: { t: number; green: boolean }) {
  const dim = ramp(t, 5.25, 0.4);
  return (
    <>
      {AGENTS.map((a, i) => {
        const r = COLD.panes[i];
        const p = easeOut(ramp(t, 3.3 + i * 0.09, 0.55));
        if (p <= 0) return null;
        const style = { left: r.x, top: r.y + (1 - p) * 40, width: r.w, height: r.h, opacity: green ? 1 : p };
        if (green) return <div key={i} className="cpane key" style={{ ...style, top: r.y }} />;
        return (
          <div key={i} className="cpane" style={{ ...style, transform: dim ? `scale(${1 - dim * 0.03})` : undefined, filter: dim ? `brightness(${1 - dim * 0.72}) blur(${dim * 5}px)` : undefined }}>
            <div className="cp-h">
              <span className={`cav ${a.cls}`}>{a.letter}</span>
              <div className="cp-who"><b>{a.name}</b><span>shopping for a quiet keyboard · {a.ask}</span></div>
              <i className="live" />
            </div>
            <div className="cp-body">
              {a.msgs.map((m, j) => {
                const at = 3.65 + i * 0.16 + j * 0.52;
                const o = ramp(t, at, 0.28);
                if (o <= 0) return null;
                const lift = (1 - easeOut(o)) * 14;
                if (m.who === "deal") return <div key={j} className="deal" style={{ opacity: o, transform: `translateY(${lift}px)` }}><i />{m.text}</div>;
                return (
                  <div key={j} className={`msg ${m.who}`} style={{ opacity: o, transform: `translateY(${lift}px)` }}>
                    <span className="from">{m.who === "buyer" ? a.name : `${m.seller} · seller agent`}</span>
                    <p>{m.text}</p>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

export function ColdOpen({ t, mode }: { t: number; mode: string }) {
  const green = mode === "green";
  const seaText = Math.min(ramp(t, 1.95, 0.4), 1 - ramp(t, 3.2, 0.3));
  const seaLift = (1 - easeOut(ramp(t, 1.95, 0.55))) * 24;
  const why = ramp(t, 5.35, 0.4);
  const whyLift = (1 - easeOut(why)) * 24;
  return (
    <div className="cold" style={{ width: W, height: H }}>
      <Sea t={t} />
      {seaText > 0 && <h1 className="big sea-text" style={{ opacity: seaText, transform: `translateY(${seaLift}px)` }}>In a sea of keyboards,</h1>}
      <Panes t={t} green={green} />
      {why > 0 && (
        <div className="why-hero" style={{ opacity: why, transform: `translateY(${whyLift * 0.6}px) scale(${0.94 + 0.06 * easeOut(why)})` }}>
          <Keyboard way={HERO} id="why" />
          <div className="hero-ring" />
        </div>
      )}
      {why > 0 && <h1 className="big why" style={{ opacity: why, transform: `translateY(${whyLift}px)` }}>Why did my agent pick <em>this one?</em></h1>}
    </div>
  );
}
