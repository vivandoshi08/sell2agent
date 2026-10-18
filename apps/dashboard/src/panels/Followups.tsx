/**
 * Bridge 3 "Follow-ups" panel: per negotiation, walked away → follow-up sent → reply → deal / paid, plus totals.
 * Reads followupSummary() (metrics/followups.ts). Shows the offer the buyer saw (price, perks, channel, masked address);
 * never the floor or any cost.
 */
import { useMemo } from "react";
import type { NegotiationEvent } from "@sa/shared";
import { followupSummary, type FollowupThread, type ThreadStatus } from "../metrics/followups";
import { pct, usd } from "../ui/Panels";
import { agentName, productName, ruleLabel } from "../ui/Seller";

const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "");
const later = (from?: string, to?: string) => {
  if (!from || !to) return "";
  const s = Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);
  return s < 60 ? `${Math.round(s)} s later` : s < 5400 ? `${Math.round(s / 60)} min later` : `${Math.round(s / 3600)} h later`;
};
const lever = (l: string) => l.replace(/_/g, " ");
const withLevers = (levers: string[]) => (levers.length ? ` + ${levers.map(lever).join(", ")}` : "");
const CHANNEL: Record<string, string> = { email: "email", sms: "text", a2a: "agent message" };
const via = (c: string | null | undefined) => (c ? CHANNEL[c] ?? c : "message");

const STATUS: Record<ThreadStatus, { label: string; cls: string }> = {
  queued: { label: "Follow-up queued", cls: "s-negotiating" }, sent: { label: "Waiting for reply", cls: "s-negotiating" },
  replied: { label: "Replied", cls: "s-negotiating" }, recovered: { label: "Recovered", cls: "s-agreed" }, paid: { label: "Recovered · paid", cls: "s-paid" },
  not_sent: { label: "Not sent", cls: "" }, failed: { label: "Send failed", cls: "" }, opted_out: { label: "Opted out", cls: "" },
};
const BLOCK: Record<string, string> = {
  followup_cap: "Not sent: this buyer already got a follow-up this week", unsubscribed: "Not sent: the buyer opted out",
  followup_policy: "Not sent: no package fit inside your rules", reply_cap: "Stopped replying: too many messages on this thread",
};
const INTENT: Record<string, string> = { accept: "Accepted the offer", counter: "Countered", clarify: "Asked a question", walk: "Declined", unsubscribe: "Replied STOP" };

export function Followups({ events, limit = 4 }: { events: NegotiationEvent[]; limit?: number }) {
  const s = useMemo(() => followupSummary(events), [events]);
  const threads = s.threads.filter((t) => t.walked?.consent || t.sent).slice(0, limit);
  return (
    <section className="panel fu" aria-label="Follow-ups">
      <div className="panel-head"><h2>Follow-ups after a walk-away</h2><span className="eyebrow">only with the buyer's consent · at most one per buyer a week</span></div>
      <div className="fu-totals num">
        <div><span>Walk-aways with consent</span><b>{s.consented}</b><small>of {s.walkaways} walk-away{s.walkaways === 1 ? "" : "s"}</small></div>
        <div><span>Follow-ups sent</span><b>{s.sent}</b><small>{[s.failed && `${s.failed} failed`, s.not_sent && `${s.not_sent} held back`].filter(Boolean).join(" · ") || "same price or better perks, no new discount"}</small></div>
        <div><span>Recovered deals</span><b>{s.recovered}</b><small>{s.sent ? `${pct(s.recovered / s.sent)} of follow-ups` : "none sent yet"}</small></div>
        <div><span>Recovered revenue</span><b>{usd(s.recovered_revenue_cents)}</b><small>{usd(s.recovered_paid_cents)} paid · Stripe test</small></div>
      </div>
      {threads.length ? (
        <div className="fu-threads">{threads.map((t) => <Thread key={t.negotiation_id} t={t} agent={agentName(events.filter((e) => e.negotiation_id === t.negotiation_id))} />)}</div>
      ) : (
        <div className="empty-state"><b>No follow-ups yet.</b><span>When a shopper walks away and says it's OK to hear back, your agent sends one better-packaged offer by email or text, then handles the reply.</span></div>
      )}
      {s.unmatched_replies > 0 && <p className="empty">{s.unmatched_replies} inbound repl{s.unmatched_replies === 1 ? "y" : "ies"} couldn't be matched to a negotiation; your agent asked which offer they meant instead of guessing.</p>}
    </section>
  );
}

type Step = { k: string; title: string; ts?: string; text?: string; note?: string; rules?: string[]; tone: "done" | "seller" | "win" | "warn" | "todo" };

function steps(t: FollowupThread): Step[] {
  const out: Step[] = [];
  out.push(t.walked
    ? { k: "walk", title: "Walked away", ts: t.walked.ts, text: t.walked.reason ? `“${t.walked.reason}”` : undefined, note: t.walked.consent ? `OK to follow up by ${via(t.walked.channel)}` : "No consent to follow up", tone: "done" }
    : { k: "walk", title: "Walked away", tone: "done" });
  if (t.sent) {
    const s = t.sent;
    out.push({ k: "sent", title: s.delivered ? `Follow-up sent by ${via(s.channel)}` : `Follow-up by ${via(s.channel)} failed`, ts: s.ts,
      text: s.price_cents != null ? `${usd(s.price_cents)}${withLevers(s.levers)}${s.list_price_cents && s.list_price_cents > s.price_cents ? ` (list ${usd(s.list_price_cents)})` : ""}, open 24 h` : undefined,
      note: [later(t.walked?.ts, s.ts), s.to && `to ${s.to}`, s.via && s.via !== "sender" && `via ${s.via === "inkbox" ? "Inkbox" : s.via}`, s.error].filter(Boolean).join(" · "),
      rules: s.rules.filter((r) => r === "no_new_concession" || r.startsWith("lever:")), tone: s.delivered ? "seller" : "warn" });
  } else if (t.blocked) {
    out.push({ k: "sent", title: BLOCK[t.blocked.rule] ?? `Not sent: ${t.blocked.rule.replace(/_/g, " ")}`, ts: t.blocked.ts, rules: [t.blocked.rule], tone: "warn" });
  } else {
    out.push({ k: "sent", title: "Follow-up queued", text: `Goes out by ${via(t.walked?.channel)} after a short wait`, tone: "todo" });
  }
  const r = t.replies.at(-1);
  if (r) {
    const counter = t.counters.at(-1);
    out.push({ k: "reply", title: `${INTENT[r.intent] ?? "Replied"}${t.replies.length > 1 ? ` · ${t.replies.length} replies` : ""}`, ts: r.ts,
      text: r.message ? `“${r.message}”` : undefined,
      note: r.intent === "counter" && counter?.price_cents != null ? `Agent answered ${usd(counter.price_cents)}` : r.reply ? `Agent: ${r.reply}` : undefined, tone: "done" });
  } else if (t.sent?.delivered) {
    out.push({ k: "reply", title: "Waiting for a reply", text: "ACCEPT, COUNTER $… or STOP", tone: "todo" });
  } else {
    out.push({ k: "reply", title: "No reply", tone: "todo" });
  }
  if (t.deal) {
    out.push({ k: "deal", title: t.paid ? "Deal · paid" : "Deal agreed", ts: t.paid?.ts ?? t.deal.ts,
      text: t.deal.price_cents != null ? `${usd(t.deal.price_cents)}${withLevers(t.deal.levers)}` : undefined, note: t.paid ? `Paid ${usd(t.paid.amount_cents || t.deal.total_cents)} · Stripe test` : "Waiting for payment", tone: "win" });
  } else {
    out.push({ k: "deal", title: "Deal", text: t.status === "opted_out" ? "Buyer opted out" : "Not yet", tone: "todo" });
  }
  return out;
}

function Thread({ t, agent }: { t: FollowupThread; agent: string }) {
  const st = STATUS[t.status];
  const product = t.product_title ?? productName(t.product_id);
  return (
    <article className="fu-thread" aria-label={`${agent}, ${product}: ${st.label}`}>
      <header className="fu-h">
        <span className="agent-av" aria-hidden="true">{agent.charAt(0)}</span>
        <div className="neg-who"><b>{agent}</b><span>{product}</span></div>
        <span className={`status ${st.cls}`}>{st.label}</span>
      </header>
      <ol className="fu-steps">
        {steps(t).map((s) => (
          <li key={s.k} className={`fu-step ${s.tone}`}>
            <span className="dot" aria-hidden="true" />
            <div className="fu-body">
              <div className="fu-top"><b>{s.title}</b>{s.ts && <time dateTime={s.ts}>{time(s.ts)}</time>}</div>
              {s.text && <p className="fu-text">{s.text}</p>}
              {s.note && <p className="fu-note">{s.note}</p>}
              {!!s.rules?.length && <div className="mv-rules">{s.rules.map((r) => <span key={r} className={`rule${s.tone === "warn" ? " warn" : ""}`}>{ruleLabel(r)}</span>)}</div>}
            </div>
          </li>
        ))}
      </ol>
    </article>
  );
}
