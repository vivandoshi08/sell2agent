// find_alternatives (read-only), plus the helper walk_away uses to answer a walk-away with a better fit.
// Logic and rules live in recovery.ts. Events reuse type "search" (the contract is frozen) with payload.recovery = true;
// the dashboard's Live view and "Walk-aways recovered" panel read them.
import { z } from "zod";
import { BLOCKERS, findAlternatives, recoveryText, type Blocker, type Recovery } from "./recovery.js";
import { catalog } from "./catalog-source.js";
import { log } from "./log.js";

export const blockerSchema = z
  .enum(BLOCKERS)
  .describe("What got in the way: price, missing_feature, delivery, trust or other");
export const stillNeedSchema = z
  .array(z.string().max(60))
  .max(8)
  .describe("Features the person still needs, as short phrases, e.g. ['silent', 'wireless']. Only products with all of them are suggested.");
export const needSchema = z
  .string()
  .max(200)
  .describe("Optional: one line on what it's for, in plain words, e.g. 'second desk, just needs to be quiet'. Never use it to share a budget.");

type Ctx = { run_id?: string; buyer_id?: string; buyer_model?: string };

export type RecoverArgs = Ctx & {
  product_id: string;
  blocker: Blocker;
  still_need?: string[];
  need?: string;
  max_price_cents?: number;
  negotiation_id?: string;
  trigger: "walk_away" | "find_alternatives";
};

/** Find alternatives and log the recovery event. Null when the product is unknown. Never throws on logging. */
export async function recover(a: RecoverArgs, mcpUrl: string): Promise<Recovery | null> {
  const cat = await catalog();
  const r = findAlternatives(
    { from_product_id: a.product_id, blocker: a.blocker, still_need: a.still_need, need: a.need, max_price_cents: a.max_price_cents },
    cat,
    mcpUrl,
  );
  if (!r) return null;
  const from = cat.products.find((p) => p.id === a.product_id);
  await log({
    run_id: a.run_id ?? "live",
    buyer_id: a.buyer_id ?? null,
    buyer_model: a.buyer_model ?? null,
    seller_id: from?.seller_id ?? null,
    product_id: a.product_id,
    negotiation_id: a.negotiation_id ?? null,
    actor: "marketplace",
    type: "search",
    price_cents: null,
    payload: {
      recovery: true,
      trigger: a.trigger,
      blocker: r.blocker,
      need: a.need?.slice(0, 200) ?? null,
      still_need: r.still_need,
      from_product_id: r.from_product_id,
      from_title: r.from_title,
      result_ids: r.alternatives.map((x) => x.product_id),
      result_titles: r.alternatives.map((x) => x.title),
      honest_no: r.honest_no,
      summary: r.summary,
    },
  });
  return r;
}

// biome-ignore lint: server type comes from mcp-use
export function registerRecoveryTools(server: any, mcpUrl: string) {
  server.tool(
    {
      name: "find_alternatives",
      title: "Find a better fit",
      description:
        "When a product isn't working out, say what's in the way and get up to two products that fit better, or an honest 'nothing here fits better'. " +
        "Never suggests the same product or anything pricier than it. Read-only: nothing is offered or bought. walk_away does this for you when you pass a blocker.",
      inputSchema: z.object({
        product_id: z.string().describe("The product that isn't working out (listing id)"),
        blocker: blockerSchema,
        still_need: stillNeedSchema.optional(),
        need: needSchema.optional(),
        max_price_cents: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional: a budget above this product's list price, if the person has one. Otherwise suggestions never cost more."),
        negotiation_id: z.string().optional().describe("The negotiation on that product, if any"),
        run_id: z.string().optional().describe("Eval run id (simulated buyers only)"),
        buyer_id: z.string().optional().describe("Your buyer_id, if you have one"),
        buyer_model: z.string().optional().describe("Buyer model name, if known"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a: Omit<RecoverArgs, "trigger">) => {
      const r = await recover({ ...a, trigger: "find_alternatives" }, mcpUrl);
      if (!r) {
        return {
          content: [{ type: "text" as const, text: `Unknown product ${a.product_id}. Use search_products to find one.` }],
          structuredContent: { ok: false, error: { code: "unknown_product", message: `no product ${a.product_id}` } },
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: recoveryText(r) }], structuredContent: { ok: true, recovery: r } };
    },
  );
}
