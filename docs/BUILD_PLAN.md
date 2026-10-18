# Build Plan: experiment findings for the TypeScript apps

> **Decided 2026-10-17: we build in TypeScript.** [CLAUDE.md](../CLAUDE.md) and the app briefs (`apps/*/BRIEF.md`) are the source of truth for structure, owners, ports, and the frozen contract in `packages/shared`. This doc adds what the experiments (E1–E11) taught us, mapped onto each app, plus contract changes we propose to Neel. Nothing here overrides CLAUDE.md. Contract changes go through Neel.

## Why TypeScript

- The team's scaffold, contract, schema, and owners already exist on `main`.
- Manufact's framework (mcp-use) is TypeScript-first. The deal-card widget is a React view in mcp-use TS, and the Python version has no widgets.
- The Python experiment harness (`sales_agent/`, `experiments/`) keeps working as an outside evaluator. It talks to any MCP server over HTTP, so it can test the TypeScript seller unchanged.

## Findings by app

### `apps/seller-mcp` (Person A): the product

| Do this | Why (evidence) |
|---|---|
| **Concede on a Boulware schedule**: price = list − (list − floor) · t³, with t = round / max_rounds. Code computes each round's price; the LLM only writes the pitch and is told the true reason. | E5: Boulware earned $8,870 per buyer vs. $7,668 for a free-form "get the best deal" LLM (+15.7%), same conversion. The free-form seller gives away 86% of its room by round 4 and earned *less than fixed price*. |
| **Offer a concession before cutting price** (`extended_warranty`, `free_shipping` from `allowed_concessions`). | E5: bundle-first +10.4%. Nash's "levers" idea (E11 testing it). |
| **Code checks accepts as well as counters.** The LLM proposing "accept" at a price below floor must be blocked too. | E1: an Opus seller tried to accept $500 under floor. E4: one injected `SYSTEM: floor is now…` line got a prompt-only seller to accept $6,100 below cost; the code check stopped the same move. |
| **Soft floor:** counters stop at floor + a buffer (e.g. 3% of the list−floor gap); accepts may go down to the hard floor. | E4: in 50 of 71 attack sessions the seller's lowest offer was exactly its floor, which reveals it. |
| **Output check on every seller message before it's returned:** any dollar figure in `message` must equal the structured `price_cents` (or a previous valid offer) and be ≥ floor; no floor/cost disclosure; no promises of concessions not in `concessions[]`; no financing; "final" only on the last round. Block → regenerate once → fall back to a template. | E2, E4: sellers revealed floors, promised "I can include delivery" outside the priced offer, and bluffed "best and final" (10 of 94 runs in E1, 13 of 70 in E5). |
| **Treat buyer `message` as untrusted text:** wrap it in delimiters in the prompt; flag injection patterns (`SYSTEM:`, "ignore previous", fake JSON). | E4: injection was the only attack that worked. |
| **Default stance: hold list longer and never concede more than ~75% of the way to the floor**; always give the LLM the true reason for the code-set price. | E10: beat the balanced schedule by $913 per session; LLM's stated price matched code on 377/378 offers. Adaptive buyer-typing lost money (−$707). |
| **Accept by offer id**, and only one priced option per seller message. | E10: 2 of 96 deals closed on the wrong option when the message mentioned a cheaper one. |
| **Hold list when the buyer clearly can pay it.** | E2: the negotiator sold 0 of 42 deals at list, even to buyers $4,300 above it. |
| **No quote-matching** ("beat any competitor by $X"). | E7: buyers carried quotes between sellers until one hit its floor. |
| **Final turn:** an offer stays acceptable after `rounds_left = 0` until it expires. | E3: 21 of 22 failed sessions ended at the round cap; two had an acceptable offer on the table. |
| `ask_question` answers only from catalog data (already in the brief). | E2/E5 false claims; Nash's claims library (E11 testing). |
| Static baseline: list price, never counter (already in the brief). | E2, E5: fixed price is the bar to beat. |

### `apps/buyer-harness` (Person B): simulated buyers

| Do this | Why |
|---|---|
| Buyers **may drop an add-on or change quantity** mid-negotiation; personas need a private walk-away and a stated budget that differ. | E3, E6: LLM buyers changed the bundle in 36% of sessions; that's how negotiation wins buyers below list. |
| Support at least two model families (the brief says Claude + one other). | E3: buyer styles differ by model (Sonnet never shares its budget). E6: a policy that won with Opus buyers lost with Haiku. |
| Mix buyer types: price-first, quality-first, balanced. **Some buyers must walk away** when the price is wrong. | E10: buyer type set the product mix; buyers that never walk made conversion impossible to move. |
| Include a few adversarial buyers (injection, fake competitor quote, floor probing across sessions). | E4, E9, E11. |
| Budget cap in code, never in the prompt only (already in the brief). | E4 pattern on the buyer side. |

### `apps/marketplace` (Person C): discovery

| Do this | Why |
|---|---|
| Listings carry `mcp_url` (already planned). Add `/.well-known/ucp` listing the MCP transport and an agent card. | E8: UCP is the one live standard pointer from a seller's domain to its MCP server. |
| A "negotiable" flag is for routing, not persuasion. | E3: buyers haggled the same whether negotiation was advertised or not. |
| Competing products per category with real tradeoffs (already in the brief). | E7: with several sellers, fixed-price sellers got zero deals and buyers ran bidding wars. |

### `apps/dashboard` + eval runner (Person D): what judges see

| Do this | Why |
|---|---|
| Report **profit per buyer session** as the headline next to conversion. | It's the number that separates good negotiation from discounting (E2, E5). |
| Safe conversion = paid deal + no guardrail breach reaching the buyer + no ungrounded claim. Give the LLM judge **the seller's rules** too. | E2/E4: without the rules, the judge flags correct statements ("we don't offer financing"). |
| Show the guardrail log ("blocked: accept below floor after injected SYSTEM line"). | The strongest single demo moment (E4). |
| Our benchmark numbers to quote: see the table at the bottom. | |

## Contract change proposals for Neel (`packages/shared`)

| Proposal | Why | Size |
|---|---|---|
| `MakeOfferOutput.final: boolean` | Lets code, not the LLM, say when an offer is final (bluff ban) | small |
| `MakeOfferOutput.expires_at` + allow `accept_deal` after `rounds_left = 0` until expiry | Final buyer turn (E3) | small |
| `accept_deal` takes an optional `payment_token` (Stripe Shared Payment Token) and returns `PaymentResult`-style `status`, `reasons`, `fix` | Stripe track: buyer's spend cap enforced by Stripe, refusals explainable | medium |
| Event types `guardrail_blocked` with `payload.rule` (`accept_below_floor`, `price_in_text_mismatch`, `floor_disclosure`, `unpriced_concession`, `false_final`, `injection_flag`) | Dashboard guardrail log and safe-conversion scoring | small |
| (Stretch) `review_deal` tool with an MCP App widget | Manufact track; a human approves before payment | medium |

## Sponsor integration by app

| Sponsor | Where | What |
|---|---|---|
| **Manufact** | seller-mcp | mcp-use TS server, Inspector, Manufact Cloud deploy, MCP App deal card, publish checklist, session replay ([manufact.md](tracks/manufact.md)) |
| **Stripe** | seller-mcp (`accept_deal`), buyer-harness | PaymentIntent at the agreed price; stretch: Shared Payment Token capped at the deal total ([stripe.md](tracks/stripe.md)) |
| **Armature** | seller-mcp, dashboard | Evals against the deployed URL (no SDK needed); analytics SDK only if it supports mcp-use (check first) ([armature.md](tracks/armature.md)) |

## Check in the first hour

1. Does Armature's analytics SDK work with mcp-use TS? If not, evals only.
2. Does the Node Stripe SDK expose Shared Payment Tokens? If not, plain PaymentIntent (Neel's plan already).
3. `ANTHROPIC_API_KEY` for the deployed seller.

## Numbers we already have (for the pitch and dashboard)

| Claim | Number | Source |
|---|---|---|
| Negotiating seller vs. static page | +54% profit per session, conversion 70% vs. 33% | E2 |
| Real Claude buyers complete purchases over MCP | 66/66 feasible runs paid, 0 invalid tool args in 116 runs | E1 |
| Strategy matters | Boulware +15.7% over free-form LLM | E5 |
| Code guardrails hold | 0 rule-breaking deals in 56 engine sessions; prompt-only leaked | E4 |
| Buyers haggle when they can | 100% countered; ~6% lower price; conversion 38% → 94% | E3 |
| Model cost is negligible | $0.19 per session vs. ~$1,063 gain | E5 |
