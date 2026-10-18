// Web door (/buy/:product_id): a buyer that can only fetch URLs asks, haggles and accepts through the REAL exchange,
// with the demo Keychron row loaded the way Supabase serves it. Same floor and guardrails as the MCP tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange, SupabaseCatalog } from "@sa/seller-mcp/exchange";
import { buyPage, toCents, aliases } from "../src/buy-page";

const row = { id: "kb_keychron_k2_real", seller_id: "s_potrero", category: "mechanical_keyboard", title: "Keychron K2 wireless mechanical keyboard, quiet brown switches",
  description: "Keychron K2, Gateron Brown switches. Lightly used. Pickup in Potrero Hill.",
  specs: { layout: "75%", switch: "Gateron Brown (tactile, quiet)", wireless: true, condition: "lightly used", warranty: "none (private sale)", pickup: "Potrero Hill, SF" },
  list_price_cents: 4000, inventory: 1, shipping_days: 0 };
const pol = { product_id: row.id, floor_price_cents: 3000, unit_cost_cents: 2000, target_margin_pct: 25, max_rounds: 6, allowed_concessions: [] };
const db: any = { from: (t: string) => ({ select: async () => ({ data: t === "products" ? [row] : t === "seller_policies" ? [pol] : [], error: null }) }) };
const listing: any = { ...row, mcp_url: "", seller_name: "Potrero Hill seller", in_stock: true };

function deps() {
  const ex = new Exchange({ catalog: new SupabaseCatalog(db), llm: null, sink: async () => {} });
  return { listing: async (id: string) => (id === row.id ? listing : null), ex: async () => ex,
    ask: async () => ({ answer: "condition: lightly used", grounded: true }), approve: (d: string) => `https://gw.example/deal/${d}?t=x` };
}
const linkParams = (body: string, re: RegExp) => Object.fromEntries(new URL(`https://x${body.match(re)![1].replace(/&amp;/g, "&")}`).searchParams);

test("page shows the listing and plain forms (no scripts)", async () => {
  const r = await buyPage(row.id, {}, deps());
  assert.equal(r.status, 200);
  assert.match(r.body, /Keychron K2/); assert.match(r.body, /\$40<\/strong>, price negotiable/); assert.match(r.body, /name="price"/);
  assert.doesNotMatch(r.body, /<script/i);
  assert.doesNotMatch(r.body, /\$30|3000|floor|unit_cost/); // never the floor or cost
});

test("fetch-only buyer: ask, haggle, accept; the floor holds and the deal is held 30 min", async () => {
  const d = deps();
  const first = await buyPage(row.id, {}, d);
  const b = first.body.match(/name="b" value="(anon_[^"]+)"/)![1];
  const ask = await buyPage(row.id, { do: "ask", q: "What condition is it?", b }, d);
  assert.match(ask.body, /lightly used/);

  let n: string | undefined; let last = "";
  for (const price of ["20", "$25", "28", "29", "29", "29"]) {
    const r = await buyPage(row.id, { do: "offer", price, b, ...(n ? { n } : {}) }, d);
    assert.equal(r.status, 200, r.body);
    n = r.body.match(/name="n" value="([^"]+)"/)?.[1] ?? n;
    last = r.body;
  }
  assert.match(last, /Accept \$\d+/);
  const acc = linkParams(last, /href="(\/buy\/[^"]+do=accept[^"]+)"/);
  const done = await buyPage(row.id, acc, d);
  assert.equal(done.status, 200, done.body);
  const price = Number(done.body.match(/Deal locked: [^,]+, [^,]+, \$(\d+)/)?.[1] ?? done.body.match(/\$(\d+)\./)![1]);
  assert.ok(price >= 30, `deal at $${price} broke the $30 floor`);
  assert.match(done.body, /Pay at pickup/); assert.match(done.body, /gw\.example\/deal\//); assert.match(done.body, /in about 30 min/);
});

test("bad input: unknown product, bad price, foreign buyer id", async () => {
  assert.equal((await buyPage("nope", {}, deps())).status, 404);
  assert.equal((await buyPage(row.id, { do: "offer", price: "thirty" }, deps())).status, 400);
  const r = await buyPage(row.id, { b: "oai_someone_else" }, deps());
  assert.doesNotMatch(r.body, /oai_someone_else/); // only gateway-minted anon_ ids are reused
});

test("helpers: dollars to cents, aliases", () => {
  assert.equal(toCents("32"), 3200); assert.equal(toCents("$32.5"), 3250); assert.equal(toCents("1,000"), 100000);
  assert.equal(toCents("-5"), null); assert.equal(toCents("abc"), null); assert.equal(toCents("0"), null);
  assert.deepEqual(aliases("k2=kb_keychron_k2_real, bad alias=x"), { k2: "kb_keychron_k2_real" });
});
