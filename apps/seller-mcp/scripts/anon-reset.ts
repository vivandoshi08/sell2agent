/**
 * E1 · show or clear client-asserted buyer memory: the shared anon bucket (Claude and other chat clients, one per
 * product) and each ChatGPT user's `oai_` id (found in `events`). Run right before the demo so the next chat
 * negotiates from list instead of resuming at a rehearsal's final offer.
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in ../../.env (the deployed gateway's store).
 *   pnpm --filter @sa/seller-mcp anon:reset                        # show live memory, change nothing
 *   pnpm --filter @sa/seller-mcp anon:reset --all                  # clear it for every product
 *   pnpm --filter @sa/seller-mcp anon:reset kb_keyforge_quiet75    # clear one or more products
 * Appends a tombstone snapshot (the store is append-only); named and simulated buyers are untouched.
 * Not covered: start limits and the probe breaker live in each gateway instance's memory (a redeploy resets them).
 */
import { db } from "@sa/shared/db";
import { ANON_MEMORY_TTL_MS, ANON_PREFIX, OAI_PREFIX, SEED_PRODUCTS, StaticCatalog, liveMemory, memoryKey } from "../src/exchange";
import { supabaseStoreFromEnv } from "../src/exchange/supabase-store";

const store = await supabaseStoreFromEnv(new StaticCatalog());
if (!store) { console.error("SUPABASE_URL not set (copy .env.example to .env)"); process.exit(1); }

const args = process.argv.slice(2);
const known = new Map(SEED_PRODUCTS.map((p) => [p.product_id, p]));
const unknown = args.filter((a) => a !== "--all" && !known.has(a));
if (unknown.length) { console.error(`unknown product(s): ${unknown.join(", ")}. Known: ${[...known.keys()].join(", ")}`); process.exit(1); }
const targets = args.includes("--all") ? [...known.keys()] : args;

// ChatGPT users seen in the last 7 days (memory older than that is long expired).
const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
const { data, error } = await db.from("events").select("buyer_id").like("buyer_id", `${OAI_PREFIX}%`).gte("ts", since).limit(5000);
if (error) { console.error(`events query: ${error.message}`); process.exit(1); }
const oai = [...new Set((data ?? []).map((r: { buyer_id: string }) => r.buyer_id))];

const now = Date.now();
const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;
console.log(`client-asserted memory (expires ${mins(ANON_MEMORY_TTL_MS)} after the last update); ${oai.length} ChatGPT user(s) seen:`);
let cleared = 0;
for (const p of SEED_PRODUCTS) {
  for (const who of [ANON_PREFIX, ...oai]) {
    const key = memoryKey(who, p.product_id);
    const live = liveMemory(who, await store.getBuyerMemory(key), now);
    if (!live) { if (who === ANON_PREFIX) console.log(`  ${p.product_id.padEnd(20)} anon        none or expired`); continue; }
    const clear = targets.includes(p.product_id);
    if (clear) { await store.clearBuyerMemory(key); cleared++; }
    const label = who === ANON_PREFIX ? "anon       " : `${who.slice(0, 11)}`;
    console.log(`  ${p.product_id.padEnd(20)} ${label} $${live.lowest_offer_cents / 100} at round ${live.round}/${p.max_rounds}` +
      `${live.round >= p.max_rounds ? " → FROZEN" : ""}, expires in ${mins(ANON_MEMORY_TTL_MS - (now - Date.parse(live.updated_at)))}${clear ? "  → cleared" : ""}`);
  }
}
console.log(targets.length ? `\nCleared ${cleared} memory record(s).` : "\nNothing changed. Pass --all or product ids to clear.");
