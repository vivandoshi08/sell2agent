# Agent-to-agent sale over Craigslist: identity, payment, seller connect

> Research done 2026-10-18 (four parallel passes plus test-mode runs). Builds on [identity-and-payments.md](identity-and-payments.md). "UNVERIFIED" means no primary source or test run confirmed it.

## Answer

- **Stripe has no negotiation API.** Its own agent-to-agent framing matches ours: the seller agent quotes, the buyer agent counters, code checks margin, and deterministic code makes the payment call ([Sessions 2026](https://stripe.com/sessions/2026/preparing-for-agent-to)). Negotiation stays ours; Stripe is the rail after the price is agreed.
- **No consumer assistant can pay a Craigslist seller through its own checkout.** ChatGPT, Gemini, Copilot and Perplexity checkouts all need the merchant pre-onboarded (ACP, Merchant Center/UCP, PayPal store sync).
- **The agents that can pay an unknown seller use Stripe's Link Agent Wallet.** This includes Grok, Instinct, Muse and Browser Use, plus any agent running link-cli as a skill or MCP server. The human approves each spend in Link, and the agent gets one of three things:
  - a virtual card, which works on any card form;
  - a Link Pay Token, for Stripe Checkout pages;
  - a Shared Payment Token (SPT), for APIs or MCP tools that accept `spt_…`.
- **Our approve page is a dead end for those agents.** It has one button that charges a hardcoded `pm_card_visa`, and no card form.
- **Fix:** make the approve link open a **Stripe Checkout Session**. Then a human, a virtual-card agent and a Link Pay Token agent can all finish the same page. Keep `pay_deal` accepting an SPT for MCP agents.

## Pay paths to support, in order

| # | Path | Who completes it | Status |
|---|---|---|---|
| 1 | Approve link → **Stripe Checkout Session** (`price_data` = negotiated total, Link on) | A human from any chat; browser agents with the user taking over; Link virtual-card agents (Grok, Instinct…); Link Pay Token agents through the hidden `.AiAgentPaymentSteering` block | GA. The steering block is experimental. A Link Pay Token in test mode is UNVERIFIED; virtual cards work with `--test`. |
| 2 | `pay_deal` with an **SPT** (`payment_method_data[shared_payment_granted_token]`) | MCP agents with link-cli; our simulated buyers | Preview API `2026-09-30.preview`. **Tested.** |
| 3 | MPP / HTTP 402 with `method="stripe"` on the same deal | MPP-native agents | Optional |
| — | ACP / UCP catalog onboarding, PayPal, Copilot | — | Skip. Needs approval we can't get in time. |

## Test-mode results (2026-10-18, our sandbox)

- **The test helper ties its SPT to our platform profile.** `agent_details.network_business_profile = profile_test_61U9…`. `.env` `STRIPE_PROFILE_ID` is empty, and this id fills it.
- **SPT plus `capture_method=manual` works.**
  - The PaymentIntent goes to `requires_capture` (3600 cents capturable).
  - Capture moves it to `succeeded`.
  - The SPT is then marked `consumed`, with `amount_captured` 3600.
  - So "hold now, charge at pickup" works on the agent path.
- **SPT plus destination charge to a seller account: not tested.** Our sandbox doesn't have Connect turned on ("You can only create new accounts if you've signed up for Connect"). Script: `scratchpad/spt_connect.sh` (rerun after Connect is on).

## Money flow: Connect

Source: [SPT for Connect](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens.md?agent-seller=connect), [destination charges](https://docs.stripe.com/connect/destination-charges.md).

- **Charge type:** destination charges without `on_behalf_of`. Every SPT goes to the **platform profile**, so no seller needs a profile and no support ticket is needed.
  - SPT path: `payment_method_data[shared_payment_granted_token]`, `transfer_data[destination]=acct_…`, `application_fee_amount`.
  - The docs don't show these fields together in one example: UNVERIFIED until tested.
  - Checkout path: `payment_intent_data[transfer_data][destination]`, `payment_intent_data[application_fee_amount]`, `payment_intent_data[capture_method]=manual`.
- **Seller accounts:** Express (`type=express`) is deprecated for new platforms. Use v1 controller properties instead:
  - `controller[fees][payer]=application`, `controller[losses][payments]=application`, `controller[stripe_dashboard][type]=express`;
  - `business_type=individual`, `capabilities[transfers][requested]=true`;
  - onboarding through Account Links (`type=account_onboarding`).
  - Test KYC: DOB 1901-01-01, SSN 0000, `address_full_match`, routing 110000000. Prefilled, onboarding takes about a minute.
- **Seller dashboard:** Connect embedded components `payments`, `payouts`, `notification-banner` (GA), mounted in our "My store" page next to our own negotiation feed from `events`.

## Identity

| Who | How | Notes |
|---|---|---|
| Buyer **agent** | SPT `agent_details` (agent name and profile), card `fingerprint`. Stretch: verify Web Bot Auth signatures (`Signature-Agent`, RFC 9421, Ed25519) | Nothing Stripe provides identifies the human behind an agent. Mastercard Agent Pay identity is opaque to the merchant. |
| Buyer **human** | Collected at pay time: Checkout email and phone (`phone_number_collection`), or Link approval. Negotiation stays anonymous (`anon_…`) until then | Stripe Identity ($1.50 per document check, first 50 free) only as an optional "verified buyer" step above a price threshold. Overkill at $40. |
| Seller | Connect KYC (Stripe-run onboarding) | Optional: Identity badge before payouts |

## Local pickup ("pay now, confirm at pickup")

- **Stripe says it doesn't provide escrow.** Its alternatives are delayed payouts and holds ([manual payouts](https://docs.stripe.com/connect/manual-payouts.md)).
- **Use a manual-capture hold.** It lasts 7 days, or 4 days 18 hours for merchant-initiated Visa. Keep the pickup window at 4 days or less.
  - At handoff, the seller enters the buyer's pickup code, and we capture.
  - On a no-show, cancel the PaymentIntent and the hold is released.
- **Longer windows:** capture right away and hold the transfer (separate charges and transfers with `transfer_group` and `source_transaction`). The platform carries disputes and recovers by reversing the transfer.

## Standards alignment (optional, after the pay fix)

- **None of A2A, AP2, ACP or UCP defines price negotiation.** Our offer and counter turns stay ours.
- **Closest fit for "seller signs the negotiated cart, buyer pays it":** a UCP checkout whose `totals` equal the agreed price, plus an AP2 merchant authorization (a JWS) and a short expiry. The buyer then pays with an SPT through Stripe's UCP handler `com.stripe.payments` ([Stripe UCP](https://docs.stripe.com/agentic-commerce/sellers/use-cases/retail/ucp.md)).
- **Discovery:** we already serve `/.well-known/ucp` and the MCP server card. Add `/llms.txt`. Whether consumer agents crawl `agent-card.json` is UNVERIFIED.
