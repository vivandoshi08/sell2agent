/**
 * Decorative background, three layers on one canvas:
 *  1. a flow field of short dashes riding slow interference waves (the "terrain"),
 *  2. topographic contour lines traced from the same height field, drifting with it,
 *  3. circuit traces (orthogonal runs, 45° bends, solder pads) with light pulses travelling along them.
 * Purely ornamental: carries no data, sits behind every panel, hidden from assistive tech.
 * Colors come from CSS tokens. Reduced motion: one still frame. Hidden tab: stops drawing.
 */
import { useEffect, useRef } from "react";

const GAP = 22;        // dash grid spacing, px
const CELL = 26;       // contour sampling cell, px
const LEVELS = [0.38, 0.5, 0.62, 0.74];
const FPS = 30;

type Pt = [number, number];
interface Trace { pts: Pt[]; len: number; seg: number[]; speed: number; offset: number }

/** Seeded PRNG so the circuit layout is stable across reloads. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildTraces(w: number, h: number): Trace[] {
  const r = rng(7);
  const out: Trace[] = [];
  const count = Math.round((w * h) / 90_000);
  const step = 26;
  for (let n = 0; n < count; n++) {
    // start on a grid point, mostly from the left and right thirds so the centre stays calm
    const side = r() < 0.5 ? r() * 0.3 : 0.7 + r() * 0.3;
    let x = Math.round((side * w) / step) * step, y = Math.round((r() * h) / step) * step;
    const pts: Pt[] = [[x, y]];
    let dir = r() < 0.5 ? 0 : 2; // 0 right, 1 down, 2 left, 3 up (cardinal) ; diagonals as 45° bends
    const runs = 3 + Math.floor(r() * 4);
    for (let k = 0; k < runs; k++) {
      const len = step * (2 + Math.floor(r() * 7));
      const d = [[1, 0], [0, 1], [-1, 0], [0, -1]][dir];
      x += d[0] * len; y += d[1] * len; pts.push([x, y]);
      // 45° chamfer into the next run
      const turn = r() < 0.5 ? 1 : 3;
      const nd = (dir + turn) % 4, e = [[1, 0], [0, 1], [-1, 0], [0, -1]][nd];
      x += (d[0] + e[0]) * step * 0.6; y += (d[1] + e[1]) * step * 0.6; pts.push([x, y]);
      dir = nd;
    }
    const seg: number[] = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); total += l; }
    out.push({ pts, len: total, seg, speed: 40 + r() * 70, offset: r() * total });
  }
  return out;
}

function pointAt(t: Trace, d: number): Pt {
  let rem = ((d % t.len) + t.len) % t.len;
  for (let i = 0; i < t.seg.length; i++) {
    if (rem <= t.seg[i]) {
      const f = rem / t.seg[i], a = t.pts[i], b = t.pts[i + 1];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    rem -= t.seg[i];
  }
  return t.pts[t.pts.length - 1];
}

export function WaveField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    let w = 0, h = 0, raf = 0, last = 0, t = 0;
    let traces: Trace[] = [];
    let field = "#2bd97a", hot = "#c4ffdc", contour = "#3fe08c", trace = "#1f9d5c";

    const readColors = () => {
      const s = getComputedStyle(canvas);
      const get = (n: string, d: string) => s.getPropertyValue(n).trim() || d;
      field = get("--field", field); hot = get("--field-hot", hot); contour = get("--contour", contour); trace = get("--trace", trace);
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      traces = buildTraces(w, h);
    };

    const height = (x: number, y: number) => {
      const a = Math.sin(x * 0.0062 + t * 0.21) * Math.cos(y * 0.0085 - t * 0.16);
      const b = Math.sin((x + y) * 0.0041 + t * 0.33);
      const c = Math.sin(x * 0.017 - y * 0.013 + t * 0.47) * 0.35;
      return (a + b * 0.6 + c + 1.95) / 3.9;
    };

    const drawDashes = () => {
      ctx.lineCap = "round";
      const cols = Math.ceil(w / GAP) + 1, rows = Math.ceil(h / GAP) + 1;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const x = i * GAP, y = j * GAP;
          const v = height(x, y);
          const ang = Math.atan2(height(x, y + 6) - v, height(x + 6, y) - v) + Math.PI / 2;
          const peak = v * v * v;
          const len = 2 + peak * 10;
          ctx.globalAlpha = 0.04 + peak * 0.45;
          ctx.strokeStyle = peak > 0.42 ? hot : field;
          ctx.lineWidth = 1 + peak;
          const cy = y - peak * 6, ux = Math.cos(ang) * len * 0.5, uy = Math.sin(ang) * len * 0.5;
          ctx.beginPath(); ctx.moveTo(x - ux, cy - uy); ctx.lineTo(x + ux, cy + uy); ctx.stroke();
        }
      }
    };

    // Marching squares over the same height field: map-like contour lines.
    const drawContours = () => {
      const cols = Math.ceil(w / CELL) + 1, rows = Math.ceil(h / CELL) + 1;
      const g = new Float32Array(cols * rows);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) g[j * cols + i] = height(i * CELL, j * CELL);
      ctx.strokeStyle = contour;
      ctx.lineWidth = 1;
      LEVELS.forEach((lv, li) => {
        ctx.globalAlpha = 0.14 + li * 0.06;
        ctx.beginPath();
        for (let j = 0; j < rows - 1; j++) {
          for (let i = 0; i < cols - 1; i++) {
            const a = g[j * cols + i], b = g[j * cols + i + 1], c = g[(j + 1) * cols + i + 1], d = g[(j + 1) * cols + i];
            const idx = (a > lv ? 8 : 0) | (b > lv ? 4 : 0) | (c > lv ? 2 : 0) | (d > lv ? 1 : 0);
            if (idx === 0 || idx === 15) continue;
            const x = i * CELL, y = j * CELL;
            const top: Pt = [x + CELL * ((lv - a) / (b - a)), y];
            const right: Pt = [x + CELL, y + CELL * ((lv - b) / (c - b))];
            const bottom: Pt = [x + CELL * ((lv - d) / (c - d)), y + CELL];
            const left: Pt = [x, y + CELL * ((lv - a) / (d - a))];
            const seg = (p: Pt, q: Pt) => { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); };
            switch (idx) {
              case 1: case 14: seg(left, bottom); break;
              case 2: case 13: seg(bottom, right); break;
              case 3: case 12: seg(left, right); break;
              case 4: case 11: seg(top, right); break;
              case 6: case 9: seg(top, bottom); break;
              case 7: case 8: seg(left, top); break;
              case 5: seg(left, top); seg(bottom, right); break;
              case 10: seg(top, right); seg(left, bottom); break;
            }
          }
        }
        ctx.stroke();
      });
    };

    const drawTraces = (now: number) => {
      ctx.lineWidth = 1.4;
      ctx.lineJoin = "round";
      ctx.strokeStyle = trace;
      ctx.fillStyle = trace;
      ctx.globalAlpha = 0.5;
      for (const tr of traces) {
        ctx.beginPath();
        tr.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        // solder pads at both ends, small vias at bends
        const [sx, sy] = tr.pts[0], [ex, ey] = tr.pts[tr.pts.length - 1];
        ctx.beginPath(); ctx.arc(sx, sy, 3.2, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(ex, ey, 2.4, 0, Math.PI * 2); ctx.fill();
      }
      // pulses: a bright head with a short fading tail
      ctx.fillStyle = hot;
      for (const tr of traces) {
        const head = tr.offset + (now / 1000) * tr.speed;
        for (let k = 0; k < 6; k++) {
          const [px, py] = pointAt(tr, head - k * 5);
          ctx.globalAlpha = 0.85 * (1 - k / 6);
          ctx.beginPath(); ctx.arc(px, py, k === 0 ? 2.2 : 1.6, 0, Math.PI * 2); ctx.fill();
        }
      }
    };

    const draw = (now: number) => {
      ctx.clearRect(0, 0, w, h);
      drawContours();
      drawDashes();
      drawTraces(now);
      ctx.globalAlpha = 1;
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 1000 / FPS) return;
      t += Math.min(now - last, 100) / 1000;
      last = now;
      draw(now);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      readColors(); resize();
      if (still.matches || document.hidden) { draw(4000); return; }
      last = performance.now(); raf = requestAnimationFrame(loop);
    };

    start();
    window.addEventListener("resize", start);
    document.addEventListener("visibilitychange", start);
    still.addEventListener("change", start);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", start);
      document.removeEventListener("visibilitychange", start);
      still.removeEventListener("change", start);
    };
  }, []);

  return <canvas ref={ref} className="field" aria-hidden="true" />;
}
