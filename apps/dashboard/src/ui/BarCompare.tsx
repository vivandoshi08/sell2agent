/** Horizontal bars, one per policy, with a 95% interval whisker. One scale for marks, ticks and labels. */
import type { Interval } from "../metrics/stats";

export interface Bar { policy: string; value: number | null; ci?: Interval | null }

export function BarCompare({ bars, format, max, height = 34, compact = false }: { bars: Bar[]; format: (v: number) => string; max?: number; height?: number; compact?: boolean }) {
  // Compact charts drop the policy labels (color + legend carry them) so text stays legible when the chart is small.
  const W = compact ? 200 : 360, L = compact ? 2 : 92, R = compact ? 62 : 70, gap = compact ? 8 : 10;
  const top = Math.max(1e-9, max ?? Math.max(...bars.flatMap((b) => [b.value ?? 0, b.ci?.hi ?? 0])) * 1.05);
  const x = (v: number) => L + (Math.max(0, Math.min(v, top)) / top) * (W - L - R);
  const H = bars.length * (height + gap) + 4;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={bars.map((b) => `${b.policy} ${b.value == null ? "no data" : format(b.value)}`).join(", ")}>
      <line className="axis" x1={L} x2={L} y1={0} y2={H - 4} />
      {bars.map((b, i) => {
        const y = i * (height + gap);
        const neg = b.policy !== "static";
        return (
          <g key={b.policy}>
            {!compact && <text x={L - 8} y={y + height / 2 + 4} textAnchor="end">{b.policy}</text>}
            {b.value == null ? (
              <text x={L + 8} y={y + height / 2 + 4}>needs cost data</text>
            ) : (
              <>
                <rect x={L} y={y} width={Math.max(1, x(b.value) - L)} height={height} rx={4} fill={neg ? "var(--neg)" : "var(--static)"} />
                {b.ci && (
                  <g className="whisker">
                    <line x1={x(b.ci.lo)} x2={x(b.ci.hi)} y1={y + height / 2} y2={y + height / 2} />
                    <line x1={x(b.ci.lo)} x2={x(b.ci.lo)} y1={y + height / 2 - 6} y2={y + height / 2 + 6} />
                    <line x1={x(b.ci.hi)} x2={x(b.ci.hi)} y1={y + height / 2 - 6} y2={y + height / 2 + 6} />
                  </g>
                )}
                <text className="val" x={Math.max(x(b.value), b.ci ? x(b.ci.hi) : 0) + 8} y={y + height / 2 + 5}>{format(b.value)}</text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}
