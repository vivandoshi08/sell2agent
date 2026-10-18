/** Shared Supabase client + event logger. FROZEN like index.ts. */
import { createClient } from "@supabase/supabase-js";
import { NegotiationEvent } from "./index";

export const db = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!,
);

/** Every app logs through this. Validates against the contract before insert. */
export async function logEvent(e: NegotiationEvent) {
  const parsed = NegotiationEvent.parse(e);
  const { error } = await db.from("events").insert(parsed);
  if (error) console.error("[logEvent]", error.message, parsed.type);
}
