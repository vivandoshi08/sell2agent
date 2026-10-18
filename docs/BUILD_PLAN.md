# Build Plan

> How the four of us build [FINAL_ARCHITECTURE.md](FINAL_ARCHITECTURE.md). Two pairs work in parallel on separate code, each starting on its riskiest piece against a mock of the other, then the pairs merge at three bridges. Interactive version: `docs/team-plan.html` (the "Team Build Plan" page). Hours are relative to the start (H0); fill in the clock time and the two open names below.

| Role | Pair | Person | Owns |
|---|---|---|---|
| **S1** gateway & deploy | Surface | _open: Ananya or #4_ | `apps/marketplace`, Manufact deploy, catalog seed, discovery files, Inkbox adapter |
| **S2** UI & proof | Surface | Neel | `apps/dashboard`, deal-card widget, wiring `packages/payments`, Armature evals, merchant console |
| **E1** exchange & safety | Engine | Vivan | `apps/seller-mcp/exchange`: state machine, sessions, offers, deals, guardrails, buyer memory, outreach |
| **E2** policy & buyers | Engine | _open: Ananya or #4_ | `apps/seller-mcp/sellers`, `apps/buyer-harness`, bandit and learning |

**Contract owner is a side duty, not a fifth person.** Neel carries it alongside S2: he wrote the contract (`packages/shared`, `supabase/migrations`) and `@sa/payments`, which S2 wires. It is real work only in H0–H1 (freeze the contract with everyone); after that it is frozen and the job is reviewing change requests, e.g. E1 asking for `offer_id`, `final`, `expires_at`. Changes go through Neel.

Start time (H0): _clock time_. Code freeze: H13. Submit: 10:00.

## How the pieces merge into the vision

| Bridge | S1 delivers | S2 delivers | E1 delivers | E2 delivers | Adds up to |
|---|---|---|---|---|---|
| **1 · ChatGPT can buy** (H5) | MCP gateway on Manufact (`search_products` ranked by lever profile, `get_listing`, `ask_question`, `make_offer`, `accept_deal`), keyboard catalog seed with lever menus, connector added in ChatGPT and Claude | Deal card (MCP App): product, included levers, price vs. list, Approve & Pay → `payDeal` (Stripe test) | Exchange: state machine, sessions, offers, deals, protocol rules; E9 guardrails ported; every step to `events` | Seller policy (`static` + `negotiating` price pacing), Claude voice with the true reason, grounded answers | A person in ChatGPT says "quiet keyboard under $150", sellers negotiate safely, they approve, it's paid |
| **2 · We can prove it** (H8) | Discovery files (`/.well-known/ucp`, agent card, server card), publish checklist green | Dashboard on real events: conversion, safe conversion, profit per buyer, margin after levers, buyer fit, time to first offer, live feed, guardrail log | Buyer memory, soft floor, noisy concession steps (E11), payment validator | Simulated buyers (5 lever profiles, walk-aways, adversarial, Claude + GPT), `runAll()` through the deployed gateway | The dashboard shows static vs. negotiating on hundreds of simulated buyers, with zero rule-breaking deals |
| **3 · It learns and follows up** (H12) | Inkbox door: verified seller identity, follow-ups by email / text / A2A, inbound replies | Armature evals (Claude Code + Codex) on the deployed URL; merchant console (lever menus, objectives) | Outreach scheduler + inbound parser | Lever policy (gated) + bandit over lever packages, learning curve, `learned_policy.json` | Sellers learn which levers win which buyers, follow up after a walk-away, and the merchant can tune it all |

**Which part of the vision each person carries:** ask ChatGPT (S1) · sellers tailored to buyer and seller (E2) · never unsafe (E1) · approve and pay (S2 + `@sa/payments`) · proven with numbers (S2 + E2) · learns (E2) · follows up (S1 + E1).

## The five seams (defined in the first hour)

The pairs only touch through these. Everyone builds against a mock of the other side until the matching bridge.

| Seam | Provided by | Used by | Shape | Mock until the bridge |
|---|---|---|---|---|
| **Exchange interface** | E1 | S1 (gateway, later the Inkbox door) | `handle(move) → response` (state, standing offer, allowed actions, reason) | S1 uses a fake exchange |
| **Seller decision** | E2 | E1 | `decide(state, sellerPolicy, buyerProfile) → proposedMove`; `voice(move, reason, prefs) → message` | E1 uses a stub seller that counters at 95% |
| **Payment** | `@sa/payments` (S2 wires it) | S2 (deal card), E1 (deal re-check) | `payDeal(deal) → result` | already built (Neel) |
| **Events** | everyone writes | S2 (dashboard), E2 (learning) | `logEvent(NegotiationEvent)` → Supabase | S2 uses fake `events` rows |
| **Learned policy** | E2 | E2's seller module | `learned_policy.json` (versioned) | `negotiating` until it passes the gate |

## Each person, step by step

Move to the next step only when the "done when" test passes.

### S1 · Gateway & deploy
| Hours | Build | Builds against | Done when |
|---|---|---|---|
| H1–H5 | **Riskiest path first:** ChatGPT → deployed gateway on Manufact → mock exchange → deal card → Stripe test. mcp-use TS server with the tools; forward negotiation tools to the exchange. | mock exchange | In real ChatGPT (and Claude), adding the deployed connector and buying a keyboard against the mock exchange ends in a paid Stripe test PaymentIntent, with no timeouts at 15 s per call |
| H6–H9 | Search ranked by lever profile (filter hard needs, rank by fit, return 3–5); keyboard catalog seed (~4 sellers, lever menus with costs and limits, objective weights); discovery files | real exchange | `search_products` returns 3–5 listings ranked by lever fit; every listing passes the "no private fields" test; `/.well-known/ucp` and the agent card serve |
| H10–H13 | Inkbox door: verified seller identity, outbound follow-ups, inbound replies into the exchange (with E1) | real exchange | An opted-in buyer gets a follow-up email from the verified seller identity; replying "ACCEPT off_…" locks a deal through the exchange |

**Demo moment:** "ChatGPT finds the keyboards."

### S2 · UI & proof
| Hours | Build | Builds against | Done when |
|---|---|---|---|
| H1–H5 | Deal-card MCP App (product, included levers, price vs. list, savings, expiry, Approve & Pay); wire `payDeal`; dashboard skeleton | fake `events` rows | Dashboard renders KPI bars, live feed and guardrail log from fake events; Approve & Pay calls `payDeal` in Stripe test mode |
| H6–H9 | Dashboard and eval-runner UI on real events: static vs. negotiating, buyer fit, which levers win | real events | A run of simulated buyers shows real conversion, safe conversion, profit per buyer, margin and buyer fit, static vs. negotiating, with confidence intervals |
| H10–H13 | Armature evals on the deployed URL; merchant console | deployed gateway | 5 Armature eval cases score ≥4/5 in both Claude Code and Codex; the console edits a lever menu and the next negotiation uses it |

**Demo moments:** the deal card in ChatGPT; the numbers slide.

### E1 · Exchange & safety
| Hours | Build | Builds against | Done when |
|---|---|---|---|
| H1–H5 | **Riskiest logic first:** state machine (OPEN → NEGOTIATING → AGREED → PAID, plus walked-away, follow-up, escalated, expired); sessions, offers, deals in Supabase; protocol rules (round cap, expiry, accept by buyer-bound `offer_id`, idempotency); E9 guardrails ported (input guard, clamp + soft floor, output guard with E11's fixes, circuit breaker); `logEvent` on every step | stub seller (counters at 95%) | A test script runs 30 negotiations including E4's attacks: every state transition valid, 0 deals below floor, 0 floor disclosures, tampered `pay_deal` rejected, accept only by a live buyer-bound `offer_id` |
| H6–H9 | Buyer memory, soft floor, noisy concession steps; payment validator | real seller policy | Restarting a negotiation never gets a better price (E11's bisection test); returning buyers see consistent prices |
| H10–H13 | Outreach scheduler + inbound parser (with S1) | Inkbox door | A walk-away with consent triggers one follow-up within policy; inbound replies parse to a structured move or a clarifying question, never a guess |

**Demo moment:** "the injected SYSTEM line gets blocked."

### E2 · Policy & buyers
| Hours | Build | Builds against | Done when |
|---|---|---|---|
| H1–H5 | `decide()` interface; `static` and `negotiating` (hold list longer, slow concession); Claude voice with the true reason and lever package; grounded `ask_question` answers | scripted buyers | Against 10 scripted buyers: stated price matches code 100%, 0 ungrounded answers, profit per buyer ≥ the static seller |
| H6–H8 | Simulated buyers: 5 lever-profile personas (price-, quality-, speed-, trust-first, balanced), walk-aways, adversarial buyers, Claude + GPT, `runAll(config)` through the deployed gateway | deployed gateway | Buyers run through the deployed gateway; each persona type closes, walks or trades levers as designed, on Claude and one other model family |
| H9–H13 | Lever policy as a gated candidate; bandit over lever packages; `learned_policy.json` | Bridge 2 data | The lever policy ships only if it beats price pacing on lever-profile buyers (E11 warning); the bandit picks per-profile packages from logged outcomes and shows a learning curve |

**Demo moment:** "two sellers behave differently for the same buyer."

## The bridges

| Bridge | When | Done when |
|---|---|---|
| **1 · ChatGPT can buy** | H5 | The mock exchange is swapped for the real one behind the deployed gateway, and real ChatGPT buys a keyboard end to end through the real exchange with a clean guardrail log |
| **2 · We can prove it** | H8 | Simulated buyers run through the deployed gateway and the dashboard shows static vs. negotiating from real events |
| **3 · It learns and follows up** | H12 | Follow-ups, the lever policy and the console plug into the existing seams; the full demo runs twice in a row without a manual fix |
| **Freeze** | H13 | Code freeze; 2-minute demo recorded; README and track write-ups done |

## Collision and idle-time rules

- **Only one shared file set:** the contract (`packages/shared`, `supabase/migrations`), frozen at H1, one owner (Neel, alongside S2).
- **E1 and E2 share `apps/seller-mcp`** but work in separate modules (`exchange/` and `sellers/`), joined only by `decide()`.
- **Nobody waits:** every step builds against a mock (fake exchange, fake events, stub seller, scripted buyers) until the matching bridge.
- **Merge to `main` at each bridge,** in small PRs reviewed by the pair partner.

## First hour (H0–H1), everyone

- [ ] Pull `main`, read [FINAL_ARCHITECTURE.md](FINAL_ARCHITECTURE.md) and this plan.
- [ ] Neel (contract owner) adds the fields the seams need: lever profile on buyer context, lever menu and objective on seller policy, lever package on offers and deals, `final` and `expires_at` on offers, guardrail event types.
- [ ] Each person writes their mock: S1 a fake exchange, S2 fake events, E1 a stub seller, E2 scripted buyers.
- [ ] Booths: Manufact (gateway timeout; is mcp-use expected), Stripe (payment tokens in a sandbox), Armature (switch on evals), Inkbox (quota).
- [ ] Keys in `.env`: Anthropic, OpenAI, Stripe test, Supabase, Manufact login.
