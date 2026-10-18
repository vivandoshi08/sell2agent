# Agent identity and payments (F5, C1)

> E8 research, 2026-10-17. Docs pages with no date of their own are marked "accessed 2026-10-17".

## Answers

**F5: detection and identity.**
- Sites block agents mainly at the CDN, bot-management, and terms-of-service layers: Cloudflare, Akamai, DataDome, HUMAN, and robots.txt. The industry is converging on **Web Bot Auth**: signed HTTP requests, now an IETF working-group draft. It proves *which operator* sent a request. It does not prove the agent may spend.
- Spend authority comes from payment credentials: Stripe SPT limits, Visa/Mastercard agent tokens on top of Web Bot Auth, AP2 mandates (now at FIDO), and Know Your Agent (KYA) tokens.
- On our own MCP front door, **MCP OAuth** identifies the client. We decide who gets in, so blocking is not our problem. Trust is.

**C1: from deal to payment.**
- Primary path: the buyer agent hands us a **Shared Payment Token (SPT)** capped at the agreed amount, and we charge it with a PaymentIntent.
- Fallback: a **Checkout Session with a custom `price_data` amount**, whose URL a human (or a wallet-enabled agent) completes.
- Both handle a per-buyer negotiated price with no catalog price changes. SPTs are still a **preview** API, but they work in test mode today.

## F5: How sites detect and block agents

- **Cloudflare:**
  - Blocks AI crawlers by default for new domains since 2025-07-01 ([Cloudflare PR](https://www.cloudflare.com/press-releases/2025/cloudflare-just-changed-how-ai-crawlers-scrape-the-internet-at-large/), 2025-07-01).
  - Pay per crawl uses HTTP 402 plus price headers and requires signed requests ([blog](https://blog.cloudflare.com/introducing-pay-per-crawl/), 2025-07-01, updated 2026-07-15).
  - "Signed agents" is a bot class for user-directed agents that sign with Web Bot Auth. The first cohort was ChatGPT agent, Goose, Browserbase, and Anchor ([blog](https://blog.cloudflare.com/signed-agents/), 2025-08-28).
  - Since 2026-07-01, signed agents count as Verified and are tagged Direct or Intermediary ([verified bots docs](https://developers.cloudflare.com/bots/concepts/bot/verified-bots/), updated 2026-10-08).
  - Cloudflare proposed new defaults for 2026-09-15: allow search, block agent use on ad-supported pages ([PR](https://www.cloudflare.com/press/press-releases/2026/cloudflare-allows-the-agentic-internet-to-flourish-with-a-simple-philosophy-your-content-your-rules/), 2026-07-01). **Unverified** whether they took effect.
- **Stealth agents get delisted.** Cloudflare caught Perplexity using undeclared crawlers with spoofed user agents and rotating IPs, and removed it from the verified list ([blog](https://blog.cloudflare.com/perplexity-is-using-stealth-undeclared-crawlers-to-evade-website-no-crawl-directives/), 2025-08-04).
- **Other vendors:**
  - Akamai announced an agent framework using Visa TAP, KYA (Skyfire, Experian), and Auth0/Ping ([PR](https://www.akamai.com/newsroom/press-release/akamai-unveils-agentic-security-framework-to-power-trusted-ai-driven-interactions-and-commerce), 2026-06-15).
  - DataDome joined Experian's Agent Trust ecosystem ([PR](https://www.experianplc.com/newsroom/press-releases/2026/datadome-joins-experian-agent-trust--ecosystem-to-add-continuous), 2026-10-01).
  - HUMAN launched AgenticTrust in 2025. **Details unverified** (403 on its pages).
- **Amazon:**
  - Its robots.txt disallows about 99 AI user agents, including GPTBot, ClaudeBot, PerplexityBot, and Google's agent and shopping agents.
  - It blocked Meta's shopping agent through its Conditions of Use ([SEJ](https://searchenginejournal.com/amazon-blocked-metas-muse-and-robots-txt-had-nothing-to-say/590494), 2026-09).
  - *Amazon v. Perplexity*: a preliminary injunction against Comet was granted in March 2026. The **Ninth Circuit vacated it on 2026-08-04**, finding the user, not Perplexity, accesses Amazon on the current record. The case is back in district court ([Retail Insight Network](https://www.retail-insight-network.com/newsletters/us-court-overturns-amazon-injunction-perplexity), 2026-08-05).
  - Big retailers are hostile to outside agents, which helps the case for a seller-run front door.

## F5: How an agent proves identity and authority

| Mechanism | Proves | Status | Source |
|---|---|---|---|
| **Web Bot Auth** (RFC 9421 signatures, `Signature-Agent` header, keys at `/.well-known/http-message-signatures-directory`) | Which operator sent the request | IETF WG draft `draft-ietf-webbotauth-httpsig-protocol-00` (2026-09-01). The WG missed its April 2026 milestone. | [datatracker](https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/) |
| Who signs today | OpenAI ChatGPT agent (live key directory at chatgpt.com); Google-Agent (experimental, subset of requests); AWS AgentCore Browser (preview) | Live / experimental | [chatgpt.com directory](https://chatgpt.com/.well-known/http-message-signatures-directory), [Google](https://developers.google.com/crawling/docs/crawlers-fetchers/web-bot-auth) (2026-10-13), [AWS](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-web-bot-auth.html) |
| **Visa Trusted Agent Protocol** | Agent intent, consumer recognition, optional payment info. Built on Web Bot Auth. | Open spec on GitHub since 2025-10-14 | [Visa PR](https://usa.visa.com/about-visa/newsroom/press-releases.releaseId.21716.html), [GitHub](https://github.com/visa/trusted-agent-protocol) |
| **Visa Intelligent Commerce / Connect** | Agent-bound tokenized cards, spend limits. Connect accepts TAP, MPP, ACP, and UCP payments. | Connect is a pilot (2026-04-08) | [Visa PR](https://usa.visa.com/about-visa/newsroom/press-releases.releaseId.22276.html) |
| **Mastercard Agent Pay** | Registered agent keys (Web Bot Auth, `agent-pay-auth` tag), agentic tokens | Live in the US per Mastercard. Primary pages returned 403, so **partly unverified**. | [merchant guide](https://developer.mastercard.com/merchant-cloud/documentation/tutorials-and-guides/agentic-commerce-guide/21/), [Cloudflare blog](https://blog.cloudflare.com/secure-agentic-commerce/) (2025-10-24) |
| **AP2 mandates** | The user's signed authority (checkout/payment mandates as verifiable credentials) | v0.2, donated to FIDO Alliance 2026-04-28 | [Google blog](https://blog.google/products-and-platforms/platforms/google-pay/agent-payments-protocol-fido-alliance/), [ap2-protocol.org](https://ap2-protocol.org/) |
| **KYA tokens** (Skyfire KYAPay `kya+jwt`, Experian Agent Trust) | Human-to-agent binding, payment claims | Individual IETF draft; Experian "being developed" | [draft-skyfire-oauth-kyapay-token-02](https://datatracker.ietf.org/doc/draft-skyfire-oauth-kyapay-token/) (2026-10-02), [Experian](https://www.experianplc.com/newsroom/press-releases/2026/experian-announces-agent-trust-to-power-trusted-ai-driven-commer) (2026-04-30) |
| **MCP OAuth** | Which client/user is calling our server | Spec 2026-07-28 (stateless, CIMD client IDs; Dynamic Client Registration deprecated). Client-credentials extension (M2M) is a draft. | [MCP versioning](https://modelcontextprotocol.io/specification/versioning), [auth spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [client credentials ext](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials) |

The Web Bot Auth draft states plainly that a valid signature does not establish that the operator is honest or authorized. **Unverified:** whether ChatGPT or Claude sign their MCP connector calls with Web Bot Auth. The evidence we found covers browsing traffic only.

**For our front door:**
- Identify the buyer agent's operator with MCP OAuth (a CIMD `client_id`, or client credentials with a JWT assertion).
- Treat the payment credential (SPT limits and `agent_details`) as the proof of spend authority.
- Web Bot Auth verification is a stretch goal.

## C1: Turning an agreed deal into a Stripe payment

**Shared Payment Tokens** ([Stripe SPT docs, seller](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens.md?agent-seller=seller), accessed 2026-10-17):
- **What it is.** The buyer's agent issues an `spt_…` token to the seller's Stripe profile. It carries `usage_limits` (currency, `max_amount`, `expires_at`) and `agent_details`.
- **How the seller charges it.** Create a PaymentIntent with `payment_method_data[shared_payment_granted_token]=spt_…` and `confirm=true`. Refunds and reporting then work as normal.
- **Test mode.** A test helper mints tokens: `POST /v1/test_helpers/shared_payment/granted_tokens` ([API ref](https://docs.stripe.com/api/shared-payment/granted-token/create)).
- **Status.** Shipped in the 2026-04-22.preview release ([changelog](https://docs.stripe.com/changelog/dahlia/2026-04-22/shared-payment-granted-token)). Current docs use `2026-09-30.preview` and require accepting preview seller terms. Available in the US, CA, and about 30 European countries. Minimum $0.50.
- **Unverified:** whether any approval is needed beyond the preview terms.
- **Buyer side.** `POST /v1/shared_payment/issued_tokens`, or the Link CLI / Link Agent Wallet, where the human approves a spend request ([agent docs](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens.md?agent-seller=agent)).

**ACP** ([GitHub](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol), accessed 2026-10-17):
- Latest stable version is 2026-04-17.
- The seller implements `POST /checkout_sessions`, `POST /checkout_sessions/{id}` (update), `GET`, `/complete`, and `/cancel`. Delegated payment returns a token capped by an `allowance`.
- **2026-04-17 added an MCP binding** with tools `create_/get_/update_/complete_/cancel_checkout_session` ([changelog](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/changelog/2026-04-17.md)).
- We can name our closing tools to match it.

**Checkout Sessions / Payment Links:**
- Both take `line_items[].price_data.unit_amount`, so any negotiated amount works without creating catalog prices.
- Sessions expire in 30 minutes to 24 hours ([API ref](https://docs.stripe.com/api/checkout/sessions/create.md)).
- They need someone to open the hosted page. The Link Agent Wallet can give an agent a Link Pay Token that completes Stripe-hosted checkouts after the human approves ([docs](https://docs.stripe.com/agentic-commerce/agents/link-agent-wallet/use-link-wallet-pay-online.md)).

**Other rails:**
- **Machine Payments Protocol (MPP):** Stripe + Tempo, HTTP 402, launched 2026-03-18. Accepts SPTs and stablecoins ([Stripe MPP docs](https://docs.stripe.com/payments/machine/mpp.md)).
- **x402** on Base through Stripe ([docs](https://docs.stripe.com/payments/machine/x402.md)). Stablecoins need Stripe approval.
- **Issuing for agents:** single-use virtual cards, preview ([docs](https://docs.stripe.com/issuing/agents)).
- **Stripe MCP server** (`mcp.stripe.com`): creates Checkout Sessions and Payment Links. Requires agent-tagged keys after 2026-11-30 ([docs](https://docs.stripe.com/mcp)).
- **Order Intents:** docs page returns 404. Likely retired or renamed (**unverified**).

## Recommendation for the build

| Option | Human step? | Status | Effort |
|---|---|---|---|
| **SPT → PaymentIntent** (primary) | No, apart from occasional 3DS | Preview API, test helper available | Low |
| **Checkout Session with `price_data`** (fallback) | Yes, someone pays on the hosted page | GA | Lowest |
| MPP endpoint | No | Available | Medium (HTTP, not MCP) |
| Full ACP checkout endpoints | No | Stable spec, thin buyer adoption | High |

Flow:
1. The negotiation ends with a quote: `{deal_id, amount, currency, seller_profile, expires_at}`.
2. The buyer sends an SPT with `max_amount = amount` to `pay_deal(deal_id, spt)`.
3. We check the limits and the expiry.
4. The policy engine re-checks the deal.
5. We create and confirm the PaymentIntent and return its status.
6. If the buyer has no SPT, we return a Checkout Session URL and wait for `checkout.session.completed`.

For experiments, keep the mock (C2) but give it the same shape. **Unverified:** whether a buyer in a different Stripe sandbox can issue an SPT to our test profile.

## Effect on our assumptions

- **A1 (need to paid order, no human UI):** feasible in principle with SPTs. In practice today, most real buyer-agent payment flows still have a human approve a spend request (Link wallet, AP2 human-present). "No human UI" should read as "no human browsing", not "no human approval".
- **A12:** supported. Identity (MCP OAuth, Web Bot Auth) and payment (SPT, ACP-style checkout tools) are standard layers we can adopt. Nothing here touches negotiation.
- **New risk:** Stripe SPTs and Agentic Commerce are preview. Don't depend on live SPT issuance from real buyer agents for a demo.
