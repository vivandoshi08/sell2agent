/**
 * Policy comparison bars. One row per policy: name and value on top, a slim bar on a full-width track below, and a
 * soft band marking the 95% interval. Every row in a chart shares one scale, and labels always show (no legend hunt).
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Interval } from "../metrics/stats";
import { policyLabel } from "./labels";

export interface Bar { policy: string; value: number | null; ci?: Interval | null }

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Eases the number on screen toward the real one, so values count up while their bars grow. */
function useTween(target: number | null, delay: number, ms = 900) {
  const [shown, setShown] = useState<number | null>(() => (target == null ? null : reduced() ? target : 0));
  const at = useRef(target == null || !reduced() ? 0 : target);
  const first = useRef(true);
  useEffect(() => {
    if (target == null) { setShown(null); return; }
    if (reduced()) { at.current = target; setShown(target); return; }
    const from = at.current, wait = first.current ? delay : 0;
    first.current = false;
    let raf = 0, start = 0;
    const step = (t: number) => {
      start ||= t + wait;
      const k = Math.max(0, Math.min(1, (t - start) / ms)), e = 1 - (1 - k) ** 3;
      at.current = from + (target - from) * e;
      setShown(at.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, delay, ms]);
  return shown;
}

export function BarCompare({ bars, format, max, compact = false }: { bars: Bar[]; format: (v: number) => string; max?: number; compact?: boolean }) {
  const top = Math.max(1e-9, max ?? Math.max(...bars.flatMap((b) => [b.value ?? 0, b.ci?.hi ?? 0])) * 1.08);
  const anyCi = bars.some((b) => b.ci && b.value != null);
  const label = bars.map((b) => `${policyLabel(b.policy)} ${b.value == null ? "no data" : format(b.value)}${b.ci ? ` (95% interval ${format(b.ci.lo)} to ${format(b.ci.hi)})` : ""}`).join(", ");
  return (
    <div className={`bars${compact ? " compact" : ""}`} role="img" aria-label={label}>
      {bars.map((b, i) => <Row key={b.policy} bar={b} top={top} format={format} delay={i * 120} />)}
      {anyCi && <p className="bars-key" aria-hidden="true"><i />95% interval</p>}
    </div>
  );
}

function Row({ bar, top, format, delay }: { bar: Bar; top: number; format: (v: number) => string; delay: number }) {
  const shown = useTween(bar.value, delay);
  const at = (v: number) => `${(Math.max(0, Math.min(v, top)) / top) * 100}%`;
  const style = { "--d": `${delay}ms` } as CSSProperties;
  return (
    <div className={`bar-row ${bar.policy === "static" ? "is-static" : "is-neg"}`} style={style}>
      <div className="bar-meta">
        <span className="bar-name">{policyLabel(bar.policy)}</span>
        {bar.value == null ? <span className="bar-na">needs cost data</span> : <b className="bar-val num">{format(shown ?? bar.value)}</b>}
      </div>
      <div className="bar-track">
        {bar.ci && bar.value != null && bar.ci.hi - bar.ci.lo > top * 0.005 && (
          <i className="bar-ci" style={{ left: at(bar.ci.lo), width: `calc(${at(bar.ci.hi)} - ${at(bar.ci.lo)})` }} title={`95% interval: ${format(bar.ci.lo)} to ${format(bar.ci.hi)}`} />
        )}
        {bar.value != null && <i className="bar-fill" style={{ width: at(bar.value) }} />}
      </div>
    </div>
  );
}
