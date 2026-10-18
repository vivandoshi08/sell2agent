/**
 * Write (or remove) S2's sample events in the shared Supabase so the live dashboard has something to show.
 * Only ever touches rows whose run_id starts with "s2-fake-" (our lane's prefix).
 *   pnpm --filter @sa/dashboard seed:fake          # insert a static + negotiating sample run
 *   pnpm --filter @sa/dashboard seed:fake:clean    # delete s2-fake-* rows only
 */
import { createClient } from "@supabase/supabase-js";
import { NegotiationEvent } from "@sa/shared";
import { fakeComparison, FAKE_PREFIX } from "../src/data/fake";

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (repo-root .env) first.");
  process.exit(1);
}
const db = createClient(url, key);

if (process.argv.includes("--clean")) {
  const { error, count } = await db.from("events").delete({ count: "exact" }).like("run_id", `${FAKE_PREFIX}%`);
  if (error) throw new Error(error.message);
  console.log(`Deleted ${count ?? 0} sample events (${FAKE_PREFIX}*).`);
} else {
  // Re-time the sample to now so the live feed shows it as fresh.
  const evs = fakeComparison(60);
  const shift = Date.now() - Date.parse(evs.at(-1)!.ts!);
  const rows = evs.map((e) => NegotiationEvent.parse({ ...e, ts: new Date(Date.parse(e.ts!) + shift).toISOString() }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("events").insert(rows.slice(i, i + 500));
    if (error) throw new Error(error.message);
  }
  console.log(`Inserted ${rows.length} sample events under ${FAKE_PREFIX}*. Remove them with seed:fake:clean.`);
}
