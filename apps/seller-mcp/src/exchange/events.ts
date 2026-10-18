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
