/** Horizontal bars, one per policy, with a 95% interval whisker. One scale for marks, ticks and labels. */
import { useId } from "react";
import type { Interval } from "../metrics/stats";

export interface Bar { policy: string; value: number | null; ci?: Interval | null }

const LABEL: Record<string, string> = { static: "static", negotiating: "negotiating", lever_policy: "lever policy" };

export function BarCompare({ bars, format, max, height = 34, compact = false }: { bars: Bar[]; format: (v: number) => string; max?: number; height?: number; compact?: boolean }) {
  const pid = useId().replace(/:/g, "");
  // Compact charts drop the policy labels (color + legend carry them) so text stays legible when the chart is small.
  const W = compact ? 220 : 420, L = compact ? 2 : 118, R = compact ? 74 : 96, gap = compact ? 10 : 14;
  const top = Math.max(1e-9, max ?? Math.max(...bars.flatMap((b) => [b.value ?? 0, b.ci?.hi ?? 0])) * 1.05);
  const x = (v: number) => L + (Math.max(0, Math.min(v, top)) / top) * (W - L - R);
  const H = bars.length * (height + gap) + 4;
  return (
    <svg className={`chart${compact ? " compact" : ""}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={bars.map((b) => `${LABEL[b.policy] ?? b.policy} ${b.value == null ? "no data" : format(b.value)}`).join(", ")}>
      <defs>
        {/* Halftone texture on the negotiating bar: a nod to the dot-matrix field, never a second encoding. */}
        <pattern id={`dots-${pid}`} width="5" height="5" patternUnits="userSpaceOnUse">
          <circle cx="2.5" cy="2.5" r="0.9" className="dot" />
        </pattern>
      </defs>
      <line className="axis" x1={L} x2={L} y1={0} y2={H - 4} />
      {bars.map((b, i) => {
        const y = i * (height + gap);
        const neg = b.policy !== "static";
        const mid = y + height / 2;
        return (
          <g key={b.policy} className={neg ? "is-neg" : "is-static"}>
            {!compact && <text className="lbl" x={L - 12} y={mid + 5} textAnchor="end">{LABEL[b.policy] ?? b.policy}</text>}
            {b.value == null ? (
              <text className="lbl" x={L + 10} y={mid + 5}>needs cost data</text>
            ) : (
              <>
                <g className="grow" style={{ animationDelay: `${i * 120}ms` }}>
                  <rect className="bar" x={L} y={y} width={Math.max(1, x(b.value) - L)} height={height} rx={3} />
                  {neg && <rect x={L} y={y} width={Math.max(1, x(b.value) - L)} height={height} rx={3} fill={`url(#dots-${pid})`} />}
                </g>
                {b.ci && (
                  <g className="whisker">
                    {/* halo first so the whisker reads on top of the bar in both themes */}
                    <g className="halo">
                      <line x1={x(b.ci.lo)} x2={x(b.ci.hi)} y1={mid} y2={mid} />
                      <line x1={x(b.ci.lo)} x2={x(b.ci.lo)} y1={mid - 7} y2={mid + 7} />
                      <line x1={x(b.ci.hi)} x2={x(b.ci.hi)} y1={mid - 7} y2={mid + 7} />
                    </g>
                    <line x1={x(b.ci.lo)} x2={x(b.ci.hi)} y1={mid} y2={mid} />
                    <line x1={x(b.ci.lo)} x2={x(b.ci.lo)} y1={mid - 7} y2={mid + 7} />
                    <line x1={x(b.ci.hi)} x2={x(b.ci.hi)} y1={mid - 7} y2={mid + 7} />
                  </g>
                )}
                <text className="val" x={Math.max(x(b.value), b.ci ? x(b.ci.hi) : 0) + 10} y={mid + (compact ? 6 : 7)}>{format(b.value)}</text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}
