/**
 * Bridge 1 payment check without the deployed gateway: lock a real deal in E1's exchange (in memory),
 * render the deal card, then Approve & Pay through S2's handler → @sa/payments → Stripe TEST mode.
 *
 *   pnpm --filter @sa/dashboard pay-smoke            # needs STRIPE_SECRET_KEY=sk_test_... in the repo-root .env
 *
 * Prints the card, the PaymentIntent id (find it in the Stripe test dashboard), and proves a second click
 * doesn't charge again. Test card pm_card_visa; nothing real is charged.
 */
import { Exchange } from "@sa/seller-mcp/exchange";
import { createDealModule, dealSummary, fromExchange } from "../../marketplace/src/deal/index";

if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
  console.error("Set STRIPE_SECRET_KEY=sk_test_... in the repo-root .env (test mode only).");
  process.exit(1);
}
const ex = new Exchange();
const ctx = { run_id: "s2-pay-smoke", buyer_id: `smoke_${Date.now()}`, buyer_model: "script" };
const offer = await ex.handle({ kind: "offer", ctx, product_id: "kb_keyforge_quiet75", offer_price_cents: 12_900 });
const offerId = offer.standing_offer?.offer_id;
if (!offer.ok || !offer.negotiation_id || !offerId) throw new Error(`offer failed: ${JSON.stringify(offer)}`);
const acc = await ex.handle({ kind: "accept", ctx, negotiation_id: offer.negotiation_id, offer_id: offerId });
if (!acc.ok || !acc.deal) throw new Error(`accept failed: ${JSON.stringify(acc)}`);

const deal = createDealModule({ deals: fromExchange(ex), defaultCredential: () => ({ test_card: "pm_card_visa" }) });
const card = await deal.reviewDeal(acc.deal.deal_id);
console.log("Card:", dealSummary(card));

const first = await deal.payApprovedDeal(card.deal_id, undefined, { buyer: ctx });
console.log("Pay:", first.status, first.payment_intent_id ?? "", first.reasons?.join("; ") ?? "", first.message ?? "");
const again = await deal.payApprovedDeal(card.deal_id, undefined, { buyer: ctx });
console.log("Second click:", again.status, again.already_paid ? "(already paid, not charged again)" : "", again.payment_intent_id ?? "");
console.log("Exchange now says:", (await ex.deals.getLockedDeal(card.deal_id))?.status);
process.exit(first.status === "succeeded" ? 0 : 1);
