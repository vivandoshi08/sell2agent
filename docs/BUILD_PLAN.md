# Build Plan: experiment findings for the TypeScript apps

> **Decided 2026-10-17: we build in TypeScript.** [CLAUDE.md](../CLAUDE.md) and the app briefs (`apps/*/BRIEF.md`) are the source of truth for structure, owners, ports, and the frozen contract in `packages/shared`. This doc adds what the experiments (E1–E11) taught us, mapped onto each app, plus contract changes we propose to Neel. Nothing here overrides CLAUDE.md. Contract changes go through Neel.

## Why TypeScript

- The team's scaffold, contract, schema, and owners already exist on `main`.
- Manufact's framework (mcp-use) is TypeScript-first. The deal-card widget is a React view in mcp-use TS, and the Python version has no widgets.
- The Python experiment harness (`sales_agent/`, `experiments/`) keeps working as an outside evaluator. It talks to any MCP server over HTTP, so it can test the TypeScript seller unchanged.

## Stages: everything ships, in this order

Everything we've discussed is in scope for the hackathon. These stages set the order, so the most important thing works first and each stage builds on the last. Times line up with CLAUDE.md's checkpoints.

| Stage | By | What works at the end | Who |
|---|---|---|---|
| **S1. Core loop** | ~20:30 (CLAUDE.md checkpoint) | One real buyer: search → negotiate with the fixed negotiating policy (hold list, slow concession, warranty first) → code guardrails → Stripe test payment, all logged to `events` | A, B, C, D on mocks, then real |
| **S2. Proof** | ~01:00 | Eval runner: static vs. negotiating at scale, several buyer models, buyers that drop add-ons and walk away. Dashboard with KPIs and the guardrail log. Seller deployed on Manufact; Armature evals against the URL | D, B, A |
| **S3. Learning loop (RL)** | ~04:00 | The seller learns from its own logged negotiations. See "The learning loop" below | A + coordinator |
| **S4. Depth** | ~05:30 | Payment token capped at the deal total (Stripe), deal-card widget (Manufact MCP App), E11 features (levers before discounts, claims library, cross-session memory), seller priority as config (E10) | A, B, C |
| **S5. Every other aspect** | ~06:45 | Everything else we discussed, listed below with owners. Built in the listed order; each item is small on its own. | all |
| **S6. Freeze and demo** | 07:00 → 09:00 | Code freeze, rehearsal, 2-minute video, submission | everyone |

## The learning loop (S3)

E6 showed what the learning loop needs to work, so S3 builds it with those fixes in place.

1. **Data:** every negotiation in `events` (offers, counters, accepts, walk-aways, final price) plus Manufact session replays. S1 and S2 produce this for free.
2. **Simulator upgrade first:** scripted buyers that drop add-ons, change quantity, and walk away from stubborn sellers. E6 found LLM buyers do this in 36% of sessions, and the old simulator couldn't, which is why its policy didn't transfer.
3. **Train (Python, reusing `experiments/e6_rl_haggling/`):** start with a bandit over whole strategies (static, Boulware, hold-list, warranty-first); E6's bandit matched the best fixed strategy within ~30k episodes. Then tabular Q-learning over per-round moves (hold, concede 5/15/35% of the gap, add a concession, final offer, accept). Reward: profit on a deal, 0 on a walk-away, a penalty below that for any move the guardrails would block.
4. **Safety:** actions are masked so the policy can't pick a price below the soft floor; the code guardrails still check every move.
5. **Ship it as a seller strategy:** export the learned policy as JSON; `seller-mcp` loads it as a third strategy, `learned`, next to `static` and `negotiating`.
6. **Prove it:** the eval runner adds a `learned` arm on the dashboard, against at least two buyer model families. E6 showed results can flip between models.
7. **Prompt-level learning alongside:** `seller_memory` (already a stretch in the seller brief) writes one insight per closed or lost negotiation and feeds recent ones back into the prompt. Watch for overfitting to our own buyer generator (E6 phase 3 did).

## S5: every other aspect we discussed

Nothing discussed is dropped. These were marked "out of the build", "stretch" or "roadmap" earlier; they're back, in priority order. Experiment notes say how to build each one well.

| # | Aspect | What to build | Owner | Notes from experiments and research |
|---|---|---|---|---|
| 1 | **Marketplace broker mode** (Inkbox-style) | Marketplace sends one buyer request to every seller and returns their bids each round; buyer counters through it | C | E7: broker cut prices ~1 point and buyers ran bidding wars. Show it as a buyer-friendly mode next to direct |
| 2 | **Dynamic pricing seller** | A seller strategy whose price reacts to demand, inventory, and competitor quotes it actually sees (never invented) | A | E7: lost to the plain negotiator because "beat any quote by $100" got exploited. Build it without quote-matching |
| 3 | **Adaptive seller** (reads buyer type) | Infers price-first / quality-first / balanced and switches tactics; selectable strategy `adaptive` | A | E10: lost $707/session vs. the profit stance; misread balanced buyers. Judge by what buyers choose, not whether they haggle |
| 4 | **Inventory-aware priority** (Nash `inventory_note`) | Per-product priority from stock: overstocked items concede more, never break needs-fit | A, C | Extends E10's priority dial |
| 5 | **Per-buyer listing** (dynamic interface) | `get_listing` emphasizes what this buyer asked about and has been offered | A | North star point 5; B7 |
| 6 | **A2A protocol endpoint** | An A2A agent card plus an A2A endpoint that maps tasks onto the same negotiation engine (counteroffer = `input_required`) | C, A | E8: no shopping agent reads A2A cards yet, but the whiteboard had A2A. Inkbox gives hosted A2A identities and a directory |
| 7 | **Discovery files** | `/.well-known/ucp`, agent card, `llms.txt`, `agents.md`, MCP server card, a `nash.v1`-compatible `negotiate.json` | C | E8: UCP is the live standard. Nash insight 7 |
| 8 | **GET-first HTTP mirror** (Nash) | Plain HTTP endpoints with a `next` link for agents that can only web-fetch | A | Nash insight 5 |
| 9 | **OAuth on the seller** | Resource-server OAuth gating `accept_deal` / payment (mcp-use TS has OAuth providers) | A | Manufact guide §3; Claude directory wants it for listing |
| 10 | **Full UCP / ACP checkout tools** | Accept a UCP-style payment instrument; optionally ACP's 5 checkout tools | A, B | Stripe guide §3 |
| 11 | **Real human approval via Link wallet** | Link spend-request for a ≤$500 deposit that locks the negotiated price | B | Stripe guide §2: Link caps $500 per request |
| 12 | **Stripe MCP as the merchant's ops view** | "List today's agent payments" through mcp.stripe.com in the demo | D | Stripe guide §5 |
| 13 | **Merchant escalation channel** | Out-of-policy asks (financing, big discounts) go to the human merchant by email (Primitive) or text (Inkbox) instead of the agent agreeing | A | Guardrail "escalate to a human" (E9) |
| 14 | **Async quotes by email** | Buyer can request a written quote; seller replies with a PDF quote | C | Primitive idea; B2B-style tractors / bulk orders |
| 15 | **Human-facing chat channel** | Same seller agent in a chat widget for human shoppers | D | Nash insight 8: one agent, two channels |
| 16 | **Armature analytics SDK** | Judged sessions on the live server, if the SDK supports mcp-use; A/B it against no SDK | A | Armature guide; telemetry field changes the tool surface |
| 17 | **Business answers for the pitch** | Who pays, pricing model (share of uplift / per transaction / subscription), what a merchant needs to see before turning it on | D | The "Parked" list in OPEN_QUESTIONS.md |

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
| `Seller.strategy` enum adds `"learned"` | S3: the learned policy ships as a selectable seller strategy | small |

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
