/** Small, deterministic stats helpers. Seeded so the same events always draw the same intervals. */

export interface Interval { lo: number; hi: number }

/** mulberry32: tiny seeded PRNG, good enough for resampling. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** 95% percentile bootstrap over units (buyers). */
export function bootstrapCI<T>(units: T[], stat: (sample: T[]) => number, opts: { resamples?: number; seed?: number } = {}): Interval {
  const n = units.length;
  if (n === 0) return { lo: 0, hi: 0 };
  const B = opts.resamples ?? 1000;
  const r = rng(opts.seed ?? 17);
  const stats: number[] = new Array(B);
  const sample: T[] = new Array(n);
  for (let b = 0; b < B; b++) {
    for (let i = 0; i < n; i++) sample[i] = units[Math.floor(r() * n)];
    stats[b] = stat(sample);
  }
  stats.sort((a, b) => a - b);
  return { lo: quantile(stats, 0.025), hi: quantile(stats, 0.975) };
}
