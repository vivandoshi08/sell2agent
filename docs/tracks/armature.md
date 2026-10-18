# Armature track: Best Agent Experience (AX)

> Submission write-up. Track brief: "Agents can use your product through a dedicated Agent-Facing Interface (MCP, CLI). Build the best experience for them!" Pre-build plan and Armature research: [docs/archive/tracks/armature-guide.md](../archive/tracks/armature-guide.md) · eval environment setup: [armature-setup.md](armature-setup.md).

## What we built

**A storefront designed for the buyer's agent as the customer**, and a way to measure how well it treats that customer. The product is an MCP server (`https://dark-zero-mesv5.run.mcp-use.com/mcp`) where an agent finds a product, asks real questions, negotiates a price and pays. Agent experience is the thesis, not a layer on top: static pages make agents guess, can't answer questions, offer one take-it-or-leave-it price and block them at checkout.

Choices we made for the agent, and the failure of a real agent behind each one:

| What an agent hit | What we changed |
|---|---|
| In an Armature eval, the first counter was already **final** ($112), so the tester could not haggle. Testers send no user id, so they all shared one "anonymous" memory per product, which earlier traffic had frozen | Memory is now per exact `buyer_id`; anonymous memory expires after 30 minutes; a reset script clears it; responses echo `buyer_id` so the agent sends it back; a first `make_offer` without an id mints one, any later call without it gets a `missing_buyer_id` error that says what to do. Both testers pass after the fix |
| ChatGPT answered "did we buy it?" with "no payment was made" right after a card payment | `check_offers` reports `PAID`, and the server instructions say a paid deal is a finished purchase and not to start a second negotiation. A recheck on production passed: 5 rounds, paid, then "i paid" made ChatGPT confirm through `check_offers` and not renegotiate |
| A retried payment is a classic agent mistake (timeouts, double-clicks) | `pay_deal` is idempotent: a retry returns `already_paid` with the original PaymentIntent. An Armature case checks it against a real Stripe test charge |
| A question the catalog can't answer invites a confident guess | `ask_question` answers only from catalog data and says it doesn't know (`grounded: false`). An Armature case checks the agent reports "the seller doesn't know" |
| Text-only agents (a messaging agent, "Instinct") can't render a card | Every offer and deal carries a one-line `summary` the agent can relay verbatim, and a locked deal returns a signed approve link |
| Errors that say "failed" waste turns | Refusals are normal results with `code`, `reasons` and a `fix`; exchange errors are codes (`stale_offer`, `offer_expired`, `round_cap`, `wrong_buyer`, …) |
| Long result lists make agents worse (Microsoft's Magentic Marketplace paper: Sonnet-4 lost 65% of buyer value going from 3 to 100 results) | `search_products` ranks by the buyer's stated lever profile and returns at most 5 |
| Listing text is read as instructions, and weaker models can be manipulated | Listing text is factual, with no instructions or hype; about 10% of our simulated buyers are red-team buyers (an injected `SYSTEM:` line, a fake competitor quote, floor probing) and the injected line is blocked at the input |

Also: nine tools with titles and read-only / destructive hints, in one fixed flow; `/.well-known/ucp`, an MCP server card and an OpenRPC file generated from the live `tools/list`; no signup to browse or negotiate (the only gate is a signed deal and a person's approval at the end).

## Evidence

**Armature evals, against the deployed gateway, 7 cases on 2 testers (all pass).** Run in Armature workspace `acommerce`, Sun Oct 18 12:35–12:58 am PT. Testers: Claude Code (Claude Sonnet 5) and Codex (GPT-5.6 Terra). A separate judge scores each run 0–5; 4–5 is Passed.

| Case | Claude Code | Codex |
|---|---|---|
| find-by-need | Passed | Passed |
| negotiate-and-accept-under-budget | Passed | Passed |
| infeasible-budget | Passed | Passed |
| read-state-without-changes | Passed | Passed |
| pay-retry-is-safe (real Stripe test charge, retry not charged again) | Passed | Passed |
| unanswerable-question | Passed (re-run) | Passed |
| recover-from-stale-offer | Passed (re-run) | Passed (re-run) |

Three of the 14 passes came on a re-run. Both causes are explained in [RESULTS.md](../../apps/dashboard/evals/armature/RESULTS.md): the frozen anonymous memory above (fixed by `anon:reset --all`, which is why we reset before every demo), and one judge run that returned no verdict although the agent answered correctly. Cases and criteria: [cases.json](../../apps/dashboard/evals/armature/cases.json).

**Agents succeed at scale, cheaply.**
- 100 Claude Haiku buyers per policy ran 200 negotiations through the production URL; the negotiating seller closed 64% of them (41% for a static listing) with 0 unsafe deals ([results](../results/bridge2-deployed/README.md)).
- Buyer cost for all 200: about **$0.43** (3.0M input and 244K output tokens on Haiku 5.5).
- Calls take about 3 s with the Claude seller voice writing every message.
- 100 Claude Sonnet buyers per policy (200 negotiations, in-process): 83% vs. 49% bought, $47.55 vs. $31.61 per buyer ([results](../results/bridge2/README.md)).

**Real agents, no hand-holding.** Real ChatGPT haggled a $129 keyboard to $110 and paid in the deal card ($110, Stripe test). Real Claude, given only the connector, bought end to end in 33 s: search, offer, counter, accept, review, pay (E1 log, "Bridge 1 validation", branch `e1/live-log`).

**Why an agent interface beats a page (pre-build experiments, Python harness, tractor catalog).**
- On the same 30 buyers a negotiating agent converted **70% vs. 33%** for a static product page and earned +54% profit per session ([E2](../../experiments/e2_static_vs_agent/README.md)). Format alone (HTML vs. a JSON feed) didn't change the buy rate.
- Over MCP, every buyer that could afford a deal completed a paid checkout (66/66) and every buyer that couldn't declined (26/26), with zero rule-breaking deals ([E1](../../experiments/e1_e2e_mcp/README.md)).

## Limits

- **We did not instrument the deployed gateway with Armature's MCP Analytics SDK.** `apps/seller-mcp/src/analytics.ts` wraps it (a no-op without a key), but the gateway is an `mcp-use` server, and the SDK's supported-server list (as of our Oct 17 research) did not include `mcp-use`. Our use of Armature is the evals, which are framework-agnostic.
- **We did not run a cold-start test** (an agent given only a domain). The discovery files exist, but we have not measured an agent finding them unaided; ChatGPT and Claude were given the connector URL.
- **Judge and tester variance.** Two cases needed a re-run (above). The anonymous-memory freeze can come back for any client without a user id until memory expires, so reset before demos.
- The pre-build experiments ran on a different catalog (tractors) and a Python harness; the build numbers above are on the keyboard catalog.

## Links

- Server: `https://dark-zero-mesv5.run.mcp-use.com/mcp` · code: [apps/marketplace](../../apps/marketplace/), [apps/seller-mcp](../../apps/seller-mcp/)
- Eval cases and results: [apps/dashboard/evals/armature](../../apps/dashboard/evals/armature/) · pre-check script: `npx -y pnpm@9.12.0 --filter @sa/dashboard armature:dryrun`
- Architecture: [docs/FINAL_ARCHITECTURE.md §9](../FINAL_ARCHITECTURE.md) · demo: [docs/DEMO.md](../DEMO.md)
