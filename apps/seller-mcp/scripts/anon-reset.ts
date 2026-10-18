/**
 * E1 · show or clear the shared anon buyer memory (every ChatGPT/Claude chat shares one per product), e.g. right
 * before the demo so the next chat negotiates from list instead of resuming at a rehearsal's final offer.
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in ../../.env (the deployed gateway's store).
 *   pnpm --filter @sa/seller-mcp anon:reset                        # show each product's anon memory, change nothing
 *   pnpm --filter @sa/seller-mcp anon:reset --all                  # clear it for every product
 *   pnpm --filter @sa/seller-mcp anon:reset kb_keyforge_quiet75    # clear one or more products
 * Appends a tombstone snapshot (the store is append-only); named and simulated buyers are untouched.
 * Not covered: the anon start limit and the probe breaker live in each gateway instance's memory (a redeploy resets them).
 */
import { ANON_MEMORY_TTL_MS, ANON_PREFIX, SEED_PRODUCTS, StaticCatalog, liveMemory, memoryKey } from "../src/exchange";
import { supabaseStoreFromEnv } from "../src/exchange/supabase-store";

const store = await supabaseStoreFromEnv(new StaticCatalog());
if (!store) { console.error("SUPABASE_URL not set (copy .env.example to .env)"); process.exit(1); }

const args = process.argv.slice(2);
const known = new Map(SEED_PRODUCTS.map((p) => [p.product_id, p]));
const unknown = args.filter((a) => a !== "--all" && !known.has(a));
if (unknown.length) { console.error(`unknown product(s): ${unknown.join(", ")}. Known: ${[...known.keys()].join(", ")}`); process.exit(1); }
const targets = args.includes("--all") ? [...known.keys()] : args;

const now = Date.now();
const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;
console.log(`anon memory (expires ${mins(ANON_MEMORY_TTL_MS)} after the last update):`);
for (const p of SEED_PRODUCTS) {
  const key = memoryKey(ANON_PREFIX, p.product_id);
  const m = await store.getBuyerMemory(key);
  const live = liveMemory(ANON_PREFIX, m, now);
  const state = !m ? "none" : !live ? `expired (${mins(now - Date.parse(m.updated_at))} old)`
    : `$${m.lowest_offer_cents / 100} at round ${m.round}/${p.max_rounds}${m.round >= p.max_rounds ? " → FROZEN: next chat gets one final offer" : ""}, ` +
      `expires in ${mins(ANON_MEMORY_TTL_MS - (now - Date.parse(m.updated_at)))}`;
  const clear = targets.includes(p.product_id) && !!live;
  if (clear) await store.clearBuyerMemory(key);
  console.log(`  ${p.product_id.padEnd(20)} ${state}${clear ? "  → cleared" : ""}`);
}
if (!targets.length) console.log("\nNothing changed. Pass --all or product ids to clear.");
