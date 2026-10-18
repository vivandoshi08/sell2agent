/**
 * E1 · Supabase-backed ExchangeStore against the CURRENT frozen schema (0001_init.sql), so a stateless deploy works
 * before the contract adds an offers table (docs/e1-asks.html n2–n4).
 *
 * Fallback mapping:
 *  - Source of truth: append-only snapshot rows in `events` (type "exchange_snapshot", run_id "exchange_state",
 *    key in `negotiation_id`, record in `payload`). Reads take the newest row per key. No floors or costs inside.
 *    Dashboard: filter out run_id "exchange_state".
 *  - Mirrors for the dashboard and joins (best effort, never block a move):
 *      negotiations: status mapped onto the old enum (negotiating→open, agreed→accepted, walked_away/expired→abandoned)
 *      deals:        final_price_cents, quantity, unit_cost_cents, stripe_payment_intent_id, paid
 * When Neel's migration lands, swap snapshot reads for the real tables here; nothing else changes.
 */
import type { BuyerMemory, ExchangeStore } from "./store";
import type { Catalog, LockedDeal, Negotiation, NegotiationState, StandingOffer } from "./types";

export const SNAPSHOT_RUN = "exchange_state";
export const SNAPSHOT_TYPE = "exchange_snapshot";

export const LEGACY_STATUS: Record<NegotiationState, "open" | "accepted" | "rejected" | "paid" | "abandoned"> = {
  open: "open", negotiating: "open", follow_up: "open", escalated: "open",
  agreed: "accepted", paid: "paid", walked_away: "abandoned", expired: "abandoned",
};

/** The slice of the Supabase client this store uses (structural, so tests can pass a fake). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from(table: string): any };

export class SupabaseStore implements ExchangeStore {
  constructor(private db: Db, private catalog: Catalog) {}

  private async read<T>(key: string): Promise<T | null> {
    const { data, error } = await this.db.from("events").select("payload").eq("run_id", SNAPSHOT_RUN).eq("type", SNAPSHOT_TYPE)
      .eq("negotiation_id", key).order("ts", { ascending: false }).limit(1);
    if (error) throw new Error(`[exchange store] read ${key}: ${error.message}`);
    const row = (data as { payload: { record: T } }[] | null)?.[0];
    return row ? row.payload.record : null;
  }

  private async write(key: string, record: unknown, meta: { seller_id?: string | null; product_id?: string | null } = {}) {
    const { error } = await this.db.from("events").insert({ run_id: SNAPSHOT_RUN, type: SNAPSHOT_TYPE, actor: "seller", negotiation_id: key,
      seller_id: meta.seller_id ?? null, product_id: meta.product_id ?? null, price_cents: null, payload: { record, saved_at: Date.now() } });
    if (error) throw new Error(`[exchange store] write ${key}: ${error.message}`);
  }

  private async mirror(table: string, row: Record<string, unknown>) {
    const { error } = await this.db.from(table).upsert(row);
    if (error) console.error(`[exchange store] mirror ${table}:`, error.message);
  }

  async getNegotiation(id: string) { return this.read<Negotiation>(`neg:${id}`); }
  async putNegotiation(n: Negotiation) {
    await this.write(`neg:${n.id}`, n, n);
    const last = n.history.filter((h) => h.by === "seller").at(-1)?.price_cents ?? null;
    await this.mirror("negotiations", { id: n.id, run_id: n.run_id, buyer_id: n.buyer_id, buyer_model: n.buyer_model, seller_id: n.seller_id,
      product_id: n.product_id, quantity: n.quantity, round: n.round, last_price_cents: last, status: LEGACY_STATUS[n.state] });
  }

  async getOffer(id: string) { return this.read<StandingOffer>(`off:${id}`); }
  async putOffer(o: StandingOffer) { await this.write(`off:${o.offer_id}`, o); }

  async getDeal(id: string) { return this.read<LockedDeal>(`deal:${id}`); }
  async putDeal(d: LockedDeal) {
    await this.write(`deal:${d.deal_id}`, d, d);
    await this.write(`offdeal:${d.offer_id}`, { deal_id: d.deal_id });
    const p = await this.catalog.get(d.product_id);
    await this.mirror("deals", { id: d.deal_id, negotiation_id: d.negotiation_id, final_price_cents: d.unit_price_cents, quantity: d.quantity,
      unit_cost_cents: p?.unit_cost_cents ?? 0, stripe_payment_intent_id: d.payment_intent_id ?? null, paid: d.status === "paid" });
  }
  async dealForOffer(offer_id: string) {
    const link = await this.read<{ deal_id: string }>(`offdeal:${offer_id}`);
    return link ? this.getDeal(link.deal_id) : null;
  }

  async getBuyerMemory(k: string) { return this.read<BuyerMemory>(`mem:${k}`); }
  async putBuyerMemory(k: string, m: BuyerMemory) { await this.write(`mem:${k}`, m); }
}

/** SupabaseStore when SUPABASE_URL is set, else null (caller falls back to MemoryStore). */
export async function supabaseStoreFromEnv(catalog: Catalog): Promise<SupabaseStore | null> {
  if (!process.env.SUPABASE_URL) return null;
  const { db } = await import("@sa/shared/db");
  return new SupabaseStore(db, catalog);
}
