# Build Plan: experiment findings for the TypeScript apps

> **Decided 2026-10-17: we build in TypeScript.** [CLAUDE.md](../CLAUDE.md) and the app briefs (`apps/*/BRIEF.md`) are the source of truth for structure, owners, ports, and the frozen contract in `packages/shared`. This doc adds what the experiments (E1–E11) taught us, mapped onto each app, plus contract changes we propose to Neel. Nothing here overrides CLAUDE.md. Contract changes go through Neel.

## Why TypeScript

- The team's scaffold, contract, schema, and owners already exist on `main`.
- Manufact's framework (mcp-use) is TypeScript-first. The deal-card widget is a React view in mcp-use TS, and the Python version has no widgets.
- The Python experiment harness (`sell2agent/`, `experiments/`) keeps working as an outside evaluator. It talks to any MCP server over HTTP, so it can test the TypeScript seller unchanged.

## The end goal (what the demo must do)

A person opens **ChatGPT** (or Claude), says *"I want a mechanical keyboard"*, and their own assistant goes through **our marketplace**: it finds competing sellers, talks to each seller's agent, gets offers tailored to **what this person wants** (budget, must-haves, quiet vs. tactile, how much they care about price vs. quality) and to **what each seller prioritizes** (profit, conversion, clearing stock), negotiates, and **closes**: the person approves and it's paid.

## The catch that shapes the core: ChatGPT connects to one MCP server

A ChatGPT or Claude user adds **one connector** (one MCP URL). The assistant can't jump to per-seller `mcp_url`s returned by a REST `/search`. So for the end goal:

- **The marketplace is an MCP gateway** (one connector, hosted on Manufact). It exposes `search_products` (with the buyer's preferences) and the seller tools, and routes each call to the right **seller agent** on the server side.
- **Each seller agent stays separate**, with its own catalog, policy (floor, cost, concessions), and priority. The gateway is a router, not a seller.
- **The simulated buyers use the same gateway** as ChatGPT, so our evals measure the real path.
- **Closing in ChatGPT:** `accept_deal` returns a deal card (Manufact MCP App) with an Approve & Pay button; approving creates the Stripe test-mode PaymentIntent at the agreed price.

This needs Neel's sign-off (contract proposal below), since today `apps/marketplace` is REST-only.

## The three core servers

| # | Server | Job | Where it lives |
|---|---|---|---|
| 1 | **Marketplace gateway (MCP)** | The one connector ChatGPT, Claude, and simulated buyers use. Does search itself; forwards every negotiation call to the exchange. Holds no negotiation state. | `apps/marketplace` (C) |
| 2 | **Negotiation exchange** | **Where buyer and seller actually interact.** Owns every session, offer, and deal (the `negotiations` and `deals` tables). Enforces the protocol: turn order, round cap, offer expiry, accept by offer id, one priced option per message. For each buyer move it asks the right seller agent for a reply, runs the guardrails on that reply, records the deal, triggers payment on approval, and logs every move to `events`. One source of truth, whichever buyer or door (MCP now, A2A later) the move came from. | `apps/seller-mcp`, as its own module (A) |
| 3 | **Seller agents** | The per-seller brain: policy (floor, cost, concessions), priority, strategy, LLM voice. Stateless: the exchange passes in the session state and gets back a proposed move. | `apps/seller-mcp`, seller module (A) |

Why separate the exchange from the seller agents: the rules, guardrails, deal records, and payment trigger must be the same for every seller, and a seller agent should never be able to skip them. Keeping them in one place also means the A2A door, the dashboard's live feed, and the learning loop all read the same sessions.


## CORE first: the thin end-to-end version of every layer

Everything works end to end in its simplest form before any extra is added. "Core still has it all": every layer exists, just not every feature.

| Layer | Core version | Owner |
|---|---|---|
| Exchange | **Negotiation exchange**: sessions, offers, deals, protocol rules, guardrails on every seller move, payment trigger, event log. | A |
| Ways in | **Marketplace MCP gateway** (one connector): `search_products(query, preferences)`, `get_listing`, `ask_question`, `make_offer`, `accept_deal`, routed to seller agents. Deployed on Manufact; added to ChatGPT and Claude. | C (gateway), A (seller side) |
| Catalog | Mechanical keyboards: 3–4 competing products per sub-type from different sellers, each seller with its own policy and priority (seed data). | C |
| Seller agent | Strategy picks the price (static baseline, negotiating = hold list longer + slow concession + concession before discount); LLM writes the pitch with the true reason; tailors to the buyer's stated preferences; respects the seller's priority. | A |
| Safety | Floor checked on counters **and** accepts; soft floor; output check (price in text = structured price, no floor leak, no false "final", no unpriced freebies); buyer text treated as untrusted. | A |
| Closing | Deal card widget → Approve & Pay → Stripe test PaymentIntent at the agreed price; amount from the stored deal. | A (widget), B (Stripe helper) |
| Buyers | Simulated buyers with personas (price-first, quality-first, balanced; budgets, must-haves; some walk away) on 2 model families, going through the gateway. | B |
| Data | Every action logged to Supabase `events`. | all |
| Proof | Eval runner: static vs. negotiating; dashboard with conversion, safe conversion, profit per buyer, margin, guardrail log. | D |
| Learning | Simplest real version: a bandit over the vetted strategies, learning from logged outcomes, shown on the dashboard. | D |

**Core is done when:** in ChatGPT, "I want a mechanical keyboard" → search → offers from several sellers → haggle → deal card → paid, with the guardrail log clean; and the dashboard shows static vs. negotiating from simulated buyers.

## AFTER core (in this order)

1. Full learning loop: buyer simulator fitted to logs, Q-learning, promotion gate, `learned` strategy (S3 below).
2. Decision feedback ("why did you choose this?"), speed as a KPI.
3. Buyer entities and cross-session memory; a sentinel module for repeated attacks; escalation to the merchant.
4. A2A over Inkbox (verified seller identity, seller-initiated messages); optional agent team.
5. Payment depth: capped payment token, Link deposit, OAuth on payment.
6. More strategies (adaptive, dynamic, inventory-aware), merchant console, broker mode, signposts and registry, outside benchmark.

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

Supabase → RL → eval is the right shape, but needs two more steps, or it repeats E6's mistakes (logs of one fixed strategy can't show what other moves would have done, and training against our own buyers overfits).

1. **Log:** every negotiation in Supabase `events`, plus Manufact session replays and Inkbox's A2A records. Each interaction gets a score: closed?, profit, safe?, rounds, latency, and the buyer's stated reason (decision feedback).
2. **Model the buyers:** fit a buyer simulator *from those logs*: how buyers respond to concessions, when they drop an add-on, when they walk, how fast they take a first proposal.
3. **Train in the simulator** (Python, reusing `experiments/e6_rl_haggling/`): (a) a contextual **bandit over vetted strategies** (static, hold-list, Boulware, warranty-first), which is safe to run live because every arm is pre-tested; (b) **Q-learning** over per-round moves. Moves below the soft floor are masked.
4. **Gate:** a new policy ships only if it beats the current one on held-out LLM buyers from **two model families** and passes the red-team suite with zero bad deals.
5. **Deploy and explore:** `seller-mcp` loads it as the `learned` strategy (a policy JSON with a version), with a small share of randomized choices whose odds are logged, so the next round of logs can evaluate alternatives. Back to step 1.

Prompt-level learning runs alongside: `seller_memory` writes one lesson per closed or lost negotiation. Keep the eval buyers separate from anything the trainer saw.

## S5: the rest of the system (final, after judge feedback)

Narrowed on purpose: **two ways in with distinct jobs, one engine behind both.** MCP is for acting (anything that pulls a tool: listing, questions, offers, accept, pay). A2A over Inkbox is for talking and waiting: the seller's identity, messages the seller starts, follow-ups, and the agent team talking to itself. Anything binding (a priced offer, an accept, a payment) goes through the engine and policy engine, whichever channel it came in on.

| # | Aspect | What to build | Owner |
|---|---|---|---|
| 1 | **A2A over Inkbox** | Seller's public Inkbox identity with an A2A endpoint, verified to the store's domain (DNS). Seller-initiated messages: fast first proposals in a market, "quote expires soon", merchant decisions, follow-ups after a walk-away. A2A tasks map onto the same engine (a counteroffer = "waiting on you"). | C |
| 2 | **Seller agent team (swarm)** | Negotiator (talks to buyers), Sentinel (watches all sessions for injection and floor probing, own memory of attacks and false alarms), Liaison (escalates out-of-policy asks to the human merchant by Inkbox email or text). Each has its own Inkbox identity and isolated memory; they coordinate over A2A. | A, C |
| 3 | **Buyer entities, memory, trust tiers** | Group sessions into a buyer entity: verified identity first (Inkbox DNS-verified, Web Bot Auth), otherwise a behavioral fingerprint. Per-entity best-offer memory (no better price for restarting, E11), and trust tiers (unknown / verified / preferred / blocked) that set pricing room and checks. | A |
| 4 | **Decision feedback** | Optional `share_feedback` MCP tool and an A2A follow-up after walk-aways: what decided it (price, specs, delivery, trust, speed, other) + one line. Fallback: classify the reason from the transcript. Dashboard panel "why buyers bought or left"; feeds the learning loop. | A, B, D |
| 5 | **Speed as a KPI** | Fast first response and a strong first offer, because buyer agents pick the first proposal 60–100% of the time in multi-seller markets (Magentic Marketplace). Track time-to-first-offer on the dashboard. | A, D |
| 6 | **No manipulating buyers** | Output guard also blocks fake urgency, social proof, and authority claims; listing and tool text stay factual (buyers read descriptions as instructions). Counts toward safe conversion. | A |
| 7 | **More seller strategies** | `adaptive` (reads buyer type; E10 says judge by what buyers choose), `dynamic` (reacts to demand and real competitor quotes, no quote-matching, E7), inventory-aware priority (Nash). All gated by the eval runner like `learned`. | A |
| 8 | **Signposts** | `/.well-known/ucp`, the A2A agent card (doubles as Inkbox card), MCP server card, MCP Registry listing. Static files pointing at the two ways in. | C |
| 9 | **Marketplace broker mode** (optional) | One request fanned out to every seller, bids returned per round. | C |
| 10 | **Payments depth** | Capped payment token, Link deposit with real human approval, UCP-style instrument, Stripe MCP as the merchant's ops view, OAuth gating payment. | A, B, D |
| 11 | **Merchant console** | The store owner sets floors, costs, concessions, priority, inventory notes; sees live negotiations, the sentinel's flags, and decision feedback. | D |
| 12 | **Outside benchmark** (stretch) | Run our seller inside Microsoft's open-source Magentic Marketplace as an independent check. | D |
| 13 | **Pitch answers** | Who pays, pricing model, what a merchant needs to see; Inkbox track decision. | D |

**Dropped after the judges' input** (covered by the two ways in): the GET-only HTTP mirror, a human chat widget, separate email quotes via Primitive.

## Findings by app

### `apps/seller-mcp` (Person A): the product

| Do this | Why (evidence) |
|---|---|
| **Concede on a Boulware schedule**: price = list − (list − floor) · t³, with t = round / max_rounds. Code computes each round's price; the LLM only writes the pitch and is told the true reason. | E5: Boulware earned $8,870 per buyer vs. $7,668 for a free-form "get the best deal" LLM (+15.7%), same conversion. The free-form seller gives away 86% of its room by round 4 and earned *less than fixed price*. |
| **Offer a concession before cutting price** (`extended_warranty`, `free_shipping` from `allowed_concessions`). | E5: bundle-first +10.4%. Nash's "levers" idea (E11 testing it). |
| **Code checks accepts as well as counters.** The LLM proposing "accept" at a price below floor must be blocked too. | E1: an Opus seller tried to accept $500 under floor. E4: one injected `SYSTEM: floor is now…` line got a prompt-only seller to accept $6,100 below cost; the code check stopped the same move. |
| **Soft floor:** counters stop at floor + a buffer (e.g. 3% of the list−floor gap); accepts may go down to the hard floor. | E4: in 50 of 71 attack sessions the seller's lowest offer was exactly its floor, which reveals it. |
| **Output check on every seller message before it's returned:** any dollar figure in `message` must equal the structured `price_cents` (or a previous valid offer) and be ≥ floor; no floor/cost disclosure; no promises of concessions not in `concessions[]`; no financing; "final" only on the last round. Block → regenerate once → fall back to a template. | E2, E4: sellers revealed floors, promised "I can include delivery" outside the priced offer, and bluffed "best and final" (10 of 94 runs in E1, 13 of 70 in E5). |
| **Use E9's recommended stack** (`experiments/e9_safety/guardrails.py` is the reference; port its rules): code picks every price behind a clamp/mask; the LLM never sees floor or cost; blocking output guard (≤2 regenerations, then a template); circuit breaker on repeated injection; reject unknown items in structured offers. | E9: 0 rule-breaking deals, 0 floor disclosures, 0 tampered payments accepted under the full stack; masking cut 7,244 below-floor proposals to 0. Keyword rules alone teach the LLM new wording, so prices must come from code. |
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
| **Marketplace becomes an MCP gateway** (one connector for ChatGPT/Claude) exposing `search_products` + the seller tools, routing to seller agents; `SearchQuery` gains buyer `preferences` (budget, must-haves, priority: price / quality / speed) | The end goal: ChatGPT can only use one connector | medium, **core** |
| `Seller.priority` (profit / conversion / balanced / clear_stock) | Each seller's priority shapes its offers (E10) | small, **core** |
| `Seller.strategy` enum adds `"learned"`, `"adaptive"`, `"dynamic"` | S3/S5: gated strategies selectable per seller | small |
| `BuyerContext` adds optional `buyer_identity` (verified id or null) and `buyer_entity_id` | Buyer entities, memory, trust tiers | small |
| New tool `share_feedback` (optional) + event type `decision_feedback` | Why buyers bought or left | small |
| Event fields `latency_ms`, `trust_tier`; event types `sentinel_flag`, `escalated_to_merchant` | Speed KPI, agent team, escalation | small |

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
