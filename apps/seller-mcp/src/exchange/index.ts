/**
 * E1 · Exchange public API. S1's gateway: `import { Exchange } from "@sa/seller-mcp/exchange"`.
 *
 *   const ex = new Exchange();                     // memory store, seed catalog, events → Supabase if env set
 *   await ex.handle({ kind: "offer", ctx, product_id, offer_price_cents, message });   // make_offer
 *   await ex.handle({ kind: "accept", ctx, negotiation_id, offer_id });                // accept_deal (locks a deal)
 *   await ex.handle({ kind: "walk", ctx, negotiation_id });
 *   await ex.handle({ kind: "status", ctx, negotiation_id });                          // check_offers
 *
 * S2's pay handler:  ex.deals.getLockedDeal(id) · ex.deals.validateForPayment(id, buyer_id, amount?) · ex.markPaid(id, pi_id)
 */
export * from "./types";
export { Exchange, OFFER_TTL_MS, BREAKER_THRESHOLD } from "./exchange";
export type { ExchangeOptions, Decider, Voicer } from "./exchange";
export { Deals, DEAL_TTL_MS, verify as verifyDeal } from "./deals";
export type { PaymentCheck } from "./deals";
export { MemoryStore, probeId, memoryKey, limitKey, breakerKey, signEvalRun, isEvalRun, EVAL_PREFIX, isAnon, isClientAsserted, liveMemory, ANON_PREFIX, OAI_PREFIX, ANON_MEMORY_TTL_MS } from "./store";
export type { ExchangeStore } from "./store";
export { StaticCatalog, SEED_PRODUCTS } from "./catalog";
export { MemorySink, defaultSink, guardrailSeverity } from "./events";
export type { EventSink, GuardrailSeverity } from "./events";
export { TRANSITIONS, canTransition, allowedActions } from "./state";
export { guardMove, capClamp, CONCESSION_CAP } from "./decision-guard";
export { inspectInput, delimit } from "./input-guard";
export { checkOutput, fallbackMessage } from "./output-guard";
export { ProbeBreaker, StartLimiter, buyerEndpoint, jitterStep, leverCost, DEFAULT_LEVER_COSTS, START_LIMIT, ANON_START_LIMIT, OAI_START_LIMIT, startLimitFor } from "./probing";
export { EXTRAS, EXTRAS_BY_ID, EXTRA_IDS, isExtra, extraLever, extraLabel, extraPhrase, extrasPackage, type ExtraDef } from "./extras";
export { SupabaseStore, LEGACY_STATUS, SNAPSHOT_RUN, SNAPSHOT_TYPE } from "./supabase-store";
export { Outreach, FOLLOWUP_DELAY_MS, FOLLOWUP_TTL_MS } from "./outreach";
export type { Sender } from "./outreach";
export { parseInbound } from "./inbound";
export type { InboundIntent } from "./inbound";
