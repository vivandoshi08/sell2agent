// Hosted approve page (for text-only buyer agents like Instinct). Offline: mock exchange, fake payDeal.
// Run: node --import tsx --test apps/marketplace/src/deal/approve.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Deal } from "@sa/payments";
import { createDealModule, createMockCatalog, createMockExchange, PRIVATE_KEYS } from "./index";
import { approveCheckout, approvePage, approvePay, approveToken, approveUrl, registerApprovePage, scriptJson, verifyApproveToken } from "./approve";

const KEY = "test-secret";
// Most tests here cover the one-tap test-card page; the Checkout tests at the bottom turn Checkout back on.
process.env.APPROVE_CHECKOUT = "off";
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

// Runs the page's real <script> against a fake DOM + fetch (production 400'd an empty-body JSON POST before our handler).
async function runPageScript(respond: (init: any) => { status: number; text: string }) {
  const { mod } = setup();
  const t = approveToken("deal_demo_ready", "buyer_demo", KEY);
  const body = (await approvePage(mod, "deal_demo_ready", { t }, KEY)).body;
  const src = body.match(/<script>([\s\S]*?)<\/script>/)![1];
  let click: () => void = () => {};
  const btn: any = { disabled: false, textContent: "Approve & Pay", setAttribute() {}, removeAttribute() {}, addEventListener: (_: string, f: () => void) => { click = f; } };
  const sent: any[] = [];
  let replaced = "";
  const { runInNewContext } = await import("node:vm");
  runInNewContext(src, {
    document: { querySelector: () => btn }, URL,
    location: { href: `https://gw/deal/deal_demo_ready?t=${t}`, replace: (u: string) => { replaced = u; } },
    fetch: async (_: string, init: any) => { sent.push(init); const r = respond(init); return { status: r.status, text: async () => r.text }; },
  });
  click();
  await new Promise((r) => setTimeout(r, 10));
  return { sent, replaced: replaced ? new URL(replaced) : null, btn };
}

test("page script sends a JSON body, and a non-JSON error shows the server's reply instead of 'network error'", async () => {
  const ok = await runPageScript((init) => init.body === "{}" ? { status: 200, text: JSON.stringify({ status: "succeeded" }) } : { status: 400, text: "Invalid JSON" });
  assert.equal(ok.sent[0].body, "{}");
  assert.equal(ok.replaced?.searchParams.get("r"), "succeeded");
  const bad = await runPageScript(() => ({ status: 400, text: "Invalid JSON" }));
  assert.equal(bad.replaced?.searchParams.get("r"), "error");
  assert.match(bad.replaced?.searchParams.get("m") ?? "", /400: Invalid JSON\. Nothing was charged/);
});

test("JSON embedded in the inline <script> can't close the tag: <, >, &, U+2028, U+2029 are escaped and round-trip", async () => {
  const nasty = "</script><script>alert(1)</script>&  <!--";
  const out = scriptJson({ v: nasty });
  for (const c of ["<", ">", "&", " ", " "]) assert.ok(!out.includes(c), `raw ${JSON.stringify(c)} left in ${out}`);
  assert.deepEqual(JSON.parse(out), { v: nasty });
  const { runInNewContext } = await import("node:vm");
  assert.equal(runInNewContext(`(${out}).v`), nasty, "still a valid JS literal");
  // The rendered page: exactly one <script> open and one close, whatever the token holds.
  const { mod } = setup();
  const body = (await approvePage(mod, "deal_demo_ready", { t: approveToken("deal_demo_ready", "buyer_demo", KEY) }, KEY)).body;
  assert.equal(body.match(/<script/gi)?.length, 1);
  assert.equal(body.match(/<\/script/gi)?.length, 1);
});

// ── Stripe Checkout variant (default in production) ──────────────────────────────────────────────────
function withCheckout<T>(f: () => Promise<T>): Promise<T> {
  delete process.env.APPROVE_CHECKOUT;
  return f().finally(() => { process.env.APPROVE_CHECKOUT = "off"; });
}

function checkoutSetup() {
  const sessions: { deal: Deal; success_url: string }[] = [];
  const paid: string[] = [], voided: string[] = [];
  const mod = createDealModule({
    deals: createMockExchange(), catalog: createMockCatalog(), logEvent: async () => {},
    createCheckout: async (deal, urls) => { sessions.push({ deal, success_url: urls.success_url }); return { id: `cs_test_${sessions.length}`, url: `https://checkout.stripe.com/c/pay/cs_test_${sessions.length}` }; },
    voidCheckout: async (cs) => { voided.push(cs); return "released"; },
    payDeal: async (deal, cred) => {
      const cs = (cred as { checkout_session: string }).checkout_session;
      paid.push(cs);
      return { status: "succeeded", deal_id: deal.deal_id, amount_cents: deal.amount_cents, mode: "checkout", payment_intent_id: "pi_held", held: true, pickup_code: "123456" };
    },
  });
  return { mod, sessions, paid, voided };
}

test("Checkout: the page button goes to Stripe Checkout, not the one-tap pay route", () => withCheckout(async () => {
  const { mod } = checkoutSetup();
  const r = await approvePage(mod, "deal_demo_ready", { t: approveToken("deal_demo_ready", "buyer_demo", KEY) }, KEY);
  assert.match(r.body, /\/deal\/deal_demo_ready\/checkout\?t=/);
  assert.doesNotMatch(r.body, /\/pay\?t=/);
}));

test("Checkout: session is for the stored total and returns to this deal's page with {CHECKOUT_SESSION_ID}", () => withCheckout(async () => {
  const { mod, sessions } = checkoutSetup();
  const t = approveToken("deal_demo_ready", "buyer_demo", KEY);
  const r = await approveCheckout(mod, "deal_demo_ready", t, "https://gw.example", KEY);
  assert.equal(r.status, 200);
  assert.match(JSON.parse(r.body).url, /^https:\/\/checkout\.stripe\.com\//);
  assert.equal(sessions[0].deal.amount_cents, 11_900);
  assert.match(sessions[0].success_url, /^https:\/\/gw\.example\/deal\/deal_demo_ready\?t=.+&cs=\{CHECKOUT_SESSION_ID\}$/);
  // Wrong buyer or a bad token never gets a session.
  assert.equal((await approveCheckout(mod, "deal_demo_ready", approveToken("deal_demo_ready", "someone_else", KEY), "https://gw.example", KEY)).status, 409);
  assert.equal((await approveCheckout(mod, "deal_demo_ready", "garbage", "https://gw.example", KEY)).status, 403);
  assert.equal(sessions.length, 1);
}));

test("Checkout: returning with ?cs settles the deal once and shows the pickup code", () => withCheckout(async () => {
  const { mod, paid, voided } = checkoutSetup();
  const t = approveToken("deal_demo_ready", "buyer_demo", KEY);
  const r = await approvePage(mod, "deal_demo_ready", { t, cs: "cs_test_1" }, KEY);
  assert.match(r.body, /held for pickup/);
  assert.match(r.body, /123456/);
  assert.deepEqual(paid, ["cs_test_1"]);
  // A reload with the same session is already paid; a second, different session gets released.
  await approvePage(mod, "deal_demo_ready", { t, cs: "cs_test_1" }, KEY);
  await approvePage(mod, "deal_demo_ready", { t, cs: "cs_test_2" }, KEY);
  assert.deepEqual(paid, ["cs_test_1"]);
  assert.ok(voided.includes("cs_test_2"));
}));

test("Checkout: a completed session for a deal that can't settle is released, not charged", () => withCheckout(async () => {
  const { mod, paid, voided } = checkoutSetup();
  // deal_demo_paid is already settled by another payment in the mock.
  const r = await approvePage(mod, "deal_demo_paid", { t: approveToken("deal_demo_paid", "buyer_demo", KEY), cs: "cs_test_9" }, KEY);
  assert.equal(r.status, 200);
  assert.deepEqual(paid, []);
  assert.deepEqual(voided, ["cs_test_9"]);
}));
