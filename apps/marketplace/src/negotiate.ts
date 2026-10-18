// Negotiation tools: thin MCP wrappers over E1's exchange (handle(move)). Responses pass through unchanged.
//
// Buyer identity (Esha's proposal): ChatGPT/Claude users send no buyer_id and the gateway is stateless, so the
// first make_offer without one mints `anon_<uuid>` and returns it; the model must send it back on every later call.
// Offers stay bound to that id, so another buyer can't accept them. Simulated buyers send their own ids.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Exchange, type ExchangeResponse, type Move } from "@sa/seller-mcp/exchange";

let exP: Promise<Exchange> | undefined;
/** Supabase-backed when SUPABASE_URL is set (stateless-safe), else in-memory (single instance). */
export const exchange = () => (exP ??= Exchange.fromEnv());

const ctxFields = {
  run_id: z.string().optional().describe("Eval run id (simulated buyers only)"),
  buyer_model: z.string().optional().describe("Buyer model name, if known"),
};
const buyerIdNew = z.string().optional().describe("Your buyer_id from an earlier response. Omit on your very first offer and one is created for you.");
const buyerIdReq = z.string().describe("The buyer_id returned by your first make_offer. Required.");

export function toCtx(a: { run_id?: string; buyer_id?: string; buyer_model?: string }) {
  return { run_id: a.run_id ?? "live", buyer_id: a.buyer_id ?? `anon_${randomUUID()}`, buyer_model: a.buyer_model ?? "unknown" };
}

const usd = (c?: number) => (c === undefined ? "" : `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`);

export function render(r: ExchangeResponse, buyer_id: string) {
  const out = { ...r, buyer_id };
  const o = r.standing_offer;
  const lines = [
    r.message,
    o ? `Standing offer ${o.offer_id}: ${usd(o.price_cents)}${o.levers.length ? ` incl. ${o.levers.join(", ")}` : ""}${o.final ? " (final)" : ""}, expires ${o.expires_at}.` : "",
    r.deal ? `Deal ${r.deal.deal_id} locked at ${usd(r.deal.total_cents)}. Ask the person to approve and pay.` : "",
    r.error ? `Error ${r.error.code}: ${r.error.message}` : "",
    r.negotiation_id ? `negotiation_id ${r.negotiation_id} · buyer_id ${buyer_id} (send both on every later call) · next: ${r.allowed_actions.join(", ") || "none"}` : "",
  ].filter(Boolean);
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: out, isError: !r.ok && !r.negotiation_id };
}

async function run(move: Move) {
  return render(await (await exchange()).handle(move), move.ctx.buyer_id);
}

// biome-ignore lint: server type comes from mcp-use
export function registerNegotiationTools(server: any) {
  server.tool(
    {
      name: "make_offer",
      title: "Make an offer",
      description:
        "Offer a price to a product's seller. The seller's agent counters, accepts, or explains. Omit negotiation_id to start; send negotiation_id and buyer_id on later rounds. Prices are integer cents.",
      inputSchema: z.object({
        product_id: z.string().describe("Listing id from search_products"),
        offer_price_cents: z.number().int().positive().describe("Your offer per unit in integer cents, e.g. 11000 for $110"),
        negotiation_id: z.string().optional().describe("From the previous response; omit to start a negotiation"),
        quantity: z.number().int().positive().optional(),
        message: z.string().max(2000).optional().describe("Optional note to the seller"),
        levers: z.array(z.string()).optional().describe("Extras you want included, from the listing (e.g. free_shipping)"),
        buyer_id: buyerIdNew,
        ...ctxFields,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (a: any) => run({ kind: "offer", ctx: toCtx(a), product_id: a.product_id, negotiation_id: a.negotiation_id, offer_price_cents: a.offer_price_cents,
      quantity: a.quantity, message: a.message, levers: a.levers }),
  );

  server.tool(
    {
      name: "accept_deal",
      title: "Accept the seller's offer",
      description: "Accept the seller's standing offer by its offer_id. Locks a deal at that price; nothing is charged until the person approves and pays.",
      inputSchema: z.object({ negotiation_id: z.string(), offer_id: z.string().describe("standing_offer.offer_id from the latest response"), buyer_id: buyerIdReq, ...ctxFields }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a: any) => run({ kind: "accept", ctx: toCtx(a), negotiation_id: a.negotiation_id, offer_id: a.offer_id }),
  );

  server.tool(
    {
      name: "walk_away",
      title: "Walk away",
      description: "End the negotiation. Optionally allow one later offer from this seller at reply_to (agent email, phone or A2A address); reply STOP to opt out.",
      inputSchema: z.object({
        negotiation_id: z.string(),
        reason: z.string().max(500).optional(),
        allow_followup_to: z.string().optional().describe("Where the seller may send one later offer; omit for none"),
        followup_channel: z.enum(["email", "sms", "a2a"]).optional(),
        buyer_id: buyerIdReq,
        ...ctxFields,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a: any) => run({ kind: "walk", ctx: toCtx(a), negotiation_id: a.negotiation_id, reason: a.reason,
      followup: a.allow_followup_to ? { reply_to: a.allow_followup_to, channel: a.followup_channel ?? "email" } : undefined }),
  );

  server.tool(
    {
      name: "check_offers",
      title: "Check a negotiation",
      description: "Read the current state, standing offer, and any locked deal for a negotiation.",
      inputSchema: z.object({ negotiation_id: z.string(), buyer_id: buyerIdReq, ...ctxFields }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a: any) => run({ kind: "status", ctx: toCtx(a), negotiation_id: a.negotiation_id }),
  );
}
