# Stripe track: agents that safely participate in the economy

> **Archived pre-build plan (Sat Oct 17, 8:49 pm).** It planned a Python server; we shipped a TypeScript gateway. The submission write-up is [../../tracks/stripe.md](../../tracks/stripe.md). Code comments that cite `docs/tracks/stripe.md` (for example `§1`) mean this file.

> Implementation guide, written 2026-10-17. Track brief: build an agent that can "buy products, provision services, manage business spending, or pay for the resources it needs", with "clear control over what their agents can do and spend". Prizes: Stripe credits $3k/$2k/$1k + Atlas fee waived; $500 credits for everyone.
> Inputs: [TRACKS.md](../../TRACKS.md), [identity-and-payments.md](../../research/identity-and-payments.md), `sell2agent/policy.py`, and the mock `checkout` in `experiments/e1_e2e_mcp/front_door.py` at commit 494584c. Every Stripe fact below comes from docs.stripe.com, stripe.dev, github.com/stripe, or PyPI, read on 2026-10-17 unless another date is given.

## The short version

The plan holds up. Stripe documents exactly this seller flow: receive an `spt_…`, then create and confirm a PaymentIntent with `payment_method_data[shared_payment_granted_token]`. A test helper mints tokens in a sandbox, and the public-preview Python SDK (`stripe==16.1.0b1`) has typed methods for all of it. Two caveats shape the demo. (1) The test helper runs on **our** seller key, so in test mode the buyer's "mint" is a simulation unless a second sandbox can issue to our profile (unverified). (2) Link's agent wallet, the real human-approval path, **caps each spend request at $500**, and our tractors cost $25k–$80k. The story judges want, controls on both sides, is already in our architecture: the policy engine is code (the merchant's control), and the SPT's `max_amount`/`expires_at`/seller scope is the buyer's control.

## 10-step build checklist (tonight)

1. **Sandbox + Stripe profile.** In a Stripe sandbox, create a Stripe profile (Dashboard → [Stripe profile](https://dashboard.stripe.com/profiles)) and note its `profile_test_…` id. Put `STRIPE_SECRET_KEY` (sk_test_) and `STRIPE_PROFILE_ID` in env, never in git.
2. **SDK:** `uv add "stripe==16.1.0b1"`. It pins API version `2026-09-30.preview` and has `shared_payment.*` services. Pin it exactly, because preview SDKs can break between b-releases.
3. **10-minute go/no-go:** run the smoke script in §1 (mint a test SPT, then charge it). If it fails with an access error, switch to Fallback A (§6) and ask at the booth.
4. **Lock deals server-side.** When the policy engine approves an accepted offer, store a deal: `{deal_id, amount_cents = price*100, currency, offer, expires_at}`. Return `deal_id`, `amount`, `currency`, `seller_profile`, `expires_at`, and a one-line instruction for minting the SPT.
5. **`pay_deal(deal_id, spt)`** (or add an `spt` argument to the existing `checkout(offer_id)`; pick one name across all three tracks): re-run the policy check, retrieve the token and pre-check its limits, create and confirm the PaymentIntent with an idempotency key, then record the order. The code is in §1.
6. **Buyer wallet tool** in the buyer harness: `request_payment_token(deal_id, amount_cents)`. It enforces the principal's cap in code, asks for human approval above a threshold, and mints with `max_amount = amount_cents`. Label it "simulated wallet (Stripe test helper)" on screen.
7. **Refusal demos:** price below floor (policy engine), token capped below the deal total (our pre-check), revoked token (test-helper revoke), declined card (`pm_card_visa_chargeDeclined`).
8. **Webhooks:** `stripe listen --forward-to localhost:PORT/stripe/webhook` and handle `payment_intent.succeeded` / `payment_intent.payment_failed`. This only applies once the server runs over HTTP; with the stdio harness, trust the synchronous PI status.
9. **Show the controls:** the MCP App deal card (shared with Manufact) shows deal terms, the SPT limits read back from Stripe (`max_amount`, `expires_at`, card brand/last4), and the resulting `pi_…`, plus the Dashboard Payments view with `deal_id` in metadata.
10. **Polish:** use an agent-tagged restricted key (§4), advertise `com.stripe.payments` in `/.well-known/ucp` (§3, optional), and record a 2-minute run: haggle → policy approve → human approves cap → SPT → paid PI in the Dashboard → one over-cap refusal.

## 1. Seller side: charging an SPT

**API surface** ([SPT seller guide](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens.md?agent-seller=seller), [granted token API](https://docs.stripe.com/api/shared-payment/granted-token)):
- Header `Stripe-Version: 2026-09-30.preview`. It's the current preview version per the [SDK versioning page](https://docs.stripe.com/sdks/versioning). SPTs shipped in `2026-04-22.preview` ([changelog](https://docs.stripe.com/changelog/dahlia/2026-04-22/shared-payment-granted-token)).
- Endpoints: `GET /v1/shared_payment/granted_tokens/{spt}`, `POST /v1/test_helpers/shared_payment/granted_tokens` (params: `payment_method` required, `usage_limits[currency|max_amount|expires_at]` required, `customer`, `shared_metadata`), `POST /v1/test_helpers/shared_payment/granted_tokens/{spt}/revoke`.
- **The test helper takes no seller/profile parameter.** It grants the token to the calling account. In the sample response, `agent_details.network_business_profile` is a Stripe test agent profile.
- Charge: `POST /v1/payment_intents` with `amount`, `currency`, `payment_method_data[shared_payment_granted_token]=spt_…`, `confirm=true`. Stripe clones the buyer's payment method into a new `PaymentMethod` on the PI, and refunds and reporting then work as normal.
- Token fields: `usage_limits{currency,max_amount,expires_at}`, `usage_details.amount_captured`, `deactivated_at`, and `deactivated_reason` ∈ `consumed|expired|resolved|revoked`. Also `payment_method_details.card.{brand,last4}`, `agent_details`, and `risk_details.insights.{bot,card_testing,stolen_card,fraudulent_dispute,card_issuer_decline}` (each has a `score` and a `recommended_action`).
- `max_amount` is **cumulative**: a token stays usable until it expires, is revoked, or total captures reach `max_amount` ([Issuing programmatic checkout](https://docs.stripe.com/issuing/agents/programmatic-checkout.md)). With `max_amount` = deal total, one charge consumes it.
- Available to sellers in the US, CA, and about 30 European countries. Minimum charge $0.50 ([MPP docs](https://docs.stripe.com/payments/machine/mpp.md)). Maximum $999,999.99 per USD PaymentIntent (8 digits), so tractor totals fit.
- Access: the docs say using SPTs means agreeing to the Agentic Commerce Seller Services **preview** terms. No sign-up step is documented. The SDK support ships in the **public** preview channel (`b` builds), not the invite-only `a` channel ([stripe-python beta changelog](https://github.com/stripe/stripe-python/blob/beta/CHANGELOG.md), 15.2.0b1 on 2026-04-23).

```python
# sell2agent/payments.py (suggested). Amounts in cents.
import os, time
from stripe import StripeClient, StripeError, CardError
client = StripeClient(os.environ["STRIPE_SECRET_KEY"], stripe_version="2026-09-30.preview")

def mint_test_spt(amount_cents, minutes=15, pm="pm_card_visa", deal_id=""):   # test mode only
    tok = client.v1.test_helpers.shared_payment.granted_tokens.create(params={
        "payment_method": pm,
        "usage_limits": {"currency": "usd", "max_amount": amount_cents,
                         "expires_at": int(time.time()) + minutes * 60},
        "shared_metadata": {"deal_id": deal_id}})
    return tok.id

def pay_deal(deal, spt):
    """deal comes from OUR store; the buyer only supplies deal_id and spt."""
    tok = client.v1.shared_payment.granted_tokens.retrieve(spt)
    lim, why = tok.usage_limits, []
    if tok.deactivated_at: why.append(f"token is {tok.deactivated_reason}")
    if lim.currency != deal["currency"]: why.append("token currency does not match the deal")
    if lim.max_amount < deal["amount"]: why.append(f"token cap {lim.max_amount} < deal total {deal['amount']} (cents)")
    if lim.expires_at and lim.expires_at <= time.time(): why.append("token expired")
    if why:  # refuse before touching money; tell the agent exactly how to fix it
        return {"status": "refused", "reasons": why,
                "fix": f"mint a new SPT: currency=usd, max_amount={deal['amount']}, seller={deal['seller_profile']}"}
    try:
        pi = client.v1.payment_intents.create(
            params={"amount": deal["amount"], "currency": deal["currency"], "confirm": True,
                    "payment_method_data": {"shared_payment_granted_token": spt},
                    "description": f"Negotiated deal {deal['deal_id']}",
                    "metadata": {"deal_id": deal["deal_id"], "policy": "approved",
                                 "list_total": deal["list_total"], "floor_total": deal["floor_total"]}},
            options={"idempotency_key": f"pay_deal-{deal['deal_id']}-{spt}"})
    except CardError as e:
        return {"status": "declined", "code": e.code, "decline_code": getattr(e.error, "decline_code", None),
                "message": e.user_message}
    except StripeError as e:
        return {"status": "error", "code": e.code, "message": e.user_message or str(e)}
    card = (tok.payment_method_details or {}).get("card")   # StripeObject is a dict
    return {"status": pi.status,            # succeeded | requires_action | processing
            "payment_intent": pi.id, "amount": pi.amount,
            "card": f"{card.brand} ****{card.last4}" if card else None}
```

**Error behavior.** The public error-code table has **no SPT-specific codes**. What happens when `amount > max_amount`, or on an expired or revoked token, is undocumented on the Stripe API side. The UCP handler table maps an expired token to `token_invalid` and a decline to `payment_declined`, but those are protocol-level codes. That is why `pay_deal` pre-checks the token. Test each case tonight and paste the real `e.code` into this doc.
**Gotchas.**
- The amount comes from the server-side deal, never from the tool call.
- Charge exactly the deal total, not the token cap.
- A `requires_action` status means the buyer must complete 3DS on their side; the SPT goes to `requires_action` for the issuer. Return a clear message and let them retry with the same `deal_id`.
- The idempotency key includes the SPT, so a retry with a new token is a new attempt and a replay of the same pair is safe.
- Default `capture_method` is now `automatic_async`. Treat `processing` as pending and confirm via the webhook.
- If a confirm ever demands `return_url`, add `automatic_payment_methods={"enabled": True, "allow_redirects": "never"}`. This is unverified for SPTs; the docs' sample works without it.

## 2. Buyer side: who mints the SPT, and what the human approves

- **Agent API (real issuance):** `POST /v1/shared_payment/issued_tokens` from the *agent's own* Stripe account: `payment_method` (a pm_ in the agent's account), `seller_details[network_business_profile]=profile_…`, `usage_limits[currency|max_amount|expires_at]`, optional `shared_metadata` (visible to the seller) and `setup_future_usage=on_session`. It returns `spt_…` with a `status` of `active|requires_action|deactivated`, and the agent can `POST …/issued_tokens/{id}/revoke` at any time ([agent guide](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens.md?agent-seller=agent), [API](https://docs.stripe.com/api/shared-payment/issued-token/create.md)). Test seller profile: `profile_test_61TU90nIeGjU7NNVXA6TU90m7ISQWsBxpcx9lASWWXTk`. Agent and seller need an **Orchestrated Commerce Agreement**, which Stripe auto-creates on the first SPT and confirms on the first payment ([changelog](https://docs.stripe.com/changelog/dahlia/2026-04-22/orchestrated-commerce-agreements-api.md)). Whether a *second sandbox* can issue to *our* `profile_test_…` is unverified.
- **Link Agent Wallet / `link-cli`** (the consumer path with real human approval): `npm i -g @stripe/link-cli`, then `link-cli auth login` (the user approves the connection at a URL), then `link-cli spend-request create --credential-type shared_payment_token --network-id profile_… --amount <cents> --context "<≥100 chars>" --line-item … --total …`. The user approves **on the Link website or in the Link app** (push notification, 30-minute window) after seeing the context, line items, and totals. Then `link-cli spend-request retrieve <id> --interval 2` returns a one-time SPT valid for 12 h. MCP mode: `npx @stripe/link-cli --mcp`. Limits: **$500 per request, $500/day, $20k per 30 days**, US/CA Link accounts only. `--test` creates test-mode requests; whether it works with `shared_payment_token` is unverified ([docs](https://docs.stripe.com/agentic-commerce/agents/link-agent-wallet/use-link-wallet-pay-online.md), [repo](https://github.com/stripe/link-cli)).
- **Issuing for agents:** you can turn an Issuing virtual card (`spending_controls`, `issuing_authorization.request` webhooks) into an SPT, but card → PaymentMethod is **private preview** ([docs](https://docs.stripe.com/issuing/agents/programmatic-checkout.md)). Not for tonight.
- **What we demo:** a buyer wallet tool. Code checks `amount ≤ principal cap`. Above an auto-approve threshold it shows an "Approve $X to Prairie Equipment, expires in 15 min" prompt (terminal or MCP App button), then mints via `mint_test_spt`. The cap is visible twice: in our wallet rule and as `usage_limits.max_amount`, read back from Stripe in `pay_deal`. Stretch: a second sandbox calling `issued_tokens` with our profile, or a Link `--test` spend request for a ≤$500 item (for example a refundable deposit that locks the negotiated price).

## 3. Agentic Commerce Suite, ACP, and UCP

- **Stripe-managed checkout** (Agentic Commerce Suite) needs a catalog feed, Dashboard onboarding, and an approved connection per AI agent, and it emits `checkout.session.completed` ([guide](https://docs.stripe.com/agentic-commerce/sellers/use-cases/retail/checkout.md)). It suits fixed catalog prices, not per-buyer haggled totals. Skip it.
- **"Use your own checkout"** now points to **UCP**, which supports REST and MCP transports. Advertise the `com.stripe.payments` handler in `/.well-known/ucp` with `config.business_profile=profile_…` and `config.environment=sandbox`. The agent tokenizes via `POST https://commerce.stripe.com/api/ucp/tokenize`, gets an SPT scoped to the checkout id, profile, and total, and sends it as `payment.instruments[0].credential.token` (`type: stripe_payment_token`) on complete. We charge it exactly as in §1 ([UCP guide](https://docs.stripe.com/agentic-commerce/sellers/use-cases/retail/ucp.md), [handler](https://docs.stripe.com/agentic-commerce/protocols/ucp/stripe-payments-handler.md)). Requires a "confirmed commerce relationship" with each agent.
- **ACP MCP binding** (ACP 2026-04-17): five tools, `create_/get_/update_/complete_/cancel_checkout_session`, each taking `{meta, id, payload}`. The payment goes in `payload.payment_data.{handler_id, instrument.token}`. Conformance needs all five tools, validation against ACP JSON Schemas, and `/.well-known/acp.json` ([binding](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/docs/mcp-binding.md)). The binding doesn't yet cover delegate payment, the step where the buyer gets the token.
- **Minimum for us:** keep `pay_deal`, but make it accept a UCP-style instrument (`{"credential": {"type": "stripe_payment_token", "token": "spt_…"}}`) as well as a bare `spt`. Add the `com.stripe.payments` block to the `/.well-known/ucp` file the Armature plan already publishes. Full ACP or UCP conformance is half a day of schema work and buys no real buyers tonight. Pitch it as compatible by design, not certified.

## 4. Controls: "clear control over what agents can do and spend"

| Control | Who sets it | How | Stripe-recommended? | In our demo |
|---|---|---|---|---|
| Policy engine (floor, max discount, add-ons, terms) | Merchant | `PolicyEngine.check` on every offer, re-run in `pay_deal` | Same pattern as Stripe's agentic-marketplace post (policy checks the final checkout; the LLM doesn't decide payment) | Seller refuses below floor |
| Server-side amount | Merchant | Charge `deal.amount`, ignore client amounts, idempotency per deal | Idempotency: yes | No double charge |
| SPT `max_amount` / `currency` / `expires_at` / one seller | Buyer | Set at mint; Stripe enforces; revocable | Yes, the core SPT design | Over-cap and revoked refusals |
| Human approval of the exact amount | Buyer's human | Link spend-request approval, or our MCP App approve button | Yes (Link, MCP human confirmation) | Approve card before mint |
| Agent-tagged restricted key | Merchant | Restricted key tagged "Authorizing agent access", minimal perms (PaymentIntents write, SPT read); approval rules gate refunds and payouts | Yes: "the recommended way" per [API keys](https://docs.stripe.com/keys.md) | Selling agent can charge, not refund |
| Radar + `risk_details` | Stripe | Radar scores SPT payments; read `risk_details.insights` | Yes | Log scores in the order record |
| Issuing spend controls + real-time auth | Buyer's business | `spending_controls`, `issuing_authorization.request` (2 s) | Yes, for business spend | Mention only (private preview for SPTs) |
| Audit trail | Both | PI `metadata.deal_id`, orders.jsonl, Workbench logs, webhooks | Yes | Dashboard view |

Stripe's own design note for agent payments ([stripe.dev, 2026-08-07](https://stripe.dev/blog/agentic-payments-for-marketplaces.md)): the agent "should not receive more authority than the buyer intended." It also lists revoke/pause, audit trails, and evaluating the actual final checkout. Our build hits each one.

## 5. Stripe MCP server and agent toolkit

- `https://mcp.stripe.com` (OAuth or an **agent API key**; plain secret or restricted keys are rejected after 2026-11-30): `stripe_api_read`, `stripe_api_write`, `search_stripe_documentation`, and more. Refunds and outbound payments need human confirmation via a URL. There are no SPT tools ([docs](https://docs.stripe.com/mcp.md)). Use it in the demo as the **merchant's ops view**: "Claude, list today's agent payments" via `claude mcp add --transport http stripe https://mcp.stripe.com/`. It's no use as the buyer's wallet.
- `stripe-agent-toolkit` (Python 0.7.0, 2026-02-12) wraps Stripe tools for the OpenAI Agents SDK, LangChain, and CrewAI. It has no SPT or Issuing tools. Skip it. The `stripe/ai` repo now centers on the MCP server, skills, and token billing.

## 6. Fallbacks

- **Fallback A (keeps in-agent checkout):** if SPT access fails, call `payment_intents.create(amount, currency, payment_method="pm_card_visa", confirm=True, metadata=…)`. It's still a real `pi_…` and still no link. The buyer cap then lives only in our wallet code. Say so on screen.
- **Fallback B (human pays):** a Checkout Session with a custom amount. This is the weakest option for this track, since the stage remark called checkout links a bad agent experience.
  ```python
  cs = client.v1.checkout.sessions.create(params={"mode": "payment", "client_reference_id": deal["deal_id"],
      "line_items": [{"quantity": 1, "price_data": {"currency": "usd", "unit_amount": deal["amount"],
                      "product_data": {"name": deal["description"]}}}],
      "success_url": "https://example.com/paid?cs={CHECKOUT_SESSION_ID}", "expires_at": int(time.time()) + 1800,
      "payment_intent_data": {"metadata": {"deal_id": deal["deal_id"]}}})   # return cs.url; fulfil on checkout.session.completed
  ```
  Payment Links also take `price_data` but are reusable. Don't use them for one-off deals.
- **MPP** (HTTP 402, accepts SPTs via `method="stripe"`, Node `mppx`, no MCP binding) and **x402** (stablecoins, needs approval) are HTTP rails. They're only worth adding if we want `link-cli mpp pay` to hit an HTTP endpoint. Not tonight.

## 7. Test setup

- Keys: sandbox `sk_test_…` / `rk_test_…`. Profile id: Dashboard, or `GET /v2/network/business_profiles/me` with `Stripe-Version: 2026-07-29.preview`.
- Test PMs for the helper: `pm_card_visa` (ok), `pm_card_visa_chargeDeclined`, `pm_card_visa_chargeDeclinedInsufficientFunds`, `pm_card_threeDSecure2Required` (→ `requires_action`), `pm_card_radarBlock`.
- Webhooks: `stripe listen --forward-to localhost:8000/stripe/webhook --events payment_intent.succeeded,payment_intent.payment_failed,shared_payment.granted_token.deactivated`. It prints the `whsec_…`. Verify with `client.construct_event(payload, sig_header, whsec)`.
- Idempotency: `options={"idempotency_key": …}` on any StripeClient call. The SDK also auto-adds keys for its own retries.
- Demo view: sandbox Dashboard → Payments → open the `pi_…` and show amount, metadata `deal_id`, and card. Workbench shows the raw API calls, including the preview header.

## What the judges likely look for

- **Track text:** useful, creative, **end-to-end**, and **user control over what agents can do and spend**. Show both sides refusing, not just a happy path.
- **Stage remarks:** a checkout link for the agent to click is a bad experience; the agent should check out directly. Our SPT → PaymentIntent flow has no hosted page. Stripe's own [Checkout-for-agents post](https://stripe.dev/blog/how-stripe-is-designing-checkout-for-ai-agents.md) (2026-09-22) measures agent checkout in tokens and tool calls, so report ours for the pay step (E1 numbers, shared with Armature).
- **The cheat sheet:** **not found.** No Stripe-published hackathon cheat sheet turned up on stripe.dev, docs.stripe.com, stripe.com, or YC event pages. 404s at `stripe.dev/hackathon(s)`, `docs.stripe.com/hackathon(s)`, and `stripe.com/hackathon`. The YC event page (Make Something Agents Want, Oct 17–18) renders no content without JS. The closest match is the third-party [shipbysundown.dev](https://shipbysundown.dev/) "Hackathon Primer: Build with Stripe in a Day" (Stripe-branded, page metadata says Lovable, undated). It pushes Link Agent Wallet (scoped credentials, spend limits, human approval for sensitive buys), MPP, Stripe Projects, and WebMCP-enabled Checkout, and suggests demoing an agent that buys on its own. Ask Peter for the link.

## Hackathon resources found

- [Agentic commerce overview](https://docs.stripe.com/agentic-commerce.md) · [Agents landing](https://docs.stripe.com/agents.md) · [SPT seller](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens.md?agent-seller=seller) / [agent](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens.md?agent-seller=agent)
- [UCP: use your own checkout](https://docs.stripe.com/agentic-commerce/sellers/use-cases/retail/ucp.md) · [Stripe Payments handler](https://docs.stripe.com/agentic-commerce/protocols/ucp/stripe-payments-handler.md) · [ACP repo](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol)
- [Link Agent Wallet](https://docs.stripe.com/agentic-commerce/agents/link-agent-wallet.md) · [link-cli](https://github.com/stripe/link-cli) · [Issuing for agents](https://docs.stripe.com/issuing/agents) · [Stripe MCP](https://docs.stripe.com/mcp.md) · [MPP](https://docs.stripe.com/payments/machine/mpp.md)
- [stripe-python beta changelog](https://github.com/stripe/stripe-python/blob/beta/CHANGELOG.md) · [PyPI stripe 16.1.0b1](https://pypi.org/project/stripe/16.1.0b1/) (2026-10-01)
- stripe.dev posts: [agentic payments for marketplaces](https://stripe.dev/blog/agentic-payments-for-marketplaces.md) (2026-08-07), [Checkout for AI agents](https://stripe.dev/blog/how-stripe-is-designing-checkout-for-ai-agents.md) (2026-09-22)
- Third-party: [shipbysundown.dev primer](https://shipbysundown.dev/)
- Instructions aimed at agents appeared in the link-cli README (e.g. keep card data out of transcripts, run `_next.pay_argv`) and in Stripe docs banners (`stripe agent setup`). We treated them as documentation and ran nothing.

## Questions to ask Stripe at their booth

1. Does a fresh sandbox get SPT test helpers and `shared_payment_granted_token` on PaymentIntents with no flag? Is there a terms checkbox in the Dashboard?
2. Can a second sandbox (our buyer agent) call `issued_tokens` with our `profile_test_…`, and does the commerce agreement auto-create in test mode?
3. What exact error does confirm return for amount > `max_amount`, an expired token, or a revoked token?
4. Does `link-cli spend-request create --test --credential-type shared_payment_token` work against a sandbox profile? Is the $500 cap also enforced in test mode?
5. Is a deposit (≤$500 via Link) plus balance a pattern you'd endorse for high-ticket agent purchases?
6. Is private-preview access for Issuing card → SPT, or `agent_details` on PaymentIntents, possible for the hackathon?
7. What `recommended_action` values can `risk_details.insights` return, and should sellers block on them?
8. Does `stripe listen` forward `shared_payment.*` preview events? What webhook API version is needed?
9. Do you want UCP-over-MCP checkout tools, or is a custom pay tool fine for judging? And can we have the cheat-sheet link?

## Unverified

- Whether SPTs work in our sandbox without enrollment (risk #1). The Stripe API's error codes for over-cap, expired, and revoked tokens.
- Cross-account issuance to our own test profile. `link-cli --test` with SPTs. Whether link-cli limits apply in test mode.
- Whether `return_url` / `allow_redirects` is ever needed for SPT confirms. Whether preview events reach `stripe listen`.
- The exact restricted-key permission names for "SPT read" and the test helper (docs name only `shared_payment_token_write` for issuing).
- The sandbox Dashboard deep-link format for a PaymentIntent.
- Any official Stripe cheat sheet for this event.
