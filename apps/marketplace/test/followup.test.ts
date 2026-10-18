// Bridge 3 follow-up loop through the gateway's door, in-process: walk away with consent → follow-up after the delay
// (log courier) → reply → locked deal. Plus Inkbox webhooks (signed), STOP, the weekly cap, auth and the Inkbox courier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Exchange, MemorySink, FOLLOWUP_DELAY_MS } from "@sa/seller-mcp/exchange";
import type { NegotiationEvent as Ev } from "@sa/shared";
import { asSender, createFollowupDoor, FallbackCourier, InkboxCourier, LogCourier, REPLY_BUDGET, startOutreachTimer, type HttpIn } from "../src/followup/index.js";
import { verifyApproveToken } from "../src/deal/approve.js";

const SECRET = "test-outreach-secret";
const SIGNING = "whsec_test_signing";
const env = { OUTREACH_SECRET: SECRET, INKBOX_SIGNING_KEY: SIGNING, EXCHANGE_HMAC_SECRET: "test-hmac" } as NodeJS.ProcessEnv;
process.env.EXCHANGE_HMAC_SECRET ??= "test-hmac";
const P = "kb_typewell_65"; // list 13900, floor 11000, levers free_shipping + extended_warranty
const ctx = (b: string) => ({ run_id: "s1-test-followup", buyer_id: b, buyer_model: "scripted" });

function rig() {
  const clock = { t: Date.now() };
  const sink = new MemorySink();
  const logCourier = new LogCourier();
  const courier = new FallbackCourier(null, logCourier);
  const ex = new Exchange({ sink: sink.sink, now: () => clock.t, send: asSender(courier) });
  const logged: Ev[] = [];
  const door = createFollowupDoor({ exchange: async () => ex, courier, approveOrigin: "https://gw.example.test", env, log: async (e) => { logged.push(e); },
    recentEvents: async () => sink.events as Ev[] });
  return { clock, sink, logCourier, ex, door, logged };
}

const req = (o: Omit<Partial<HttpIn>, "body" | "headers"> & { body?: unknown; auth?: string | null; headers?: Record<string, string> } = {}): HttpIn => {
  const h: Record<string, string> = { ...(o.auth === null ? {} : { authorization: `Bearer ${o.auth ?? SECRET}` }), ...o.headers };
  return { params: o.params ?? {}, query: o.query ?? new URLSearchParams(), headers: (n) => h[n.toLowerCase()], body: typeof o.body === "string" ? o.body : JSON.stringify(o.body ?? {}) };
};
const out = (r: { body: string }) => JSON.parse(r.body);

async function walkAway(ex: Exchange, buyer: string, reply_to = `${buyer}@agents.example.test`, channel: "email" | "sms" = "email", product_id = P) {
  let r = await ex.handle({ kind: "offer", ctx: ctx(buyer), product_id, offer_price_cents: 10000, buyer_profile: { warranty: 0.9, price: 0.4 } });
  r = await ex.handle({ kind: "offer", ctx: ctx(buyer), product_id, negotiation_id: r.negotiation_id, offer_price_cents: 10200 });
  const last = r.standing_offer!.price_cents;
  await ex.handle({ kind: "walk", ctx: ctx(buyer), negotiation_id: r.negotiation_id!, followup: { reply_to, channel } });
  return { neg: r.negotiation_id!, last };
}

test("end to end: consented walk-away → follow-up after the delay (log courier) → ACCEPT off_… → locked deal", async () => {
  const { clock, logCourier, ex, door } = rig();
  const { neg, last } = await walkAway(ex, "e2e1");
  assert.equal(out(await door.cron(req())).sent, 0, "nothing before the delay");
  clock.t += FOLLOWUP_DELAY_MS + 1;
  const c = out(await door.cron(req()));
  assert.equal(c.sent, 1);
  assert.equal(c.followups[0].to, "e2***@agents.example.test");
  assert.equal(logCourier.outbox.length, 1, "log courier kept it");
  const sentText = logCourier.outbox[0].text;
  const offer_id = sentText.match(/offer_id: (off_[0-9a-f-]+)/)![1];
  const p = (await ex.catalog.get(P))!;
  const price = c.followups[0].price_cents;
  assert.ok(price >= last, "never below the buyer's last price");
  assert.ok(price - 1200 >= p.floor_price_cents, "never below floor + lever cost (extended warranty added)");

  const ob = out(await door.outbox(req()));
  assert.equal(ob.events[0].kind, "followup");
  assert.equal(ob.events[0].offer_id, offer_id);
  assert.equal(ob.local.length, 1);

  const r = out(await door.inbound(req({ params: { channel: "email" }, body: { from: "e2e1@agents.example.test", text: `ACCEPT ${offer_id}`, subject: "Re: TypeWell" } })));
  assert.equal(r.routed, true);
  assert.equal(r.intent, "accept");
  assert.equal(r.state, "agreed");
  assert.ok(r.deal_id);
  assert.equal(verifyApproveToken(r.deal_id, new URL(r.approve_url).searchParams.get("t"), "test-hmac"), "e2e1", "approve link for this buyer");
  assert.match(r.reply, /Deal locked/);
  assert.equal(r.delivery.via, "log");
  assert.equal(logCourier.outbox[0].subject, "Re: TypeWell");
  const st = await ex.handle({ kind: "status", ctx: ctx("e2e1"), negotiation_id: neg });
  assert.equal(st.state, "agreed");
  assert.equal(st.deal?.unit_price_cents, price);
});

test("Inkbox webhook (signed): an unclear email reply gets a clarifying question routed by sender; bad or stale signatures are refused", async () => {
  const { clock, ex, door, logCourier, sink } = rig();
  const { neg } = await walkAway(ex, "ink1", "Ink1@Agents.Example.test");
  clock.t += FOLLOWUP_DELAY_MS + 1;
  await door.cron(req());
  const body = JSON.stringify({ id: "evt_1", event_type: "message.received", data: { message: { direction: "inbound", from_address: "ink1@agents.example.test",
    email_address: "seller@inkboxmail.com", subject: "Re: TypeWell 65 Silent", body: "sounds good, deal", message_id: "<m1@agents.example.test>" }, contacts: [], agent_identities: [] } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = (b: string, t = ts) => `sha256=${createHmac("sha256", SIGNING).update(`req_1.${t}.${b}`).digest("hex")}`;
  const signed = (b: string, t = ts, s = sig(b, t)) => req({ params: { channel: "email" }, body: b, auth: null, headers: { "x-inkbox-request-id": "req_1", "x-inkbox-timestamp": t, "x-inkbox-signature": s } });

  assert.equal((await door.inbound(signed(body, ts, sig(body.replace("deal", "DEAL"))))).status, 401, "signature over other bytes");
  const stale = String(Math.floor(Date.now() / 1000) - 600);
  assert.equal((await door.inbound(signed(body, stale))).status, 401, "stale timestamp");
  const r = out(await door.inbound(signed(body)));
  assert.equal(r.negotiation_id, neg);
  assert.equal(r.intent, "clarify", "accept without the offer_id is never a guess");
  assert.match(r.reply, /ACCEPT off_/);
  assert.equal(logCourier.outbox[0].subject, "Re: TypeWell 65 Silent");
  assert.equal(out(await door.inbound(signed(body))).duplicate, true, "Inkbox retry with the same event id");
  const e = sink.events.find((x) => x.type === "question_asked" && x.payload.inbound === true)!;
  assert.equal(e.payload.followup_channel, "email");
  assert.equal(e.payload.from_matches_consent, true);
});

test("SMS STOP (Inkbox text.received) unsubscribes; the address never gets another follow-up", async () => {
  const { clock, ex, door, logCourier } = rig();
  await walkAway(ex, "sms1", "+1 (415) 555-0199", "sms");
  clock.t += FOLLOWUP_DELAY_MS + 1;
  await door.cron(req());
  const r = out(await door.inbound(req({ params: { channel: "sms" }, body: { id: "evt_s1", event_type: "text.received",
    data: { text_message: { direction: "inbound", remote_phone_number: "+14155550199", local_phone_number: "+14155550100", text: "STOP" } } } })));
  assert.equal(r.intent, "unsubscribe");
  assert.match(r.reply, /unsubscribed/);
  assert.equal(logCourier.outbox[0].to, "•••0199");
  await walkAway(ex, "sms2", "+14155550199", "sms", "kb_hushline_96");
  clock.t += FOLLOWUP_DELAY_MS + 1;
  assert.equal(out(await door.cron(req())).sent, 0);
});

test("a second walk-away by the same buyer in the same week is blocked by followup_cap", async () => {
  const { clock, ex, door, sink } = rig();
  await walkAway(ex, "cap1");
  clock.t += FOLLOWUP_DELAY_MS + 1;
  assert.equal(out(await door.cron(req())).sent, 1);
  const { neg } = await walkAway(ex, "cap1", undefined, "email", "kb_hushline_96");
  clock.t += FOLLOWUP_DELAY_MS + 1;
  assert.equal(out(await door.cron(req())).sent, 0);
  const cap = sink.events.find((e) => e.type === "guardrail_blocked" && e.payload.rule === "followup_cap");
  assert.equal(cap?.negotiation_id, neg);
});

test("counter by email goes through the exchange's guards and the reply says how to accept", async () => {
  const { clock, ex, door } = rig();
  await walkAway(ex, "ctr1");
  clock.t += FOLLOWUP_DELAY_MS + 1;
  await door.cron(req());
  const r = out(await door.inbound(req({ params: { channel: "email" }, body: { from: "ctr1@agents.example.test", text: "COUNTER $95" } })));
  assert.equal(r.intent, "counter");
  assert.ok(r.standing_offer.price_cents >= 11000, "floor held");
  assert.match(r.reply, new RegExp(`ACCEPT ${r.standing_offer.offer_id}`));
});

test("auth: cron and plain JSON need OUTREACH_SECRET; without one configured they refuse", async () => {
  const { door } = rig();
  assert.equal((await door.cron(req({ auth: "nope" }))).status, 401);
  assert.equal((await door.cron(req({ auth: null }))).status, 401);
  assert.equal((await door.inbound(req({ params: { channel: "email" }, auth: null, body: { text: "ACCEPT off_12345678" } }))).status, 401);
  assert.equal((await door.inbound(req({ params: { channel: "fax" }, body: { text: "x" } }))).status, 404);
  assert.equal((await door.outbox(req({ auth: null, query: new URLSearchParams({ key: SECRET }) }))).status, 200, "?key= works for /outbox");
  const bare = createFollowupDoor({ exchange: async () => new Exchange({ sink: new MemorySink().sink }), courier: new FallbackCourier(null, new LogCourier()), env: {} });
  assert.equal((await bare.cron(req())).status, 503);
  assert.equal((await bare.inbound(req({ params: { channel: "email" }, body: { text: "hi" } }))).status, 401);
});

test("unmatched replies get one pointer per address per day; replies per negotiation are budgeted", async () => {
  const { clock, ex, door, logged, logCourier } = rig();
  const a = out(await door.inbound(req({ params: { channel: "email" }, body: { from: "nobody@example.test", text: "hello?" } })));
  assert.equal(a.routed, false);
  assert.equal(a.delivery.via, "log");
  assert.equal(out(await door.inbound(req({ params: { channel: "email" }, body: { from: "nobody@example.test", text: "hello??" } }))).delivery.status, "skipped");
  assert.equal(logged.filter((e) => e.payload.routed === false).length, 2);
  await walkAway(ex, "loop1");
  clock.t += FOLLOWUP_DELAY_MS + 1;
  await door.cron(req());
  const before = logCourier.outbox.length;
  for (let i = 0; i < REPLY_BUDGET + 2; i++) await door.inbound(req({ params: { channel: "email" }, body: { from: "loop1@agents.example.test", text: "what do you mean?" } }));
  assert.equal(logCourier.outbox.length - before, REPLY_BUDGET, "two agents can't clarify at each other forever");
  assert.ok(logged.some((e) => e.type === "guardrail_blocked" && e.payload.rule === "reply_cap"));
});

test("Inkbox courier: email from the identity's mailbox, SMS from its number, idempotent, errors surface", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (!url.startsWith("https://inkbox.ai/api/v1/")) return new Response("{\"error\":\"bad gateway\"}", { status: 502 });
    if (url.endsWith("/identities/acme-seller")) return new Response(JSON.stringify({ mailbox: { email_address: "sales@acme.example" }, phone_number: { id: "pn_1" } }));
    if (url.includes("/mail/")) return new Response(JSON.stringify({ id: "m1", message_id: "<x@inkboxmail.com>", thread_id: "t1" }), { status: 201 });
    if (url.includes("/texts")) return new Response(JSON.stringify({ id: "tx1", conversation_id: "c1" }), { status: 201 });
    return new Response("nope", { status: 500 });
  }) as unknown as typeof fetch;
  const ink = new InkboxCourier({ apiKey: "ApiKey_test", identity: "acme-seller", fetch: fake });
  const e = await ink.deliver({ channel: "email", to: "buyer@example.test", subject: "Offer", text: "hi", idempotency_key: "off_1" });
  assert.deepEqual(e, { via: "inkbox", status: "sent", message_id: "<x@inkboxmail.com>", thread_id: "t1" });
  const mail = calls.find((c) => c.url.includes("/mail/"))!;
  assert.equal(mail.url, "https://inkbox.ai/api/v1/mail/mailboxes/sales%40acme.example/messages");
  const h = mail.init.headers as Record<string, string>;
  assert.equal(h["X-API-Key"], "ApiKey_test");
  assert.equal(h["Idempotency-Key"], "off_1");
  assert.deepEqual(JSON.parse(String(mail.init.body)), { recipients: { to: ["buyer@example.test"] }, subject: "Offer", body_text: "hi" });
  await ink.deliver({ channel: "sms", to: "+14155550199", subject: "", text: "hi" });
  assert.equal(calls.at(-1)!.url, "https://inkbox.ai/api/v1/phone/numbers/pn_1/texts");
  assert.equal(calls.filter((c) => c.url.includes("/identities/")).length, 1, "identity looked up once");
  const broken = new InkboxCourier({ apiKey: "k", mailbox: "a@b.example", baseUrl: "https://inkbox.test/v9", fetch: fake });
  await assert.rejects(broken.deliver({ channel: "email", to: "x@y.example", subject: "s", text: "t" }), /inkbox POST/);
  const both = new FallbackCourier(new InkboxCourier({ apiKey: "k", mailbox: "a@b.example", fetch: fake }), new LogCourier());
  assert.equal((await both.deliver({ channel: "a2a", to: "agent://x", subject: "s", text: "t" })).via, "log", "A2A falls back to the log");
  assert.equal((await both.deliver({ channel: "sms", to: "+14155550199", subject: "s", text: "t" })).via, "log", "no number configured → log");
});

test("timer: off when OUTREACH_TICK_MS=0 or in production by default", () => {
  assert.equal(startOutreachTimer(async () => { throw new Error("unused"); }, { OUTREACH_TICK_MS: "0" }), null);
  assert.equal(startOutreachTimer(async () => { throw new Error("unused"); }, { NODE_ENV: "production" }), null);
  const stop = startOutreachTimer(async () => { throw new Error("unused"); }, { OUTREACH_TICK_MS: "60000" });
  assert.equal(typeof stop, "function");
  stop!();
});
