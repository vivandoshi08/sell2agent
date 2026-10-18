/**
 * Bridge 3 follow-ups: a walk-away with consent → one follow-up offer (email / SMS / log) → the buyer's reply → a deal.
 * Pure functions over `events`, like kpis.ts. Event shapes (E1 outreach, branch b3-followups):
 *   buyer_walked_away   payload.followup_consent, payload.channel
 *   offer_countered     payload.followup: true, followup_channel, offer_id, lever_package (lever ids), expires_at,
 *                       delivery {via,status,message_id} | {status:"failed",error}, outbox {channel,to (masked),subject}
 *   question_asked      actor buyer, payload.inbound: true, intent, clarify_reason?, message (sanitized), reply, result_state
 *                       (negotiation_id null + routed: false when the reply couldn't be matched to a negotiation)
 *   guardrail_blocked   rule followup_cap | unsubscribed | followup_policy | reply_cap
 * Only public numbers are read: the offer price, list price and the deal. Floors and costs are never shown.
 */
import type { NegotiationEvent } from "@sa/shared";
import { leverIds } from "./levers";

type Ev = NegotiationEvent;
const p = (e: Ev) => (e.payload ?? {}) as Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** Blocks that belong to the follow-up loop (shown on the thread, not as pricing incidents). */
export const FOLLOWUP_RULES = ["followup_cap", "unsubscribed", "followup_policy", "reply_cap"] as const;
export const isFollowupBlock = (e: Ev) => e.type === "guardrail_blocked" && (FOLLOWUP_RULES as readonly string[]).includes(String(p(e).rule));
export const isFollowupOffer = (e: Ev) => e.type === "offer_countered" && p(e).followup === true;
export const isInboundReply = (e: Ev) => e.type === "question_asked" && p(e).inbound === true;

export type ThreadStatus = "queued" | "sent" | "replied" | "recovered" | "paid" | "not_sent" | "failed" | "opted_out";

export interface FollowupThread {
  negotiation_id: string;
  run_id: string;
  buyer_id: string | null;
  buyer_model: string | null;
  product_id: string | null;
  product_title: string | null;
  walked: { ts: string; reason?: string; consent: boolean; channel: string | null } | null;
  sent: { ts: string; channel: string | null; price_cents: number | null; list_price_cents: number | null; levers: string[]; expires_at?: string;
    via?: string; delivered: boolean; error?: string; to?: string; subject?: string; rules: string[] } | null;
  blocked: { ts: string; rule: string; reason?: string } | null;
  replies: { ts: string; intent: string; message?: string; reply?: string; clarify_reason?: string; channel: string | null; result_state?: string }[];
  /** The seller's answers after the follow-up that weren't the follow-up itself (e.g. a counter to a COUNTER reply). */
  counters: { ts: string; price_cents: number | null }[];
  deal: { ts: string; price_cents: number | null; total_cents: number; levers: string[]; deal_id?: string } | null;
  paid: { ts: string; amount_cents: number } | null;
  status: ThreadStatus;
  last_ts: string;
}

export interface FollowupSummary {
  walkaways: number;
  consented: number;
  sent: number;
  failed: number;
  not_sent: number;
  replies: number;
  /** Inbound replies that couldn't be matched to a negotiation (routed: false). */
  unmatched_replies: number;
  recovered: number;
  recovered_paid: number;
  recovered_revenue_cents: number;
  recovered_paid_cents: number;
  /** Newest activity first. */
  threads: FollowupThread[];
}

function statusOf(t: Omit<FollowupThread, "status" | "last_ts">): ThreadStatus {
  if (t.paid) return "paid";
  if (t.deal) return "recovered";
  if (t.blocked?.rule === "unsubscribed" || t.replies.some((r) => r.intent === "unsubscribe")) return "opted_out";
  if (t.sent && !t.sent.delivered) return "failed";
  if (t.replies.length) return "replied";
  if (t.sent) return "sent";
  if (t.blocked) return "not_sent";
  return "queued";
}

export function followupSummary(events: Ev[]): FollowupSummary {
  const byNeg = new Map<string, Ev[]>();
  let unmatched = 0;
  for (const e of events) {
    if (isInboundReply(e) && (!e.negotiation_id || p(e).routed === false)) { unmatched++; continue; }
    if (!e.negotiation_id) continue;
    (byNeg.get(e.negotiation_id) ?? byNeg.set(e.negotiation_id, []).get(e.negotiation_id)!).push(e);
  }
  const threads: FollowupThread[] = [];
  let walkaways = 0, consented = 0;
  for (const [negotiation_id, raw] of byNeg) {
    const evs = [...raw].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
    const walk = evs.find((e) => e.type === "buyer_walked_away");
    if (walk) { walkaways++; if (p(walk).followup_consent === true) consented++; }
    const offer = evs.find(isFollowupOffer);
    if (!offer && !(walk && p(walk).followup_consent === true)) continue;

    const after = (e: Ev) => !offer || (e.ts ?? "") >= (offer.ts ?? "");
    const delivery = (offer ? p(offer).delivery : undefined) as { via?: string; status?: string; error?: string } | undefined;
    const outbox = (offer ? p(offer).outbox : undefined) as { to?: string; subject?: string; channel?: string; text?: string } | undefined;
    const block = evs.find(isFollowupBlock);
    const deal = offer ? evs.find((e) => e.type === "deal_accepted" && after(e)) : undefined;
    const dealId = deal ? str(p(deal).deal_id) : undefined;
    const paid = deal ? evs.find((e) => e.type === "payment_succeeded" && after(e) && (!dealId || !str(p(e).deal_id) || p(e).deal_id === dealId)) : undefined;
    // The follow-up's offer block says "price: $125 (list $139)"; else any list price the negotiation logged.
    const listInText = /\(list \$([\d,]+(?:\.\d\d)?)\)/.exec(outbox?.text ?? "")?.[1];
    const listed = listInText ? Math.round(Number(listInText.replace(/,/g, "")) * 100)
      : evs.map((e) => p(e).list_price_cents).find((v): v is number => typeof v === "number") ?? null;
    const qty = deal && typeof p(deal).quantity === "number" ? (p(deal).quantity as number) : 1;
    const first = walk ?? offer!;
    const t: Omit<FollowupThread, "status" | "last_ts"> = {
      negotiation_id,
      run_id: first.run_id,
      buyer_id: evs.find((e) => e.buyer_id)?.buyer_id ?? null,
      buyer_model: evs.find((e) => e.buyer_model)?.buyer_model ?? null,
      product_id: evs.find((e) => e.product_id)?.product_id ?? null,
      product_title: evs.map((e) => str(p(e).product_title)).find(Boolean) ?? null,
      walked: walk ? { ts: walk.ts ?? "", reason: str(p(walk).reason), consent: p(walk).followup_consent === true, channel: str(p(walk).channel) ?? null } : null,
      sent: offer ? {
        ts: offer.ts ?? "", channel: str(p(offer).followup_channel) ?? str(outbox?.channel) ?? null, price_cents: offer.price_cents ?? null, list_price_cents: listed,
        levers: leverIds(p(offer).lever_package), expires_at: str(p(offer).expires_at), via: str(delivery?.via), delivered: delivery?.status !== "failed",
        error: str(delivery?.error), to: str(outbox?.to), subject: str(outbox?.subject),
        rules: Array.isArray(p(offer).rule_refs) ? (p(offer).rule_refs as unknown[]).filter((r): r is string => typeof r === "string") : [],
      } : null,
      blocked: block ? { ts: block.ts ?? "", rule: String(p(block).rule), reason: str(p(block).reason) } : null,
      replies: evs.filter(isInboundReply).map((e) => ({ ts: e.ts ?? "", intent: String(p(e).intent ?? "reply"), message: str(p(e).message), reply: str(p(e).reply),
        clarify_reason: str(p(e).clarify_reason), channel: str(p(e).followup_channel) ?? null, result_state: str(p(e).result_state) })),
      counters: offer ? evs.filter((e) => e.type === "offer_countered" && e !== offer && after(e) && !isFollowupOffer(e)).map((e) => ({ ts: e.ts ?? "", price_cents: e.price_cents ?? null })) : [],
      deal: deal ? { ts: deal.ts ?? "", price_cents: deal.price_cents ?? null, total_cents: Number(p(deal).total_cents ?? (deal.price_cents ?? 0) * qty), levers: leverIds(p(deal).lever_package), deal_id: dealId } : null,
      paid: paid ? { ts: paid.ts ?? "", amount_cents: Number(p(paid).amount_cents ?? paid.price_cents ?? 0) } : null,
    };
    threads.push({ ...t, status: statusOf(t), last_ts: evs.at(-1)?.ts ?? "" });
  }
  threads.sort((a, b) => b.last_ts.localeCompare(a.last_ts));
  const recovered = threads.filter((t) => t.deal);
  const paid = recovered.filter((t) => t.paid);
  return {
    walkaways, consented,
    sent: threads.filter((t) => t.sent?.delivered).length,
    failed: threads.filter((t) => t.sent && !t.sent.delivered).length,
    not_sent: threads.filter((t) => !t.sent && t.blocked).length,
    replies: threads.reduce((s, t) => s + t.replies.length, 0),
    unmatched_replies: unmatched,
    recovered: recovered.length,
    recovered_paid: paid.length,
    recovered_revenue_cents: recovered.reduce((s, t) => s + (t.deal?.total_cents ?? 0), 0),
    recovered_paid_cents: paid.reduce((s, t) => s + (t.deal?.total_cents ?? 0), 0),
    threads,
  };
}
