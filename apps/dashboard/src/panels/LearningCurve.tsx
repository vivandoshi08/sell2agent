/**
 * Learning curve + what the bandit learned (E2's contextual bandit, FINAL_ARCHITECTURE §10).
 * Source: apps/seller-mcp/learned_policy.json, which `pnpm e2:bandit` writes (curve, per-context stats, gate).
 * Owned by the S2 data session; the design session places it in App.tsx and may restyle it.
 */
import learned from "../../../seller-mcp/learned_policy.json";

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
          {data.gate.learned_minus_best_fixed_cents < 0 && <> The best single policy ({data.gate.best_fixed_policy}) is still {usd(-data.gate.learned_minus_best_fixed_cents)} ahead per buyer.</>}
        </p>
      )}
      <div className="scroll">
        <table className="pgrid">
          <thead><tr><th>Buyer cares most about</th><th>Seller now uses</th>{data.arms.map((a) => <th key={a}>{a}<br /><span style={{ opacity: 0.65, fontWeight: 400 }}>profit/buyer · tries</span></th>)}</tr></thead>
          <tbody>
            {contexts.map((c) => (
              <tr key={c}>
                <td>{c}</td>
                <td><span className="pill neg">{data.choice[c]}</span></td>
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

function CurveChart({ curve }: { curve: { epoch: number; bandit: number; negotiating: number }[] }) {
  const W = 900, H = 240, L = 52, R = 130, T = 12, B = 30;
  const b = smooth(curve.map((c) => c.bandit)), n = smooth(curve.map((c) => c.negotiating));
  const all = [...b, ...n];
  const lo = Math.floor(Math.min(...all) / 500) * 500, hi = Math.ceil(Math.max(...all) / 500) * 500;
  const x = (i: number) => L + (i / Math.max(1, curve.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - T - B);
  const path = (vs: number[]) => vs.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const ticks = [lo, (lo + hi) / 2, hi];
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Profit per buyer by training epoch, 5-epoch average. Learned ends at ${usd(Math.round(b.at(-1)!))}, fixed negotiating at ${usd(Math.round(n.at(-1)!))}.`}>
      {ticks.map((t) => <g key={t}><line className="axis" x1={L} x2={W - R} y1={y(t)} y2={y(t)} strokeDasharray="2 4" /><text x={L - 8} y={y(t) + 4} textAnchor="end">{usd(t).replace(/\.00$/, "")}</text></g>)}
      {[1, Math.ceil(curve.length / 2), curve.length].map((e) => <text key={e} x={x(e - 1)} y={H - 8} textAnchor="middle">epoch {e}</text>)}
      <path d={path(n)} fill="none" stroke="var(--static)" strokeWidth={2} strokeDasharray="5 4" />
      <path d={path(b)} fill="none" stroke="var(--neg)" strokeWidth={2.5} />
      <text x={W - R + 8} y={y(b.at(-1)!) + 4} style={{ fill: "var(--neg)", fontWeight: 600 }}>learned {usd(Math.round(b.at(-1)!)).replace(/\.\d\d$/, "")}</text>
      <text x={W - R + 8} y={y(n.at(-1)!) + (Math.abs(y(n.at(-1)!) - y(b.at(-1)!)) < 14 ? 18 : 4)}>negotiating {usd(Math.round(n.at(-1)!)).replace(/\.\d\d$/, "")}</text>
    </svg>
  );
}
