/**
 * E1 · Exchange store. One interface, two backends: memory (tests, local) and Supabase (deploy; Manufact is
 * stateless). The Supabase backend lands once the contract has an offers table (docs/e1-asks.html n2–n4).
 */
import type { LockedDeal, Negotiation, StandingOffer } from "./types";

export interface ExchangeStore {
  getNegotiation(id: string): Promise<Negotiation | null>;
  putNegotiation(n: Negotiation): Promise<void>;
  getOffer(id: string): Promise<StandingOffer | null>;
  putOffer(o: StandingOffer): Promise<void>;
  getDeal(id: string): Promise<LockedDeal | null>;
  putDeal(d: LockedDeal): Promise<void>;
  dealForOffer(offer_id: string): Promise<LockedDeal | null>;
  /** E11 buyer memory: per buyer × product, the seller's lowest offer and how far the concession clock got. */
  getBuyerMemory(key: string): Promise<BuyerMemory | null>;
  putBuyerMemory(key: string, m: BuyerMemory): Promise<void>;
}

export interface BuyerMemory {
  lowest_offer_cents: number;
  round: number; // seller turns used across all sessions (one deadline per buyer)
  sessions: number;
  updated_at: string;
}
/**
 * Who a buyer is for anti-probing (start limit, buyer memory, jitter). Gateway-minted `anon_` ids are one per
 * chat, so a new chat would reset everything; all anonymous buyers share one `anon` bucket per product instead.
 * Named and simulated buyer_ids keep their own bucket.
 */
export const ANON_PREFIX = "anon_";
export const probeId = (buyer_id: string) => (buyer_id.startsWith(ANON_PREFIX) ? "anon" : buyer_id);
export const memoryKey = (buyer_id: string, product_id: string) => `${probeId(buyer_id)}::${product_id}`;

const clone = <T>(x: T): T => structuredClone(x);

export class MemoryStore implements ExchangeStore {
  private negs = new Map<string, Negotiation>();
  private offers = new Map<string, StandingOffer>();
  private deals = new Map<string, LockedDeal>();
  private memory = new Map<string, BuyerMemory>();

  async getNegotiation(id: string) { const n = this.negs.get(id); return n ? clone(n) : null; }
  async putNegotiation(n: Negotiation) { this.negs.set(n.id, clone(n)); }
  async getOffer(id: string) { const o = this.offers.get(id); return o ? clone(o) : null; }
  async putOffer(o: StandingOffer) { this.offers.set(o.offer_id, clone(o)); }
  async getDeal(id: string) { const d = this.deals.get(id); return d ? clone(d) : null; }
  async putDeal(d: LockedDeal) { this.deals.set(d.deal_id, clone(d)); }
  async dealForOffer(offer_id: string) {
    for (const d of this.deals.values()) if (d.offer_id === offer_id) return clone(d);
    return null;
  }
  async getBuyerMemory(k: string) { const m = this.memory.get(k); return m ? clone(m) : null; }
  async putBuyerMemory(k: string, m: BuyerMemory) { this.memory.set(k, clone(m)); }
  /** Test helper: raw access, for tamper tests. */
  _rawDeal(id: string) { return this.deals.get(id); }
}
