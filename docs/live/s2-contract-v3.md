# Instinct Demo: Team Asks (S2 contract v3) — repo snapshot

> Snapshot of Ananya's Claude Doc (claude.ai/code/artifact/87cf2bd9-59a5-49dd-97d0-92762076d9a6) as of its 00:55 change-log entry, committed by E1 (Vivan) because other roles' Claude sessions get "access denied" on the doc (E2 asked for it here). **Ananya's doc is the source of truth**; if it has moved on, it wins. If this disagrees with `packages/shared` on main, the code wins; flag the gap to Ananya.

For the live demo, a real Instinct agent buys from Keyforge over text and the seller watches every move. S2 needs contract v3 from Neel, two exchange changes from Vivan, and two routes plus a redeploy from Esha. Everything is additive; nothing existing breaks.

P0 is needed for the live demo. P1 and P2 can land after the 7am freeze.

## What each person needs to do

**Neel (contract + E2)**
- [ ] Add the P0 fields below to `packages/shared` (channel, agent_operator, summary, list_price_cents, total_cents, approve_url, PayDealOutput extras).
- [ ] Generate `summary` text on offers and deals from the structured offer (never the floor or cost).

**Vivan (E1 exchange)**
- [ ] Write `reason`, `rule_refs` and `product_title` (the public listing title, so seller cards don't show raw ids) into `offer_countered`, `offer_accepted` and `deal_accepted` payloads, and `seller_message` on `guardrail_blocked`.
- [ ] Make the gateway's exchange read `seller_policies`, so rules set in the console reach live negotiations.
- [x] Fix issue #41 (static marks every move final; negotiating exceeds the concession cap) so the demo shows no odd blocks. — done in #61

**Esha (S1 gateway)**
- [ ] Add `GET /deal/:deal_id?t=<token>` and `POST /deal/:deal_id/pay?t=<token>`, render the approve page with S2's `DealCardView`, and return `approve_url` from `accept_deal`.
- [ ] Fill `channel` and `agent_operator` on every tool call (Instinct = `messaging`).
- [ ] Redeploy, then text our Instinct the URL to check whether it can use MCP or only browses.

## What the UI already does (S2, on branches)

- Seller app, Live view (PR #27): one card per negotiation with each move, its reason and rule_refs as rule chips, sale alerts, and a blocked-by-your-rules log. Shows real gateway buyers automatically (liveTraffic) and replays the eval run only when no one is shopping; until `reason` lands it shows the logged voice message as the why. Falls back to today's events until the new keys land.
- Deal card / approve page (PR #26): checkout look, all payment states, works in ChatGPT/Claude and as Esha's hosted approve page.
- Neither is merged to main yet; whoever can merge, please review #26 and #27.

## Why the contract has to change

The live demo buyer is Vivan texting his Instinct agent, not a ChatGPT deal card:
1. Instinct relays our replies as text messages. No MCP App UI, so every offer needs a short, self-contained line it can text verbatim.
2. Approval happens outside our card: Instinct's own approval prompt, or a hosted approve link. Instinct pays with real Stripe Link one-time cards and our payments run in test mode, so the demo charges a test card on our approve page.
3. The seller is the customer. The seller's live view needs the real reason behind each move and the rule that shaped it, not just the price.

**Flow:** Vivan texts his Instinct → it negotiates with Keyforge's agent through our gateway → he approves on a link → Keyforge watches it happen. Search, questions, offers and payment are built; the P0 asks fill the rest.

## P0: the live Instinct demo

Five additions, all optional, on top of contract v2 in `packages/shared/src/index.ts`.

**1. Who is buying, and through what.** The gateway fills these for real buyers; the harness passes them.

```ts
export const BuyerChannel = z.enum(["mcp_app", "messaging", "web", "harness"]);
BuyerContext.extend({
  channel: BuyerChannel.optional(),       // Instinct = "messaging", ChatGPT/Claude = "mcp_app"
  agent_operator: z.string().optional(),  // "instinct" | "chatgpt" | "claude" | "harness"
});
```

**2. Every offer carries a line the agent can text verbatim.**

```ts
MakeOfferOutput.extend({
  summary: z.string().max(280),
  // "Keyforge can do $119 with a 2-year warranty and free 2-day shipping. Offer holds 15 min."
  // Plain text, self-contained. Price and perks come from the structured offer only. Never floor or cost.
  list_price_cents: z.number().int().positive(), // so the buyer can show savings
});
```

**3. Accepting returns a summary and an approve link for agents with no card UI.**

```ts
AcceptDealOutput.extend({
  summary: z.string().max(280),
  // "Deal locked: KeyForge Quiet 75, $119.00, 2-yr warranty, free shipping. Approve: <url>"
  total_cents: z.number().int().positive(),
  approve_url: z.string().url().optional(), // hosted approve page, signed with the deal's existing HMAC (deals.signature)
});
```

**4. A payment result the approve page and the text can show.**

```ts
PayDealOutput.extend({
  card: z.string().optional(),          // "visa ****4242"
  already_paid: z.boolean().optional(), // a retry on a paid deal returns the original result
  code: z.string().optional(),
  message: z.string().optional(),
});
```

**5. Why the seller did what it did**, as payload keys on existing events (no new event types):

| Event | New payload keys |
| --- | --- |
| `offer_countered`, `offer_accepted`, `deal_accepted` | `reason` (the real reason given to voice, one sentence), `rule_refs: string[]` (e.g. `"floor"`, `"lever:extended_warranty"`), `lever_package`, `channel`, `agent_operator` |
| `guardrail_blocked` | existing `rule` plus `seller_message` (one plain sentence) |
| `question_answered` | `question`, `grounded` |

**Two new HTTP routes on the gateway** (not MCP tools):

| Route | Returns |
| --- | --- |
| `GET /deal/:deal_id?t=<token>` | `DealCard` (S2's type, public fields only) |
| `POST /deal/:deal_id/pay?t=<token>` | `PayDealOutput`; the amount always comes from the stored deal |

## P1: seller setup for the whole store

Sellers set one store-wide goal plus a few exceptions by collection, not settings per product. The resolver turns that into the existing `SellerPolicy` per product, so the exchange doesn't change. Today the console (PR #49) edits `seller_policies` per product; this sits on top of it.

```ts
Product.extend({ collections: z.array(z.string()).default([]) });
export const StoreGoal = z.enum(["protect_margin", "balanced", "move_units"]); // 45% / 30% / 15% minimum margin
export const SellerRule = z.object({
  id: z.string(),
  scope: z.object({ type: z.enum(["store", "collection", "product"]), id: z.string().optional() }),
  kind: z.enum(["min_margin_pct", "no_discount", "lever_min_order", "lever_disallow"]),
  params: z.record(z.string(), z.union([z.number(), z.string()])),
  // { pct: 10 } | { lever_id: "extended_warranty", min_total_cents: 11500 }
  source_text: z.string().optional(), // the seller's plain-English version
  enabled: z.boolean().default(true),
});
export const StorePolicy = z.object({
  seller_id: z.string(),
  goal: StoreGoal,
  min_margin_pct: z.number().min(0).max(100),
  lever_menu: z.array(LeverOption).default([]),
  rules: z.array(SellerRule).default([]),
});
// Output stays the existing type, so the exchange is untouched:
// resolvePolicy(store: StorePolicy, product: Product, unit_cost_cents: number) => SellerPolicy
// Precedence: product rule > collection rule > store goal.
```

`lever_min_order` ("warranty only on orders over $115") is a new kind of limit; the exchange's guards would need to enforce it.

## P2: after the sale (seller-only, never buyer-facing)

Big orders outside the rules go to the seller, notifications reach the seller's phone, and a weekly summary answers "did this make me money, and what did buyers ask for?"

```ts
// New event types. NegotiationStatus already has "escalated".
EventType: + "escalated"        // payload { quantity, offer_price_cents, total_cents, reason }
           + "seller_decision"  // payload { decision: "approve" | "counter" | "decline", price_cents? }
export const SellerNotification = z.object({
  seller_id: z.string(),
  kind: z.enum(["sale", "needs_you", "weekly_summary", "rule_test"]),
  title: z.string(), body: z.string(),
  actions: z.array(z.object({ id: z.string(), label: z.string() })).default([]),
  deal_id: z.string().optional(), negotiation_id: z.string().optional(),
  ts: z.string().datetime(),
});
export const SellerSummary = z.object({
  seller_id: z.string(), period_start: z.string().datetime(), period_end: z.string().datetime(),
  extra_profit_cents: z.number().int(),
  profit_per_buyer: z.object({ with_agent: z.number(), fixed: z.number(), ci_lo: z.number(), ci_hi: z.number() }),
  sales: z.number().int(), conversion: z.number(), rules_broken: z.number().int(),
  gave_away: z.array(z.object({ lever_id: z.string(), label: z.string(), deals: z.number().int(), cost_cents: z.number().int() })),
  avg_discount_cents: z.number().int(),
  buyer_asks: z.array(z.object({ text: z.string(), count: z.number().int() })), // from grounded:false answers and unmet requests
});
```

"Profit versus fixed price" on real traffic needs a holdout: a logged share of real buyers sees the fixed-price policy. The eval runner already does this for simulated buyers.

## Who builds what

| Piece | Owner (proposed) | Priority |
| --- | --- | --- |
| Contract v3 fields in `packages/shared` | Neel | P0 |
| `summary` text on offers and deals | Neel (E2 voice) | P0 |
| `reason` and `rule_refs` written into events | Vivan (E1 exchange) + Neel | P0 |
| Gateway reads `seller_policies` so console edits reach live deals | Vivan (E1) | P0 |
| `/deal/:id` and `/deal/:id/pay` routes, `approve_url` | Esha (S1 gateway) | P0 |
| Approve page view, seller live-feed view | Ananya (S2 design) | P0 |
| Store goal, rules, `resolvePolicy` | Neel + S2 data session | P1 |
| Escalation, notifications, weekly summary | TBD | P2 |

## Open questions

- Can our Instinct add an MCP connector, or does it only browse? If it only browses, we need a plain web version of the tools.
- Does the approve page charge a Stripe test card for the demo, given Instinct pays with real Link cards?
- Who redeploys the gateway after these land, and when?

## Change log (from the doc)

| Date | Change |
| --- | --- |
| Oct 18, 00:55 | S2 Live view reads real gateway buyers (liveTraffic), dims routine-severity blocks from #60, labels `payment_refused`; asked Vivan for `product_title` on events. PRs #26/#27 synced with main. |
| Oct 18, 00:35 | Now covers Vivan and Esha with a per-person checklist and what the UI already does |
| Oct 18, 00:20 | First version: P0 for the live Instinct demo, P1 seller setup, P2 after-sale |
