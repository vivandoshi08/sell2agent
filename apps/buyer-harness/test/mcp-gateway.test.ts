// McpGateway against a stub MCP client (no network): what it sends to the deployed gateway and how it reads replies.
// Run: pnpm --filter @sa/buyer-harness test
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpGateway, ScriptedBrain, makeBuyers, runBuyer } from "../src";
import type { ToolCaller } from "../src/gateway/mcp";

type Call = { name: string; args: Record<string, any> };

const LISTING = {
  id: "kb_typewell_65", seller_id: "typewell", seller_name: "TypeWell", category: "mechanical_keyboard", title: "TypeWell 65",
  description: "Wireless 65% board.", specs: { wireless: true, hot_swap: false }, list_price_cents: 13900, shipping_days: 2,
  in_stock: true, mcp_url: "https://example.test/mcp",
};

/** Answers like S1's gateway: search_products → { results: [{ listing, fit_note, levers_offered }] }, make_offer → ExchangeResponse. */
function stub(): { client: ToolCaller; calls: Call[] } {
  const calls: Call[] = [];
  const reply = (structuredContent: unknown) => ({ structuredContent, content: [] });
  const client: ToolCaller = {
    async callTool({ name, arguments: args = {} }) {
      calls.push({ name, args });
      switch (name) {
        case "search_products":
          return reply({ relaxed: false, results: [{ listing: LISTING, fit_note: "", levers_offered: [
            { id: "free_shipping", lever: "delivery", label: "Free shipping" },
            { id: "extended_warranty", lever: "warranty", label: "Extended warranty" }] }] });
        case "get_listing":
          return reply(LISTING); // the real get_listing returns the bare Listing: no levers_offered
        case "ask_question":
          return reply({ answer: "It is wireless.", grounded: true });
        case "make_offer":
          return reply({ ok: true, negotiation_id: "neg_1", status: "counter", round: 1, rounds_left: 3, message: "How about $110?",
            standing_offer: { offer_id: "off_1", price_cents: 11000, final: false, levers: args.levers ?? [] } });
        case "accept_deal":
          return reply({ ok: true, message: "Deal.", deal: { deal_id: "deal_1", product_id: LISTING.id, unit_price_cents: 11000 } });
        default:
          return reply({ ok: false, message: `unknown tool ${name}` });
      }
    },
    async close() {},
  };
  return { client, calls };
}

const ctx = { run_id: "t_mcp", buyer_id: "b1", buyer_model: "scripted" };

test("search_products gets the persona's lever profile as preferences", async () => {
  const { client, calls } = stub();
  const gw = new McpGateway("https://example.test/mcp", "negotiating", client);
  const task = makeBuyers({ n: 5, models: ["scripted"], seed: 1, adversarial_share: 0 }).find((b) => b.persona === "quality_first")!;
  await runBuyer(task, new ScriptedBrain(), gw, "t_mcp", () => {}, 30, "negotiating");
  const search = calls.find((c) => c.name === "search_products")!;
  assert.deepEqual(search.args.preferences, { quality: 1, warranty: 0.8, price: 0.3 });
  assert.equal(search.args.buyer_id, task.buyer_id);
  assert.ok(calls.some((c) => c.name === "make_offer"), "the buyer went on to negotiate");
});

test("an empty profile sends no preferences (the gateway then ranks by query match)", async () => {
  const { client, calls } = stub();
  await new McpGateway("https://example.test/mcp", undefined, client).search(ctx, "keyboard", undefined, undefined, {});
  assert.equal(calls[0].args.preferences, undefined);
});

test("extras on: listings carry levers_offered ids, get_listing reuses them, make_offer sends levers", async () => {
  process.env.E2_BUYER_EXTRAS = "on";
  const { client, calls } = stub();
  const gw = new McpGateway("https://example.test/mcp", "negotiating", client);
  delete process.env.E2_BUYER_EXTRAS;
  const [l] = await gw.search(ctx, "keyboard");
  assert.deepEqual(l.extras, ["free_shipping", "extended_warranty"]);
  assert.deepEqual((await gw.getListing(ctx, LISTING.id))?.extras, ["free_shipping", "extended_warranty"]);
  const r = await gw.offer(ctx, { product_id: LISTING.id, offer_price_cents: 10000, levers: ["free_shipping"] });
  const offer = calls.find((c) => c.name === "make_offer")!;
  assert.deepEqual(offer.args.levers, ["free_shipping"]);
  assert.equal(offer.args.strategy, "negotiating");
  assert.deepEqual(r.extras, ["free_shipping"]);
});

test("extras off by default: listings show none and make_offer sends no levers (strategy still sent)", async () => {
  const { client, calls } = stub();
  const gw = new McpGateway("https://example.test/mcp", "static", client);
  const ls = await gw.search(ctx, "keyboard");
  assert.ok(ls.every((l) => (l.extras ?? []).length === 0));
  assert.deepEqual((await gw.getListing(ctx, LISTING.id))?.extras, []);
  const r = await gw.offer(ctx, { product_id: LISTING.id, offer_price_cents: 10000, levers: ["free_shipping"] });
  const offer = calls.find((c) => c.name === "make_offer")!;
  assert.equal(offer.args.levers, undefined);
  assert.equal(offer.args.strategy, "static");
  assert.deepEqual(r.extras, []);
  const d = await gw.accept(ctx, r.negotiation_id);
  assert.ok(d.ok && d.final_price_cents === 11000);
  assert.equal(calls.find((c) => c.name === "accept_deal")!.args.offer_id, "off_1");
});
