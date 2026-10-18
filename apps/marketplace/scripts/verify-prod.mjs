// S1 · Post-deploy check against the deployed gateway (no deps; Node 22+).
//   node apps/marketplace/scripts/verify-prod.mjs [mcp_url] [--pay]
// Checks: tools/list (9 tools), lever-ranked search (extras carry the shared map's values), and one haggle
// make_offer → accept_deal → review_deal (→ pay_deal in Stripe test mode with --pay). Uses its own buyer_id and
// run_id "s1-test-verify" (hidden from the dashboard) so it never touches the anon bucket or the live run.
const URL = process.argv.find((a) => a.startsWith("http")) ?? "https://dark-zero-mesv5.run.mcp-use.com/mcp";
const PAY = process.argv.includes("--pay");
const RUN = "s1-test-verify"; // dashboard isTestRun() hides s1-test* runs
const BUYER = `verify_${Date.now().toString(36)}`;
let id = 0;
const fail = (m) => { console.error(`FAIL ${m}`); process.exit(1); };

async function rpc(method, params) {
  const t0 = Date.now();
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  // Stateless HTTP may answer as SSE: take the last data: line.
  const body = text.trim().startsWith("{") ? text : (text.split("\n").filter((l) => l.startsWith("data:")).pop() ?? "").slice(5);
  const msg = JSON.parse(body);
  if (msg.error) fail(`${method}: ${JSON.stringify(msg.error)}`);
  return { result: msg.result, ms: Date.now() - t0 };
}
async function call(name, args) {
  const { result, ms } = await rpc("tools/call", { name, arguments: args });
  const text = result.content?.[0]?.text ?? "{}";
  let sc = result.structuredContent;
  if (!sc) try { sc = JSON.parse(text); } catch { sc = { refused: true, message: text }; } // refusals come back as text
  console.log(`  ${name} (${ms} ms): ${(sc.message ?? sc.status ?? "").toString().slice(0, 110)}`);
  return sc;
}

console.log(`gateway ${URL}  buyer ${BUYER}`);
const { result: tl } = await rpc("tools/list", {});
const names = tl.tools.map((t) => t.name).sort();
console.log(`tools (${names.length}): ${names.join(", ")}`);
if (names.length < 9) fail("expected 9 tools");

const s = await call("search_products", { category: "keyboard", preferences: { delivery: 1 }, run_id: RUN });
for (const r of s.results) console.log(`    ${r.listing.id.padEnd(22)} $${r.listing.list_price_cents / 100}  ship ${r.listing.shipping_days}d  fit ${r.fit_score}  warranty ${r.listing.specs?.warranty ?? "-"}  extras ${r.levers_offered.map((l) => `${l.id}→${l.lever}`).join(",")}`);
const fs = s.results.flatMap((r) => r.levers_offered).find((l) => l.id === "free_shipping");
if (fs && fs.lever !== "delivery") fail(`free_shipping serves ${fs.lever}, expected delivery (shared extras map)`);

const pid = "kb_keyforge_quiet75";
let r = await call("make_offer", { product_id: pid, offer_price_cents: 9000, buyer_id: BUYER, run_id: RUN, buyer_model: "verify" });
if (!r.ok || !r.negotiation_id) fail(`make_offer: ${JSON.stringify(r).slice(0, 300)}`);
const offer = r.standing_offer;
if (!offer?.offer_id) fail(`no standing offer: ${JSON.stringify(r).slice(0, 300)}`);
console.log(`    seller counter $${offer.price_cents / 100} (floor stays private)`);
r = await call("accept_deal", { negotiation_id: r.negotiation_id, offer_id: offer.offer_id, buyer_id: BUYER });
if (!r.deal?.deal_id) fail(`accept_deal: ${JSON.stringify(r).slice(0, 300)}`);
const deal_id = r.deal.deal_id;
const other = await call("review_deal", { deal_id, buyer_id: `${BUYER}_other`, run_id: RUN });
if (!other.refused && other.status === "ready") fail("another buyer can review this deal");
const card = await call("review_deal", { deal_id, buyer_id: BUYER, run_id: RUN, buyer_model: "verify" });
if (card.status !== "ready") fail(`card status ${card.status}`);
console.log(`    card: ${card.seller_name} ${card.product?.title} $${card.total_cents / 100} (saves $${card.savings_cents / 100})`);
if (PAY) {
  const p = await call("pay_deal", { deal_id, buyer_id: BUYER, run_id: RUN, buyer_model: "verify" });
  if (p.status !== "succeeded" && !p.already_paid) fail(`pay_deal: ${JSON.stringify(p).slice(0, 300)}`);
  const again = await call("pay_deal", { deal_id, buyer_id: BUYER, run_id: RUN, buyer_model: "verify" });
  if (!again.already_paid) fail("second pay_deal did not report already_paid");
}
console.log(`OK  buyer_id=${BUYER} deal_id=${deal_id}`);
