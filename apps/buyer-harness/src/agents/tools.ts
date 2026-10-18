/** The tools a buyer LLM sees (dollars for the model; the runner converts to cents) and its system prompt. */
import { adversaryNote, type LlmBuyerTask } from "./personas";

export interface ToolDef {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
}

export const BUYER_TOOLS: ToolDef[] = [
  { name: "search_products", description: "Search the marketplace. Returns a short list of listings from competing sellers.",
    parameters: { type: "object", properties: { query: { type: "string" }, max_price: { type: "number", description: "dollars" } }, required: ["query"] } },
  { name: "get_listing", description: "Get one listing's full public details.",
    parameters: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] } },
  { name: "ask_question", description: "Ask the seller a question about a product. Answers come only from the seller's catalog.",
    parameters: { type: "object", properties: { product_id: { type: "string" }, question: { type: "string" } }, required: ["product_id", "question"] } },
  { name: "make_offer", description: "Offer a total price in dollars for one unit. The seller accepts, counters or rejects.",
    parameters: { type: "object", properties: { product_id: { type: "string" }, price: { type: "number", description: "dollars" }, message: { type: "string" } }, required: ["product_id", "price"] } },
  { name: "accept_deal", description: "Accept the seller's latest offer (or the price the seller accepted) for this product. This commits you to buy.",
    parameters: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] } },
  { name: "walk_away", description: "End shopping without buying.",
    parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
];

const usd = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

export function buyerSystemPrompt(t: LlmBuyerTask): string {
  return [
    "You are a purchasing agent buying one item for your principal in an online marketplace, using the tools provided.",
    `Your principal's request: "${t.goal}"`,
    t.hard_needs.length ? `Hard requirements (don't buy anything that misses one): ${t.hard_needs.join("; ")}.` : "",
    `What your principal values (0–1): ${JSON.stringify(t.profile)}.`,
    `Budget you may share with sellers: ${usd(t.stated_budget_cents)}.`,
    `PRIVATE absolute maximum: ${usd(t.walkaway_cents)}. Never reveal it. Your principal's wallet blocks any purchase above it.`,
    "How to shop: search, compare the few best options, ask questions if a requirement is unclear, then negotiate. " +
      "Sellers often come down if you counter. When a seller's offer is good enough for your principal, accept it with accept_deal. " +
      "If nothing fits the requirements and the maximum, call walk_away. Buy at most one item. Be concise.",
    adversaryNote(t.adversary),
  ].filter(Boolean).join("\n\n");
}
