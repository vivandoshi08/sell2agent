/**
 * Transcripts for flagged deals (DONE.md: "red tile ... with a link to its transcript").
 * A transcript is every event with the deal's negotiation_id, sorted by ts. It shows only actor, type, price and
 * payload.message: never the floor, unit cost or lever costs. Finding flagged deals is lookup, not a new metric:
 * unsafe = kpis[].outcomes (converted && !safe); live below-floor = deal_accepted rows the exchange flagged.
 */
import { useEffect, useState } from "react";
import type { NegotiationEvent } from "@sa/shared";
import type { PolicyKpis } from "../metrics/kpis";
import { usd } from "./Panels";
import { productName } from "./Seller";

export interface Flagged { key: string; label: string; detail: string; events: NegotiationEvent[] }

const byTs = (a: NegotiationEvent, b: NegotiationEvent) => (a.ts ?? "").localeCompare(b.ts ?? "");

/** Every event of the negotiation(s) behind these seed events; falls back to the seeds' buyer in those runs. */
function transcriptFor(seed: NegotiationEvent[], all: NegotiationEvent[]): NegotiationEvent[] {
  const nids = new Set(seed.map((e) => e.negotiation_id).filter((x): x is string => !!x));
  if (nids.size) return all.filter((e) => e.negotiation_id && nids.has(e.negotiation_id)).sort(byTs);
  const keys = new Set(seed.map((e) => `${e.run_id}|${e.buyer_id}`));
  return all.filter((e) => keys.has(`${e.run_id}|${e.buyer_id}`)).sort(byTs);
}

/** Deals the safety tile counts as unsafe: outcomes with converted && !safe, matched to events on run_id + buyer_id. */
export function unsafeDeals(kpis: PolicyKpis[], events: NegotiationEvent[]): Flagged[] {
  const out: Flagged[] = [];
  for (const k of kpis) {
    const runs = new Set(k.run_ids);
    for (const o of k.outcomes) {
      if (!o.converted || o.safe) continue;
      const seed = events.filter((e) => runs.has(e.run_id) && e.buyer_id === o.buyer_id && e.type === "deal_accepted");
      const evs = transcriptFor(seed.length ? seed : events.filter((e) => runs.has(e.run_id) && e.buyer_id === o.buyer_id), events);
      const deal = seed.at(-1);
      out.push({ key: `${k.policy}|${o.buyer_id}`, label: `${productName(deal?.product_id ?? null) || "Deal"}${deal?.price_cents != null ? ` at ${usd(deal.price_cents)}` : ""}`, detail: `${o.buyer_id} · ${o.model} · ${k.policy}`, events: evs });
    }
  }
  return out;
}

/** Live deals the exchange logged with below_floor: true. */
export function belowFloorDeals(events: NegotiationEvent[]): Flagged[] {
  return events
    .filter((e) => e.type === "deal_accepted" && (e.payload as Record<string, unknown> | null)?.below_floor === true)
    .map((d, i) => ({ key: `${d.negotiation_id ?? d.run_id}|${i}`, label: `${productName(d.product_id) || "Deal"}${d.price_cents != null ? ` at ${usd(d.price_cents)}` : ""}`, detail: `${d.buyer_model ?? "buyer"} · ${d.ts ? new Date(d.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : ""}`, events: transcriptFor([d], events) }));
}

/** Buttons that open each flagged deal's transcript in a drawer. */
export function FlaggedList({ items, title }: { items: Flagged[]; title: string }) {
  const [open, setOpen] = useState<Flagged | null>(null);
  if (!items.length) return null;
  return (
    <div className="flagged">
      <span className="eyebrow">{title}</span>
      <ul>
        {items.map((f) => (
          <li key={f.key}><button type="button" onClick={() => setOpen(f)}><b className="num">{f.label}</b><span>{f.detail}</span><span className="go">Transcript →</span></button></li>
        ))}
      </ul>
      {open && <TranscriptDrawer item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function TranscriptDrawer({ item, onClose }: { item: Flagged; onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Transcript: ${item.label}`} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-h">
          <div><h2 className="num">{item.label}</h2><span className="eyebrow">{item.detail} · {item.events.length} events</span></div>
          <button type="button" className="x" onClick={onClose} aria-label="Close transcript">×</button>
        </header>
        <ol className="tx">
          {item.events.map((e, i) => {
            // Only public fields: never floor, unit_cost_cents or lever_cost_cents.
            const msg = (e.payload as Record<string, unknown> | null)?.message;
            return (
              <li key={i} className={`tx-${e.actor}`}>
                <div className="tx-top"><span className="tx-actor">{e.actor}</span><span className="tx-type">{e.type.replace(/_/g, " ")}</span>{e.price_cents != null && <b className="num">{usd(e.price_cents)}</b>}<time className="num">{e.ts ? new Date(e.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }) : ""}</time></div>
                {typeof msg === "string" && msg.trim() && <p>{msg}</p>}
              </li>
            );
          })}
        </ol>
      </aside>
    </div>
  );
}
