// Bridge 3 · Follow-up loop end to end against a running gateway (no deps; Node 22+).
//   OUTREACH_SECRET=… node apps/marketplace/scripts/followup-e2e.mjs [mcp_url] [--delay-ms 5000] [--phase all|walk|finish]
// The gateway must run with the same OUTREACH_SECRET and FOLLOWUP_DELAY_MS (e.g. 5000). OUTREACH_TICK_MS=0 keeps its
// timer out of the way; the script then drives sends with POST /cron/outreach.
// Flow: make_offer ×2 → walk_away with allow_followup_to → cron before the delay sends nothing → cron after the delay
// sends the follow-up → check_offers shows it (follow_up, price ≥ last offer) → /outbox has it → an unclear reply gets
// a clarifying question → "ACCEPT off_…" locks a deal → the same buyer's second walk-away is capped (no follow-up).
// --phase walk stops after the walk-aways and prints a state line; --phase finish <state> picks up from it (restart test).
// Uses run_id "s1-test-followup" (dashboard hides s1-test* runs).
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MCP = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:3002/mcp";
const ORIGIN = new URL(MCP).origin;
const SECRET = process.env.OUTREACH_SECRET;
const DELAY = Number(arg("--delay-ms", process.env.FOLLOWUP_DELAY_MS ?? 5000));
const PHASE = arg("--phase", "all");
const RUN = "s1-test-followup";
let id = 0;
const fail = (m) => { console.error(`FAIL ${m}`); process.exit(1); };
const ok = (m) => console.log(`  ok  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!SECRET) fail("set OUTREACH_SECRET (same as the gateway's)");

async function rpc(method, params) {
  const res = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const text = await res.text();
  const body = text.trim().startsWith("{") ? text : (text.split("\n").filter((l) => l.startsWith("data:")).pop() ?? "").slice(5);
  const msg = JSON.parse(body);
  if (msg.error) fail(`${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}
async function tool(name, args) {
  const r = await rpc("tools/call", { name, arguments: { run_id: RUN, buyer_model: "followup-e2e", ...args } });
  return r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? "{}");
}
async function http(method, path, body) {
  const res = await fetch(`${ORIGIN}${path}`, { method, // an empty body with content-type json is a 400 from the framework, so cron posts send none
    headers: { authorization: `Bearer ${SECRET}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) fail(`${method} ${path}: ${res.status} ${JSON.stringify(j)}`);
  return j;
}

async function walkAway(buyer_id, reply_to, product_id) {
  let r = await tool("make_offer", { product_id, offer_price_cents: 9000, buyer_id });
  if (!r.negotiation_id) fail(`make_offer: ${JSON.stringify(r).slice(0, 300)}`);
  r = await tool("make_offer", { product_id, negotiation_id: r.negotiation_id, offer_price_cents: 9500, buyer_id });
  const last = r.standing_offer?.price_cents;
  const w = await tool("walk_away", { negotiation_id: r.negotiation_id, buyer_id, reason: "e2e: over budget", allow_followup_to: reply_to, followup_channel: "email" });
  if (w.state !== "walked_away") fail(`walk_away: ${JSON.stringify(w).slice(0, 300)}`);
  return { neg: r.negotiation_id, last };
}

async function walkPhase() {
  const buyer = `fe2e_${Date.now().toString(36)}`;
  const reply_to = `${buyer}@agents.example.test`;
  console.log(`gateway ${MCP}  buyer ${buyer}  delay ${DELAY} ms`);
  const a = await walkAway(buyer, reply_to, "kb_typewell_65");
  ok(`walked away from ${a.neg} with consent (last seller price $${a.last / 100})`);
  const early = await http("POST", "/cron/outreach");
  if (early.followups.some((f) => f.negotiation_id === a.neg)) fail("follow-up went out before the delay");
  ok("cron before the delay: no follow-up for us");
  return { buyer, reply_to, a, t0: Date.now() };
}

async function finishPhase({ buyer, reply_to, a, t0 }) {
  await sleep(Math.max(0, t0 + DELAY + 1500 - Date.now()));
  const due = await http("POST", "/cron/outreach");
  const st = await tool("check_offers", { negotiation_id: a.neg, buyer_id: buyer });
  if (st.state !== "follow_up") fail(`expected follow_up after the delay, got ${st.state} (cron sent ${due.sent}; is the gateway's FOLLOWUP_DELAY_MS ≤ ${DELAY}?)`);
  const o = st.standing_offer;
  if (!o?.offer_id) fail("no follow-up offer on check_offers");
  if (o.price_cents < a.last) fail(`follow-up $${o.price_cents / 100} is below the last offer $${a.last / 100}`);
  ok(`follow-up sent after the delay (${due.via}): ${o.offer_id} at $${o.price_cents / 100}${o.levers.length ? ` + ${o.levers.join(", ")}` : ""}, not below the last offer`);
  const box = await http("GET", "/outbox");
  const inBox = box.events.some((e) => e.offer_id === o.offer_id) || box.local.some((e) => e.text.includes(o.offer_id));
  if (!inBox) fail("follow-up missing from /outbox");
  ok("follow-up is in /outbox");

  const unclear = await http("POST", "/inbound/email", { from: reply_to, text: "sounds good, deal", subject: "Re: your offer" });
  if (unclear.intent !== "clarify" || !unclear.reply.includes(o.offer_id)) fail(`unclear reply: ${JSON.stringify(unclear)}`);
  ok(`unclear reply → clarifying question, no guess: "${unclear.reply.slice(0, 70)}…"`);
  const acc = await http("POST", "/inbound/email", { from: reply_to, text: `ACCEPT ${o.offer_id}\n\n> earlier message`, subject: "Re: your offer" });
  if (acc.intent !== "accept" || acc.state !== "agreed" || !acc.deal_id) fail(`ACCEPT: ${JSON.stringify(acc)}`);
  ok(`ACCEPT ${o.offer_id} → deal ${acc.deal_id} locked ($${acc.total_cents / 100})${acc.approve_url ? ", approve link sent" : ""}`);
  const after = await tool("check_offers", { negotiation_id: a.neg, buyer_id: buyer });
  if (after.state !== "agreed" || after.deal?.deal_id !== acc.deal_id) fail(`check_offers after accept: ${after.state}`);
  ok("check_offers: agreed, same deal");

  const b = await walkAway(buyer, reply_to, "kb_hushline_96");
  await sleep(DELAY + 1500);
  const again = await http("POST", "/cron/outreach");
  const st2 = await tool("check_offers", { negotiation_id: b.neg, buyer_id: buyer });
  if (st2.state !== "walked_away" || again.followups.some((f) => f.negotiation_id === b.neg)) fail(`second walk-away was not capped: ${st2.state}`);
  ok("same buyer's second walk-away this week: no follow-up (followup_cap)");
  console.log("PASS follow-up loop end to end");
}

if (PHASE === "walk") console.log(`STATE ${JSON.stringify(await walkPhase())}`);
else if (PHASE === "finish") await finishPhase(JSON.parse(process.argv.at(-1)));
else await finishPhase(await walkPhase());
