// SupabaseStore against a fake client that mimics the query chain it uses. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Exchange, MemorySink, StaticCatalog, FOLLOWUP_DELAY_MS, type OutboundMessage } from "../src/exchange";
import { SupabaseStore, SNAPSHOT_RUN } from "../src/exchange/supabase-store";

function fakeDb() {
  const tables: Record<string, any[]> = { events: [], negotiations: [], deals: [] };
  let seq = 0;
  const from = (t: string) => {
    const filters: [string, unknown][] = [];
    const likes: [string, string][] = [];
    let lim = Infinity;
    const q: any = {
      insert: async (row: any) => { tables[t].push({ ...row, ts: ++seq }); return { error: null }; },
      upsert: async (row: any) => { const i = tables[t].findIndex((r) => r.id === row.id); i >= 0 ? (tables[t][i] = row) : tables[t].push(row); return { error: null }; },
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return q; },
      like: (c: string, pat: string) => { likes.push([c, pat.replace(/%$/, "")]); return q; },
      order: () => q,
      limit: (n: number) => { lim = n; return q; },
      then: (res: any) => res({ data: tables[t].filter((r) => filters.every(([c, v]) => r[c] === v) && likes.every(([c, p]) => String(r[c]).startsWith(p))).sort((a, b) => b.ts - a.ts).slice(0, lim), error: null }),
    };
    return q;
  };
  return { db: { from } as any, tables };
}

test("exchange round trip on SupabaseStore: state survives a new Exchange instance (stateless deploy)", async () => {
  const { db, tables } = fakeDb();
  const catalog = new StaticCatalog();
  const mk = () => new Exchange({ store: new SupabaseStore(db, catalog), catalog, sink: new MemorySink().sink });
  const ctx = { run_id: "e1-test-sb", buyer_id: "b1", buyer_model: "scripted" };
  const r1 = await mk().handle({ kind: "offer", ctx, product_id: "kb_keyforge_quiet75", offer_price_cents: 9000 });
  const r2 = await mk().handle({ kind: "offer", ctx, product_id: "kb_keyforge_quiet75", negotiation_id: r1.negotiation_id, offer_price_cents: 9500 });
  assert.equal(r2.round, 2);
  const stale = await mk().handle({ kind: "accept", ctx, negotiation_id: r1.negotiation_id!, offer_id: r1.standing_offer!.offer_id });
  assert.equal(stale.error?.code, "stale_offer");
  const acc = await mk().handle({ kind: "accept", ctx, negotiation_id: r1.negotiation_id!, offer_id: r2.standing_offer!.offer_id });
  assert.equal(acc.state, "agreed");
  const again = await mk().handle({ kind: "accept", ctx, negotiation_id: r1.negotiation_id!, offer_id: r2.standing_offer!.offer_id });
  assert.equal(again.deal!.deal_id, acc.deal!.deal_id);
  const ex = mk();
  assert.equal((await ex.deals.validateForPayment(acc.deal!.deal_id, "b1")).ok, true);
  await ex.markPaid(acc.deal!.deal_id, "pi_test");
  assert.equal(tables.negotiations[0].status, "paid");
  assert.equal(tables.deals[0].paid, true);
  assert.equal(tables.deals[0].final_price_cents, acc.deal!.unit_price_cents);
  const snaps = tables.events.filter((e) => e.run_id === SNAPSHOT_RUN);
  assert.ok(snaps.length > 0);
  assert.ok(!JSON.stringify(snaps).includes("floor_price_cents") && !JSON.stringify(snaps).includes("\"unit_cost_cents\""), "no private fields in snapshots");
});

test("clearBuyerMemory appends a tombstone that reads back as no memory", async () => {
  const { db, tables } = fakeDb();
  const store = new SupabaseStore(db, new StaticCatalog());
  await store.putBuyerMemory("anon::kb_keyforge_quiet75", { lowest_offer_cents: 11200, round: 4, sessions: 3, updated_at: new Date().toISOString() });
  assert.equal((await store.getBuyerMemory("anon::kb_keyforge_quiet75"))?.lowest_offer_cents, 11200);
  await store.clearBuyerMemory("anon::kb_keyforge_quiet75");
  assert.equal(await store.getBuyerMemory("anon::kb_keyforge_quiet75"), null);
  assert.equal(tables.events.filter((e) => e.negotiation_id === "mem:anon::kb_keyforge_quiet75").length, 2, "append-only");
});

test("follow-up queue and weekly cap survive a fresh Exchange (stateless deploy: runDue in a new process)", async () => {
  const { db, tables } = fakeDb();
  const catalog = new StaticCatalog();
  const now = { t: Date.now() };
  const sent: OutboundMessage[] = [];
  const mk = () => new Exchange({ store: new SupabaseStore(db, catalog), catalog, sink: new MemorySink().sink, now: () => now.t, send: async (m) => { sent.push(m); } });
  const ctx = { run_id: "e1-test-sb-fu", buyer_id: "fu1", buyer_model: "scripted" };
  const walk = async (product_id: string) => {
    const r = await mk().handle({ kind: "offer", ctx, product_id, offer_price_cents: 9000 });
    await mk().handle({ kind: "walk", ctx, negotiation_id: r.negotiation_id!, followup: { reply_to: "fu1@example.test", channel: "email" } });
    return r.negotiation_id!;
  };
  const neg = await walk("kb_typewell_65");
  assert.equal((await mk().outreach.runDue()).length, 0, "not due yet");
  now.t += FOLLOWUP_DELAY_MS + 1;
  assert.equal((await mk().outreach.runDue()).length, 1, "a fresh process finds the queued job");
  assert.equal((await mk().outreach.runDue()).length, 0, "and sends it once");
  assert.equal(sent[0].negotiation_id, neg);
  const acc = await mk().inbound(neg, "fu1", `ACCEPT ${sent[0].offer.offer_id}`);
  assert.equal(acc.state, "agreed");
  await walk("kb_hushline_96");
  now.t += FOLLOWUP_DELAY_MS + 1;
  assert.equal((await mk().outreach.runDue()).length, 0, "weekly cap read back from the store");
  assert.equal(sent.length, 1);
  assert.equal((await new SupabaseStore(db, catalog).listFollowupJobs()).length, 0, "both jobs tombstoned");
  assert.ok(tables.events.some((e) => e.negotiation_id === "fu:route:email:fu1@example.test"));
});
