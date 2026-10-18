/**
 * Decorative background: a grid of short dashes riding slow interference waves, like a flow field over
 * dot-matrix terrain. Purely ornamental: it carries no data, sits behind every panel, and is hidden from
 * assistive tech. Colors come from CSS tokens (--field, --field-hot) so it follows light/dark.
 * Reduced motion: draws one still frame. Hidden tab: stops drawing.
 */
import { useEffect, useRef } from "react";

const GAP = 22; // px between grid points
const FPS = 30;

export function WaveField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    let w = 0, h = 0, raf = 0, last = 0, t = 0, frame = 0;
    let field = "#3fdc86", hot = "#b6ffd4";

    const readColors = () => {
      const s = getComputedStyle(canvas);
      field = s.getPropertyValue("--field").trim() || field;
      hot = s.getPropertyValue("--field-hot").trim() || hot;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    // Height of the "terrain" at (x, y) and time t, in 0..1. Three slow interfering waves.
    const height = (x: number, y: number) => {
      const a = Math.sin(x * 0.0062 + t * 0.21) * Math.cos(y * 0.0085 - t * 0.16);
      const b = Math.sin((x + y) * 0.0041 + t * 0.33);
      const c = Math.sin(x * 0.017 - y * 0.013 + t * 0.47) * 0.35;
      return (a + b * 0.6 + c + 1.95) / 3.9;
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = "round";
      const cols = Math.ceil(w / GAP) + 1, rows = Math.ceil(h / GAP) + 1;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const x = i * GAP, y = j * GAP;
          const v = height(x, y);
          // Flow direction follows the local slope, so dashes curl around ridges.
          const dx = height(x + 6, y) - v, dy = height(x, y + 6) - v;
          const ang = Math.atan2(dy, dx) + Math.PI / 2;
          const peak = v * v * v; // emphasize ridges
          const len = 2 + peak * 11;
          const lift = peak * 7; // ridges rise a little, like terrain
          ctx.globalAlpha = 0.05 + peak * 0.55;
          ctx.strokeStyle = peak > 0.42 ? hot : field;
          ctx.lineWidth = 1 + peak * 1.2;
          const cx = x, cy = y - lift;
          const ux = Math.cos(ang) * len * 0.5, uy = Math.sin(ang) * len * 0.5;
          ctx.beginPath(); ctx.moveTo(cx - ux, cy - uy); ctx.lineTo(cx + ux, cy + uy); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 1000 / FPS) return;
      t += Math.min(now - last, 100) / 1000;
      last = now;
      if (frame++ % 60 === 0) readColors(); // theme may change while the page is open
      draw();
    };

    const start = () => {
      cancelAnimationFrame(raf);
      readColors(); resize();
      if (still.matches || document.hidden) { draw(); return; }
      last = performance.now(); raf = requestAnimationFrame(loop);
    };

    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => { readColors(); draw(); };
    start();
    window.addEventListener("resize", start);
    document.addEventListener("visibilitychange", start);
    still.addEventListener("change", start);
    scheme.addEventListener("change", onScheme);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", start);
      document.removeEventListener("visibilitychange", start);
      still.removeEventListener("change", start);
      scheme.removeEventListener("change", onScheme);
    };
  }, []);

  return <canvas ref={ref} className="field" aria-hidden="true" />;
}
