// Event logging through the shared logEvent(). @sa/shared/db creates its Supabase client on import,
// so it is only loaded once SUPABASE_URL is set; until then events go to stdout.
import type { NegotiationEvent } from "@sa/shared";

let logger: ((e: NegotiationEvent) => Promise<void>) | undefined;

export async function log(e: NegotiationEvent): Promise<void> {
  try {
    if (!process.env.SUPABASE_URL) {
      console.log("[event]", JSON.stringify(e));
      return;
    }
    logger ??= (await import("@sa/shared/db")).logEvent;
    await logger(e);
  } catch (err) {
    // Logging must never break a buyer's tool call.
    console.error("[event] log failed", err);
  }
}
