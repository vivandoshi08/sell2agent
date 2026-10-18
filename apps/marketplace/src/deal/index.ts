/**
 * S2-owned (Ananya). The seam Esha's gateway calls (agreed on both S1 and S2 pages):
 *
 *   review_deal({ deal_id })  → reviewDeal()       → structuredContent: DealCard, view "deal-card"
 *   pay_deal({ deal_id })     → payApprovedDeal()  → visibility ["model", "app"]
 *
 * Until Bridge 1 the exchange and catalog are in-memory mocks (mock-exchange.ts).
 * At the bridge, pass E1's real exchange and S1's catalog to `createDealModule()`.
 */
import type { NegotiationEvent } from "@sa/shared";
import type { PaymentCredential } from "@sa/payments";
import { assertPublic, toDealCard } from "./card";
import { createPayHandler, type PayContext } from "./pay";
import { createMockCatalog, createMockExchange } from "./mock-exchange";
import type { CatalogSource, DealCard, DealSource, PayResult } from "./types";

export type { DealCard, PayResult, StoredDeal, DealSource, CatalogSource, ProductFacts, Validation } from "./types";
export { toDealCard, assertPublic, leverLabel, PRIVATE_KEYS } from "./card";
export { createPayHandler } from "./pay";
export { createMockExchange, createMockCatalog, fixtureDeals, fixtureProducts } from "./mock-exchange";
export { fromExchange, type ExchangeLike } from "./exchange-adapter";

export interface DealModuleDeps {
  deals: DealSource;
  /** Public catalog (S1) for seller names. Optional: E1's deals already carry title and list price. */
  catalog?: CatalogSource;
  payDeal?: Parameters<typeof createPayHandler>[0]["payDeal"];
  logEvent?: (e: NegotiationEvent) => Promise<void>;
  defaultCredential?: () => PaymentCredential | null;
}

/** Imported lazily so the gateway can start without Supabase or Stripe keys (events then print to stdout). */
async function defaultLogEvent(e: NegotiationEvent) {
  if (!process.env.SUPABASE_URL) { console.log("[event]", e.type, JSON.stringify(e.payload)); return; }
  const { logEvent } = await import("@sa/shared/db");
  await logEvent(e);
}

async function defaultPayDeal(...args: Parameters<NonNullable<DealModuleDeps["payDeal"]>>) {
  const { payDeal } = await import("@sa/payments");
  return payDeal(...args);
}

/** Test mode: with no credential from the card, charge Stripe's test Visa. Never used with live keys (@sa/payments refuses them). */
function defaultCredential(): PaymentCredential | null {
  return process.env.STRIPE_PAYMENT_MODE === "test_card" ? { test_card: "pm_card_visa" } : null;
}

export function createDealModule(deps: DealModuleDeps) {
  const pay = createPayHandler({
    deals: deps.deals,
    payDeal: deps.payDeal ?? defaultPayDeal,
    logEvent: deps.logEvent ?? defaultLogEvent,
    defaultCredential: deps.defaultCredential ?? defaultCredential,
  });

  async function reviewDeal(deal_id: string): Promise<DealCard> {
    const deal = await deps.deals.getDeal(deal_id);
    if (!deal) throw new Error(`No deal ${deal_id}. Call accept_deal first and use the deal_id it returns.`);
    const product = deps.catalog ? await deps.catalog.getProduct(deal.product_id) : null;
    if (!product && deal.title === undefined) throw new Error(`Deal ${deal_id} refers to unknown product ${deal.product_id}.`);
    const card = toDealCard(deal, product);
    assertPublic(card);
    return card;
  }

  async function payApprovedDeal(deal_id: string, credential?: PaymentCredential, ctx?: PayContext): Promise<PayResult> {
    const r = await pay(deal_id, credential, ctx);
    assertPublic(r, "payment");
    return r;
  }

  return { reviewDeal, payApprovedDeal };
}

/** Text the model sees next to the card (clients without MCP Apps get only this). */
export function dealSummary(c: DealCard): string {
  const usd = (n: number) => `$${(n / 100).toFixed(2)}`;
  const levers = c.levers.length ? ` Includes: ${c.levers.map((l) => l.label).join(", ")}.` : "";
  const state = c.status === "ready" ? `Expires ${c.expires_at}. Ask the user to approve before paying.` : `Status: ${c.status}.`;
  return `${c.product.title} × ${c.quantity} from ${c.seller_name}: ${usd(c.total_cents)} (list ${usd(c.list_total_cents)}, save ${usd(c.savings_cents)}).${levers} ${state} Stripe test mode.`;
}

// Default instance on mocks, so Esha can import and mount today. Replaced at Bridge 1.
const mock = createDealModule({ deals: createMockExchange(), catalog: createMockCatalog() });
export const reviewDeal = mock.reviewDeal;
export const payApprovedDeal = mock.payApprovedDeal;
