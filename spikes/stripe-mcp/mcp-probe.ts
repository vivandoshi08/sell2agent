/**
 * Spike: can the official Stripe MCP (mcp.stripe.com) create a fixed-amount payment surface for a LOCKED deal?
 * Creates (TEST mode) a Payment Link and a Checkout Session for exactly 3600 cents with metadata.deal_id, then
 * re-reads both with the plain Stripe SDK (independent of the agent) to check amount + metadata + no buyer knobs.
 * Also probes which "money" operations the MCP exposes (PaymentIntent create/confirm, SPT).
 */
import Stripe from "stripe";
import { connect } from "./list-tools";
import { testKey } from "./env";

const DEAL_ID = `deal_spike_${Date.now()}`;
const AMOUNT = 3600;
const redact = (s: string) => s.replace(/(sk|rk)_(test|live)_[A-Za-z0-9]+/g, "$1_$2_REDACTED");

const mcp = await connect();
async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] };
  return { isError: !!r.isError, text: redact(r.content.map((c) => c.text ?? "").join("\n")) };
}
const json = (t: string) => { try { return JSON.parse(t); } catch { return null; } };

// 1. Which operations exist for the money paths we care about?
for (const [intent, resource] of [["create", "payment intent"], ["confirm", "payment intent"], ["create", "shared payment granted token"], ["create", "payment link"], ["create", "checkout session"]]) {
  const r = await call("stripe_api_search", { intent, resource, limit: 5 });
  console.log(`\n[search ${intent} ${resource}]\n${r.text.slice(0, 600)}`);
}

// 2. Payment Link via MCP: product+price, then link with quantity 1, no adjustable quantity, no promo codes.
const price = await call("stripe_api_write", { stripe_api_operation_id: "PostPrices", parameters: {
  currency: "usd", unit_amount: AMOUNT, product_data: { name: "Spike: Aeron chair (negotiated)" }, metadata: { deal_id: DEAL_ID } } });
console.log(`\n[PostPrices] isError=${price.isError}\n${price.text.slice(0, 400)}`);
const priceId = json(price.text)?.id ?? price.text.match(/price_[A-Za-z0-9]+/)?.[0];

const link = await call("stripe_api_write", { stripe_api_operation_id: "PostPaymentLinks", parameters: {
  line_items: [{ price: priceId, quantity: 1 }], metadata: { deal_id: DEAL_ID }, payment_intent_data: { metadata: { deal_id: DEAL_ID } },
  allow_promotion_codes: false, restrictions: { completed_sessions: { limit: 1 } } } });
console.log(`\n[PostPaymentLinks] isError=${link.isError}\n${link.text.slice(0, 500)}`);
const linkId = json(link.text)?.id ?? link.text.match(/plink_[A-Za-z0-9]+/)?.[0];

// 3. Checkout Session via MCP: inline price_data, 30-min expiry like DEAL_TTL_MS.
const sess = await call("stripe_api_write", { stripe_api_operation_id: "PostCheckoutSessions", parameters: {
  mode: "payment", line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: AMOUNT, product_data: { name: "Spike: Aeron chair (negotiated)" } } }],
  metadata: { deal_id: DEAL_ID }, client_reference_id: DEAL_ID, payment_intent_data: { metadata: { deal_id: DEAL_ID } },
  success_url: "https://example.com/deal/ok", expires_at: Math.floor(Date.now() / 1000) + 31 * 60 } });
console.log(`\n[PostCheckoutSessions] isError=${sess.isError}\n${sess.text.slice(0, 500)}`);
const sessId = json(sess.text)?.id ?? sess.text.match(/cs_test_[A-Za-z0-9]+/)?.[0];

// 4. Try the current payDeal path through MCP: PaymentIntent create+confirm with a test card.
const pi = await call("stripe_api_write", { stripe_api_operation_id: "PostPaymentIntents", parameters: {
  amount: AMOUNT, currency: "usd", confirm: true, payment_method: "pm_card_visa", metadata: { deal_id: DEAL_ID },
  automatic_payment_methods: { enabled: true, allow_redirects: "never" } } });
console.log(`\n[PostPaymentIntents confirm=true] isError=${pi.isError}\n${pi.text.slice(0, 400)}`);

// 5. Independent verification with the SDK (server-side source of truth, not the agent's word).
const s = new Stripe(testKey());
if (linkId) {
  const pl = await s.paymentLinks.retrieve(linkId, { expand: ["line_items"] });
  const li = pl.line_items!.data[0];
  console.log(`\n[verify link ${pl.id}] url=${pl.url} metadata.deal_id=${pl.metadata.deal_id} pi_meta=${pl.payment_intent_data?.metadata?.deal_id}`,
    `amount_total=${li.amount_total} qty=${li.quantity} adjustable_quantity=${JSON.stringify((li as any).adjustable_quantity ?? null)}`,
    `allow_promotion_codes=${pl.allow_promotion_codes} custom_unit_amount=${JSON.stringify(li.price?.custom_unit_amount ?? null)}`,
    `restrictions=${JSON.stringify(pl.restrictions)} active=${pl.active}`);
}
if (sessId) {
  const cs = await s.checkout.sessions.retrieve(sessId, { expand: ["line_items"] });
  const li = cs.line_items!.data[0];
  console.log(`\n[verify session ${cs.id}] amount_total=${cs.amount_total} metadata.deal_id=${cs.metadata?.deal_id} client_reference_id=${cs.client_reference_id}`,
    `adjustable_quantity=${JSON.stringify((li as any).adjustable_quantity ?? null)} allow_promotion_codes=${cs.allow_promotion_codes} expires_at_in_min=${Math.round((cs.expires_at - Date.now() / 1000) / 60)}`,
    `status=${cs.status} url_prefix=${cs.url?.slice(0, 40)}`);
}
await mcp.close();
