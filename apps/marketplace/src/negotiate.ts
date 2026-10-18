// Negotiation tools: thin MCP wrappers over E1's exchange (handle(move)). Responses pass through unchanged.
//
// Buyer identity, in order: a buyer_id the caller sends (simulated buyers, or the id echoed back by the model);
// else ChatGPT's per-user `openai/subject`, hashed to `oai_<hex>` so one person keeps one id across chats;
// else the first make_offer (no negotiation_id) mints `anon_<uuid>` and returns it, and the model must send it back.
// Later calls with no id at all get `missing_buyer_id` (never a fresh anon_ id, which would read as wrong_buyer).
// Offers stay bound to that id, so another buyer can't accept them.
import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { Exchange, type ExchangeResponse, type Move } from "@sa/seller-mcp/exchange";
import { defaultLlm, dealSummary as dealLine } from "@sa/seller-mcp/sellers";
import { approveUrl } from "./deal/approve.js";

let exP: Promise<Exchange> | undefined;
/** Supabase-backed when SUPABASE_URL is set (stateless-safe), else in-memory (single instance). */
// Seller voice: Claude when ANTHROPIC_API_KEY is set (E2 voice() guards every figure and falls back to templates).
export const exchange = () => (exP ??= Exchange.fromEnv({ llm: defaultLlm() }));

const ctxFields = {
  run_id: z.string().optional().describe("Eval run id (simulated buyers only)"),
  buyer_model: z.string().optional().describe("Buyer model name, if known"),
  channel: z.enum(["mcp_app", "messaging", "web", "harness"]).optional().describe("How the buyer reaches us; filled in automatically if omitted"),
  agent_operator: z.string().optional().describe("Which agent is buying (e.g. instinct, chatgpt, harness); filled in automatically if omitted"),
};
const buyerIdNew = z.string().optional().describe("Your buyer_id from an earlier response. Omit on your very first offer and one is created for you.");
const buyerIdReq = z.string().optional().describe("The buyer_id returned by your first make_offer. Send it on every later call; it can be omitted only when the client identifies the user (ChatGPT).");

/** The slice of mcp-use's request context we read: client-reported OpenAI user hints (unverified, not auth). */
export type RequestLike = {
  client?: { user?: () => { subject?: string } | undefined; info?: () => { name?: string } | undefined };
};

type Channel = "mcp_app" | "messaging" | "web" | "harness";
const CHANNELS: Channel[] = ["mcp_app", "messaging", "web", "harness"];

// Known clients by their MCP clientInfo name (seen in production). Text-only agents relay summaries and pay
// on the approve link, so they are "messaging"; app hosts that render the deal card are "mcp_app".
const KNOWN_CLIENTS: { match: RegExp; operator: string; channel: Channel }[] = [
  { match: /^openai-mcp/i, operator: "chatgpt", channel: "mcp_app" },
  { match: /^instinct/i, operator: "instinct", channel: "messaging" },
];

/** channel + agent_operator (contract v3): explicit args win (the harness sends "harness"), else the client's name. */
export function buyerChannel(a: { channel?: string; agent_operator?: string; run_id?: string }, rc?: RequestLike): { channel: Channel; agent_operator: string } {
  const name = rc?.client?.info?.()?.name?.trim() ?? "";
  const known = KNOWN_CLIENTS.find((k) => k.match.test(name));
  const explicit = CHANNELS.find((c) => c === a.channel);
  const operator = (a.agent_operator || known?.operator || name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "unknown").slice(0, 32);
  return { channel: explicit ?? known?.channel ?? (operator === "harness" ? "harness" : "mcp_app"), agent_operator: operator };
}

// Keyed, so ids in `events` (readable with the anon key) can't be linked back to a known subject.
const SUBJECT_KEY = process.env.EXCHANGE_HMAC_SECRET ?? "dev-subject-secret";

/** `oai_` + keyed hash of ChatGPT's anonymized user id, or undefined when the client sent none. */
export function subjectBuyerId(rc?: RequestLike): string | undefined {
  const subject = rc?.client?.user?.()?.subject;
  return subject ? `oai_${createHmac("sha256", SUBJECT_KEY).update(subject).digest("hex").slice(0, 32)}` : undefined;
}

/** buyer_id is "" when nothing identifies the buyer and `mint` is off; `run` turns that into missing_buyer_id. */
export function toCtx(
  a: { run_id?: string; buyer_id?: string; buyer_model?: string; channel?: string; agent_operator?: string },
  rc?: RequestLike,
  { mint = false } = {},
) {
  const fromSubject = subjectBuyerId(rc);
  const { channel, agent_operator } = buyerChannel(a, rc);
  return {
    run_id: a.run_id ?? "live",
    buyer_id: a.buyer_id ?? fromSubject ?? (mint ? `anon_${randomUUID()}` : ""),
    buyer_model: a.buyer_model ?? (fromSubject ? "chatgpt" : agent_operator !== "unknown" ? agent_operator : "unknown"),
    channel,
    agent_operator,
  };
}

export const MISSING_BUYER_ID = "buyer_id missing: send the buyer_id from your first make_offer response on this call.";

export function missingBuyer() {
  return {
    content: [{ type: "text" as const, text: `Error missing_buyer_id: ${MISSING_BUYER_ID}` }],
    structuredContent: { ok: false, error: { code: "missing_buyer_id", message: MISSING_BUYER_ID }, allowed_actions: [] },
    isError: true,
  };
}

const usd = (c?: number) => (c === undefined ? "" : `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`);

// Public origin for hosted approve links (S2's approve page, #81), set by registerNegotiationTools.
let approveOrigin: string | undefined;

/** Approve link for one locked deal and its buyer; none without an origin or EXCHANGE_HMAC_SECRET. */
function approveLink(deal_id: string, buyer_id: string): string | undefined {
  if (!approveOrigin) return undefined;
  try {
    return approveUrl(approveOrigin, deal_id, buyer_id);
  } catch {
    return undefined;
  }
}

export function render(r: ExchangeResponse, buyer_id: string) {
  // A locked, unpaid deal gets a hosted approve link, so text-only agents (no deal card) can send it to the person.
  const d = r.deal && r.state !== "paid" ? r.deal : undefined;
  const approve_url = d ? approveLink(d.deal_id, buyer_id) : undefined;
  const out = { ...r, buyer_id, ...(d && approve_url ? { approve_url, summary: dealLine({ title: d.title, total_cents: d.total_cents, quantity: d.quantity,
    unit_price_cents: d.unit_price_cents, levers: d.levers, approve_url }) } : {}) };
  const o = r.standing_offer;
  const lines = [
    r.message,
    o ? `Standing offer ${o.offer_id}: ${usd(o.price_cents)}${o.levers.length ? ` incl. ${o.levers.join(", ")}` : ""}${o.final ? " (final)" : ""}, expires ${o.expires_at}.` : "",
    r.state === "paid" ? `PAID: the purchase is complete${r.deal ? ` (deal ${r.deal.deal_id}, ${usd(r.deal.total_cents)})` : ""}. Tell the person it's bought; don't negotiate this item again.` : "",
    d ? `Deal ${d.deal_id} locked at ${usd(d.total_cents)}. Ask the person to approve and pay${approve_url ? `: show the deal card (review_deal), or if you can't show cards, send them this approval link: ${approve_url}` : "."}` : "",
    r.error ? `Error ${r.error.code}: ${r.error.message}` : "",
    r.negotiation_id ? `negotiation_id ${r.negotiation_id} · buyer_id ${buyer_id} (send both on every later call) · next: ${r.allowed_actions.join(", ") || "none"}` : "",
  ].filter(Boolean);
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: out, isError: !r.ok && !r.negotiation_id };
}

async function run(move: Move) {
  if (!move.ctx.buyer_id) return missingBuyer();
  return render(await (await exchange()).handle(move), move.ctx.buyer_id);
}

// biome-ignore lint: server type comes from mcp-use
export function registerNegotiationTools(server: any, opts: { approveOrigin?: string } = {}) {
  approveOrigin = opts.approveOrigin;
  server.tool(
    {
      name: "make_offer",
      title: "Make an offer",
      description:
        "Offer a price to a product's seller. The seller's agent counters, accepts, or explains. Omit negotiation_id to start; send negotiation_id and buyer_id on later rounds. Prices are integer cents. Don't open a new negotiation for an item the person already paid for unless they ask to buy another.",
      inputSchema: z.object({
        product_id: z.string().describe("Listing id from search_products"),
        offer_price_cents: z.number().int().positive().describe("Your offer per unit in integer cents, e.g. 11000 for $110"),
        negotiation_id: z.string().optional().describe("From the previous response; omit to start a negotiation"),
        quantity: z.number().int().positive().optional(),
        message: z.string().max(2000).optional().describe("Optional note to the seller"),
        levers: z.array(z.string()).optional().describe("Extras you want included, from the listing (e.g. free_shipping)"),
        strategy: z
          .enum(["static", "negotiating", "balanced"])
          .optional()
          .describe("Eval runs only: seller strategy for A/B tests. Honoured by the exchange only for a signed eval run_id; ignored otherwise."),
        buyer_id: buyerIdNew,
        ...ctxFields,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (a: any, rc?: RequestLike) => run({ kind: "offer", ctx: toCtx(a, rc, { mint: !a.negotiation_id }), product_id: a.product_id, negotiation_id: a.negotiation_id, offer_price_cents: a.offer_price_cents,
      quantity: a.quantity, message: a.message, levers: a.levers,
      // E1 decides whether to honour it (signed eval run_id only); the gateway just passes it along.
      ...(a.strategy ? { strategy: a.strategy } : {}) }),
  );

  server.tool(
    {
      name: "accept_deal",
      title: "Accept the seller's offer",
      description: "Accept the seller's standing offer by its offer_id. Locks a deal at that price; nothing is charged until the person approves and pays.",
      inputSchema: z.object({ negotiation_id: z.string(), offer_id: z.string().describe("standing_offer.offer_id from the latest response"), buyer_id: buyerIdReq, ...ctxFields }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a: any, rc?: RequestLike) => run({ kind: "accept", ctx: toCtx(a, rc), negotiation_id: a.negotiation_id, offer_id: a.offer_id }),
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
    async (a: any, rc?: RequestLike) => run({ kind: "walk", ctx: toCtx(a, rc), negotiation_id: a.negotiation_id, reason: a.reason,
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
    async (a: any, rc?: RequestLike) => run({ kind: "status", ctx: toCtx(a, rc), negotiation_id: a.negotiation_id }),
  );
}
