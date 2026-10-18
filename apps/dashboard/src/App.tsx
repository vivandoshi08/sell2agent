import { useEffect, useMemo, useRef, useState } from "react";
import type { NegotiationEvent } from "@sa/shared";
import { pickFeed } from "./data/source";
import { listModels, useRunSelection } from "./data/runs";
import { liveTraffic, policyKpis } from "./metrics/kpis";
import { BarCompare } from "./ui/BarCompare";
import { GuardrailLog, PersonaGrid, SafetyTile, pct, usd } from "./ui/Panels";
import { LiveTally, NegotiationCard, SaleToasts, Tally, useNegotiations } from "./ui/Seller";
import { Contours, Mark } from "./ui/Brand";
import { BuyerFit, LeverWins, LiveTrafficPanel, ModelFilter, RunPicker } from "./panels/S2Panels";
import { LearningCurve } from "./panels/LearningCurve";
import { FlaggedList, belowFloorDeals, unsafeDeals } from "./ui/Transcript";
import { EvalRunner } from "./ui/EvalRunner";
import "./ui/fonts";

const feed = pickFeed();
// `?tests` puts teammates' test runs (s1-test-…, s2-test-…) in the Live view, to check the pipe end to end. Eval runs never.
const showTests = new URLSearchParams(location.search).has("tests");
type View = "live" | "proof";
const viewFromHash = (): View => (location.hash === "#proof" ? "proof" : "live");

export function App() {
  const [events, setEvents] = useState<NegotiationEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(viewFromHash);
  const prevIds = useRef<Set<string>>(new Set());

  useEffect(() => feed.start((all) => setEvents(all), setError), []);
  useEffect(() => { const on = () => setView(viewFromHash()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);

  // Live view shows real buyers on the deployed gateway when there are any (an Instinct, ChatGPT, Claude…);
  // otherwise it replays whatever the feed has (eval run or sample) so the screen is never empty.
  const live = useMemo(() => liveTraffic(events, { includeTests: showTests }), [events]);
  const real = useMemo(() => (showTests ? liveTraffic(events) : live), [events, live]);
  const liveEvents = useMemo(() => { if (!live.negotiations) return events; const ids = new Set(live.run_ids); return events.filter((e) => ids.has(e.run_id)); }, [events, live]);
  const negs = useNegotiations(liveEvents, 6);
  const freshIds = useMemo(() => {
    const now = new Set(negs.map((n) => `${n.id}|${n.evs.length}`));
    const fresh = new Set([...now].filter((k) => !prevIds.current.has(k)).map((k) => k.split("|")[0]));
    prevIds.current = now;
    return fresh;
  }, [negs]);

  const { runs, selected, setSelected, filtered, isDefault, models, model, setModel } = useRunSelection(events);
  const kpis = useMemo(() => policyKpis(filtered, { resamples: 600 }), [filtered]);
  // The eval on screen, for the eval-runner card when this machine has no saved run (live mode).
  const current = useMemo(() => {
    const sel = runs.filter((r) => selected.includes(r.run_id));
    const ids = [...new Set(sel.map((r) => r.eval_id))];
    return ids.length === 1 && ids[0] ? { eval_id: ids[0], buyers: sel.reduce((s, r) => s + r.buyers, 0), models: listModels(filtered), policies: sel.map((r) => r.policy).sort((a, b) => (a === "static" ? -1 : b === "static" ? 1 : a.localeCompare(b))) } : null;
  }, [runs, selected, filtered]);
  const base = kpis.find((k) => k.policy === "static");
  const neg = kpis.find((k) => k.policy !== "static");
  const ratio = base?.profit_per_buyer_cents && neg?.profit_per_buyer_cents != null ? neg.profit_per_buyer_cents / base.profit_per_buyer_cents : null;
  const unsafe = kpis.reduce((s, k) => s + k.unsafe_deals, 0);
  const unsafeList = useMemo(() => (unsafe ? unsafeDeals(kpis, filtered) : []), [unsafe, kpis, filtered]);
  const floorList = useMemo(() => (live.below_floor ? belowFloorDeals(liveEvents) : []), [live, liveEvents]);
  const buyers = kpis.reduce((s, k) => s + k.buyers, 0);
  const profitDiff = neg?.profit_per_buyer_cents != null && base?.profit_per_buyer_cents != null ? neg.profit_per_buyer_cents - base.profit_per_buyer_cents : null;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><Mark /><b>Counter</b></div>
        <span className="store"><span className="av">KF</span>Keyforge</span>
        <nav className="tabs" aria-label="Views">
          <a href="#live" aria-current={view === "live" ? "page" : undefined}>Live</a>
          <a href="#proof" aria-current={view === "proof" ? "page" : undefined}>Results</a>
          <a href="console">Rules</a>
        </nav>
        <span className="sp" />
        <span className={`data-badge ${feed.mode}`}><i />{feed.label}</span>
      </header>

      {error && <p className="err">{error}</p>}

      {view === "live" ? (
        <main className="page" id="live">
          <section className="head">
            <Contours />
            <p className="meta">{live.negotiations ? `Your seller agent · live on the gateway · ${live.models.filter((m) => m !== "unknown").join(", ") || "buyer agents"}${showTests ? " · including test runs" : ""}` : "Your seller agent · no live shoppers yet, replaying " + feed.label.toLowerCase()}</p>
            <h1>AI shoppers are negotiating with Keyforge right now.</h1>
            <p className="lede">Every move your agent makes, why it made it, and the rule that kept it safe. Payments are Stripe test mode.</p>
          </section>
          <div className="live-grid">
            <section className="negs" aria-label="Negotiations">
              {negs.length ? negs.map((n) => <NegotiationCard key={n.id} n={n} fresh={freshIds.has(n.id)} />) : (
                <div className="empty-state"><b>Waiting for the first shopper.</b><span>When an assistant like Instinct starts talking to your store, the negotiation appears here as it happens.</span></div>
              )}
            </section>
            <aside className="side" aria-label="Today">
              <section className="card"><h2>{live.negotiations ? (showTests ? "Shoppers today, with test runs" : "Real shoppers today") : "Today"}</h2>{live.negotiations ? <LiveTally live={live} /> : <Tally events={liveEvents} />}</section>
              {floorList.length > 0 && <section className="card"><FlaggedList items={floorList} title="Flagged below floor" /></section>}
              <section className="card"><h2>Blocked by your rules</h2><GuardrailLog events={liveEvents} /></section>
            </aside>
          </div>
          <SaleToasts events={liveEvents} />
        </main>
      ) : (
        <main className="page" id="proof">
          <section className="head">
            <Contours />
            <p className="meta num">{buyers} simulated buyers · {feed.label}</p>
            <h1>{ratio != null ? <>Negotiating sellers earn <em>{ratio.toFixed(1)}×</em> more profit per buyer</> : <>Negotiating sellers vs. fixed prices</>}{unsafe === 0 && buyers > 0 ? ", with no rule broken." : "."}</h1>
            <p className="lede">Same catalog, same buyers. One group saw fixed listings; the other negotiated with the seller agent inside the seller's floors and perks.</p>
          </section>
          <div className="filters"><ModelFilter models={models} model={model} onChange={setModel} /></div>
          <LiveTrafficPanel live={real} />
          <FlaggedList items={floorList} title="Live deals flagged below floor" />
          <RunPicker runs={runs} selected={selected} onChange={setSelected} isDefault={isDefault} />

          <section className="strip" aria-label="Key metrics">
            <div className="m"><h3>Profit per buyer</h3><span className="v num">{neg?.profit_per_buyer_cents != null ? usd(neg.profit_per_buyer_cents) : "—"}</span>
              <span className="c num">{profitDiff != null && <span className="chip">{profitDiff >= 0 ? "+" : "−"}{usd(Math.abs(profitDiff))}</span>}vs {base?.profit_per_buyer_cents != null ? usd(base.profit_per_buyer_cents) : "—"} fixed</span></div>
            <div className="m"><h3>Conversion</h3><span className="v num">{neg ? pct(neg.conversion_rate) : "—"}</span>
              <span className="c num">{neg && base && <span className="chip">{neg.conversion_rate >= base.conversion_rate ? "+" : "−"}{Math.round(Math.abs(neg.conversion_rate - base.conversion_rate) * 100)} pts</span>}vs {base ? pct(base.conversion_rate) : "—"} fixed</span></div>
            <div className="m"><h3>Margin after perks</h3><span className="v num">{neg?.avg_margin_pct != null ? `${neg.avg_margin_pct.toFixed(0)}%` : "—"}</span><span className="c num">vs {base?.avg_margin_pct != null ? `${base.avg_margin_pct.toFixed(0)}%` : "—"} fixed</span></div>
            <div className="m"><h3>Time to first offer <small>lower is better</small></h3><span className="v num">{neg?.median_ms_to_first_offer != null ? `${(neg.median_ms_to_first_offer / 1000).toFixed(1)} s` : "—"}</span><span className="c">median seller reply</span></div>
          </section>

          <div className="grid2">
            <section className="card">
              <div className="card-h"><h2>Profit per buyer</h2><span>unit cost and perk costs included</span></div>
              <BarCompare height={40} format={usd} bars={kpis.map((k) => ({ policy: k.policy, value: k.profit_per_buyer_cents, ci: k.ci.profit_per_buyer_cents }))} />
              <p className="legend"><span><i className="sw static" />Fixed price</span><span><i className="sw neg" />Negotiating seller</span><span><i className="wkey" />95% interval</span></p>
            </section>
            <div className="safety-col"><SafetyTile kpis={kpis} /><FlaggedList items={unsafeList} title="Open a flagged deal" /></div>
          </div>

          <div className="grid2">
            <section className="card kpi"><div className="card-h"><h2>Conversion</h2><span>with 95% intervals</span></div>
              <BarCompare compact height={26} format={pct} max={1} bars={kpis.map((k) => ({ policy: k.policy, value: k.conversion_rate, ci: k.ci.conversion_rate }))} /></section>
            <BuyerFit kpis={kpis} />
          </div>

          <LeverWins kpis={kpis} />
          <section className="card"><div className="card-h"><h2>Who buys, by buyer type</h2></div><PersonaGrid kpis={kpis} /></section>
          <LearningCurve />
          <EvalRunner current={current} />

          <p className="foot">Intervals are 95%, bootstrapped over buyers; margin and time to first offer are point values. A deal converts when it's accepted; profit counts unit cost and perk costs.{feed.mode === "sample" ? " Sample data: made-up buyers, so every number here is illustrative." : ""}</p>
        </main>
      )}
    </div>
  );
}
