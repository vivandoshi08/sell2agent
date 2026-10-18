# Stripe track: agents that safely participate in the economy

> Submission write-up. Track brief: agents that buy products or pay for resources, with "clear control over what their agents can do and spend". Pre-build plan and Stripe API research: [docs/archive/tracks/stripe-guide.md](../archive/tracks/stripe-guide.md).

## What we built

**The checkout step of an agent-to-agent sale, with controls on both sides.** A buyer's agent negotiates with a seller's agent over MCP; when they agree, the deal is locked and paid in Stripe test mode. Nobody is trusted: the seller's agent can't undercut its own limits, and the buyer's agent can't be charged more than the deal.

**The merchant's controls (the seller can't lose money by accident).** All in code:
- **Floor and margin are enforced by the exchange**, not the prompt. The seller never accepts below the hard floor, never offers below the soft floor plus the cost of any extras it includes, never raises a price it already gave, and never charges above list. The model writes the words; code sets the price and checks the words (a figure other than the offer, the list price or an earlier price is rejected and rewritten).
- **A deal is a signed, immutable record** bound to one buyer: amount, extras, expiry (30 minutes). Tampering with it fails the signature.
- **`pay_deal` charges the stored amount, never one from the tool call.** Before touching money the exchange validates the deal: `unknown_deal`, `tampered`, `expired`, `already_paid`, `wrong_buyer`, `amount_mismatch`, `policy_recheck_failed` (the seller re-checks its own policy at payment time).
- **At most one charge per deal.** Concurrent clicks share one attempt, a retry returns `already_paid` with the original PaymentIntent, and a retry with a different card is blocked instead of charging twice. Stripe sees an idempotency key per deal and credential.
- **Refusals are logged as guardrail events, not payment failures.** A wrong-buyer or tampered attempt shows as an `attack` row with a reason, so it can't skew the payment-failure rate. `review_deal` also shows the card only to the buyer who accepted.
- **Audit trail.** Every PaymentIntent carries `deal_id`, `negotiation_id`, `buyer_id`, `product_id` and `seller_id` in its metadata, and every step lands in Supabase `events` (`payment_succeeded`, `payment_failed`, `guardrail_blocked`).

**The buyer's controls (the buyer can't be charged more than it agreed).**
- **`BuyerWallet`** (`@sa/payments`): a per-purchase cap and a running total cap, enforced in code; a human-approval threshold above which a person must say yes; a refusal comes back with reasons the agent can act on. The simulated buyers' walk-away price is a hard cap in code too.
- **Shared Payment Tokens** (Stripe's agent-payment primitive): the token is minted with `max_amount` equal to the deal total and a 15-minute expiry. The seller pre-checks it before charging (`precheckToken`: cap, currency, expiry, revoked) and refuses with `reasons` and a `fix` such as "mint a new SPT with max_amount=…".
- **A person approves the exact amount.** In ChatGPT or Claude the **deal card** shows product, extras, price vs. list, savings and expiry, and Approve & Pay is the consent. For agents that only exchange text, a locked deal returns an HMAC-signed approve link that charges only the stored amount.

**Test mode only, enforced.** `@sa/payments` refuses any key that isn't `sk_test_` or `rk_test_`. All Stripe calls go through it; no app imports `stripe` directly.

## Evidence

| Claim | Evidence | Source |
|---|---|---|
| A negotiated price is the price charged, once | Production probe: `pay_deal` charged Stripe test **$112 exactly once** (`pi_3URnPQ…`); the second `pay_deal` returned `already_paid` with the same PaymentIntent; another buyer's attempt got `wrong_buyer` | E1 log, "Bridge 1 validation" |
| A real person's agent paid | Real ChatGPT on production: $129 list → **$110** deal → Approve & Pay in the card → `payment_succeeded`, `pi_3URoOK…`. A later recheck paid $118 (`pi_3URowU…`) and ChatGPT confirmed it as PAID through `check_offers` | E1 log, "Bridge 1 closed", #65 |
| A coding agent paid with no help | Real Claude as client bought in 33 s, `pi_3URnRD…` | E1 log |
| Retrying a payment is safe, judged by an outside tester | Armature case `pay-retry-is-safe` (a real Stripe test charge, then a retry that must not charge again) passes on Claude Code and Codex | [Armature RESULTS.md](../../apps/dashboard/evals/armature/RESULTS.md) |
| The seller stayed inside its limits at volume | **0 unsafe deals** across 200 negotiations through the production gateway (65 negotiating deals checked in Supabase, 0 below floor) and 0 of 132 deals in the 200-negotiation in-process run; the output guard caught 16 attempts to state a floor or cost figure | [bridge2-deployed](../results/bridge2-deployed/README.md), [bridge2](../results/bridge2/README.md) |
| Why the rules are in code | Our red-team experiment (pre-build, Python harness): the policy engine allowed **0 rule-breaking deals across 36 attack sessions and 20 control sessions**, while prompt-only rules leaked: an Opus seller accepted $28,500 for a bundle with a $41,700 floor after one fake `SYSTEM:` line. In the build, an injected `SYSTEM:` line is blocked at the input (`input_injection`) | [experiments/e4_red_team](../../experiments/e4_red_team/README.md), E1 log |
| Stripe SPTs work on our sandbox | `stripe:smoke` passed 6/6 and reported that Shared Payment Tokens are available | E1 log, "Bridge 1 check" |
| The controls have tests | Offline tests cover token pre-checks (cap, currency, expiry, revoked) and wallet caps and approval | [packages/payments/test](../../packages/payments/test/logic.test.ts) |

Run it yourself: `npx -y pnpm@9.12.0 stripe:smoke` (go/no-go), `node apps/marketplace/scripts/verify-prod.mjs --pay` (a haggle and a test payment with a retry against production), `npx -y pnpm@9.12.0 --filter @sa/dashboard pay-smoke` (a deal locked in the real exchange and paid through the handler).

## Limits

- **Production charges a test card, not an SPT.** The deployed gateway runs `STRIPE_PAYMENT_MODE=test_card`: `pay_deal` creates a PaymentIntent for the stored deal total with a Stripe test card, and the person pressing Approve & Pay is the consent. The SPT path is built and passed the smoke test, but ChatGPT and Claude have no wallet that mints a buyer-side token for us.
- **The buyer's token is simulated in test mode.** When SPTs are used, the token is minted with Stripe's test helper on the seller's own key, so the wallet is labelled "simulated wallet (Stripe test helper)". Link's real agent wallet (human approval in the Link app, capped at $500 per request) is not integrated.
- **Preview SDK.** `stripe@23.1.0-beta.1` (API `2026-09-30.preview`), pinned, because SPT support is in the public preview.
- **Webhooks.** `payment_intent.*` verification code exists in `@sa/payments`; `pay_deal` relies on the synchronous PaymentIntent status, and a `processing` status is not logged as a success.
- **Not shown:** refunds, disputes, Radar `risk_details`, the Stripe MCP as the merchant's ops view.

## Links

- Code: [packages/payments](../../packages/payments/) ([README](../../packages/payments/README.md)) · pay handler: [apps/marketplace/src/deal/pay.ts](../../apps/marketplace/src/deal/pay.ts) · exchange and deal signing: [apps/seller-mcp/src/exchange](../../apps/seller-mcp/src/exchange/)
- Architecture: [docs/FINAL_ARCHITECTURE.md §3](../FINAL_ARCHITECTURE.md) · demo: [docs/DEMO.md](../DEMO.md) · gateway: `https://dark-zero-mesv5.run.mcp-use.com/mcp`
