/**
 * E1 · Event sink. Default: `logEvent` from @sa/shared/db when Supabase env is set, else a no-op.
 * Tests pass a MemorySink. Floors and unit costs never go into events.
 */
import type { NegotiationEvent } from "@sa/shared";

export type EventSink = (e: NegotiationEvent) => Promise<void>;

export class MemorySink {
  events: NegotiationEvent[] = [];
  sink: EventSink = async (e) => { this.events.push(e); };
}

let shared: EventSink | null | undefined;
export async function defaultSink(): Promise<EventSink> {
  if (shared !== undefined) return shared ?? (async () => {});
  if (!process.env.SUPABASE_URL) {
    shared = null;
    return async () => {};
  }
  const { logEvent } = await import("@sa/shared/db"); // createClient throws without env, so import lazily
  shared = logEvent;
  return logEvent;
}

/**
 * Severity for `guardrail_blocked` events, set as `payload.severity` (the event type stays `guardrail_blocked`, per n6).
 *   routine  the guard shaped a normal move (concession pacing, clamps, follow-up limits). Expected every run.
 *   catch    code stopped a bad seller move (below-floor accept, leaky or wrong text, stale offer). Worth a look.
 *   attack   a buyer tried something hostile (injected instructions, floor probing). Highlight these.
 * Unknown rules count as `catch`, so a new rule is never hidden by default.
 */
export type GuardrailSeverity = "routine" | "catch" | "attack";
const ROUTINE = new Set(["concession_cap", "clamp_low", "clamp_high", "monotone", "final_not_final", "price_freeze",
  "buyer_memory_resume", "followup_cap", "unsubscribed"]);
const ATTACK = new Set(["input_injection", "circuit_breaker", "probe_breaker"]);
export function guardrailSeverity(rule: unknown): GuardrailSeverity {
  const r = String(rule ?? "");
  if (ROUTINE.has(r)) return "routine";
  if (ATTACK.has(r)) return "attack";
  return "catch";
}

/**
 * Seller-facing payload keys (S2 Instinct demo, P0): the seller's live view shows why each move happened and which of
 * their rules shaped it. `rule_refs` are short chips ("floor", "lever:free_shipping"); `seller_message` is one plain
 * sentence on `guardrail_blocked`. Seller-only text: no floor or cost figures, since events are not access-controlled.
 */
const RULE_REF: Record<string, string> = {
  clamp_low: "floor", mask_accept_below_floor: "floor", policy_recheck: "floor", clamp_high: "list_price",
  concession_cap: "concession_cap", monotone: "no_price_increase", price_freeze: "price_freeze", circuit_breaker: "price_freeze",
  input_injection: "injection_guard", probe_breaker: "probe_guard", buyer_memory_resume: "buyer_memory",
  out_of_policy_ask: "out_of_policy", final_not_final: "honest_final",
};
export const ruleRef = (rule: unknown): string => {
  const r = String(rule ?? "");
  return RULE_REF[r] ?? (r.startsWith("output_") ? "message_check" : r);
};

const SELLER_MESSAGE: Record<string, string> = {
  clamp_low: "Your agent tried to go below your floor; the exchange held the price above it.",
  mask_accept_below_floor: "The buyer's price was under your floor, so your agent countered instead of accepting.",
  policy_recheck: "An offer the buyer tried to accept no longer fits your current rules, so it was not locked.",
  clamp_high: "Your agent's price was above list; the exchange capped it at list.",
  concession_cap: "Your agent tried to give a bigger discount than one round allows; the exchange made it smaller.",
  monotone: "Your agent tried to raise a price it had already offered; the exchange kept the lower price.",
  final_not_final: "Your agent called an offer final before the last round; the exchange removed that claim.",
  price_freeze: "The price is frozen for this buyer, so your agent held it.",
  circuit_breaker: "This buyer's agent kept sending hidden instructions, so their price is now frozen.",
  input_injection: "The buyer's agent sent hidden instructions; your agent ignored them and kept to your rules.",
  probe_breaker: "A last-round bid just under your floor looked like probing, so last-round discounts are paused for 24 hours.",
  buyer_memory_resume: "A returning buyer picked up at the price they were last offered, not from list.",
  out_of_policy_ask: "The buyer asked for something outside your rules; your agent declined and logged it for you.",
};
export function sellerMessage(rule: unknown): string {
  const r = String(rule ?? "");
  if (SELLER_MESSAGE[r]) return SELLER_MESSAGE[r];
  if (r.startsWith("output_")) return "Your agent's message broke a rule (for example a wrong price or a private figure), so it was rewritten.";
  return "Your rules blocked a move the agent tried to make.";
}
