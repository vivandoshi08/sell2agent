/** "Walk-aways recovered" (Live view): saves, revenue kept, what got in the way, and what agents still asked for. */
import { useEffect, useRef, useState } from "react";
import type { NegotiationEvent } from "@sa/shared";
import { BLOCKERS, BLOCKER_LABEL, recoveryStats } from "../metrics/recovery";
import { usd } from "../ui/Panels";

export function RecoveryPanel({ events }: { events: NegotiationEvent[] }) {
  const s = recoveryStats(events);
  // Gentle highlight when a new save lands (not on first load).
  const seen = useRef<number | null>(null);
  const [glow, setGlow] = useState(false);
  useEffect(() => {
    if (seen.current !== null && s.saved > seen.current) { setGlow(true); const id = setTimeout(() => setGlow(false), 2400); seen.current = s.saved; return () => clearTimeout(id); }
    seen.current = s.saved;
  }, [s.saved]);

  const total = s.offered + s.honestNo;
  const blockers = BLOCKERS.filter((b) => s.byBlocker[b] > 0);
  const last = s.saves.at(-1);
  return (
    <section className={`card recovery${glow ? " glow" : ""}`} aria-label="Walk-aways recovered">
      <div className="card-h"><h2>Walk-aways recovered</h2>{total > 0 && <span className="num">{total} walk-away{total === 1 ? "" : "s"}</span>}</div>
      {!total ? (
        <p className="empty">When an agent walks away, your seller now offers a better fit, or says honestly that nothing fits.</p>
      ) : (
        <>
          <div className="tally">
            <div><span>Saved</span><b className="num">{s.saved}<small> / {s.offered} offered</small></b></div>
            <div><span>Revenue saved</span><b className="num">{usd(s.savedRevenueCents)}</b></div>
          </div>
          {last && <p className="rc-last">Latest: <b>{last.agent}</b> walked from {last.from_title}, bought <b>{last.to_title}</b> at <span className="num">{usd(last.price_cents)}</span>{last.paid ? "" : " (not paid yet)"}.</p>}
          {blockers.length > 0 && (
            <div className="rc-row"><span className="eyebrow">What got in the way</span>
              <ul className="rc-chips">{blockers.map((b) => <li key={b} className="pill">{BLOCKER_LABEL[b]} <b className="num">{s.byBlocker[b]}</b></li>)}</ul></div>
          )}
          {s.honestNo > 0 && <p className="sub num">{s.honestNo} time{s.honestNo === 1 ? "" : "s"} nothing fit better, and the agent was told so.</p>}
          {s.askedFor.length > 0 && (
            <div className="rc-row"><span className="eyebrow">Agents asked for</span>
              <ul className="rc-chips">{s.askedFor.map((a) => <li key={a.term} className="pill neg">{a.term} <b className="num">{a.count}</b></li>)}</ul></div>
          )}
        </>
      )}
    </section>
  );
}
