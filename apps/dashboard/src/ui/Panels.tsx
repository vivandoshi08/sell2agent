/** Presentational panels. Props only, so the look can change without touching data or metrics. */
import type { NegotiationEvent } from "@sa/shared";
import type { PolicyKpis } from "../metrics/kpis";
import { personaGrid } from "../metrics/kpis";

export const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents >= 100_000 ? 0 : 2 });
export const pct = (x: number) => `${Math.round(x * 100)}%`;
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour12: false }) : "");
const human = (s: string) => s.replace(/_/g, " ");

export function SafetyTile({ kpis }: { kpis: PolicyKpis[] }) {
  const unsafe = kpis.reduce((s, k) => s + k.unsafe_deals, 0);
  const deals = kpis.reduce((s, k) => s + k.outcomes.filter((o) => o.converted).length, 0);
  const blocks = kpis.reduce((s, k) => s + k.guardrail_blocks, 0);
  return (
    <section className={`panel safety ${unsafe ? "bad" : "ok"}`} role="status" aria-label="Rule-breaking deals">
      <span className="eyebrow">Rule-breaking deals</span>
      <b className="safety-num num">{unsafe}</b>
      <p className="safety-of num">of {deals} deals</p>
      <p className="safety-note">
        {unsafe
          ? `${unsafe} deal${unsafe === 1 ? " was" : "s were"} below floor or judged unsafe. See the guardrail log.`
          : <>No deal went below a seller's floor or broke a rule. <b className="num">{blocks}</b> unsafe moves were stopped in code before reaching a buyer.</>}
      </p>
    </section>
  );
}

function describe(e: NegotiationEvent): string {
  const price = e.price_cents != null ? usd(e.price_cents) : "";
  switch (e.type) {
    case "offer_made": return `buyer offers ${price}`;
    case "offer_countered": return `seller counters ${price}`;
    case "deal_accepted": return `deal at ${price}`;
    case "payment_succeeded": return `paid ${price}`;
    case "payment_failed": return `payment failed`;
    case "buyer_walked_away": return `buyer walked away`;
    case "guardrail_blocked": return `blocked: ${human(String((e.payload as Record<string, unknown>).rule ?? "rule"))}`;
    case "listing_viewed": return `viewed listing`;
    case "run_started": return e.buyer_id ? `buyer joined` : `run started`;
    default: return human(e.type);
  }
}

const tone = (e: NegotiationEvent) =>
  e.type === "guardrail_blocked" || e.type === "payment_failed" ? "bad"
    : e.type === "deal_accepted" || e.type === "payment_succeeded" ? "win"
    : "";

export function LiveFeed({ events, policyOf, freshFrom }: { events: NegotiationEvent[]; policyOf: (run: string) => string; freshFrom: number }) {
  const rows = events.slice(-40).reverse();
  if (!rows.length) return <p className="empty">Waiting for the first negotiation. Start a run and events appear here.</p>;
  return (
    <ul className="feed" aria-live="polite">
      {rows.map((e, i) => {
        const pol = policyOf(e.run_id);
        const idx = events.length - 1 - i;
        return (
          <li key={`${e.run_id}-${idx}`} className={`${idx >= freshFrom ? "new " : ""}${tone(e)}`}>
            <time className="num">{time(e.ts)}</time>
            <span className={`pill ${pol === "static" ? "" : "neg"}`}>{human(pol)}</span>
            <span className="what"><b>{e.buyer_id ?? "harness"}</b> {describe(e)}{e.product_id ? <span className="prod"> · {e.product_id}</span> : null}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function GuardrailLog({ events }: { events: NegotiationEvent[] }) {
  const rows = events.filter((e) => e.type === "guardrail_blocked").slice(-30).reverse();
  if (!rows.length) return <p className="empty">No blocks yet. Every move the seller code stops shows up here with the rule that fired.</p>;
  return (
    <ul className="glog">
      {rows.map((e, i) => {
        const p = e.payload as Record<string, unknown>;
        return (
          <li key={i}>
            <time className="num">{time(e.ts)}</time>
            <span className="glog-body">
              <span className="pill bad">{human(String(p.rule ?? "blocked"))}</span>
              <span className="reason">{String(p.reason ?? "")}</span>
            </span>
            <span className="held num">{typeof p.clamped_to_cents === "number" ? <>held at<br /><b>{usd(p.clamped_to_cents)}</b></> : ""}</span>
          </li>
        );
      })}
    </ul>
  );
}

const SMALL_N = 5;

export function PersonaGrid({ kpis }: { kpis: PolicyKpis[] }) {
  const rows = personaGrid(kpis);
  return (
    <div className="scroll">
      <table className="pgrid">
        <thead><tr><th>Buyer type</th>{kpis.map((k) => <th key={k.policy}>{human(k.policy)} · bought</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.persona}>
              <td className="persona">{human(r.persona)}</td>
              {r.cells.map((c) => (
                <td key={c.policy}>
                  <span className={`cell num${c.n < SMALL_N ? " few" : ""}`} title={c.n < SMALL_N ? `Only ${c.n} buyers: treat as a hint, not a result` : undefined}>
                    {/* track = 100%, fill = conversion; same scale in every row */}
                    <span className="track"><span className={`bar ${c.policy === "static" ? "" : "neg"}`} style={{ width: `${Math.round(c.conversion_rate * 100)}%` }} /></span>
                    <b>{pct(c.conversion_rate)}</b> <span className="n">of {c.n}</span>
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
