/**
 * E1 · Exchange store. One interface, two backends: memory (tests, local) and Supabase (deploy; Manufact is
 * stateless). The Supabase backend lands once the contract has an offers table (docs/e1-asks.html n2–n4).
 */
import { createHmac } from "node:crypto";
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
  /** Ops (scripts/anon-reset.ts): forget a buyer × product memory. */
  clearBuyerMemory(key: string): Promise<void>;
  /** Bridge 3 follow-up queue: one job per consented walk-away, so runDue() works from a fresh process. */
  putFollowupJob(j: FollowupJob): Promise<void>;
  deleteFollowupJob(negotiation_id: string): Promise<void>;
  listFollowupJobs(): Promise<FollowupJob[]>;
  /** Follow-up marks: the weekly cap (`cap:…`) and inbound routing by reply address (`route:…`). */
  getFollowupMark(key: string): Promise<FollowupMark | null>;
  putFollowupMark(key: string, m: FollowupMark): Promise<void>;
}

export interface FollowupJob {
  negotiation_id: string;
  due_at: string; // ISO
}
export interface FollowupMark {
  negotiation_id: string;
  buyer_id: string;
  sent_at: string; // ISO
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
export const isAnon = (buyer_id: string) => buyer_id.startsWith(ANON_PREFIX);
/** ChatGPT users: the gateway hashes `openai/subject` to `oai_<hex>` (S1 #48). Own bucket per person, but client-asserted. */
export const OAI_PREFIX = "oai_";
/** Ids the gateway derives from what the client reports (not a verified account): memory expires for these. */
export const isClientAsserted = (buyer_id: string) => isAnon(buyer_id) || buyer_id.startsWith(OAI_PREFIX);
/**
 * Signed eval runs (Bridge 2): simulated buyers reuse ids like `b001` across runs and all hit the one deployed
 * store, so run 2 would resume at run 1's prices, hit the 4/day start limit, and a near-miss adversary would trip
 * the probe breaker for the live demo. A run_id `eval_<id>.<sig>` (sig = HMAC of the id with
 * EXCHANGE_HMAC_SECRET) scopes every anti-probing bucket to that run. Unsigned run_ids change nothing, so a
 * shopper can't rotate run_id to dodge memory or limits. Harness: `run_id: signEvalRun("run_…")`.
 */
export const EVAL_PREFIX = "eval_";
const evalSig = (id: string) =>
  createHmac("sha256", process.env.EXCHANGE_HMAC_SECRET ?? "dev-jitter-secret").update(`eval-run|${id}`).digest("hex").slice(0, 16);
export const signEvalRun = (id: string) => `${EVAL_PREFIX}${id}.${evalSig(id)}`;
export function isEvalRun(run_id?: string | null): boolean {
  if (!run_id?.startsWith(EVAL_PREFIX)) return false;
  const dot = run_id.lastIndexOf(".");
  return dot > EVAL_PREFIX.length && run_id.slice(dot + 1) === evalSig(run_id.slice(EVAL_PREFIX.length, dot));
}
const scoped = (base: string, run_id?: string | null) => (isEvalRun(run_id) ? `${run_id}/${base}` : base);

/** Start limit, jitter endpoint and probe breaker: anon chats share one bucket per product. */
export const probeId = (buyer_id: string, run_id?: string | null) => scoped(isAnon(buyer_id) ? "anon" : buyer_id, run_id);
export const limitKey = (buyer_id: string, product_id: string, run_id?: string | null) => `${probeId(buyer_id, run_id)}::${product_id}`;
/** Breaker scope: a product, or a product inside one signed eval run. */
export const breakerKey = (product_id: string, run_id?: string | null) => scoped(product_id, run_id);
/**
 * Buyer memory is per exact buyer_id (S1 ask, Bridge 2): with a shared anon memory every new anon_ chat opened at
 * the last chat's frozen final offer, so nobody could haggle. Restarting still can't win: a fresh anon chat walks the
 * same shared jitter stream to the same shared endpoint as the last one, and starts count against the shared limit.
 */
export const memoryKey = (buyer_id: string, product_id: string, run_id?: string | null) => `${scoped(buyer_id, run_id)}::${product_id}`;

/** A reply address as one key: lowercased, `Name <addr>` and `mailto:` stripped, phone numbers reduced to digits (+ kept). */
export function normalizeAddress(a: string): string {
  const s = (a.match(/<([^>]+)>/)?.[1] ?? a).trim().toLowerCase().replace(/^mailto:/, "");
  return /^[+(\d][\d\s().-]{6,}$/.test(s) ? s.replace(/(?!^\+)\D/g, "") : s;
}
/** Weekly follow-up cap: one per buyer and one per reply address, each scoped to a signed eval run (eval ids repeat). */
export const followupCapKeys = (buyer_id: string, reply_to: string, run_id?: string | null) =>
  [`cap:buyer:${scoped(buyer_id, run_id)}`, `cap:to:${scoped(normalizeAddress(reply_to), run_id)}`];
/** Inbound routing: the latest follow-up sent to this address on this channel. */
export const followupRouteKey = (channel: string, address: string) => `route:${channel}:${normalizeAddress(address)}`;
/** STOP: this address never gets another follow-up, on any negotiation. */
export const followupOptOutKey = (address: string) => `optout:${normalizeAddress(address)}`;

/**
 * Memory for client-asserted ids (the shared anon bucket and per-person `oai_` ids) expires 30 min after its last
 * update (override: EXCHANGE_ANON_MEMORY_TTL_MS). Without it, one chat that reached the final round froze every later
 * chat on that product (anon: every user; oai_: that ChatGPT user, e.g. the demo account) at a round-1 "final offer",
 * forever (the memory lives in Supabase). Within the window a fresh chat still can't beat the last one.
 */
export const ANON_MEMORY_TTL_MS = Number(process.env.EXCHANGE_ANON_MEMORY_TTL_MS) || 30 * 60_000;

/** Memory still in force: a named buyer's never expires; a client-asserted id's expires ANON_MEMORY_TTL_MS after its last update. */
export function liveMemory(buyer_id: string, m: BuyerMemory | null, now: number): BuyerMemory | null {
  if (!m || !isClientAsserted(buyer_id)) return m;
  return now - Date.parse(m.updated_at) < ANON_MEMORY_TTL_MS ? m : null;
}

const clone = <T>(x: T): T => structuredClone(x);

export class MemoryStore implements ExchangeStore {
  private negs = new Map<string, Negotiation>();
  private offers = new Map<string, StandingOffer>();
  private deals = new Map<string, LockedDeal>();
  private memory = new Map<string, BuyerMemory>();
  private jobs = new Map<string, FollowupJob>();
  private marks = new Map<string, FollowupMark>();

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
  async clearBuyerMemory(k: string) { this.memory.delete(k); }
  async putFollowupJob(j: FollowupJob) { this.jobs.set(j.negotiation_id, clone(j)); }
  async deleteFollowupJob(id: string) { this.jobs.delete(id); }
  async listFollowupJobs() { return [...this.jobs.values()].map(clone); }
  async getFollowupMark(k: string) { const m = this.marks.get(k); return m ? clone(m) : null; }
  async putFollowupMark(k: string, m: FollowupMark) { this.marks.set(k, clone(m)); }
  /** Test helper: raw access, for tamper tests. */
  _rawDeal(id: string) { return this.deals.get(id); }
}
