// Hosted approve page (for text-only buyer agents like Instinct). Offline: mock exchange, fake payDeal.
// Run: node --import tsx --test apps/marketplace/src/deal/approve.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Deal } from "@sa/payments";
import { createDealModule, createMockCatalog, createMockExchange, PRIVATE_KEYS } from "./index";
import { approvePage, approvePay, approveToken, approveUrl, registerApprovePage, verifyApproveToken } from "./approve";

const KEY = "test-secret";
function setup() {
  const charges: Deal[] = [];
  const mod = createDealModule({
    deals: createMockExchange(), catalog: createMockCatalog(),
    payDeal: async (deal) => { charges.push(deal); return { status: "succeeded", deal_id: deal.deal_id, amount_cents: deal.amount_cents, mode: "test_card", payment_intent_id: `pi_${charges.length}` }; },
    logEvent: async () => {}, defaultCredential: () => ({ test_card: "pm_card_visa" }),
  });
  return { mod, charges };
}

test("token opens only its own deal, for its own buyer; tampering fails", () => {
  const t = approveToken("deal_demo_ready", "buyer_demo", KEY);
  assert.equal(verifyApproveToken("deal_demo_ready", t, KEY), "buyer_demo");
  assert.equal(verifyApproveToken("deal_demo_paid", t, KEY), null, "other deal");
  assert.equal(verifyApproveToken("deal_demo_ready", t, "other-key"), null, "other secret");
  const [, sig] = t.split(".");
  const forged = `${Buffer.from("someone_else").toString("base64url")}.${sig}`;
  assert.equal(verifyApproveToken("deal_demo_ready", forged, KEY), null, "swapped buyer");
  for (const bad of [undefined, "", "x", "a.b", "..."]) assert.equal(verifyApproveToken("deal_demo_ready", bad, KEY), null);
  assert.match(approveUrl("https://gw.example/", "deal_demo_ready", "buyer_demo", KEY), /^https:\/\/gw\.example\/deal\/deal_demo_ready\?t=[\w-]+\.[\w-]+$/);
});

test("GET renders the public deal card with a pay button, and no private fields", async () => {
  const { mod } = setup();
  const r = await approvePage(mod, "deal_demo_ready", { t: approveToken("deal_demo_ready", "buyer_demo", KEY) }, KEY);
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /text\/html/);
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.match(r.body, /QuietPro 75/);
  assert.match(r.body, /\$119\.00/);
  assert.match(r.body, /dc-btn/);
  assert.match(r.body, /\/deal\/deal_demo_ready\/pay\?t=/, "script posts to the pay route");
  assert.doesNotMatch(r.body, /https?:\/\/(?!gw)/, "no external loads");
  for (const k of PRIVATE_KEYS) assert.ok(!r.body.includes(k), `leaked ${k}`);
});

test("GET with a bad token or unknown deal is a clear page, not a crash", async () => {
  const { mod } = setup();
  assert.equal((await approvePage(mod, "deal_demo_ready", { t: "nope" }, KEY)).status, 403);
  assert.equal((await approvePage(mod, "deal_missing", { t: approveToken("deal_missing", "b", KEY) }, KEY)).status, 404);
});

test("POST pays the stored amount once, as the token's buyer; a retry doesn't charge again", async () => {
  const { mod, charges } = setup();
  const t = approveToken("deal_demo_ready", "buyer_demo", KEY);
  const a = JSON.parse((await approvePay(mod, "deal_demo_ready", t, KEY)).body);
  assert.equal(a.status, "succeeded");
  assert.equal(charges.length, 1);
  assert.equal(charges[0].amount_cents, 11_900);
  const b = JSON.parse((await approvePay(mod, "deal_demo_ready", t, KEY)).body);
  assert.equal(b.already_paid, true);
  assert.equal(charges.length, 1);
  // After paying, the page shows the paid state and no pay script.
  const page = await approvePage(mod, "deal_demo_ready", { t }, KEY);
  assert.doesNotMatch(page.body, /<script>/);
});

test("POST with a token for another buyer is refused before any charge", async () => {
  const { mod, charges } = setup();
  const r = await approvePay(mod, "deal_demo_ready", approveToken("deal_demo_ready", "someone_else", KEY), KEY);
  assert.equal(JSON.parse(r.body).status, "refused");
  assert.equal(charges.length, 0);
  assert.equal((await approvePay(mod, "deal_demo_ready", "garbage", KEY)).status, 403);
});

test("registerApprovePage mounts GET and POST on a Hono-style server", async () => {
  const { mod } = setup();
  const routes = new Map<string, (c: any) => Promise<Response>>();
  const server = { get: (p: string, h: any) => routes.set(`GET ${p}`, h), post: (p: string, h: any) => routes.set(`POST ${p}`, h) };
  registerApprovePage(server, () => mod, { key: KEY });
  const t = approveToken("deal_demo_ready", "buyer_demo", KEY);
  const ctx = (url: string) => ({ req: { url, param: () => "deal_demo_ready" } });
  const g = await routes.get("GET /deal/:deal_id")!(ctx(`https://gw/deal/deal_demo_ready?t=${t}`));
  assert.equal(g.status, 200);
  const p = await routes.get("POST /deal/:deal_id/pay")!(ctx(`https://gw/deal/deal_demo_ready/pay?t=${t}`));
  assert.equal((await p.json()).status, "succeeded");
});
