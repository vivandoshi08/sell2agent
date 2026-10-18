import { useEffect, useMemo, useRef, useState } from "react";
import type { NegotiationEvent } from "@sa/shared";
import { pickFeed } from "./data/source";
import { policyKpis, runPolicies } from "./metrics/kpis";
import { BarCompare } from "./ui/BarCompare";
import { GuardrailLog, LiveFeed, PersonaGrid, SafetyTile, pct, usd } from "./ui/Panels";

const feed = pickFeed();

export function App() {
  const [events, setEvents] = useState<NegotiationEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const prevLen = useRef(0);
  const [freshFrom, setFreshFrom] = useState(0);

  useEffect(() => feed.start((all) => { setFreshFrom(prevLen.current); prevLen.current = all.length; setEvents(all); }, setError), []);

  const kpis = useMemo(() => policyKpis(events, { resamples: 600 }), [events]);
  const policies = useMemo(() => runPolicies(events), [events]);
  const base = kpis.find((k) => k.policy === "static");
  const neg = kpis.find((k) => k.policy !== "static");
  const lift = base?.profit_per_buyer_cents && neg?.profit_per_buyer_cents != null ? neg.profit_per_buyer_cents / base.profit_per_buyer_cents - 1 : null;
  const buyers = kpis.reduce((s, k) => s + k.buyers, 0);

  return (
    <main className="app">
      <header className="top">
        <div>
          <span className="eyebrow">Seller agents · proof</span>
          <h1>Static listings vs. negotiating sellers</h1>
        </div>
        <div className="badges">
          <span className={`badge ${feed.mode === "local" ? "live" : feed.mode}`}>{feed.label}</span>
          <span className="badge num">{buyers} buyers</span>
          <span className="badge num">{events.length} events</span>
        </div>
      </header>

      {error && <p className="err">{error}</p>}

      <section className="panel hero" aria-label="Profit per buyer">
        <div className="hero-nums">
          <span className="eyebrow">Profit per buyer session</span>
          {neg && <div className="hero-num neg"><b>{neg.profit_per_buyer_cents == null ? "—" : usd(neg.profit_per_buyer_cents)}</b><span>{neg.policy} sellers</span></div>}
          {base && <div className="hero-num"><b>{base.profit_per_buyer_cents == null ? "—" : usd(base.profit_per_buyer_cents)}</b><span>static listings</span></div>}
          {lift != null && <span className="delta">{lift >= 0 ? "+" : ""}{Math.round(lift * 100)}% per buyer</span>}
        </div>
        <BarCompare height={44} format={usd} bars={kpis.map((k) => ({ policy: k.policy, value: k.profit_per_buyer_cents, ci: k.ci.profit_per_buyer_cents }))} />
      </section>

      <div className="legend" aria-hidden="true"><span><i style={{ background: "var(--static)" }} />static listings</span><span><i style={{ background: "var(--neg)" }} />negotiating sellers</span></div>
      <section className="kpis">
        <div className="panel kpi"><h3>Conversion</h3><p className="sub">Buyers who reached a deal</p>
          <BarCompare compact height={26} format={pct} max={1} bars={kpis.map((k) => ({ policy: k.policy, value: k.conversion_rate, ci: k.ci.conversion_rate }))} /></div>
        <div className="panel kpi"><h3>Safe conversion</h3><p className="sub">Deals that broke no seller rule</p>
          <BarCompare compact height={26} format={pct} max={1} bars={kpis.map((k) => ({ policy: k.policy, value: k.safe_conversion_rate, ci: k.ci.safe_conversion_rate }))} /></div>
        <div className="panel kpi"><h3>Margin after lever costs</h3><p className="sub">Mean over deals</p>
          <BarCompare compact height={26} format={(v) => `${v.toFixed(0)}%`} max={100} bars={kpis.map((k) => ({ policy: k.policy, value: k.avg_margin_pct }))} /></div>
        <div className="panel kpi"><h3>Time to first offer</h3><p className="sub">Median seller reply</p>
          <BarCompare compact height={26} format={(v) => `${(v / 1000).toFixed(1)} s`} bars={kpis.map((k) => ({ policy: k.policy, value: k.median_ms_to_first_offer }))} /></div>
      </section>

      <section className="row3">
        <SafetyTile kpis={kpis} />
        <div className="panel">
          <div className="panel-head"><h2>Live negotiations</h2><span className="eyebrow">newest first</span></div>
          <LiveFeed events={events} policyOf={(r) => policies.get(r) ?? r} freshFrom={freshFrom} />
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Guardrail log</h2><span className="eyebrow">blocked in code</span></div>
          <GuardrailLog events={events} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Who buys, by buyer type</h2>
          <span className="legend"><span><i style={{ background: "var(--static)" }} />static</span><span><i style={{ background: "var(--neg)" }} />negotiating</span></span></div>
        <PersonaGrid kpis={kpis} />
      </section>

      <p className="foot">Bars show 95% intervals, bootstrapped over buyers. A deal converts when it's accepted; profit counts unit cost and the cost of any levers included.{feed.mode === "sample" ? " Sample data: made-up buyers, so every number here is illustrative." : ""}</p>
    </main>
  );
}
