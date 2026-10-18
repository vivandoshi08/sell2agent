/**
 * Builds the console API for the dev server. Loaded by vite.config.ts through ssrLoadModule, so it runs in
 * Node only. Uses the service-role key when present (writes seller_policies); otherwise an in-memory store.
 * Set CONSOLE_STORE=memory to force memory even with keys (e.g. rehearsing without touching the shared DB).
 */
import { createClient } from "@supabase/supabase-js";
import { consoleApi } from "./api";
import { memoryStore, supabaseStore } from "./store";

export function makeConsoleApi(env: Record<string, string | undefined>) {
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  const useDb = url && key && env.CONSOLE_STORE !== "memory";
  const store = useDb ? supabaseStore(createClient(url, key, { auth: { persistSession: false } })) : memoryStore();
  return { store: store.kind, handler: consoleApi(store) };
}
