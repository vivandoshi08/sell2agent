/**
 * E1 · Outreach scheduler + inbound door (FINAL_ARCHITECTURE §5). Opt-in only.
 *  - A walk-away with consent schedules ONE follow-up (per negotiation; at most one per buyer and per reply address
 *    per week).
 *  - The follow-up is a new standing offer, re-packaged around the levers the buyer valued, never below the
 *    buyer's last price (no new concession, so walking away can't be used to probe), still checked against
 *    floor + lever costs. Sent as readable text + a machine-readable offer block through the injected sender.
 *  - Inbound replies go through parseInbound(): a structured move, or a clarifying question. Never a guess.
 *  - STOP unsubscribes (this negotiation, and the address for every later one).
 * Queue, weekly cap, routing and opt-outs live in the store (Supabase snapshot rows on deploy), so runDue() works from
 * a fresh process. Something must call runDue(): the gateway's `POST /cron/outreach` or its dev timer.
 */
import { randomUUID } from "node:crypto";
import type { NegotiationEvent } from "@sa/shared";
import type { LeverName } from "../sellers";
import type { Exchange } from "./exchange";
import { parseInbound, type InboundIntent } from "./inbound";
import { inspectInput } from "./input-guard";
import { leverCost } from "./probing";
import { followupCapKeys, followupOptOutKey, followupRouteKey, normalizeAddress } from "./store";
import type { ExchangeResponse, FollowUpConsent, Negotiation, OutboundMessage, ProductConfig, StandingOffer } from "./types";

/** Wait between the walk-away and the follow-up. Env FOLLOWUP_DELAY_MS overrides it (demo: 60000). */
export const FOLLOWUP_DELAY_MS = Number(process.env.FOLLOWUP_DELAY_MS) > 0 ? Number(process.env.FOLLOWUP_DELAY_MS) : 60 * 60_000;
export const FOLLOWUP_TTL_MS = 24 * 3600_000;
export const BUYER_FOLLOWUP_CAP_MS = 7 * 24 * 3600_000;

/** Which lever serves which buyer value. */
const LEVER_FOR: Partial<Record<LeverName, string>> = { warranty: "extended_warranty", delivery: "free_shipping", convenience: "free_shipping", quality: "extended_warranty" };

/** What a sender reports back. `void` = delivered, no details. */
export interface SendReceipt {
  via: string; // "inkbox" | "log" | …
  status: "sent" | "logged";
  message_id?: string;
  thread_id?: string;
}
export type Sender = (m: OutboundMessage) => Promise<SendReceipt | void>;

export interface OutreachDeps {
  ex: Exchange;
  now: () => number;
  send: Sender;
  emit: (n: Negotiation, type: NegotiationEvent["type"], price: number | null, payload: Record<string, unknown>, actor?: "buyer" | "seller") => Promise<void>;
  setState: (n: Negotiation, to: "follow_up") => Promise<void>;
}

/** Where an inbound reply came from (the messaging door fills this in). */
export interface InboundMeta {
  channel?: string; // email | sms | a2a
  from?: string;
}

export class Outreach {
  /** Messages this process sent (tests, local dev). The durable outbox is the `offer_countered` events with `payload.outbox`. */
  readonly outbox: OutboundMessage[] = [];
  private running: Promise<OutboundMessage[]> | null = null;

  constructor(private d: OutreachDeps) {}

  /** Record consent on the negotiation and queue the follow-up in the store. The caller saves the negotiation. */
  async consent(n: Negotiation, c: FollowUpConsent) {
    const t = this.d.now();
    n.followup = { ...c, consent_at: new Date(t).toISOString(), due_at: new Date(t + FOLLOWUP_DELAY_MS).toISOString() };
    await this.d.ex.store.putFollowupJob({ negotiation_id: n.id, due_at: n.followup.due_at });
  }

  /** Send every follow-up that is due. Returns what was sent. One run at a time per process (cron and timer can overlap). */
  runDue(): Promise<OutboundMessage[]> {
    return (this.running ??= this.drain().finally(() => { this.running = null; }));
  }

  private async drain(): Promise<OutboundMessage[]> {
    const store = this.d.ex.store;
    const sent: OutboundMessage[] = [];
    const jobs = (await store.listFollowupJobs()).sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
    for (const j of jobs) {
      if (Date.parse(j.due_at) > this.d.now()) continue;
      try {
        // claim first: at most one message per job, even if delivery fails or another process runs too
        await store.deleteFollowupJob(j.negotiation_id);
        const m = await this.sendOne(j.negotiation_id);
        if (m) sent.push(m);
      } catch (e) {
        console.error("[outreach] follow-up failed", j.negotiation_id, (e as Error).message);
      }
    }
    return sent;
  }

  private async sendOne(negotiation_id: string): Promise<OutboundMessage | null> {
    const store = this.d.ex.store;
    const n = await store.getNegotiation(negotiation_id);
    const f = n?.followup;
    if (!n || !f || f.sent_at || f.unsubscribed || n.state !== "walked_away") return null;
    if (await store.getFollowupMark(followupOptOutKey(f.reply_to))) {
      await this.d.emit(n, "guardrail_blocked", null, { rule: "unsubscribed", reason: "this address replied STOP earlier; not sent" });
      return null;
    }
    const capKeys = followupCapKeys(n.buyer_id, f.reply_to, n.run_id);
    for (const k of capKeys) {
      const mark = await store.getFollowupMark(k);
      if (mark && mark.negotiation_id !== n.id && this.d.now() - Date.parse(mark.sent_at) < BUYER_FOLLOWUP_CAP_MS) {
        await this.d.emit(n, "guardrail_blocked", null, { rule: "followup_cap", reason: "buyer already got a follow-up this week",
          seller_message: "This buyer already got a follow-up this week, so this one was not sent." });
        return null;
      }
    }
    const p = await this.d.ex.catalog.get(n.product_id);
    if (!p) return null;
    const msg = await this.makeOffer(n, p, f);
    if (!msg) return null;

    let receipt: SendReceipt | void = undefined;
    let error: string | undefined;
    try {
      receipt = await this.d.send(msg);
    } catch (e) {
      error = (e as Error).message.slice(0, 200);
    }
    if (!error) {
      const mark = { negotiation_id: n.id, buyer_id: n.buyer_id, sent_at: new Date(this.d.now()).toISOString() };
      for (const k of [...capKeys, followupRouteKey(f.channel, f.reply_to)]) await store.putFollowupMark(k, mark);
      this.outbox.push(msg);
    }
    const levers = msg.offer.levers;
    await this.d.emit(n, "offer_countered", msg.offer.price_cents, {
      followup: true, followup_channel: f.channel, offer_id: msg.offer.offer_id, lever_package: levers, final: false, expires_at: msg.offer.expires_at,
      message: msg.text.split("\n")[0],
      reason: `Followed up by ${f.channel} after the buyer walked away: the last price offered${levers.length ? `, now with ${levers.map((l) => l.replace(/_/g, " ")).join(" and ")}` : ""}.`,
      rule_refs: ["followup", "no_new_concession", ...levers.map((l) => `lever:${l}`)],
      delivery: error ? { status: "failed", error } : { via: receipt?.via ?? "sender", status: receipt?.status ?? "sent", ...(receipt?.message_id ? { message_id: receipt.message_id } : {}) },
      outbox: { channel: f.channel, to: maskAddress(f.reply_to), subject: msg.subject, text: msg.text },
    });
    return error ? null : msg;
  }

  private async makeOffer(n: Negotiation, p: ProductConfig, f: NonNullable<Negotiation["followup"]>): Promise<OutboundMessage | null> {
    const price = Math.min(...n.history.filter((h) => h.by === "seller").map((h) => h.price_cents), p.list_price_cents);
    // re-package: add the lever this buyer valued most, if the listing offers it and the price still covers floor + its cost
    let levers = [...n.levers];
    const ranked = Object.entries(n.buyer_profile ?? {}).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
    for (const [value] of ranked) {
      const lever = LEVER_FOR[value as LeverName];
      if (!lever || levers.includes(lever) || !p.allowed_levers.includes(lever)) continue;
      if (price - leverCost([...levers, lever], p.lever_costs) >= p.floor_price_cents) { levers = [...levers, lever]; break; }
    }
    if (price - leverCost(levers, p.lever_costs) < p.floor_price_cents) {
      await this.d.emit(n, "guardrail_blocked", price, { rule: "followup_policy", reason: "follow-up package would break policy; not sent" });
      return null;
    }
    const t = this.d.now();
    const o: StandingOffer = { offer_id: `off_${randomUUID()}`, negotiation_id: n.id, buyer_id: n.buyer_id, price_cents: price, quantity: n.quantity,
      levers, final: false, expires_at: new Date(t + FOLLOWUP_TTL_MS).toISOString(), status: "live", round: n.round };
    await this.d.ex.store.putOffer(o);
    n.standing_offer_id = o.offer_id;
    n.levers = levers;
    n.followup = { ...f, sent_at: new Date(t).toISOString(), offer_id: o.offer_id };
    await this.d.setState(n, "follow_up");
    const usd = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
    const extras = levers.length ? `, including ${levers.map((l) => l.replace(/_/g, " ")).join(" and ")}` : "";
    const offer = { offer_id: o.offer_id, product_id: p.product_id, title: p.title, price_cents: price, list_price_cents: p.list_price_cents, levers,
      expires_at: o.expires_at, accept: `ACCEPT ${o.offer_id}`, counter: "COUNTER $<price>", stop: "STOP" };
    const text = [
      `You looked at the ${p.title} earlier. It's still available for ${usd(price)}${extras}. This offer is open for 24 hours.`,
      "",
      "--- offer ---",
      `offer_id: ${o.offer_id}`,
      `item: ${p.title}`,
      `price: ${usd(price)} (list ${usd(p.list_price_cents)})`,
      `includes: ${levers.length ? levers.join(", ") : "nothing extra"}`,
      `expires: ${o.expires_at}`,
      `to accept, reply: ACCEPT ${o.offer_id}`,
      "to make an offer, reply: COUNTER $<price>",
      "to stop these messages, reply: STOP",
    ].join("\n");
    return { negotiation_id: n.id, buyer_id: n.buyer_id, seller_id: n.seller_id, channel: f.channel, reply_to: f.reply_to,
      subject: `${p.title}: ${usd(price)} for 24 hours`, text, offer };
  }

  /**
   * Which negotiation an inbound reply belongs to: an explicit negotiation_id, else an offer_id anywhere in the text
   * (quoted history included), else the latest follow-up sent to that address on that channel. null = can't tell.
   */
  async resolve(r: { negotiation_id?: string; buyer_id?: string; text: string } & InboundMeta): Promise<{ negotiation_id: string; buyer_id: string } | null> {
    const store = this.d.ex.store;
    if (r.negotiation_id) {
      const n = await store.getNegotiation(r.negotiation_id);
      return n && (!r.buyer_id || r.buyer_id === n.buyer_id) ? { negotiation_id: n.id, buyer_id: n.buyer_id } : null;
    }
    for (const id of new Set([...(r.text ?? "").matchAll(/\boff_[0-9a-f-]{8,}\b/gi)].map((m) => m[0].toLowerCase()))) {
      const o = await store.getOffer(id);
      if (o) return { negotiation_id: o.negotiation_id, buyer_id: o.buyer_id };
    }
    if (r.from && r.channel) {
      const m = await store.getFollowupMark(followupRouteKey(r.channel, r.from));
      if (m) return { negotiation_id: m.negotiation_id, buyer_id: m.buyer_id };
    }
    return null;
  }

  /** An inbound reply (email / SMS / A2A) on a negotiation. Logged as a buyer `question_asked` with `payload.inbound`. */
  async inbound(negotiation_id: string, buyer_id: string, text: string, meta: InboundMeta = {}): Promise<ExchangeResponse & { intent: InboundIntent }> {
    const n = await this.d.ex.store.getNegotiation(negotiation_id);
    if (!n || n.buyer_id !== buyer_id)
      return { ok: false, allowed_actions: [], message: "unknown conversation", error: { code: "unknown_negotiation", message: "unknown conversation" }, intent: { kind: "clarify", question: "", reason: "unknown negotiation" } };
    const p = await this.d.ex.catalog.get(n.product_id);
    const intent = parseInbound(text, { standing_offer_id: n.standing_offer_id, allowed_levers: p?.allowed_levers ?? [] });
    const r = await this.act(n, intent);
    const f = n.followup;
    await this.d.emit(n, "question_asked", null, {
      inbound: true, followup_channel: meta.channel ?? f?.channel ?? null, intent: intent.kind,
      ...(intent.kind === "clarify" ? { clarify_reason: intent.reason } : {}),
      ...(meta.from && f?.reply_to ? { from_matches_consent: normalizeAddress(meta.from) === normalizeAddress(f.reply_to) } : {}),
      message: inspectInput(text ?? "").sanitized.slice(0, 300), reply: r.message.slice(0, 500), ok: r.ok, result_state: r.state ?? null,
    }, "buyer");
    return r;
  }

  private async act(n: Negotiation, intent: InboundIntent): Promise<ExchangeResponse & { intent: InboundIntent }> {
    const negotiation_id = n.id;
    const ctx = { run_id: n.run_id, buyer_id: n.buyer_id, buyer_model: n.buyer_model };
    switch (intent.kind) {
      case "accept": return { ...(await this.d.ex.handle({ kind: "accept", ctx, negotiation_id, offer_id: intent.offer_id })), intent };
      case "counter": return { ...(await this.d.ex.handle({ kind: "offer", ctx, product_id: n.product_id, negotiation_id, offer_price_cents: intent.price_cents, levers: intent.levers.length ? [...new Set([...n.levers, ...intent.levers])] : undefined })), intent };
      case "walk": return { ...(await this.d.ex.handle({ kind: "walk", ctx, negotiation_id })), intent };
      case "unsubscribe": {
        const store = this.d.ex.store;
        if (n.followup) {
          n.followup.unsubscribed = true;
          await store.putFollowupMark(followupOptOutKey(n.followup.reply_to), { negotiation_id, buyer_id: n.buyer_id, sent_at: new Date(this.d.now()).toISOString() });
        }
        await store.deleteFollowupJob(n.id);
        await store.putNegotiation(n);
        await this.d.emit(n, "guardrail_blocked", null, { rule: "unsubscribed", reason: "buyer opted out of follow-ups" });
        return { ok: true, negotiation_id, state: n.state, allowed_actions: ["status"], message: "You're unsubscribed. We won't message you again.", intent };
      }
      case "clarify":
        return { ok: true, negotiation_id, state: n.state, status: "info", allowed_actions: ["offer", "accept", "walk"], message: intent.question, intent };
    }
  }
}

/** For events (not access-controlled): `bu***@example.com`, `•••0999`, else the first 6 characters. */
export function maskAddress(a: string): string {
  const s = a.trim();
  const at = s.lastIndexOf("@");
  if (at > 0) return `${s.slice(0, Math.min(2, at))}***${s.slice(at)}`;
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 7 && /^[+\d\s().-]+$/.test(s)) return `•••${digits.slice(-4)}`;
  return s.length > 6 ? `${s.slice(0, 6)}…` : s;
}
