/** One real TEST-mode call: does Stripe accept checkoutParams() as built from a LockedDeal? */
import Stripe from "stripe";
import { lockDeal } from "../../apps/seller-mcp/src/exchange/deals";
import { checkoutParams } from "./checkout";
import { testKey } from "./env";

const d = lockDeal({ negotiation_id: "n1", offer_id: "o1", buyer_id: "b1", seller_id: "s1", product_id: "p1", title: "Spike Aeron",
  quantity: 1, unit_price_cents: 3600, list_price_cents: 4500, levers: [] }, Date.now() + 60_000);
const cs = await new Stripe(testKey()).checkout.sessions.create(checkoutParams(d, "https://example.com/ok"));
console.log(cs.id.slice(0, 12), "amount_total", cs.amount_total, "deal_id_ok", cs.metadata?.deal_id === d.deal_id,
  "adaptive", cs.adaptive_pricing?.enabled, "promo", cs.allow_promotion_codes, "expires_in_min", Math.round((cs.expires_at - Date.now() / 1000) / 60));
