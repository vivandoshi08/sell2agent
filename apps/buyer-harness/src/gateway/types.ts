/**
 * The gateway "plug": everything a buyer agent can do in our marketplace.
 * Two implementations:
 *   - LocalGateway (local.ts): an in-process stand-in store. Uses E2's seller brain. Mock until Bridge 2.
 *   - McpGateway (mcp.ts): the real deployed gateway over MCP (S1/Esha). Set GATEWAY_URL to use it.
 * Shapes follow packages/shared (MakeOfferOutput, AcceptDealOutput, BuyerContext). Money is cents.
 */
import type { BuyerContext } from "@sa/shared";

export interface GwListing {
  product_id: string;
  seller_name: string;
  title: string;
  description: string;
  specs: Record<string, string | number | boolean>;
  list_price_cents: number;
  shipping_days: number;
  negotiable: boolean;
}

export interface GwOfferResult {
  negotiation_id: string;
  status: "accept" | "counter" | "reject";
  price_cents: number; // the seller's counter, or the accepted price
  round: number;
  rounds_left: number;
  final: boolean;
  message: string;
}

export type GwAcceptResult =
  | { ok: true; deal_id: string; final_price_cents: number; product_id: string }
  | { ok: false; error: string };

export interface Gateway {
  readonly kind: "local" | "mcp";
  search(ctx: BuyerContext, query: string, max_price_cents?: number): Promise<GwListing[]>;
  getListing(ctx: BuyerContext, product_id: string): Promise<GwListing | null>;
  ask(ctx: BuyerContext, product_id: string, question: string): Promise<{ answer: string; grounded: boolean }>;
  offer(ctx: BuyerContext, a: { product_id: string; negotiation_id?: string; offer_price_cents: number; message?: string }): Promise<GwOfferResult>;
  accept(ctx: BuyerContext, negotiation_id: string): Promise<GwAcceptResult>;
  close?(): Promise<void>;
}
