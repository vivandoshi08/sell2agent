// Inbound request parsing + auth for the messaging door (POST /inbound/:channel).
//   Inkbox webhooks (https://inkbox.ai/docs/webhooks): envelope { id, event_type, data }, `message.received` (email) and
//   `text.received` (SMS). Signed per identity: X-Inkbox-Signature = sha256=HMAC(key, "{request_id}.{timestamp}.{raw}").
//   Plain JSON: { text, from?, negotiation_id?, buyer_id?, subject? } (A2A agents, scripts, tests).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FollowupChannel } from "./couriers";

export const CHANNELS: FollowupChannel[] = ["email", "sms", "a2a"];
const MAX_SKEW_S = 300;

export type Headers = (name: string) => string | undefined;

export interface InboundMessage {
  source: "inkbox" | "json";
  channel: FollowupChannel;
  text: string;
  from?: string;
  subject?: string;
  negotiation_id?: string;
  buyer_id?: string;
  message_id?: string; // RFC 5322 Message-ID (email threading)
  event_id?: string; // Inkbox envelope id, stable across retries (dedupe)
  to_self?: string; // the mailbox / number it arrived at
}

export type Parsed = { ok: true; msg: InboundMessage } | { ok: false; ignore: string };

const eq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
/** Constant-time check of a presented secret; false when either side is missing. */
export const secretMatches = (given: string | undefined, secret: string | undefined) => !!given && !!secret && eq(given, secret);

/** Inkbox's documented check: fresh timestamp, then HMAC-SHA256 over "{request_id}.{timestamp}.{raw_body}". */
export function verifyInkboxSignature(raw: string, h: Headers, key: string, nowMs = Date.now()): boolean {
  const rid = h("x-inkbox-request-id"), ts = h("x-inkbox-timestamp"), sig = h("x-inkbox-signature");
  if (!rid || !ts || !sig || !Number.isFinite(Number(ts))) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > MAX_SKEW_S) return false;
  const want = createHmac("sha256", key).update(`${rid}.${ts}.${raw}`).digest("hex");
  return eq(sig.replace(/^sha256=/, ""), want);
}

/** Bearer OUTREACH_SECRET (also usable as an Inkbox subscription `auth_token`), or a valid Inkbox signature. */
export function authorize(raw: string, h: Headers, env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): "secret" | "inkbox" | null {
  if (secretMatches(h("authorization")?.replace(/^Bearer\s+/i, "") ?? h("x-outreach-secret"), env.OUTREACH_SECRET)) return "secret";
  if (env.INKBOX_SIGNING_KEY && verifyInkboxSignature(raw, h, env.INKBOX_SIGNING_KEY, nowMs)) return "inkbox";
  return null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

export function parseInboundRequest(channel: FollowupChannel, body: unknown): Parsed {
  if (!body || typeof body !== "object") return { ok: false, ignore: "body must be JSON" };
  const b = body as Record<string, unknown>;
  if (typeof b.event_type === "string") {
    const data = (b.data ?? {}) as Record<string, unknown>;
    if (b.event_type === "message.received") {
      const m = (data.message ?? {}) as Record<string, unknown>;
      if (m.direction && m.direction !== "inbound") return { ok: false, ignore: "not an inbound message" };
      const text = str(m.body) ?? str(m.snippet) ?? "";
      return { ok: true, msg: { source: "inkbox", channel: "email", text, from: str(m.from_address), subject: str(m.subject), message_id: str(m.message_id),
        event_id: str(b.id), to_self: str(m.email_address) } };
    }
    if (b.event_type === "text.received") {
      const t = (data.text_message ?? {}) as Record<string, unknown>;
      if (t.direction && t.direction !== "inbound") return { ok: false, ignore: "not an inbound text" };
      return { ok: true, msg: { source: "inkbox", channel: "sms", text: str(t.text) ?? "", from: str(t.remote_phone_number) ?? str(t.sender_phone_number),
        event_id: str(b.id) ?? str(t.id), to_self: str(t.local_phone_number) } };
    }
    return { ok: false, ignore: `event ${b.event_type} not handled` };
  }
  const text = str(b.text) ?? str(b.body) ?? str(b.message);
  if (!text) return { ok: false, ignore: "text is required" };
  return { ok: true, msg: { source: "json", channel, text, from: str(b.from), subject: str(b.subject), negotiation_id: str(b.negotiation_id), buyer_id: str(b.buyer_id),
    message_id: str(b.message_id) } };
}
