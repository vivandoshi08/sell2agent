/**
 * E1 · live Supabase check for the exchange store. Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in ../../.env.
 *   pnpm --filter @sa/seller-mcp supabase:smoke          # runs, verifies, then deletes its own rows
 *   pnpm --filter @sa/seller-mcp supabase:smoke --keep   # leave the rows for the dashboard to show
 *
 * One buyer negotiates → accepts → validates → marks paid, then a SECOND Exchange instance (a stateless restart)
 * must read the same negotiation back as `paid`. Also checks the events / negotiations / deals rows landed.
 */
import { db } from "@sa/shared/db";
import { Exchange, SNAPSHOT_RUN } from "../src/exchange";

if (!process.env.SUPABASE_URL) { console.error("SUPABASE_URL not set (copy .env.example to .env)"); process.exit(1); }
const keep = process.argv.includes("--keep");
const run_id = `e1-smoke-${Date.now()}`;
const started = new Date().toISOString();
const ctx = { run_id, buyer_id: `${run_id}-buyer`, buyer_model: "scripted" };
const P = "kb_keyforge_quiet75";
const fails: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };

const ex = await Exchange.fromEnv();
let r = await ex.handle({ kind: "offer", ctx, product_id: P, offer_price_cents: 9000 });
check(r.ok === true && !!r.standing_offer, `offer → ${r.status} at ${r.standing_offer?.price_cents}`);
while (r.ok && r.allowed_actions.includes("offer"))
  r = await ex.handle({ kind: "offer", ctx, product_id: P, negotiation_id: r.negotiation_id, offer_price_cents: 9000 });
const acc = await ex.handle({ kind: "accept", ctx, negotiation_id: r.negotiation_id!, offer_id: r.standing_offer!.offer_id });
check(acc.ok === true && !!acc.deal, `accept → deal ${acc.deal?.deal_id} total ${acc.deal?.total_cents}`);
const deal_id = acc.deal!.deal_id, negotiation_id = r.negotiation_id!;
const chk = await ex.deals.validateForPayment(deal_id, ctx.buyer_id, acc.deal!.total_cents);
check(chk.ok, "validateForPayment ok");
await ex.markPaid(deal_id, `pi_smoke_${Date.now()}`);

const fresh = await Exchange.fromEnv(); // stateless restart: everything must come from Supabase
const st = await fresh.handle({ kind: "status", ctx, negotiation_id });
check(st.state === "paid", `restart reads state back: ${st.state}`);
check((await fresh.deals.validateForPayment(deal_id, ctx.buyer_id)).ok === false, "restart refuses a second payment");

const ev = await db.from("events").select("type").eq("run_id", run_id);
const types = new Set((ev.data ?? []).map((e: { type: string }) => e.type));
check(!ev.error && ["offer_made", "offer_countered", "deal_accepted"].every((t) => types.has(t)), `events rows: ${[...types].join(", ") || ev.error?.message}`);
const neg = await db.from("negotiations").select("status").eq("id", negotiation_id);
check(neg.data?.[0]?.status === "paid", `negotiations mirror: ${neg.data?.[0]?.status ?? neg.error?.message ?? "missing"}`);
const dl = await db.from("deals").select("paid,final_price_cents").eq("id", deal_id);
check(dl.data?.[0]?.paid === true, `deals mirror: paid=${dl.data?.[0]?.paid ?? dl.error?.message ?? "missing"}`);

if (!keep) {
  await db.from("deals").delete().eq("id", deal_id);
  await db.from("negotiations").delete().eq("id", negotiation_id);
  await db.from("events").delete().eq("run_id", run_id);
  await db.from("events").delete().eq("run_id", SNAPSHOT_RUN).gte("ts", started);
  console.log("cleaned up smoke rows");
}
console.log(fails.length ? `\nFAIL: ${fails.length} check(s)` : "\nPASS: exchange state round-trips through Supabase");
process.exit(fails.length ? 1 : 0);
