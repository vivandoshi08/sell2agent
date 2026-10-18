/** Presentational panels. Props only, so the look can change without touching data or metrics. */
import type { NegotiationEvent } from "@sa/shared";
import type { PolicyKpis } from "../metrics/kpis";
import { personaGrid } from "../metrics/kpis";

export const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents >= 100_000 ? 0 : 2 });
export const pct = (x: number) => `${Math.round(x * 100)}%`;
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour12: false }) : "");

export function SafetyTile({ kpis }: { kpis: PolicyKpis[] }) {
  const unsafe = kpis.reduce((s, k) => s + k.unsafe_deals, 0);
  const deals = kpis.reduce((s, k) => s + k.outcomes.filter((o) => o.converted).length, 0);
  const blocks = kpis.reduce((s, k) => s + k.guardrail_blocks, 0);
  return (
    <div className={`panel safety ${unsafe ? "bad" : "ok"}`} role="status">
      <span className="eyebrow" style={{ color: "inherit" }}>Rule-breaking deals</span>
      <b className="num">{unsafe}</b>
      <p>{unsafe ? `${unsafe} of ${deals} deals were below floor or judged unsafe. Open the guardrail log.` : `0 of ${deals} deals broke a seller rule. ${blocks} unsafe moves were blocked in code before reaching a buyer.`}</p>
    </div>
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
    case "guardrail_blocked": return `blocked: ${String((e.payload as Record<string, unknown>).rule ?? "rule")}`;
    case "listing_viewed": return `viewed listing`;
    case "run_started": return e.buyer_id ? `buyer joined` : `run started`;
    default: return e.type.replace(/_/g, " ");
  }
}

export function LiveFeed({ events, policyOf, freshFrom }: { events: NegotiationEvent[]; policyOf: (run: string) => string; freshFrom: number }) {
  const rows = events.slice(-40).reverse();
  if (!rows.length) return <p className="empty">Waiting for the first negotiation. Start a run and events appear here.</p>;
  return (
    <ul className="feed" aria-live="polite">
      {rows.map((e, i) => {
        const pol = policyOf(e.run_id);
        const idx = events.length - 1 - i;
        return (
          <li key={`${e.run_id}-${idx}`} className={idx >= freshFrom ? "new" : ""}>
            <time>{time(e.ts)}</time>
            <span className={`pill ${e.type === "guardrail_blocked" && (e.payload as Record<string, unknown>)?.severity !== "routine" ? "bad" : pol === "static" ? "" : "neg"}`}>{pol}</span>
            <span className="what"><b>{e.buyer_id ?? "harness"}</b> {describe(e)}{e.product_id ? <span style={{ color: "var(--muted)" }}> · {e.product_id}</span> : null}</span>
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
        // E1 tags each block: routine (normal price clamps) is dimmed so attacks and catches stand out.
        const routine = p.severity === "routine";
        return (
          <li key={i} className={routine ? "routine" : undefined} title={typeof p.severity === "string" ? p.severity : undefined}>
            <time>{time(e.ts)}</time>
            <span className={`pill ${routine ? "" : "bad"}`}>{String(p.rule ?? "blocked")}</span>
            <span>{String(p.reason ?? "")}{typeof p.clamped_to_cents === "number" ? ` → held at ${usd(p.clamped_to_cents)}` : ""}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function PersonaGrid({ kpis }: { kpis: PolicyKpis[] }) {
  const rows = personaGrid(kpis);
  return (
    <div className="scroll">
      <table className="pgrid">
        <thead><tr><th>Buyer type</th>{kpis.map((k) => <th key={k.policy}>{k.policy} · bought</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.persona}>
              <td>{r.persona.replace(/_/g, " ")}</td>
              {r.cells.map((c) => (
                <td key={c.policy}>
                  <span className="cell num">
                    <span className={`bar ${c.policy === "static" ? "" : "neg"}`} style={{ width: `${Math.round(c.conversion_rate * 90)}px` }} />
                    {pct(c.conversion_rate)} <span style={{ color: "var(--muted)" }}>of {c.n}</span>
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
