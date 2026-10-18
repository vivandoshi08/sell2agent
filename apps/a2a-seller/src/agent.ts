/**
 * SPIKE (spike/a2a-primitive): one transport-agnostic seller "brain door" over E1's Exchange.
 * Two inputs, same Exchange.handle():
 *   - structured skill calls (A2A DataPart {skill, args}) — what a coded buyer agent sends
 *   - free text (A2A TextPart, or an email body via Primitive) — what an off-the-shelf agent sends
 * A conversation key (A2A contextId, or the email thread / sender) maps to one buyer + negotiation,
 * so the buyer never has to echo negotiation_id / offer_id unless it wants to.
 */
import type { BuyerContext } from "@sa/shared";
import { Exchange, SEED_PRODUCTS, StaticCatalog, parseInbound, type ExchangeResponse, type ProductConfig } from "@sa/seller-mcp/exchange";

export type SkillName = "search_products" | "get_listing" | "make_offer" | "accept_deal" | "walk_away" | "check_offers";
export interface SkillCall { skill: SkillName; args?: Record<string, unknown> }

interface Session { buyer_id: string; product_id?: string; negotiation_id?: string; offer_id?: string }

/** Public listing: never floor or cost. */
export function publicListing(p: ProductConfig) {
  return { product_id: p.product_id, seller_name: p.seller_id, title: p.title, description: p.title, specs: {},
    list_price_cents: p.list_price_cents, shipping_days: 3, negotiable: p.strategy !== "static", extras: p.allowed_levers };
}

export class SellerAgent {
  readonly exchange: Exchange;
  readonly events: unknown[] = [];
  private sessions = new Map<string, Session>();
  constructor(private products: ProductConfig[] = SEED_PRODUCTS, opts: { channel?: BuyerContext["channel"]; operator?: string } = {}) {
    this.exchange = new Exchange({ catalog: new StaticCatalog(products), sink: async (e) => { this.events.push(e); } });
    this.channel = opts.channel ?? "messaging";
    this.operator = opts.operator ?? "a2a";
  }
  private channel: BuyerContext["channel"];
  private operator: string;

  /** buyer identity: whatever the transport can vouch for (A2A: nothing → per-context anon id; email: DMARC-verified sender). */
  session(key: string, buyer_id?: string): Session {
    let s = this.sessions.get(key);
    if (!s) { s = { buyer_id: buyer_id ?? `a2a_${key}` }; this.sessions.set(key, s); }
    return s;
  }
  private ctx(s: Session): BuyerContext {
    return { run_id: "a2a-spike", buyer_id: s.buyer_id, buyer_model: "unknown", channel: this.channel, agent_operator: this.operator };
  }
  private remember(s: Session, r: ExchangeResponse) {
    if (r.negotiation_id) s.negotiation_id = r.negotiation_id;
    if (r.standing_offer?.offer_id) s.offer_id = r.standing_offer.offer_id;
  }

  async call(key: string, c: SkillCall, buyer_id?: string): Promise<unknown> {
    const s = this.session(key, buyer_id);
    const a = c.args ?? {};
    switch (c.skill) {
      case "search_products": {
        const q = String(a.query ?? "").toLowerCase();
        return { results: this.products.filter((p) => !q || p.title.toLowerCase().includes(q) || p.product_id.includes(q)).map(publicListing) };
      }
      case "get_listing": {
        const p = this.products.find((x) => x.product_id === a.product_id);
        if (p) s.product_id = p.product_id;
        return p ? publicListing(p) : { error: "unknown product_id" };
      }
      case "make_offer": {
        const product_id = String(a.product_id ?? s.product_id ?? "");
        // new product → new negotiation
        if (s.product_id !== product_id) { s.negotiation_id = undefined; s.offer_id = undefined; }
        s.product_id = product_id;
        const r = await this.exchange.handle({ kind: "offer", ctx: this.ctx(s), product_id, negotiation_id: (a.negotiation_id as string) ?? s.negotiation_id,
          offer_price_cents: Number(a.offer_price_cents), message: a.message as string | undefined, levers: a.levers as string[] | undefined });
        this.remember(s, r);
        return r;
      }
      case "accept_deal": {
        const negotiation_id = (a.negotiation_id as string) ?? s.negotiation_id;
        const offer_id = (a.offer_id as string) ?? s.offer_id;
        if (!negotiation_id || !offer_id) return { ok: false, message: "No live offer to accept yet. make_offer first." };
        const r = await this.exchange.handle({ kind: "accept", ctx: this.ctx(s), negotiation_id, offer_id });
        this.remember(s, r);
        return r;
      }
      case "walk_away": {
        if (!s.negotiation_id) return { ok: false, message: "No negotiation open." };
        return this.exchange.handle({ kind: "walk", ctx: this.ctx(s), negotiation_id: s.negotiation_id, reason: a.reason as string | undefined });
      }
      case "check_offers": {
        if (!s.negotiation_id) return { ok: false, message: "No negotiation open." };
        return this.exchange.handle({ kind: "status", ctx: this.ctx(s), negotiation_id: s.negotiation_id });
      }
      default:
        return { ok: false, message: `unknown skill ${(c as SkillCall).skill}` };
    }
  }

  /**
   * Free text → one move. Deterministic (E1's parseInbound: never guesses; mixed/unclear → a question).
   * Opening line must name a product id ("I'd like kb_clackco_tkl, can you do $90?"), or the session already has one.
   */
  async text(key: string, raw: string, buyer_id?: string): Promise<{ reply: string; data?: unknown }> {
    const s = this.session(key, buyer_id);
    const pid = this.products.find((p) => raw.includes(p.product_id))?.product_id;
    if (pid && pid !== s.product_id) { s.product_id = pid; s.negotiation_id = undefined; s.offer_id = undefined; }
    if (!s.product_id) return { reply: `Which item? Name a product id: ${this.products.map((p) => p.product_id).join(", ")}.` };
    const p = this.products.find((x) => x.product_id === s.product_id)!;
    const intent = parseInbound(raw.replaceAll(p.product_id, ""), { standing_offer_id: s.offer_id, allowed_levers: p.allowed_levers });
    let r: unknown;
    switch (intent.kind) {
      case "counter": r = await this.call(key, { skill: "make_offer", args: { offer_price_cents: intent.price_cents, levers: intent.levers.length ? intent.levers : undefined, message: raw } }); break;
      case "accept": r = await this.call(key, { skill: "accept_deal", args: { offer_id: intent.offer_id } }); break;
      case "walk": case "unsubscribe": r = await this.call(key, { skill: "walk_away" }); break;
      case "clarify":
        if (!s.negotiation_id) return { reply: `${p.title} (${p.product_id}) lists at $${(p.list_price_cents / 100).toFixed(2)}. Reply with one price, e.g. "COUNTER $${Math.round(p.list_price_cents * 0.8 / 100)}".` };
        return { reply: intent.question };
    }
    return { reply: toText(r as ExchangeResponse), data: r };
  }
}

/** One plain reply line for text-only agents. */
export function toText(r: ExchangeResponse): string {
  const parts = [r.summary ?? r.message];
  if (r.deal) parts.push(`Deal ${r.deal.deal_id} locked at $${(r.deal.unit_price_cents / 100).toFixed(2)}.`);
  else if (r.standing_offer) parts.push(`To take it reply: ACCEPT ${r.standing_offer.offer_id}. Or COUNTER $<price>.`);
  if (r.error) parts.push(`[${r.error.code}] ${r.error.message}`);
  return parts.filter(Boolean).join(" ");
}
