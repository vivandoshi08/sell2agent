import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { NegotiationEvent } from "@sa/shared";
import { pickFeed } from "./data/source";
import { policyKpis, runPolicies } from "./metrics/kpis";
import { BarCompare } from "./ui/BarCompare";
import { GuardrailLog, LiveFeed, PersonaGrid, SafetyTile, pct, usd } from "./ui/Panels";
import { WaveField } from "./ui/WaveField";

const feed = pickFeed();

function Legend() {
  return (
    <span className="legend" aria-hidden="true">
      <span><i className="sw static" />static</span>
      <span><i className="sw neg" />negotiating</span>
    </span>
  );
}

function Kpi({ title, sub, better, children }: { title: string; sub: string; better: "higher" | "lower"; children: ReactNode }) {
  return (
    <section className="panel kpi" aria-label={title}>
      <div className="kpi-head">
        <h3>{title}</h3>
        <span className={`dir ${better}`}>{better === "higher" ? "↑ higher is better" : "↓ lower is better"}</span>
      </div>
      <p className="sub">{sub}</p>
      {children}
    </section>
  );
}

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
    <>
      <WaveField />
      <main className="app">
        <header className="top">
          <div className="title">
            <span className="eyebrow">Seller agents · proof</span>
            <h1>Static listings <span className="vs">vs.</span> <span className="hl">negotiating sellers</span></h1>
          </div>
          <div className="badges">
            <span className={`badge ${feed.mode}`}>{feed.mode === "live" ? "Live · Supabase" : "Sample data · illustrative"}</span>
            <span className="badge num">{buyers} buyers</span>
            <span className="badge num">{events.length} events</span>
          </div>
        </header>

        {error && <p className="err">{error}</p>}

        <div className="lead">
          <section className="panel hero" aria-label="Profit per buyer">
            <div className="hero-nums">
              <span className="eyebrow">Profit per buyer session</span>
              {neg && <div className="hero-num neg num"><b>{neg.profit_per_buyer_cents == null ? "—" : usd(neg.profit_per_buyer_cents)}</b><span>{neg.policy} sellers</span></div>}
              {base && <div className="hero-num base num"><b>{base.profit_per_buyer_cents == null ? "—" : usd(base.profit_per_buyer_cents)}</b><span>static listings</span></div>}
              {lift != null && <span className="delta num">{lift >= 0 ? "+" : ""}{Math.round(lift * 100)}% per buyer</span>}
            </div>
            <div className="hero-chart">
              <BarCompare height={48} format={usd} bars={kpis.map((k) => ({ policy: k.policy, value: k.profit_per_buyer_cents, ci: k.ci.profit_per_buyer_cents }))} />
              <p className="ci-note"><span className="wk" aria-hidden="true" />95% interval, bootstrapped over buyers</p>
            </div>
          </section>
          <SafetyTile kpis={kpis} />
        </div>

        <div className="kpis-head"><Legend /></div>
        <div className="kpis">
          <Kpi title="Conversion" sub="Buyers who reached a deal" better="higher">
            <BarCompare compact height={28} format={pct} max={1} bars={kpis.map((k) => ({ policy: k.policy, value: k.conversion_rate, ci: k.ci.conversion_rate }))} />
          </Kpi>
          <Kpi title="Safe conversion" sub="Deals that broke no seller rule" better="higher">
            <BarCompare compact height={28} format={pct} max={1} bars={kpis.map((k) => ({ policy: k.policy, value: k.safe_conversion_rate, ci: k.ci.safe_conversion_rate }))} />
          </Kpi>
          <Kpi title="Margin after lever costs" sub="Mean over deals" better="higher">
            <BarCompare compact height={28} format={(v) => `${v.toFixed(0)}%`} max={100} bars={kpis.map((k) => ({ policy: k.policy, value: k.avg_margin_pct }))} />
          </Kpi>
          <Kpi title="Time to first offer" sub="Median seller reply" better="lower">
            <BarCompare compact height={28} format={(v) => `${(v / 1000).toFixed(1)} s`} bars={kpis.map((k) => ({ policy: k.policy, value: k.median_ms_to_first_offer }))} />
          </Kpi>
        </div>

        <div className="row2">
          <section className="panel">
            <div className="panel-head"><h2>Live negotiations</h2><span className="eyebrow">newest first</span></div>
            <LiveFeed events={events} policyOf={(r) => policies.get(r) ?? r} freshFrom={freshFrom} />
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Guardrail log</h2><span className="eyebrow">blocked in code</span></div>
            <GuardrailLog events={events} />
          </section>
        </div>

        <section className="panel">
          <div className="panel-head"><h2>Who buys, by buyer type</h2><Legend /></div>
          <PersonaGrid kpis={kpis} />
          <p className="grid-note">Faded rows have fewer than 5 buyers: a hint, not a result.</p>
        </section>

        <p className="foot">Whiskers show 95% intervals, bootstrapped over buyers. Margin and time to first offer show point values only. A deal converts when it's accepted; profit counts unit cost and the cost of any levers included.{feed.mode === "sample" ? " Sample data: made-up buyers, so every number here is illustrative." : ""}</p>
      </main>
    </>
  );
}
