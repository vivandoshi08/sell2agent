/**
 * S2-owned. In-memory stand-in for E1's exchange and S1's catalog, used until Bridge 1.
 * Behaves like E1's plan says the real one will: a deal is bound to its buyer, expires, and can be paid once.
 * Swap: replace `createMockExchange()` in index.ts with E1's real functions; nothing else changes.
 */
import type { CatalogSource, DealSource, ProductFacts, StoredDeal, Validation } from "./types";

const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

/** Fixture deals covering each card state. Keyboard catalog, same as S1's mock. */
export function fixtureDeals(): StoredDeal[] {
  return [
    { deal_id: "deal_demo_ready", negotiation_id: "neg_demo_1", buyer_id: "buyer_demo", seller_id: "keyforge",
      product_id: "kb_quietpro_75", quantity: 1, unit_price_cents: 11_900, total_cents: 11_900,
      levers: [{ name: "extended_warranty", detail: "2 years" }, { name: "free_shipping", detail: "2-day" }],
      expires_at: inAnHour(), state: "AGREED" },
    { deal_id: "deal_demo_paid", negotiation_id: "neg_demo_2", buyer_id: "buyer_demo", seller_id: "keyforge",
      product_id: "kb_quietpro_75", quantity: 1, unit_price_cents: 12_400, total_cents: 12_400,
      levers: [], expires_at: inAnHour(), state: "PAID" },
    { deal_id: "deal_demo_expired", negotiation_id: "neg_demo_3", buyer_id: "buyer_demo", seller_id: "tactile_co",
      product_id: "kb_tactile_tkl", quantity: 2, unit_price_cents: 8_900, total_cents: 17_800,
      levers: [{ name: "bundle_discount", detail: "wrist rest" }],
      expires_at: new Date(Date.now() - 60_000).toISOString(), state: "AGREED" },
  ];
}

export function fixtureProducts(): ProductFacts[] {
  return [
    { product_id: "kb_quietpro_75", title: "QuietPro 75 Mechanical Keyboard", list_price_cents: 14_900, seller_name: "KeyForge" },
    { product_id: "kb_tactile_tkl", title: "Tactile TKL", list_price_cents: 9_900, seller_name: "Tactile Co." },
  ];
}

export function createMockExchange(deals: StoredDeal[] = fixtureDeals()): DealSource & { markPaid(deal_id: string): void } {
  const byId = new Map(deals.map((d) => [d.deal_id, { ...d }]));
  return {
    async getDeal(deal_id) {
      const d = byId.get(deal_id);
      return d ? { ...d, levers: [...d.levers] } : null;
    },
    async validateForPayment(deal_id, buyer): Promise<Validation> {
      const d = byId.get(deal_id);
      if (!d) return { ok: false, code: "unknown_deal", reason: `no deal ${deal_id}` };
      if (d.state === "PAID") return { ok: false, code: "already_paid", reason: `deal ${deal_id} is already paid` };
      if (d.state !== "AGREED") return { ok: false, code: "not_payable", reason: `deal ${deal_id} is ${d.state}` };
      if (Date.parse(d.expires_at) <= Date.now()) return { ok: false, code: "expired", reason: `deal ${deal_id} expired at ${d.expires_at}` };
      if (buyer?.buyer_id && buyer.buyer_id !== d.buyer_id) return { ok: false, code: "wrong_buyer", reason: "deal is bound to a different buyer" };
      return { ok: true, deal: { ...d, levers: [...d.levers] } };
    },
    markPaid(deal_id) {
      const d = byId.get(deal_id);
      if (d) d.state = "PAID";
    },
  };
}

export function createMockCatalog(products: ProductFacts[] = fixtureProducts()): CatalogSource {
  const byId = new Map(products.map((p) => [p.product_id, p]));
  return { async getProduct(id) { return byId.get(id) ?? null; } };
}
