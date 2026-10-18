# Protocol landscape (G4, F6)

> E8 research, 2026-10-17. Specs and docs without a date of their own are marked "accessed 2026-10-17".

## Answer

**G4: No major agentic-commerce protocol covers seller-side price negotiation.**
- MCP, A2A, ACP, AP2, UCP, x402, Visa TAP/Intelligent Commerce, Mastercard Agent Pay, and Shopify's agent stack cover discovery, catalog, cart, checkout, payment, identity, and mandates.
- When they say "negotiation" they mean matching capabilities or versions, not price.
- An August 2026 paper mapped 80 commerce capabilities against ACP, UCP, and AP2 and found no direct analogue for bilateral negotiation ([Agentic Commerce World, arXiv 2608.02441](https://arxiv.org/abs/2608.02441), 2026-08-03).

**The closest existing things:**
1. **Pier39's Nash (`nash.v1`, formerly `negotiate.v1`)**: a small open protocol plus a seller agent that haggles with shopper agents. This is a **direct competitor to our idea**, with no evidence of adoption.
2. **IAB Tech Lab's Seller Agent**: quote/counter over MCP, but for ad inventory.
3. **Merchant-set offer levers**: UCP locked discount codes, Google Direct Offers, and a proposed ACP RFC that names future "reconsideration offers".

**Where we fit:** we sit *on top of* the standards.
- MCP front door (with an optional A2A card).
- Our own negotiation tools.
- Hand off the agreed price to a standard checkout (UCP/ACP session or a locked discount code).
- Pay with a Stripe Shared Payment Token.

**F6:** all the major assistants (ChatGPT, Claude, Copilot, Perplexity, Cursor, VS Code, OpenAI's API) now connect to **remote MCP over Streamable HTTP with OAuth**. ChatGPT supports remote *only*. A public HTTPS front door with OAuth 2.1 reaches all of them.

## The protocols

| Protocol | Backers / governance | Latest | Covers | Negotiation? |
|---|---|---|---|---|
| **MCP** | Agentic AI Foundation under the Linux Foundation; donated by Anthropic ([Anthropic](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation), 2025-12-09) | **2026-07-28**: stateless, no `initialize`, server-minted handles for cross-call state, `server/discover`, Tasks as an extension, MCP Apps for UI ([versioning](https://modelcontextprotocol.io/specification/versioning), [changelog](https://modelcontextprotocol.io/specification/latest/changelog)) | Tools, resources, auth (OAuth 2.1, Client ID Metadata Documents) | No. A transport for our tools. |
| **A2A** | Linux Foundation, 150+ orgs ([LF](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year), 2026-04-09) | **v1.0** (March 2026): signed agent cards, multi-tenancy ([A2A spec](https://a2a-protocol.org/latest/specification/)) | Agent cards, tasks (incl. `INPUT_REQUIRED`), extensions | No. Only content-type and capability negotiation. A custom extension could carry offers. |
| **ACP** (Agentic Commerce Protocol) | OpenAI, Stripe; Meta joining ([GitHub](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol)) | **2026-04-17**: cart, product feed, orders, 3DS, an **MCP binding** (5 checkout tools), `/.well-known/acp.json` ([changelog](https://raw.githubusercontent.com/agentic-commerce-protocol/agentic-commerce-protocol/main/changelog/2026-04-17.md)) | Feed → checkout session → delegated payment; discount extension (2026-01-30) | **No, intent only.** See the Intent Traces RFC below. |
| **AP2** | Google → **FIDO Alliance** (2026-04-28) ([Google](https://blog.google/products-and-platforms/platforms/google-pay/agent-payments-protocol-fido-alliance/)) | **v0.2**: Checkout and Payment mandates, each with open (constraints) and closed (final) forms ([ap2-protocol.org](https://ap2-protocol.org/ap2/checkout_mandate/)) | User authority to buy within limits; A2A extension; x402 extension | No. The merchant signs a final checkout that must fit the buyer's budget constraints. |
| **UCP** (Universal Commerce Protocol) | Google with Shopify, Etsy, Wayfair, Target, Walmart; endorsed by Visa, Mastercard, Stripe and others ([Google](https://developers.googleblog.com/under-the-hood-universal-commerce-protocol-ucp/), 2026-01-11) | **v2026-08-25** ([releases](https://github.com/Universal-Commerce-Protocol/ucp/releases)) | `/.well-known/ucp` profile; catalog, cart, checkout, order, identity linking; REST/MCP/A2A/embedded transports | **Partial.** Merchant-side levers only: the discount extension, eligibility-based provisional discounts, and "locked negotiated discount codes" via `request_constraints` ([spec](https://ucp.dev/latest/specification/overview/), [discount ext](https://ucp.dev/latest/specification/shopping/extensions/discount/)). No offer or counter objects. |
| **x402** | x402 Foundation (Linux Foundation, 2026-04-02) ([LF](https://www.linuxfoundation.org/press/linux-foundation-is-launching-the-x402-foundation-and-welcoming-the-contribution-of-the-x402-protocol)) | v2 spec, 2025-12-09 ([spec](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)) | HTTP 402 pay-per-request; `exact`/`upto` schemes; MCP and A2A transports | No |
| **Visa TAP / Intelligent Commerce** | Visa, with Cloudflare ([Visa](https://usa.visa.com/about-visa/newsroom/press-releases.releaseId.21716.html), 2025-10-14) | Intelligent Commerce Connect pilot accepts TAP/MPP/ACP/UCP (2026-04-08) | Agent identity on Web Bot Auth, agent-bound tokens | No |
| **Mastercard Agent Pay** | Mastercard | Agentic tokens; Verifiable Intent (2026-03) heading to FIDO | Tokens, intent records, risk scores | No. Primary pages blocked (403); based on investor-relations PDFs and press. |
| **Shopify agent stack** | Shopify (UCP co-developer) | Catalog, Cart/Checkout/Order MCP servers implementing UCP ([shopify.dev/docs/agents](https://shopify.dev/docs/agents)) | Product search, checkout | No |

Related identity and payment detail: [identity-and-payments.md](identity-and-payments.md). Discovery mechanics: [discovery.md](discovery.md).

## Negotiation-adjacent pieces in the big protocols

- **ACP Intent Traces RFC** (proposal, 2025-12-16):
  - When a buyer agent cancels a checkout, it can send a reason code (`price_sensitivity`, `comparison`, …) plus metadata such as `max_budget` or `competitor_price`.
  - The RFC frames this as a step toward deterministic negotiation by bidding, and says a later RFC may define reconsideration offers.
  - Today the merchant can't respond with a counteroffer ([RFC](https://raw.githubusercontent.com/agentic-commerce-protocol/agentic-commerce-protocol/main/rfcs/rfc.intent_traces.md)).
  - **OpenAI and Stripe plainly see negotiation coming. That is both validation and a threat.**
- **ACP `suggested_price`** (unreleased SEP): lets the buyer pass the feed price it saw. It is for price matching, not bargaining.
- **UCP locked discount codes:** the business can issue a code and require the next request to carry it. A negotiated price could travel this way into a standard UCP checkout.
- **Google Direct Offers** (Ads pilot, 2026-01-11, extended to UCP brands 2026-05-20): merchants preset discounts, and Google's AI decides when to show one in AI Mode ([Google](https://blog.google/products/ads-commerce/agentic-commerce-ai-tools-protocol-retailers-platforms/)). Per-shopper offers, but set by the merchant, not haggled.
- **Google Business Agent:** a branded "sales associate" agent on Search. It is the nearest big-player seller-side agent, but it serves humans and doesn't negotiate (same post).

## Things that do cover negotiation

| What | Status | Notes |
|---|---|---|
| **Pier39 Nash / `nash.v1`** ([protocol spec](https://nash-checkout.pier39.ai/docs/protocol), [overview](https://nash-checkout.pier39.ai/docs/overview), accessed 2026-10-17) | MIT. MCP connector `negotiate-mcp` v0.2.2 on PyPI, first released 2026-05-03 ([PyPI](https://pypi.org/project/negotiate-mcp/)). Hosted at mcp.pier39.ai; listed in the ChatGPT app store, per their docs. | The same concept as ours: a seller agent with a hidden floor, discovery via `/.well-known/negotiate.json` and a directory, and shopper tools (`start_negotiation`, `send_message`). Offers are free text with no machine-readable offer field. No checkout or payment spec. All claims are self-reported; we found no independent coverage, customers, or company info. |
| **IAB Tech Lab Seller Agent / OpenProposal** ([MCP API](https://iabtechlab.github.io/seller-agent/api/mcp/), [press release](https://iabtechlab.com/press-releases/iab-tech-lab-introduces-aamp-3-0-with-openproposal/), 2026-09-22) | Draft, ad tech | A publisher-side agent over Streamable HTTP MCP with `request_quote`, `get_pricing` (tiered by buyer), `approve_or_reject` (including counter), and buyer trust levels (unknown → preferred → blocked). **The best reference design for our front-door tools**, in another industry. |
| AIP (Agent Interaction Protocol) ([pkg.go.dev](https://pkg.go.dev/github.com/narko4u/aip-spec)) | Draft v0.2, Aug 2026, one company | Offer/counter/accept/reject message types. No adoption. |
| IETF PACT draft ([-01](https://datatracker.ietf.org/doc/html/draft-laxsharma-pact-01), Sept 2026) | Individual draft | v00 had a sealed-bid award step; v01 dropped it to focus on liability and settlement. |
| Defensive publication on agent-to-agent negotiation ([TDCommons #11338](https://www.tdcommons.org/dpubs_series/11338), 2026-08-12) | Prior art | Buyer broadcasts constraints; sellers return signed incentive tokens. Relevant to any IP claims. |
| Research environments: ACWorld (`propose_offer`/`counter_offer`), [Magentic Marketplace](https://www.microsoft.com/en-us/research/blog/magentic-marketplace-an-open-source-simulation-environment-for-studying-agentic-markets/) (2025-11-05), [AgenticPay](https://arxiv.org/abs/2602.06008) (2026-02) | Research | Useful message schemas and benchmarks for our harness. |
| Nibble (UK) ([Fortune](https://fortune.com/2024/07/16/negotiating-chatbot-nibble-ai-ecommerce/), 2024-07-16) | Commercial, live | A haggling chatbot for *human* shoppers on Shopify/BigCommerce; ~2% of converted sales. No agent-to-agent support found. |

Demand signal: Forrester predicted that in 2026 at least one in five B2B sellers will have to answer buyer agents with counteroffers from seller-controlled agents ([Forrester](https://www.forrester.com/press-newsroom/forrester-b2b-marketing-sales-product-2026-predictions), 2025-10-28). This is a forecast, not a measurement.

## How our architecture maps

| Our component | Standard to adopt | Our gap |
|---|---|---|
| Discovery | A2A agent card, `/.well-known/ucp`, `/.well-known/acp.json`, product feeds | Signaling "this seller negotiates" (no standard field) |
| MCP front door | MCP 2026-07-28 over Streamable HTTP + OAuth | Negotiation tool design. Use server-minted `negotiation_id`/`offer_id` handles, as the stateless spec expects. |
| Selling agent | none | **All of it** |
| Policy engine | AP2 open mandates give the buyer's limits (if shared) | All of it |
| Checkout | ACP MCP checkout tools or UCP checkout; deliver the price as line items or a locked discount code | Mapping deal → session |
| Payment | Stripe SPT capped at the agreed total | none |

**Caveat:** the SPT's maximum amount is set to the transaction total, so the price must be final before the buyer's agent mints the token. Negotiation has to finish before checkout starts.

## F6: Remote vs local MCP in buyer-side products

| Product | Remote (HTTP) | Local (stdio) | Auth | Source |
|---|---|---|---|---|
| ChatGPT (apps / developer mode) | Yes, **remote only**, Streamable HTTP, public HTTPS | No (tunnel for private servers) | OAuth 2.1 + PKCE; CIMD preferred | [Apps SDK](https://developers.openai.com/apps-sdk/build/mcp-server), [auth](https://developers.openai.com/apps-sdk/build/auth) |
| claude.ai / Desktop / mobile | Yes, connected from Anthropic's cloud; Free plan gets 1 custom connector | Desktop only | OAuth (CIMD/DCR), or none | [Claude docs](https://www.claude.com/docs/connectors/custom/remote-mcp) |
| Claude Code | Yes (HTTP recommended) | Yes | OAuth | [docs](https://code.claude.com/docs/en/mcp) |
| Copilot Studio / M365 Copilot | Yes, Streamable only | No | API key, OAuth, Entra SSO | [Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent) (2026-05-28), [M365](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/build-mcp-plugins) (2026-09-30) |
| Perplexity | Yes, custom remote | macOS only | Not documented | [help](https://www.perplexity.ai/help-center/en/articles/11502712-local-and-remote-mcps-for-perplexity) |
| Cursor, VS Code | Yes | Yes | OAuth | [Cursor](https://cursor.com/docs/context/mcp), [VS Code](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) (2026-10-14) |
| OpenAI Responses API / Agents SDK | Yes | SDK only | Bearer token / headers | [Responses](https://developers.openai.com/api/docs/guides/tools-connectors-mcp), [Agents SDK](https://openai.github.io/openai-agents-python/mcp/) |
| Gemini CLI | Yes | Yes | OAuth + DCR | [docs](https://geminicli.com/docs/tools/mcp-server/) |
| Gemini app / Gemini Enterprise | Reported (2026) | No | OAuth | **Unverified**, secondary sources only |
| AWS Bedrock AgentCore | Hosts and consumes Streamable HTTP MCP | n/a | JWT/OAuth | [docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html) |

**Implication:** our harness can use local stdio (`claude -p` with a mounted server). A demo against real assistants needs the FastMCP server on public HTTPS with Streamable HTTP and OAuth 2.1 (PKCE, CIMD or DCR, RFC 9728 metadata). Manufact or an Inkbox tunnel can provide the URL ([stack.md](stack.md)). Claude says 2026-07-28 support is still rolling out across its products ([Claude blog](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude), 2026-07-28), so serve the 2025-11-25 handshake too.

## Effect on our assumptions

- **A12: validated, with a caveat.** Every component except the selling agent and policy engine maps onto a standard, and no standard covers negotiation. The caveat: Pier39 shows the concept is already being built, and ACP's RFC shows the protocol owners intend to add bidding or offers. The gap is real but may not stay open long.
- **A11 (tool design matters):** the IAB Seller Agent and Nash give two tested tool sets to compare against (structured quote/counter vs. free-text chat).
