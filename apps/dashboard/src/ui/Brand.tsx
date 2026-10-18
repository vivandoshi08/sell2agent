/** Brand pieces: the wordmark and a faint, slowly drifting contour pattern used behind page headlines. Decorative only. */
import { useEffect, useRef } from "react";

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="var(--ink)" />
      <path d="M5 15.5c2.5-4 5-4 7 0s4.5 4 7 0M5 10c2.5-4 5-4 7 0s4.5 4 7 0" fill="none" stroke="var(--canvas)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Topographic contour lines (marching squares over slow waves). Stops under reduced motion and in hidden tabs. */
export function Contours({ className = "contours" }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current, ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, last = 0;
    const t0 = performance.now();
    const size = () => { const d = Math.min(devicePixelRatio || 1, 2); cv.width = cv.clientWidth * d; cv.height = cv.clientHeight * d; ctx.setTransform(d, 0, 0, d, 0, 0); };
    const h = (x: number, y: number, t: number) => (Math.sin(x * 0.012 + t * 0.15) * Math.cos(y * 0.02 - t * 0.1) + Math.sin((x + y) * 0.008 + t * 0.2) * 0.6 + 1.6) / 3.2;
    const draw = (t: number) => {
      const w = cv.clientWidth, ht = cv.clientHeight, C = 8, cols = Math.ceil(w / C) + 1, rows = Math.ceil(ht / C) + 1, g = new Float32Array(cols * rows);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) g[j * cols + i] = h(i * C, j * C, t);
      ctx.clearRect(0, 0, w, ht);
      ctx.strokeStyle = getComputedStyle(cv).getPropertyValue("--brand").trim() || "#0f5e43";
      ctx.lineWidth = 1;
      [0.3, 0.4, 0.5, 0.6, 0.7].forEach((lv, li) => {
        ctx.globalAlpha = 0.1 + li * 0.03;
        ctx.beginPath();
        for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
          const a = g[j * cols + i], b = g[j * cols + i + 1], c = g[(j + 1) * cols + i + 1], d = g[(j + 1) * cols + i];
          const k = (a > lv ? 8 : 0) | (b > lv ? 4 : 0) | (c > lv ? 2 : 0) | (d > lv ? 1 : 0);
          if (k === 0 || k === 15) continue;
          const X = i * C, Y = j * C;
          const T: [number, number] = [X + C * ((lv - a) / (b - a)), Y], R: [number, number] = [X + C, Y + C * ((lv - b) / (c - b))];
          const B: [number, number] = [X + C * ((lv - d) / (c - d)), Y + C], L: [number, number] = [X, Y + C * ((lv - a) / (d - a))];
          const s = (p: [number, number], q: [number, number]) => { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); };
          if (k === 1 || k === 14) s(L, B); else if (k === 2 || k === 13) s(B, R); else if (k === 3 || k === 12) s(L, R);
          else if (k === 4 || k === 11) s(T, R); else if (k === 6 || k === 9) s(T, B); else if (k === 7 || k === 8) s(L, T);
          else if (k === 5) { s(L, T); s(B, R); } else { s(T, R); s(L, B); }
        }
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    };
    const tick = (now: number) => { raf = requestAnimationFrame(tick); if (document.hidden || now - last < 50) return; last = now; draw((now - t0) / 1000); };
    size(); draw(8);
    if (!reduce) raf = requestAnimationFrame(tick);
    const onResize = () => { size(); draw((performance.now() - t0) / 1000); };
    window.addEventListener("resize", onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
  }, []);
  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
