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
