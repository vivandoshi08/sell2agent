// Follow-up delivery (Bridge 3). A courier delivers one outgoing message on one channel and says how it went.
//   InkboxCourier: email / SMS from the seller's verified Inkbox identity. On only when INKBOX_API_KEY is set.
//   LogCourier:    the fallback. Delivers nothing; keeps an in-memory outbox and prints a line, so the demo works
//                  without Inkbox. The durable record is the follow-up event itself: E1's outreach logs every
//                  follow-up as `offer_countered` with `payload.followup` + `payload.outbox` (subject, text, masked
//                  address, delivery), whichever courier ran. The dashboard reads those.
import { randomUUID } from "node:crypto";
import { maskAddress, type OutboundMessage, type Sender, type SendReceipt } from "@sa/seller-mcp/exchange";

export type FollowupChannel = "email" | "sms" | "a2a";

export interface Outgoing {
  channel: FollowupChannel;
  to: string;
  subject: string;
  text: string;
  in_reply_to?: string; // RFC 5322 Message-ID, for email threading
  idempotency_key?: string;
}

export interface Courier {
  readonly name: string;
  canDeliver(channel: FollowupChannel): boolean;
  deliver(m: Outgoing): Promise<SendReceipt>;
}

export interface OutboxEntry {
  at: string;
  via: string;
  channel: FollowupChannel;
  to: string; // masked
  subject: string;
  text: string;
  message_id?: string;
}

const OUTBOX_MAX = 100;

export class LogCourier implements Courier {
  readonly name = "log";
  readonly outbox: OutboxEntry[] = [];
  canDeliver() { return true; }
  async deliver(m: Outgoing): Promise<SendReceipt> {
    const message_id = `log_${randomUUID()}`;
    this.outbox.unshift({ at: new Date().toISOString(), via: "log", channel: m.channel, to: maskAddress(m.to), subject: m.subject, text: m.text, message_id });
    this.outbox.length = Math.min(this.outbox.length, OUTBOX_MAX);
    console.log(`[followup:log] ${m.channel} → ${maskAddress(m.to)}: ${m.subject}`);
    return { via: "log", status: "logged", message_id };
  }
}

/** Inkbox REST (https://inkbox.ai/docs/api/mail/messages, /docs/api/phone/texts). Auth: X-API-Key. */
export interface InkboxConfig {
  apiKey: string;
  mailbox?: string; // sending address (the identity's mailbox, on the seller's verified domain once set up)
  phoneNumberId?: string; // sending number for SMS
  identity?: string; // agent handle: when mailbox / phoneNumberId are unset, read them from GET /identities/{handle}
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class InkboxCourier implements Courier {
  readonly name = "inkbox";
  private base: string;
  private f: typeof fetch;
  private resolved: Promise<{ mailbox?: string; phoneNumberId?: string }> | undefined;

  constructor(private c: InkboxConfig) {
    this.base = (c.baseUrl ?? "https://inkbox.ai/api/v1").replace(/\/$/, "");
    this.f = c.fetch ?? fetch;
  }

  /** Email needs a mailbox (or an identity to look it up); SMS needs a number. A2A goes to the fallback for now. */
  canDeliver(channel: FollowupChannel) {
    if (channel === "email") return !!(this.c.mailbox || this.c.identity);
    if (channel === "sms") return !!(this.c.phoneNumberId || this.c.identity);
    return false;
  }

  /** The mailbox address replies arrive at (so the door can ignore our own mail). */
  async mailbox(): Promise<string | undefined> {
    return (await this.channels()).mailbox;
  }

  private channels() {
    if (this.c.mailbox && (this.c.phoneNumberId || !this.c.identity)) return Promise.resolve({ mailbox: this.c.mailbox, phoneNumberId: this.c.phoneNumberId });
    return (this.resolved ??= this.call("GET", `/identities/${encodeURIComponent(this.c.identity!)}`).then((id) => ({
      mailbox: this.c.mailbox ?? (id as { mailbox?: { email_address?: string } }).mailbox?.email_address,
      phoneNumberId: this.c.phoneNumberId ?? (id as { phone_number?: { id?: string } }).phone_number?.id,
    })).catch((e) => { this.resolved = undefined; throw e; }));
  }

  async deliver(m: Outgoing): Promise<SendReceipt> {
    const { mailbox, phoneNumberId } = await this.channels();
    const key = m.idempotency_key ? { "Idempotency-Key": m.idempotency_key.slice(0, 255), Prefer: "idempotency-replay" } : undefined;
    if (m.channel === "email") {
      if (!mailbox) throw new Error("inkbox: no sending mailbox (set INKBOX_MAILBOX or INKBOX_IDENTITY)");
      const r = await this.call("POST", `/mail/mailboxes/${encodeURIComponent(mailbox)}/messages`, {
        recipients: { to: [m.to] }, subject: m.subject.slice(0, 998), body_text: m.text, ...(m.in_reply_to ? { in_reply_to_message_id: m.in_reply_to } : {}),
      }, key) as { id?: string; message_id?: string; thread_id?: string };
      return { via: "inkbox", status: "sent", message_id: r.message_id ?? r.id, thread_id: r.thread_id };
    }
    if (m.channel === "sms") {
      if (!phoneNumberId) throw new Error("inkbox: no sending number (set INKBOX_PHONE_NUMBER_ID or attach one to INKBOX_IDENTITY)");
      const r = await this.call("POST", `/phone/numbers/${encodeURIComponent(phoneNumberId)}/texts`, { to: m.to, text: m.text.slice(0, 1600) }, key) as { id?: string; conversation_id?: string };
      return { via: "inkbox", status: "sent", message_id: r.id, thread_id: r.conversation_id };
    }
    throw new Error(`inkbox: channel ${m.channel} not supported`);
  }

  private async call(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<unknown> {
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: { "X-API-Key": this.c.apiKey, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`inkbox ${method} ${path.split("/").slice(0, 3).join("/")}: ${res.status} ${text.slice(0, 160)}`);
    return text ? JSON.parse(text) : {};
  }
}

/** Inkbox for the channels it is configured for, the log courier for the rest (and for everything without a key). */
export class FallbackCourier implements Courier {
  readonly name: string;
  constructor(readonly primary: Courier | null, readonly fallback: LogCourier) {
    this.name = primary ? `${primary.name}+${fallback.name}` : fallback.name;
  }
  canDeliver() { return true; }
  deliver(m: Outgoing) {
    return this.primary?.canDeliver(m.channel) ? this.primary.deliver(m) : this.fallback.deliver(m);
  }
}

export function courierFromEnv(env: NodeJS.ProcessEnv = process.env): FallbackCourier {
  const inkbox = env.INKBOX_API_KEY
    ? new InkboxCourier({ apiKey: env.INKBOX_API_KEY, mailbox: env.INKBOX_MAILBOX || undefined, phoneNumberId: env.INKBOX_PHONE_NUMBER_ID || undefined,
        identity: env.INKBOX_IDENTITY || undefined, baseUrl: env.INKBOX_BASE_URL || undefined })
    : null;
  return new FallbackCourier(inkbox, new LogCourier());
}

/** E1's Sender (the follow-up offer) on top of a courier. The offer_id is the idempotency key, so a retry never sends twice. */
export function asSender(c: Courier): Sender {
  return (m: OutboundMessage) => c.deliver({ channel: m.channel, to: m.reply_to, subject: m.subject, text: m.text, idempotency_key: m.offer.offer_id });
}
