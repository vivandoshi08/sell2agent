/**
 * E1 · Outreach scheduler + inbound door (FINAL_ARCHITECTURE §5). Opt-in only.
 *  - A walk-away with consent schedules ONE follow-up (per negotiation; at most one per buyer per week).
 *  - The follow-up is a new standing offer, re-packaged around the levers the buyer valued, never below the
 *    buyer's last price (no new concession, so walking away can't be used to probe), still checked against
 *    floor + lever costs. Sent as readable text + a machine-readable offer block through the injected sender.
 *  - Inbound replies go through parseInbound(): a structured move, or a clarifying question. Never a guess.
 *  - STOP unsubscribes.
 * Queue is in-process (call runDue() on a timer); the follow-up record itself lives on the negotiation in the store.
 */
import { randomUUID } from "node:crypto";
import type { LeverName } from "../sellers";
import type { Exchange } from "./exchange";
import { parseInbound, type InboundIntent } from "./inbound";
import { leverCost } from "./probing";
import type { ExchangeResponse, FollowUpConsent, Negotiation, OutboundMessage, ProductConfig, StandingOffer } from "./types";

export const FOLLOWUP_DELAY_MS = 60 * 60_000;
export const FOLLOWUP_TTL_MS = 24 * 3600_000;
export const BUYER_FOLLOWUP_CAP_MS = 7 * 24 * 3600_000;

/** Which lever serves which buyer value. */
const LEVER_FOR: Partial<Record<LeverName, string>> = { warranty: "extended_warranty", delivery: "free_shipping", convenience: "free_shipping", quality: "extended_warranty" };

export type Sender = (m: OutboundMessage) => Promise<void>;

export interface OutreachDeps {
  ex: Exchange;
  now: () => number;
  send: Sender;
  emit: (n: Negotiation, type: "offer_countered" | "guardrail_blocked", price: number | null, payload: Record<string, unknown>) => Promise<void>;
  setState: (n: Negotiation, to: "follow_up") => Promise<void>;
}

export class Outreach {
  private queue = new Set<string>();
  private lastSentToBuyer = new Map<string, number>();
  readonly outbox: OutboundMessage[] = [];

  constructor(private d: OutreachDeps) {}

  consent(n: Negotiation, c: FollowUpConsent) {
    const t = this.d.now();
    n.followup = { ...c, consent_at: new Date(t).toISOString(), due_at: new Date(t + FOLLOWUP_DELAY_MS).toISOString() };
    this.queue.add(n.id);
  }

  /** Send every follow-up that is due. Returns what was sent. */
  async runDue(): Promise<OutboundMessage[]> {
    const sent: OutboundMessage[] = [];
    for (const id of [...this.queue]) {
      const n = await this.d.ex.store.getNegotiation(id);
      const f = n?.followup;
      if (!n || !f || f.sent_at || f.unsubscribed || n.state !== "walked_away") { this.queue.delete(id); continue; }
      if (Date.parse(f.due_at) > this.d.now()) continue;
      this.queue.delete(id);
      const last = this.lastSentToBuyer.get(n.buyer_id);
      if (last !== undefined && this.d.now() - last < BUYER_FOLLOWUP_CAP_MS) {
        await this.d.emit(n, "guardrail_blocked", null, { rule: "followup_cap", reason: "buyer already got a follow-up this week" });
        continue;
      }
      const p = await this.d.ex.catalog.get(n.product_id);
      if (!p) continue;
      const msg = await this.makeOffer(n, p, f);
      if (!msg) continue;
      await this.d.send(msg);
      this.outbox.push(msg);
      this.lastSentToBuyer.set(n.buyer_id, this.d.now());
      sent.push(msg);
    }
    return sent;
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
    await this.d.emit(n, "offer_countered", price, { followup: true, channel: f.channel, offer_id: o.offer_id, lever_package: levers, final: false, expires_at: o.expires_at, message: text.split("\n")[0] });
    return { negotiation_id: n.id, buyer_id: n.buyer_id, seller_id: n.seller_id, channel: f.channel, reply_to: f.reply_to,
      subject: `${p.title}: ${usd(price)} for 24 hours`, text, offer };
  }

  /** An inbound reply (email / SMS / A2A) on a negotiation. */
  async inbound(negotiation_id: string, buyer_id: string, text: string): Promise<ExchangeResponse & { intent: InboundIntent }> {
    const n = await this.d.ex.store.getNegotiation(negotiation_id);
    if (!n || n.buyer_id !== buyer_id)
      return { ok: false, allowed_actions: [], message: "unknown conversation", error: { code: "unknown_negotiation", message: "unknown conversation" }, intent: { kind: "clarify", question: "", reason: "unknown negotiation" } };
    const p = await this.d.ex.catalog.get(n.product_id);
    const intent = parseInbound(text, { standing_offer_id: n.standing_offer_id, allowed_levers: p?.allowed_levers ?? [] });
    const ctx = { run_id: n.run_id, buyer_id: n.buyer_id, buyer_model: n.buyer_model };
    switch (intent.kind) {
      case "accept": return { ...(await this.d.ex.handle({ kind: "accept", ctx, negotiation_id, offer_id: intent.offer_id })), intent };
      case "counter": return { ...(await this.d.ex.handle({ kind: "offer", ctx, product_id: n.product_id, negotiation_id, offer_price_cents: intent.price_cents, levers: intent.levers.length ? [...new Set([...n.levers, ...intent.levers])] : undefined })), intent };
      case "walk": return { ...(await this.d.ex.handle({ kind: "walk", ctx, negotiation_id })), intent };
      case "unsubscribe": {
        if (n.followup) n.followup.unsubscribed = true;
        this.queue.delete(n.id);
        await this.d.ex.store.putNegotiation(n);
        await this.d.emit(n, "guardrail_blocked", null, { rule: "unsubscribed", reason: "buyer opted out of follow-ups" });
        return { ok: true, negotiation_id, state: n.state, allowed_actions: ["status"], message: "You're unsubscribed. We won't message you again.", intent };
      }
      case "clarify":
        return { ok: true, negotiation_id, state: n.state, status: "info", allowed_actions: ["offer", "accept", "walk"], message: intent.question, intent };
    }
  }
}
