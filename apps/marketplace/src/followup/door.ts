// The messaging door (Bridge 3, FINAL_ARCHITECTURE §5) on the gateway:
//   POST /cron/outreach     send every due follow-up (E1's outreach.runDue()). Bearer OUTREACH_SECRET.
//   POST /inbound/:channel  a reply (Inkbox webhook or plain JSON) → ex.inbound() → one reply back on the same channel.
//                           "ACCEPT off_…" locks a deal; anything unclear gets a clarifying question; STOP unsubscribes.
//   GET  /outbox            recent follow-ups and inbound replies (events, plus this process's log outbox). Bearer secret.
// Without OUTREACH_SECRET the cron and plain-JSON routes refuse every call (Inkbox-signed webhooks still work).
// Handlers are plain functions (HttpIn → HttpOut) so tests run them without a server.
import type { NegotiationEvent } from "@sa/shared";
import { maskAddress, type Exchange, type ExchangeResponse, type InboundIntent } from "@sa/seller-mcp/exchange";
import { approveUrl } from "../deal/approve.js";
import { log as defaultLog } from "../log.js";
import { InkboxCourier, type FallbackCourier, type FollowupChannel } from "./couriers";
import { authorize, CHANNELS, parseInboundRequest, secretMatches, type Headers, type InboundMessage } from "./inbound";

export interface HttpIn {
  params: Record<string, string | undefined>;
  query: URLSearchParams;
  headers: Headers;
  body: string;
}
export interface HttpOut { status: number; headers: Record<string, string>; body: string }

const json = (status: number, body: unknown): HttpOut => ({ status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });

/** At most this many automatic replies per negotiation per day, so two agents can't clarify at each other forever. */
export const REPLY_BUDGET = 5;
const DAY_MS = 24 * 3600_000;

export interface DoorDeps {
  exchange: () => Promise<Exchange>;
  courier: FallbackCourier;
  approveOrigin?: string;
  log?: (e: NegotiationEvent) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Recent follow-up / inbound events for GET /outbox; default reads Supabase when SUPABASE_URL is set. */
  recentEvents?: () => Promise<NegotiationEvent[]>;
}

const usd = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

export function createFollowupDoor(d: DoorDeps) {
  const env = d.env ?? process.env;
  const now = d.now ?? Date.now;
  const log = d.log ?? defaultLog;
  const secretOk = (h: Headers, q?: URLSearchParams) =>
    secretMatches(h("authorization")?.replace(/^Bearer\s+/i, "") ?? h("x-outreach-secret") ?? q?.get("key") ?? undefined, env.OUTREACH_SECRET);

  async function cron(req: HttpIn): Promise<HttpOut> {
    if (!env.OUTREACH_SECRET) return json(503, { ok: false, error: "OUTREACH_SECRET is not set on the gateway" });
    if (!secretOk(req.headers)) return json(401, { ok: false, error: "unauthorized" });
    const ex = await d.exchange();
    const sent = await ex.outreach.runDue();
    return json(200, { ok: true, sent: sent.length, via: d.courier.name,
      followups: sent.map((m) => ({ negotiation_id: m.negotiation_id, offer_id: m.offer.offer_id, channel: m.channel, to: maskAddress(m.reply_to), price_cents: m.offer.price_cents })) });
  }

  async function inbound(req: HttpIn): Promise<HttpOut> {
    const channel = req.params.channel as FollowupChannel;
    if (!CHANNELS.includes(channel)) return json(404, { ok: false, error: `channel must be one of ${CHANNELS.join(", ")}` });
    const auth = authorize(req.body, req.headers, env, now());
    if (!auth) return json(401, { ok: false, error: "unauthorized: Bearer OUTREACH_SECRET or a valid Inkbox signature" });
    let body: unknown;
    try { body = JSON.parse(req.body); } catch { return json(400, { ok: false, error: "body must be JSON" }); }
    const p = parseInboundRequest(channel, body);
    if (!p.ok) return json(200, { ok: true, ignored: p.ignore }); // 2xx so Inkbox doesn't retry events we don't handle
    const msg = p.msg;
    if (msg.source === "json" && auth !== "secret") return json(401, { ok: false, error: "plain JSON needs Bearer OUTREACH_SECRET" });
    const ex = await d.exchange();
    const store = ex.store;
    const self = msg.channel === "email" && d.courier.primary instanceof InkboxCourier ? await d.courier.primary.mailbox().catch(() => undefined) : undefined;
    if (msg.from && (msg.from === msg.to_self || (self && msg.from.toLowerCase() === self.toLowerCase()))) return json(200, { ok: true, ignored: "our own message" });
    if (msg.event_id && (await store.getFollowupMark(`inbound:${msg.event_id}`))) return json(200, { ok: true, duplicate: true });

    const route = await ex.outreach.resolve({ negotiation_id: msg.negotiation_id, buyer_id: msg.buyer_id, text: msg.text, channel: msg.channel, from: msg.from });
    if (!route) return unrouted(ex, msg);
    const r = await ex.inbound(route.negotiation_id, route.buyer_id, msg.text, { channel: msg.channel, from: msg.from });
    const approve_url = r.deal && d.approveOrigin ? safe(() => approveUrl(d.approveOrigin!, r.deal!.deal_id, route.buyer_id)) : undefined;
    const reply = replyText(r, approve_url);
    const delivery = await replyOnce(ex, route, msg, reply);
    if (msg.event_id) await store.putFollowupMark(`inbound:${msg.event_id}`, { ...route, sent_at: new Date(now()).toISOString() });
    return json(200, { ok: true, routed: true, negotiation_id: route.negotiation_id, intent: r.intent.kind, state: r.state ?? null,
      ...(r.deal ? { deal_id: r.deal.deal_id, total_cents: r.deal.total_cents } : {}), ...(approve_url ? { approve_url } : {}),
      ...(r.standing_offer ? { standing_offer: r.standing_offer } : {}), reply, delivery });
  }

  /** One reply to the sender, within the per-negotiation budget. Over budget: stay silent and log it. */
  async function replyOnce(ex: Exchange, route: { negotiation_id: string; buyer_id: string }, msg: InboundMessage, text: string) {
    if (!msg.from) return { status: "no_reply_address" };
    const key = `replies:${route.negotiation_id}`;
    const t = now();
    const prev = await ex.store.getFollowupMark(key);
    const fresh = !prev || t - Date.parse(prev.sent_at) >= DAY_MS;
    const count = fresh ? 0 : prev!.count ?? 0;
    if (count >= REPLY_BUDGET) {
      const n = await ex.store.getNegotiation(route.negotiation_id);
      await log({ run_id: n?.run_id ?? "live", buyer_id: route.buyer_id, buyer_model: n?.buyer_model ?? null, seller_id: n?.seller_id ?? null, product_id: n?.product_id ?? null,
        negotiation_id: route.negotiation_id, actor: "seller", type: "guardrail_blocked", price_cents: null,
        payload: { rule: "reply_cap", severity: "routine", inbound: true, reason: `more than ${REPLY_BUDGET} automatic replies today; not replying`,
          seller_message: "Your agent stopped replying to this buyer's messages for today, so the two agents can't loop." } });
      return { status: "skipped", reason: "reply_cap" };
    }
    await ex.store.putFollowupMark(key, { ...route, sent_at: fresh ? new Date(t).toISOString() : prev!.sent_at, count: count + 1 });
    try {
      const subject = msg.subject ? (/^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`) : "Re: your offer";
      return await d.courier.deliver({ channel: msg.channel, to: msg.from, subject, text, in_reply_to: msg.message_id });
    } catch (e) {
      console.error("[followup] reply failed", (e as Error).message);
      return { status: "failed", error: (e as Error).message.slice(0, 200) };
    }
  }

  /** No negotiation matches: one short pointer per address per day (never a guess), and a log line. */
  async function unrouted(ex: Exchange, msg: InboundMessage): Promise<HttpOut> {
    const reply = "I couldn't match this message to an offer. Reply to the offer message itself, with ACCEPT <offer_id> to take it, COUNTER $<price> to make an offer, or STOP to unsubscribe.";
    let delivery: unknown = { status: "no_reply_address" };
    if (msg.from) {
      const key = `noroute:${msg.channel}:${msg.from.toLowerCase()}`;
      const prev = await ex.store.getFollowupMark(key);
      if (prev && now() - Date.parse(prev.sent_at) < DAY_MS) delivery = { status: "skipped", reason: "already told this address today" };
      else {
        await ex.store.putFollowupMark(key, { negotiation_id: "", buyer_id: "", sent_at: new Date(now()).toISOString() });
        delivery = await d.courier.deliver({ channel: msg.channel, to: msg.from, subject: "Re: your message", text: reply, in_reply_to: msg.message_id })
          .catch((e: Error) => ({ status: "failed", error: e.message.slice(0, 200) }));
      }
    }
    await log({ run_id: "live", buyer_id: null, buyer_model: null, seller_id: null, product_id: null, negotiation_id: null, actor: "buyer", type: "question_asked", price_cents: null,
      payload: { inbound: true, routed: false, followup_channel: msg.channel, from: msg.from ? maskAddress(msg.from) : null, reply } });
    return json(200, { ok: true, routed: false, reply, delivery });
  }

  async function outbox(req: HttpIn): Promise<HttpOut> {
    if (!env.OUTREACH_SECRET) return json(503, { ok: false, error: "OUTREACH_SECRET is not set on the gateway" });
    if (!secretOk(req.headers, req.query)) return json(401, { ok: false, error: "unauthorized" });
    const events = await (d.recentEvents ?? defaultRecentEvents)().catch((e: Error) => { console.error("[followup] outbox read", e.message); return [] as NegotiationEvent[]; });
    return json(200, { ok: true, via: d.courier.name, local: d.courier.fallback.outbox.slice(0, 50), events: events.map(outboxRow).filter(Boolean).slice(0, 50) });
  }

  return { cron, inbound, outbox };
}

function safe<T>(f: () => T): T | undefined {
  try { return f(); } catch { return undefined; }
}

/** The reply the buyer's agent gets: the exchange's own words, plus exactly what to send next. */
export function replyText(r: ExchangeResponse & { intent: InboundIntent }, approve_url?: string): string {
  if (r.deal) {
    return [r.message, approve_url ? `Approve and pay here before ${r.deal.expires_at}: ${approve_url}` : `deal_id: ${r.deal.deal_id} (approve and pay before ${r.deal.expires_at})`].join("\n");
  }
  const lines = [r.ok ? r.message : r.error?.message ?? r.message];
  const o = r.standing_offer;
  if (o && r.intent.kind === "counter" && r.allowed_actions.includes("accept"))
    lines.push("", `Current offer: ${usd(o.price_cents)}${o.levers.length ? ` incl. ${o.levers.join(", ")}` : ""}, expires ${o.expires_at}. To accept, reply: ACCEPT ${o.offer_id}`);
  return lines.join("\n");
}

function outboxRow(e: NegotiationEvent) {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (e.type === "offer_countered" && p.followup === true)
    return { ts: e.ts, kind: "followup", negotiation_id: e.negotiation_id, price_cents: e.price_cents, offer_id: p.offer_id, ...(p.outbox as object), delivery: p.delivery };
  if (e.type === "question_asked" && p.inbound === true)
    return { ts: e.ts, kind: "inbound", negotiation_id: e.negotiation_id, channel: p.followup_channel, intent: p.intent ?? null, message: p.message ?? null, reply: p.reply };
  return null;
}

async function defaultRecentEvents(): Promise<NegotiationEvent[]> {
  if (!process.env.SUPABASE_URL) return [];
  const { db } = await import("@sa/shared/db");
  const { data, error } = await db.from("events").select("ts, run_id, buyer_id, negotiation_id, type, price_cents, payload")
    .in("type", ["offer_countered", "question_asked"]).neq("run_id", "exchange_state").order("ts", { ascending: false }).limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []) as NegotiationEvent[];
}
