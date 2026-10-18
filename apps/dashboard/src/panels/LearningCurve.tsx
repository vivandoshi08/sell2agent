/**
 * "What the seller learned" (Bridge 3; E2's contextual bandit, FINAL_ARCHITECTURE §10).
 * Two sources:
 *  - apps/seller-mcp/learned_policy.json (`pnpm e2:bandit` / `pnpm e2:retrain`): the arm chosen per buyer type, training
 *    stats, the learning curve and the held-out gate. Versioned; the exchange's `learned` strategy loads it.
 *  - `events` (optional): the latest `learned` A/B run and its fixed-policy siblings (`pnpm e2:learned`), scored per buyer
 *    type by learnedEval(): which arm the seller actually drew, win rate and profit per buyer vs the fixed policies.
 * Also placed on the merchant console with no events (file only).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { NegotiationEvent } from "@sa/shared";
import learned from "../../../seller-mcp/learned_policy.json";
import { learnedEval, liveArmPicks, orderContexts, type Cell, type LearnedEval } from "../metrics/learned";
import { personaLabel, policyLabel } from "../ui/labels";

interface ArmStats { n: number; sum: number }
interface Learned {
  version: number; trained_at: string; arms: string[]; epsilon: number;
  stats: Record<string, Record<string, ArmStats>>; choice: Record<string, string>;
  curve?: { epoch: number; bandit: number; negotiating: number; balanced?: number }[];
  gate?: { passed: boolean; best_fixed_policy: string; learned_minus_best_fixed_cents: number; holdout_buyers: number; diff_vs_negotiating_cents: number; ci95_cents: [number, number]; below_floor: number;
    ci95_vs_best_fixed_cents?: [number, number]; beats_best_fixed?: boolean; source?: string };
  trained_on?: { source: string; sessions: number; runs?: string[]; previous_version?: number };
}
const LP = learned as unknown as Learned;
const usd = (c: number) => `${c < 0 ? "−" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
const signed = (c: number) => `${c >= 0 ? "+" : "−"}${usd(Math.abs(c))}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The seller's playbooks (bandit arms) in merchant words. */
export const ARM: Record<string, { name: string; how: string }> = {
  negotiating: { name: "Negotiating", how: "holds list early, concedes late" },
  balanced: { name: "Balanced", how: "concedes steadily toward your soft floor" },
  lever_policy: { name: "Perks first", how: "adds warranty or shipping before cutting price" },
  static: { name: "Fixed price", how: "list price, no haggling" },
  learned: { name: "Learned", how: "picks a playbook per buyer type" },
};
const armName = (a: string) => ARM[a]?.name ?? policyLabel(a);
/** Buyer type in sentence case ("Price first"); lower-cased where it sits mid-sentence. */
const ctxName = (c: string) => (c === "unknown" ? "No stated preference" : personaLabel(c));

/** Trailing moving average: the per-epoch numbers are noisy (30 buyers each). */
export function smooth(xs: number[], k = 5): number[] {
  return xs.map((_, i) => { const w = xs.slice(Math.max(0, i - k + 1), i + 1); return w.reduce((a, b) => a + b, 0) / w.length; });
}

const mean = (s?: ArmStats) => (s?.n ? s.sum / s.n : null);

export function LearningCurve({ data = LP, events }: { data?: Learned; events?: NegotiationEvent[] }) {
  const ab = useMemo(() => (events ? learnedEval(events) : null), [events]);
  const live = useMemo(() => (events ? liveArmPicks(events) : []), [events]);
  const curve = data.curve ?? [];
  const contexts = orderContexts(Object.keys(data.choice ?? {}).length ? Object.keys(data.choice) : Object.keys(data.stats));
  const fixed = ab ? ab.policies.filter((x) => x !== "learned") : [];
  return (
    <section className="panel lp" aria-label="What the seller learned">
      <div className="panel-head"><h2>What the seller learned</h2>
        <span className="eyebrow">learned policy v{data.version}{data.trained_on ? ` · ${data.trained_on.source.startsWith("logged") ? `retrained on ${data.trained_on.sessions} logged negotiations` : `${data.trained_on.sessions} training negotiations`}` : ""}</span></div>
      <p className="sub">For each type of buyer, the seller tried its playbooks and kept the one that earned the most. Every playbook runs through the same floor and concession guards.</p>

      <div className="card-h"><h3>Playbook per buyer type</h3><span>buyer type = what the buyer weighs most</span></div>
      <div className="lp-picks">
        {contexts.map((c) => <PickTile key={c} context={c} data={data} ab={ab} />)}
      </div>

      {ab && <Comparison ab={ab} fixed={fixed} />}

      <div className="lp-curve">
        <div className="card-h"><h3>Learning curve</h3><span>profit per buyer by training epoch, 5-epoch average</span></div>
        {curve.length ? <CurveChart curve={curve} /> : <p className="empty">No learning curve yet: run <code>pnpm e2:bandit</code>.</p>}
      </div>

      {data.gate && <Gate gate={data.gate} />}

      {live.length > 0 && (
        <p className="sub">Live shoppers on the <code>learned</code> strategy so far: {live.map((l) => `${ctxName(l.context).toLowerCase()} → ${l.picks.map((x) => `${armName(x.arm)} ×${x.n}`).join(", ")}`).join("; ")}.</p>
      )}

      <details className="lp-train" open={!ab}>
        <summary>Training data: profit per buyer and tries, per playbook</summary>
        <div className="scroll">
          <table className="pgrid">
            <thead><tr><th>Buyer type</th><th>Seller now uses</th>{data.arms.map((a) => <th key={a}>{armName(a)}<br /><span className="th-sub">profit/buyer · tries</span></th>)}</tr></thead>
            <tbody>
              {contexts.map((c) => (
                <tr key={c}>
                  <td className="persona">{ctxName(c)}</td>
                  <td><span className="pill neg">{armName(data.choice[c] ?? "negotiating")}</span></td>
                  {data.arms.map((a) => {
                    const s = data.stats[c]?.[a];
                    return <td key={a} className={`num${a === data.choice[c] ? " best" : " dim"}`}>{s?.n ? `${usd(Math.round(s.sum / s.n))} · ${s.n}` : "—"}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="empty">Playbooks: {data.arms.map((a) => `${armName(a)} ${ARM[a]?.how ?? ""}`.trim()).join("; ")}. Trained {new Date(data.trained_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} {data.trained_on?.source.startsWith("logged") ? `on ${data.trained_on.sessions} logged negotiations with AI buyers` : "on simulated lever-profile buyers"}; explores {Math.round(data.epsilon * 100)}% of the time in deployment, and logs the odds of every pick so retraining stays unbiased.</p>
    </section>
  );
}

function PickTile({ context, data, ab }: { context: string; data: Learned; ab: LearnedEval | null }) {
  const arm = data.choice[context] ?? "negotiating";
  const row = ab?.rows.find((r) => r.context === context);
  const drawn = row?.picks.find((x) => x.arm === arm);
  const top = row?.picks[0];
  const mine = row?.cells.learned;
  // vs the default (Negotiating, also the learned strategy's fallback), like the gate; else the best fixed playbook in the A/B
  const fixedCells = row ? Object.entries(row.cells).filter(([pol, cell]) => pol !== "learned" && cell.profit_per_buyer_cents != null) : [];
  const baseline = fixedCells.find(([pol]) => pol === "negotiating") ?? fixedCells.sort((a, b) => b[1].profit_per_buyer_cents! - a[1].profit_per_buyer_cents!)[0];
  const chosen = mean(data.stats[context]?.[arm]), neg = mean(data.stats[context]?.negotiating);
  return (
    <div className="lp-pick">
      <span className="eyebrow">Cares most about</span>
      <b className="lp-ctx">{ctxName(context)}</b>
      <span className="lp-arm"><span className="pill neg">{armName(arm)}</span><small>{ARM[arm]?.how}</small></span>
      {mine && mine.n ? (
        <span className="lp-ev num">
          {drawn ? <>picked {pct(drawn.share)} of {mine.n} · </> : top ? <>A/B drew {armName(top.arm)} · </> : null}wins {pct(mine.win_rate)}{mine.profit_per_buyer_cents != null && <> · {usd(Math.round(mine.profit_per_buyer_cents))}/buyer</>}
          {baseline && mine.profit_per_buyer_cents != null && <><br /><span className={mine.profit_per_buyer_cents >= baseline[1].profit_per_buyer_cents! ? "up" : "down"}>{signed(Math.round(mine.profit_per_buyer_cents - baseline[1].profit_per_buyer_cents!))}</span>/buyer vs {armName(baseline[0])}</>}
        </span>
      ) : chosen != null ? (
        <span className="lp-ev num">{usd(Math.round(chosen))}/buyer over {data.stats[context][arm].n} tries{arm !== "negotiating" && neg != null && <><br /><span className={chosen >= neg ? "up" : "down"}>{signed(Math.round(chosen - neg))}</span>/buyer vs Negotiating</>}</span>
      ) : null}
    </div>
  );
}

function Comparison({ ab, fixed }: { ab: LearnedEval; fixed: string[] }) {
  const cols = ["learned", ...fixed];
  const best = (cells: Record<string, Cell>) => cols.reduce<string | null>((b, pol) => {
    const v = cells[pol]?.profit_per_buyer_cents; return v != null && (b == null || v > (cells[b]?.profit_per_buyer_cents ?? -Infinity)) ? pol : b;
  }, null);
  const cell = (cells: Record<string, Cell>, pol: string, b: string | null) => {
    const c = cells[pol];
    if (!c?.n) return <td key={pol} className="dim">—</td>;
    return <td key={pol} className={`num${pol === b ? " best" : ""}`}>{pct(c.win_rate)} won<br /><span className="th-sub">{c.profit_per_buyer_cents != null ? `${usd(Math.round(c.profit_per_buyer_cents))}/buyer` : "profit n/a"} · {c.n}</span></td>;
  };
  return (
    <div className="lp-ab">
      <div className="card-h"><h3>Same buyers, learned vs fixed playbooks</h3><span>{ab.key} · {ab.overall.learned?.n ?? 0} buyers per policy{ab.versions.length ? ` · policy v${ab.versions.join(", v")}` : ""}</span></div>
      <div className="scroll">
        <table className="pgrid">
          <thead><tr><th>Buyer type</th><th>Seller picked</th>{cols.map((c) => <th key={c}>{armName(c)}<br /><span className="th-sub">won · profit/buyer · buyers</span></th>)}</tr></thead>
          <tbody>
            {ab.rows.map((r) => {
              const b = best(r.cells);
              return (
                <tr key={r.context}>
                  <td className="persona">{ctxName(r.context)}</td>
                  <td>{r.picks.length ? r.picks.slice(0, 2).map((x) => <div key={x.arm} className="num">{armName(x.arm)} <span className="th-sub">{pct(x.share)}</span></div>) : <span className="dim">—</span>}</td>
                  {cols.map((pol) => cell(r.cells, pol, b))}
                </tr>
              );
            })}
            <tr className="total"><td>All buyers</td><td />{cols.map((pol) => cell(ab.overall, pol, best(ab.overall)))}</tr>
          </tbody>
        </table>
      </div>
      {ab.fallbacks > 0 && <p className="empty">{ab.fallbacks} learned negotiation{ab.fallbacks === 1 ? "" : "s"} had no usable policy file and fell back to Negotiating.</p>}
    </div>
  );
}

function Gate({ gate }: { gate: NonNullable<Learned["gate"]> }) {
  return (
    <p className="sub lp-gate">
      <span className={`pill ${gate.passed ? "neg" : "bad"}`}>{gate.passed ? "Gate passed" : "Gate not passed"}</span>{" "}
      On {gate.holdout_buyers} held-out buyers, learned vs. Negotiating: <b className="num">{signed(gate.diff_vs_negotiating_cents)}</b> profit per buyer
      {" "}(95% CI <span className="num">{usd(gate.ci95_cents[0])} to {usd(gate.ci95_cents[1])}</span>), {gate.below_floor} deals below floor.
      {gate.learned_minus_best_fixed_cents < 0
        ? <> The best single playbook ({armName(gate.best_fixed_policy)}) is still {usd(-gate.learned_minus_best_fixed_cents)} ahead per buyer, so learned isn't the default yet.</>
        : <> {gate.beats_best_fixed ? "Also beats" : "At or above"} the best single playbook ({armName(gate.best_fixed_policy)}) by {usd(gate.learned_minus_best_fixed_cents)} per buyer{gate.ci95_vs_best_fixed_cents ? <> (95% CI <span className="num">{usd(gate.ci95_vs_best_fixed_cents[0])} to {usd(gate.ci95_vs_best_fixed_cents[1])}</span>)</> : null}.</>}
    </p>
  );
}

const SERIES = [
  { key: "bandit", label: "Learned", stroke: "var(--brand)", width: 2.25, dash: undefined, opacity: 1, bold: true, swatch: "k-learned" },
  { key: "negotiating", label: "Negotiating", stroke: "var(--muted)", width: 1.5, dash: "4 4", opacity: 0.7, bold: false, swatch: "k-neg" },
  { key: "balanced", label: "Balanced", stroke: "var(--ink-2)", width: 1.5, dash: "1.5 4", opacity: 0.8, bold: false, swatch: "k-bal" },
] as const;

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

/** Drawn at the container's real width (no viewBox squeeze), so text stays true pixel size. */
function CurveChart({ curve }: { curve: NonNullable<Learned["curve"]> }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const wide = width >= 560;
  const W = Math.max(280, width), H = wide ? 240 : 200, L = 44, R = wide ? 116 : 10, T = 12, B = 28;
  const series = SERIES.filter((s) => curve.every((c) => typeof c[s.key] === "number")).map((s) => ({ ...s, ys: smooth(curve.map((c) => c[s.key] as number)) }));
  const all = series.flatMap((s) => s.ys);
  const lo = Math.floor(Math.min(...all) / 500) * 500, hi = Math.ceil(Math.max(...all) / 500) * 500;
  const x = (i: number) => L + (i / Math.max(1, curve.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - T - B);
  const path = (vs: number[]) => vs.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const ticks = [lo, (lo + hi) / 2, hi];
  const end = (ys: number[]) => usd(Math.round(ys.at(-1)!)).replace(/\.\d\d$/, "");
  // End labels sit at each line's last point, nudged apart (16px min gap) so they never overlap.
  const labels = series.map((s) => ({ s, y: y(s.ys.at(-1)!) + 4 })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 16);
  const desc = series.map((s) => `${s.label} ends at ${end(s.ys)}`).join(", ");
  const lead = series.find((s) => s.bold);
  return (
    <div ref={ref} className="curve">
      {width > 0 && (
        <svg className="chart lp-chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Profit per buyer by training epoch, 5-epoch average: ${desc}.`}>
          {ticks.map((t) => <g key={t}><line className="axis" x1={L} x2={W - R} y1={y(t)} y2={y(t)} strokeDasharray="2 4" /><text x={L - 8} y={y(t) + 4} textAnchor="end">{usd(t).replace(/\.00$/, "")}</text></g>)}
          {[1, Math.ceil(curve.length / 2), curve.length].map((e, i) => <text key={e} x={x(e - 1)} y={H - 6} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}>epoch {e}</text>)}
          {[...series].reverse().map((s) => <path key={s.key} d={path(s.ys)} fill="none" stroke={s.stroke} strokeOpacity={s.opacity} strokeWidth={s.width} strokeDasharray={s.dash} strokeLinecap="round" strokeLinejoin="round" />)}
          {lead && <circle cx={x(lead.ys.length - 1)} cy={y(lead.ys.at(-1)!)} r={3.5} fill={lead.stroke} />}
          {wide && labels.map(({ s, y: ly }) => <text key={s.key} x={W - R + 10} y={ly} className={s.bold ? "end" : undefined} style={s.bold ? { fill: "var(--brand)" } : undefined}>{s.label} {end(s.ys)}</text>)}
        </svg>
      )}
      {!wide && width > 0 && (
        <p className="curve-key">{series.map((s) => <span key={s.key}><i className={s.swatch} />{s.label} <b className="num">{end(s.ys)}</b></span>)}</p>
      )}
    </div>
  );
}
