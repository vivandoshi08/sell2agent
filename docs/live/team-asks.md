# Instinct Demo: Team Asks (repo mirror)

> Repo mirror of the Claude Doc "Instinct Demo: Team Asks" (https://claude.ai/code/artifact/87cf2bd9-59a5-49dd-97d0-92762076d9a6),
> for Claude sessions that can't open that doc. Read it with `bash scripts/live-docs.sh team-asks` (works before this branch merges).
> Owner: Ananya (S2 design). If this disagrees with `packages/shared` on `main`, the code wins; tell Ananya.

**Last updated:** Sun Oct 18, 1:05 am PT.

For the live demo, a real Instinct agent buys from Keyforge over text and the seller watches every move.
Everything below is additive; nothing existing breaks. P0 = needed for the live demo. P1/P2 can land after the 7am freeze.

## What each person needs to do

**Neel (contract + E2)**
- [ ] Add the P0 fields below to `packages/shared` (`channel`, `agent_operator`, `summary`, `list_price_cents`, `total_cents`, `approve_url`, `PayDealOutput` extras).
- [ ] Generate `summary` text on offers and deals from the structured offer (never the floor or cost).

**Vivan (E1 exchange)**
- [ ] Write `reason`, `rule_refs` and `product_title` (the public listing title, so seller cards don't show raw ids) into `offer_countered`, `offer_accepted` and `deal_accepted` payloads, and `seller_message` on `guardrail_blocked`.
- [ ] Make the gateway's exchange read `seller_policies`, so rules set in the console reach live negotiations.
- [ ] Fix issue #41 (static marks every move final; negotiating exceeds the concession cap) so the demo shows no odd blocks.

**Esha (S1 gateway)**
- [ ] Add `GET /deal/:deal_id?t=<token>` and `POST /deal/:deal_id/pay?t=<token>`, render the approve page with S2's `DealCardView`, and return `approve_url` from `accept_deal`.
- [ ] Fill `channel` and `agent_operator` on every tool call (Instinct = `messaging`).
- [ ] Redeploy, then text our Instinct the URL to check whether it can use MCP or only browses.

## What the UI already does (S2, on branches, not merged yet)

- **Seller app, Live view** (PR #27): one card per negotiation with each move, the why (`reason`, else the logged voice `message`), `rule_refs` as rule chips, sale alerts, a blocked-by-your-rules log. Shows real gateway buyers automatically (`liveTraffic`), replays the eval run when no one is shopping. Routine-severity blocks read as calm "held the price" moves.
- **Deal card / approve page** (PR #26): checkout look, every `PayState`, works in ChatGPT/Claude and as Esha's hosted approve page.

## Why the contract changes

- **Instinct relays our replies as text.** No MCP App UI, so every offer needs a short, self-contained line it can text verbatim.
- **Approval happens outside our card.** Instinct shows its own prompt, or the person taps a hosted approve link. Instinct pays with real Stripe Link cards; ours is test mode, so the demo charges a test card on our approve page.
- **The seller is the customer.** The Live view needs the real reason behind each move and the rule that shaped it, not just the price.

## P0: the live Instinct demo (all optional fields on top of contract v2)

**1. Who is buying, and through what.** Gateway fills for real buyers; harness passes them.
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
  // Plain text. Price and perks from the structured offer only. Never floor or cost.
  list_price_cents: z.number().int().positive(),
});
```

**3. Accepting returns a summary and an approve link.**
```ts
AcceptDealOutput.extend({
  summary: z.string().max(280), // "Deal locked: KeyForge Quiet 75, $119.00, 2-yr warranty, free shipping. Approve: <url>"
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

**5. Why the seller did what it did** (payload keys on existing events; no new event types):

| Event | New payload keys |
| --- | --- |
| `offer_countered`, `offer_accepted`, `deal_accepted` | `reason` (one sentence), `rule_refs: string[]` (e.g. `"floor"`, `"lever:extended_warranty"`), `product_title`, `lever_package`, `channel`, `agent_operator` |
| `guardrail_blocked` | existing `rule` (+ `severity`) plus `seller_message` (one plain sentence) |
| `question_answered` | `question`, `grounded` |

**Two HTTP routes on the gateway** (not MCP tools):

| Route | Returns |
| --- | --- |
| `GET /deal/:deal_id?t=<token>` | `DealCard` (S2's type, public fields only) |
| `POST /deal/:deal_id/pay?t=<token>` | `PayDealOutput`; amount always from the stored deal |

## P1 and P2 (after the demo)

- **P1, store-wide setup:** `StoreGoal` (`protect_margin` / `balanced` / `move_units`), `SellerRule` (store / collection / product scope), `StorePolicy`, and `resolvePolicy(store, product, unit_cost) => SellerPolicy` so the exchange is untouched. Full shapes in the Claude Doc.
- **P2, after the sale:** `escalated` / `seller_decision` events, `SellerNotification`, `SellerSummary` (weekly). Full shapes in the Claude Doc.

## Open questions

- [ ] Can our Instinct add an MCP connector, or does it only browse? If only browse, we need a plain web version of the tools.
- [ ] Does the approve page charge a Stripe test card for the demo, given Instinct pays with real Link cards?
- [ ] Who redeploys the gateway after these land, and when?
