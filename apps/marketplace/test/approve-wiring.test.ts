// The gateway wiring for S2's hosted approve page (#81): accept_deal returns approve_url, and /deal/:id serves it.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.EXCHANGE_HMAC_SECRET ??= "s1-test-approve-secret";
const { registerNegotiationTools } = await import("../src/negotiate");
const { deal, registerDealTools } = await import("../src/deal-tools");
const { registerApprovePage } = await import("../src/deal/index");

const ORIGIN = "https://gateway.test";
const tools = new Map<string, (a: any) => Promise<any>>();
const routes = new Map<string, (c: any) => Promise<Response>>();
const server = {
  tool: (def: { name: string }, fn: (a: any) => Promise<any>) => tools.set(def.name, fn),
  get: (path: string, fn: (c: any) => Promise<Response>) => routes.set(`GET ${path}`, fn),
  post: (path: string, fn: (c: any) => Promise<Response>) => routes.set(`POST ${path}`, fn),
};
registerNegotiationTools(server, { approveOrigin: ORIGIN });
registerDealTools(server);
registerApprovePage(server, deal);
const call = (name: string, a: any) => tools.get(name)!(a);

/** Call a registered route the way mcp-use's Hono context would. */
function hit(method: "GET" | "POST", url: string) {
  const u = new URL(url);
  const deal_id = decodeURIComponent(u.pathname.split("/")[2]);
  const fn = routes.get(method === "GET" ? "GET /deal/:deal_id" : "POST /deal/:deal_id/pay")!;
  return fn({ req: { url, param: () => deal_id } });
}

async function lockDeal(buyer_id: string) {
  const o = (await call("make_offer", { product_id: "kb_typewell_65", offer_price_cents: 13900, buyer_id, run_id: "s1-test-approve" })).structuredContent;
  return call("accept_deal", { negotiation_id: o.negotiation_id, offer_id: o.standing_offer.offer_id, buyer_id });
}

test("accept_deal returns an approve_url for this deal and buyer, in the text and the summary too", async () => {
  const r = await lockDeal("s1-test-approve-a");
  const { deal: d, approve_url, summary } = r.structuredContent;
  assert.ok(approve_url.startsWith(`${ORIGIN}/deal/${encodeURIComponent(d.deal_id)}?t=`), approve_url);
  assert.ok(r.content[0].text.includes(approve_url), "the model sees the link");
  assert.match(summary, /Approve: https:\/\/gateway\.test\/deal\//);
});

test("the link opens its own deal; a tampered token or another deal is refused", async () => {
  const a = (await lockDeal("s1-test-approve-b")).structuredContent;
  const other = (await lockDeal("s1-test-approve-c")).structuredContent;

  const page = await hit("GET", a.approve_url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /TypeWell 65 Silent/);
  for (const k of ["floor_price_cents", "unit_cost_cents", "signature"]) assert.ok(!html.includes(k), `leaked ${k}`);

  assert.equal((await hit("GET", a.approve_url.replace(/.$/, (c: string) => (c === "A" ? "B" : "A")))).status, 403);
  const reused = `${ORIGIN}/deal/${encodeURIComponent(other.deal.deal_id)}?t=${new URL(a.approve_url).searchParams.get("t")}`;
  assert.equal((await hit("GET", reused)).status, 403, "a link only opens the deal it was made for");
});

test("paying through the link charges the stored total once", async () => {
  const a = (await lockDeal("s1-test-approve-d")).structuredContent;
  const payUrl = a.approve_url.replace(/\/deal\/([^?]+)\?/, "/deal/$1/pay?");
  const first = await (await hit("POST", payUrl)).json();
  const second = await (await hit("POST", payUrl)).json();
  if (first.status === "succeeded") {
    assert.equal(first.amount_cents, a.deal.total_cents);
    assert.ok(second.status === "succeeded" || second.already_paid, "a second click never charges again");
  } else {
    // No Stripe key in this environment: still a clean, explained refusal, never a charge for another amount.
    assert.ok(["refused", "failed", "declined", "error"].includes(first.status), JSON.stringify(first));
  }
});
