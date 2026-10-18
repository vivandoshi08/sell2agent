/**
 * SPIKE demo: localhost A2A seller + three buyers.
 *  1. coded buyer via A2AGateway (DataPart skill calls): discover card → search → get_listing → offers → accept
 *  2. "off-the-shelf" text-only A2A buyer: plain sentences only
 *  3. email buyer through the Primitive handler (fake inbound event, fake reply port; no Primitive account)
 */
import type { BuyerContext } from "@sa/shared";
import type { EmailReceivedEvent } from "@primitivedotdev/sdk/webhook";
import { SellerAgent } from "../src/agent";
import { startA2AServer } from "../src/server";
import { handleEmailEvent } from "../src/email";
import { A2AGateway } from "../../buyer-harness/src/gateway/a2a";

const $ = (c: number) => `$${(c / 100).toFixed(2)}`;
const agent = new SellerAgent();
const { server, url } = await startA2AServer(agent, 0);
console.log(`seller A2A on ${url}`);
console.log("card:", JSON.stringify(await (await fetch(`${url}.well-known/agent-card.json`)).json()).slice(0, 200), "...");

// 1. coded buyer
console.log("\n== 1. A2AGateway buyer (structured) ==");
const gw = new A2AGateway(url);
const ctx: BuyerContext = { run_id: "a2a-spike", buyer_id: "buyer_coded_1", buyer_model: "scripted", channel: "harness", agent_operator: "harness" };
const hits = await gw.search(ctx, "tkl");
console.log("search tkl ->", hits.map((h) => `${h.product_id} ${$(h.list_price_cents)}`));
const l = (await gw.getListing(ctx, "kb_clackco_tkl"))!;
console.log("get_listing ->", l.title, $(l.list_price_cents), "negotiable:", l.negotiable);
let bid = 8000, nid: string | undefined, last;
for (let i = 0; i < 6; i++) {
  last = await gw.offer(ctx, { product_id: l.product_id, negotiation_id: nid, offer_price_cents: bid });
  nid = last.negotiation_id;
  console.log(`offer ${$(bid)} -> ${last.status} ${$(last.price_cents)} round ${last.round} left ${last.rounds_left} | ${last.message.slice(0, 110)}`);
  if (last.status === "accept" || last.final || last.price_cents - bid <= 300) break;
  bid = Math.round((bid + last.price_cents) / 2);
}
const deal = await gw.accept(ctx, nid!);
console.log("accept_deal ->", JSON.stringify(deal));

// 2. text-only A2A buyer
console.log("\n== 2. text-only A2A buyer ==");
const say = async (text: string) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send",
    params: { message: { kind: "message", messageId: crypto.randomUUID(), contextId: "chat_42", role: "user", parts: [{ kind: "text", text }] } } }) });
  const t = ((await r.json()) as { result: { parts: { text?: string }[] } }).result.parts[0].text!;
  console.log(`buyer: ${text}\nseller: ${t}`);
  return t;
};
await say("Hi! Saw your listing kb_typewell_65. Is it still available?");
const t1 = await say("Can you do $100 for it?");
const off = t1.match(/off_[0-9a-f-]+/)?.[0];
await say(`OK, ACCEPT ${off}`);

// 3. email buyer via the Primitive handler
console.log("\n== 3. email buyer via Primitive handler (simulated inbound) ==");
const replies: string[] = [];
const port = { reply: async (_e: unknown, i: { text: string }) => { replies.push(i.text); return { id: "sent_fake" }; } };
const mkEvent = (n: number, body: string): EmailReceivedEvent => ({
  id: `evt_${n}`, event: "email.received", version: "2025-01-01", delivery: { endpoint_id: "ep", attempt: 1, attempted_at: new Date().toISOString() },
  email: { id: `em_${n}`, thread_id: "thr_1", received_at: new Date().toISOString(),
    smtp: { helo: null, mail_from: "agent@buyer.example", rcpt_to: ["sell@demo.primitive.email"] },
    headers: { message_id: `<m${n}@buyer.example>`, subject: "kb_hushline_96", from: "Buyer Agent <agent@buyer.example>", to: "sell@demo.primitive.email", date: null },
    content: { raw: null, download: null },
    parsed: { status: "complete", body_text: body, body_html: null } as never,
    analysis: {} as never,
    auth: { spf: "pass", dmarc: "pass", dmarcPolicy: "reject", dmarcFromDomain: "buyer.example", dmarcSpfAligned: true, dmarcDkimAligned: true } as never },
} as EmailReceivedEvent);
const e1 = await handleEmailEvent(agent, mkEvent(1, "Would you take $95 for the Hushline?"), port);
console.log("buyer identity:", JSON.stringify((e1 as { buyer: unknown }).buyer));
console.log("reply 1:", replies.at(-1));
const off2 = replies.at(-1)!.match(/off_[0-9a-f-]+/)?.[0];
await handleEmailEvent(agent, mkEvent(2, `Deal. ACCEPT ${off2}\n\nOn Sat someone wrote:\n> old text`), port);
console.log("reply 2:", replies.at(-1));

// 4. protocol check: the official A2A JS client (@a2a-js/sdk) talks to our hand-rolled server
console.log("\n== 4. official @a2a-js/sdk client ==");
const { A2AClient } = await import("@a2a-js/sdk/client");
const client = await A2AClient.fromCardUrl(`${url}.well-known/agent-card.json`);
const r = await client.sendMessage({ message: { kind: "message", messageId: crypto.randomUUID(), contextId: "sdk_1", role: "user",
  parts: [{ kind: "data", data: { skill: "make_offer", args: { product_id: "kb_keyforge_quiet75", offer_price_cents: 11000 } } }] } });
const res = (r as { result?: { parts?: { kind: string; text?: string }[] }; error?: unknown });
console.log("sdk sendMessage ->", res.error ? JSON.stringify(res.error) : res.result?.parts?.find((p) => p.kind === "text")?.text);

const types = agent.events.map((e) => (e as { type: string }).type);
console.log(`\nexchange events logged: ${types.length} (deal_accepted: ${types.filter((t) => t === "deal_accepted").length})`);
server.close();
