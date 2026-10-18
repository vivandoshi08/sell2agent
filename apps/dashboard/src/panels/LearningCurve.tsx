/**
 * Learning curve + what the bandit learned (E2's contextual bandit, FINAL_ARCHITECTURE §10).
 * Source: apps/seller-mcp/learned_policy.json, which `pnpm e2:bandit` writes (curve, per-context stats, gate).
 * Owned by the S2 data session; the design session places it in App.tsx and may restyle it.
 */
import { useEffect, useRef, useState } from "react";
import learned from "../../../seller-mcp/learned_policy.json";
import { personaLabel, policyLabel } from "../ui/labels";

interface ArmStats { n: number; sum: number }
interface Learned {
  version: number; trained_at: string; arms: string[]; epsilon: number;
  stats: Record<string, Record<string, ArmStats>>; choice: Record<string, string>;
  curve?: { epoch: number; bandit: number; negotiating: number }[];
  gate?: { passed: boolean; best_fixed_policy: string; learned_minus_best_fixed_cents: number; holdout_buyers: number; diff_vs_negotiating_cents: number; ci95_cents: [number, number]; below_floor: number };
}
const LP = learned as unknown as Learned;
const usd = (c: number) => `${c < 0 ? "−" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;

/** Trailing moving average: the per-epoch numbers are noisy (30 buyers each). */
export function smooth(xs: number[], k = 5): number[] {
  return xs.map((_, i) => { const w = xs.slice(Math.max(0, i - k + 1), i + 1); return w.reduce((a, b) => a + b, 0) / w.length; });
}

export function LearningCurve({ data = LP }: { data?: Learned }) {
  const curve = data.curve ?? [];
  const contexts = Object.keys(data.stats).sort();
  return (
    <div className="panel">
      <div className="panel-head"><h2>The seller learns which policy wins each buyer type</h2><span className="eyebrow">E2 bandit · v{data.version}</span></div>
      {curve.length ? <CurveChart curve={curve} /> : <p className="empty">No learning curve yet: run <code>pnpm e2:bandit</code>.</p>}
      {data.gate && (
        <p className="sub">
          On {data.gate.holdout_buyers} held-out buyers, learned vs. fixed negotiating: <b className="num">{data.gate.diff_vs_negotiating_cents >= 0 ? "+" : ""}{usd(data.gate.diff_vs_negotiating_cents)}</b> profit per buyer
          {" "}(95% CI <span className="num">{usd(data.gate.ci95_cents[0])} to {usd(data.gate.ci95_cents[1])}</span>), {data.gate.below_floor} deals below floor.
          {" "}Gate: <b>{data.gate.passed ? "passed" : "not passed"}</b>.
          {data.gate.learned_minus_best_fixed_cents < 0 && <> The best single policy ({policyLabel(data.gate.best_fixed_policy).toLowerCase()}) is still {usd(-data.gate.learned_minus_best_fixed_cents)} ahead per buyer.</>}
        </p>
      )}
      <div className="scroll">
        <table className="pgrid">
          <thead><tr><th>Buyer cares most about</th><th>Seller now uses</th>{data.arms.map((a) => <th key={a}>{policyLabel(a)}<br /><span className="th-sub">profit per buyer · tries</span></th>)}</tr></thead>
          <tbody>
            {contexts.map((c) => (
              <tr key={c}>
                <td>{personaLabel(c)}</td>
                <td><span className="pill neg">{policyLabel(data.choice[c])}</span></td>
                {data.arms.map((a) => {
                  const s = data.stats[c]?.[a];
                  return <td key={a} className="num" style={a === data.choice[c] ? { fontWeight: 600 } : { opacity: 0.75 }}>{s?.n ? `${usd(Math.round(s.sum / s.n))} · ${s.n}` : "—"}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="empty">Simulated lever-profile buyers (E2). Trained {new Date(data.trained_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}; explores {Math.round(data.epsilon * 100)}% of the time in deployment.</p>
    </div>
  );
}

/** Width of an element in CSS pixels, kept current as the layout changes. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function CurveChart({ curve }: { curve: { epoch: number; bandit: number; negotiating: number }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const b = smooth(curve.map((c) => c.bandit)), n = smooth(curve.map((c) => c.negotiating));
  const wide = width >= 560;
  const W = Math.max(280, width), H = wide ? 240 : 200, L = 44, R = wide ? 116 : 10, T = 12, B = 28;
  const all = [...b, ...n];
  const lo = Math.floor(Math.min(...all) / 500) * 500, hi = Math.ceil(Math.max(...all) / 500) * 500;
  const x = (i: number) => L + (i / Math.max(1, curve.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - T - B);
  const path = (vs: number[]) => vs.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const ticks = [lo, (lo + hi) / 2, hi];
  const endB = usd(Math.round(b.at(-1)!)).replace(/\.\d\d$/, ""), endN = usd(Math.round(n.at(-1)!)).replace(/\.\d\d$/, "");
  // End labels sit at each line's last point; when the two ends are close, push them apart so they never overlap.
  let yb = y(b.at(-1)!), yn = y(n.at(-1)!);
  const push = Math.max(0, 16 - Math.abs(yb - yn)) / 2;
  if (yb <= yn) { yb -= push; yn += push; } else { yb += push; yn -= push; }
  return (
    <div ref={ref} className="curve">
      {width > 0 && (
        <svg className="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Profit per buyer by training epoch, 5-epoch average. Learned ends at ${endB}, fixed negotiating at ${endN}.`}>
          {ticks.map((t) => <g key={t}><line className="axis" x1={L} x2={W - R} y1={y(t)} y2={y(t)} strokeDasharray="2 4" /><text x={L - 8} y={y(t) + 4} textAnchor="end">{usd(t).replace(/\.00$/, "")}</text></g>)}
          {[1, Math.ceil(curve.length / 2), curve.length].map((e, i) => <text key={e} x={x(e - 1)} y={H - 6} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}>epoch {e}</text>)}
          <path d={path(n)} fill="none" stroke="var(--muted)" strokeOpacity={0.7} strokeWidth={1.5} strokeDasharray="4 4" />
          <path d={path(b)} fill="none" stroke="var(--brand)" strokeWidth={2.25} strokeLinejoin="round" />
          <circle cx={x(b.length - 1)} cy={y(b.at(-1)!)} r={3.5} fill="var(--brand)" />
          {wide && <>
            <text className="end" x={W - R + 10} y={yb + 4} style={{ fill: "var(--brand)" }}>Learned {endB}</text>
            <text x={W - R + 10} y={yn + 4}>Negotiating {endN}</text>
          </>}
        </svg>
      )}
      {!wide && width > 0 && (
        <p className="curve-key"><span><i className="k-learned" />Learned <b className="num">{endB}</b></span><span><i className="k-neg" />Negotiating <b className="num">{endN}</b></span></p>
      )}
    </div>
  );
}
