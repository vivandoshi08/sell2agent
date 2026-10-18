# Manufact track: Best MCP Server for Agents

> Submission write-up. Track brief: "Best MCP server built for agents as the primary customer." Pre-build plan (Python, superseded): [docs/archive/tracks/manufact-guide.md](../archive/tracks/manufact-guide.md).

## What we built

**A storefront whose customer is the buyer's agent.** The server is a seller marketplace: a buyer agent searches four competing keyboard sellers, asks questions, negotiates a price with each seller's own agent, locks a deal, and pays, all through nine MCP tools. A person is only in the loop at the end, to press Approve & Pay.

- **Live:** `https://dark-zero-mesv5.run.mcp-use.com/mcp`. Streamable HTTP, public, no auth (a storefront should be open like a website; money is gated by a signed deal and a human approval, not by a login).
- **Built on mcp-use, hosted on Manufact Cloud.** `apps/marketplace` is an `mcp-use` 2.10.1 `MCPServer` (TypeScript, stateless HTTP), deployed from a Dockerfile with `mcp-use deploy --no-github`. The framework is the server itself, not only the host. Negotiation state lives in Supabase, so an instance restart doesn't lose an offer.

| Tool | Job | Hints |
|---|---|---|
| `search_products` | Find products. Drops any that miss a hard need, **ranks by fit to the buyer's lever profile** (price, quality, delivery, warranty, trust, convenience), returns at most 5 | read-only, idempotent |
| `get_listing` | Public facts for one product | read-only |
| `ask_question` | Answer from catalog data only; says it doesn't know otherwise (`grounded: false`) | read-only |
| `make_offer` | Offer a price; the seller's agent counters, holds, or accepts. Returns `offer_id`, `final`, `expires_at`, rounds left, allowed next actions | writes, not destructive |
| `accept_deal` | Accept a live offer by `offer_id`. Locks a signed, immutable deal. Does not charge | writes, not destructive |
| `walk_away` | End a negotiation | writes, not destructive |
| `check_offers` | Read the state of a negotiation (including `PAID`) | read-only |
| `review_deal` | The **deal card** (MCP App): product, included extras, negotiated vs. list price, savings, expiry, **Approve & Pay** | read-only |
| `pay_deal` | Charge the stored deal in Stripe test mode, once | destructive, idempotent, open-world |

Every tool has a title, read-only / destructive hints and a zod-typed input; `search_products` and `review_deal` also publish output schemas. Agent-first details:

- **Few tools in a fixed order.** The server `instructions` give the whole flow in one line: search → (get_listing / ask_question) → make_offer rounds → accept_deal → review_deal. They also say a card-paid deal is a finished purchase, so a chat doesn't start a second negotiation.
- **Errors tell the agent what to do.** A refused `pay_deal` returns `status: "refused"` with `code`, `reasons` and a `fix` ("the offer expired; make a new offer to get a fresh deal"). Exchange errors carry codes (`stale_offer`, `offer_expired`, `round_cap`, `wrong_buyer`, `missing_buyer_id`, and more), not prose.
- **A deal card in the buyer's own client** (`views/deal-card`, served as `ui://views/deal-card.html`, `text/html;profile=mcp-app`). For agents with no card UI, every offer and deal carries a short `summary` line the agent can relay verbatim, and a locked deal returns an `approve_url`: a hosted approve page, HMAC-signed per deal and buyer, that charges only the stored amount.
- **Discoverable from the domain.** `/.well-known/ucp` (a UCP profile listing the MCP transport, plus a `negotiation` capability: no standard field says "this seller negotiates", so we propose one), `/.well-known/mcp/server-card.json` (SEP-2127) and `/openrpc.json`. They are built from the server's own `tools/list`, so they can't drift from what is deployed.
- **No private fields.** Listings never show the floor, cost or the seller's objective; a test asserts it for every listing search returns.
- **Fast enough for a chat tool call.** Calls take about 3 s with the Claude seller voice writing every message (about 3.5 s per `make_offer`), well inside the 15 s per-call budget we set ourselves.

## Evidence

| Claim | Evidence | Source |
|---|---|---|
| A real person's agent can buy end to end | In real ChatGPT on production the agent haggled a $129 keyboard to a $110 deal and paid in the deal card: `payment_succeeded`, Stripe test PaymentIntent `pi_3URoOK…`. A later recheck bought at $118 after 5 rounds | E1 log, "Bridge 1 closed" |
| Other clients work with no help | Real Claude (`claude -p` with the connector) bought in 33 s: search → offer → counter → accept → `review_deal` → `pay_deal` | E1 log, "Bridge 1 validation" |
| It holds up under volume | 100 Haiku buyers per policy ran **200 negotiations through this URL** (static vs. negotiating): 64% vs. 41% bought, 0 unsafe deals | [docs/results/bridge2-deployed](../results/bridge2-deployed/README.md) |
| Outside agents pass it | Armature's tester agents in Claude Code and Codex pass all 7 eval cases against this URL | [RESULTS.md](../../apps/dashboard/evals/armature/RESULTS.md) |
| The deploy is checkable | `node apps/marketplace/scripts/verify-prod.mjs [--pay]` checks 9 tools, ranked search, a haggle, the deal card's owner check, and a test payment with a retry. `scripts/demo-check.sh` runs it with the rest of the pre-demo checks | [apps/marketplace/scripts/verify-prod.mjs](../../apps/marketplace/scripts/verify-prod.mjs) |

Hosting also forced real fixes: `STRIPE_*`, Supabase and signing secrets live in Manufact's env and survive redeploys; deploys go from a clean checkout of `main`; and after each deploy we run the verify script and clear anonymous-buyer memory.

## Limits

- **No OAuth.** The server is public. Manufact Cloud does not add OAuth to a server; we chose open browsing and negotiation, and gate only the money.
- **We have not run Manufact's publish checklist or Testing suites** on this server, so there is no score to quote. The Manufact MCP catalog report is public, so we haven't triggered it.
- **We did not use Manufact Sessions replay as learning data.** Our own `events` table in Supabase is the source for the dashboard and for the learned policy, because it also holds negotiation state and guardrail decisions.
- **The deal card is verified in ChatGPT.** Claude and the other clients bought through the text summary; we have not confirmed the card renders in claude.ai.
- Stripe is test mode only ([Stripe write-up](stripe.md)).

## Links

- Server: `https://dark-zero-mesv5.run.mcp-use.com/mcp` · code: [apps/marketplace](../../apps/marketplace/) · image: [Dockerfile](../../apps/marketplace/Dockerfile)
- Discovery: [src/discovery.ts](../../apps/marketplace/src/discovery.ts)
- Deal card: [views/deal-card](../../apps/marketplace/views/deal-card/) · approve page: [src/deal/approve.tsx](../../apps/marketplace/src/deal/approve.tsx)
- Architecture: [docs/FINAL_ARCHITECTURE.md](../FINAL_ARCHITECTURE.md) · demo: [docs/DEMO.md](../DEMO.md)
