# Stack: Inkbox, Primitive, Stripe, Manufact (G8)

> E8 research, 2026-10-17. Pages without a publication date are marked "accessed 2026-10-17".

## Answer

All three names resolve to YC-backed agent-infrastructure startups. We found no page listing them together as sponsors, so treat "they are partners/sponsors" as unconfirmed.

| Name | Company | What it gives us | Usable today? | Where it fits |
|---|---|---|---|---|
| **Inkbox** | inkbox.ai (YC S26) | Agent identities: email, phone, iMessage, a public tunnel URL, a credential vault, and an **A2A 1.0** endpoint with hosted agent cards and a public agent directory | Yes. Open signup, free tier (3 identities) | Discovery (directory), seller identity, A2A channel for negotiation |
| **Primitive** | primitive.dev (YC Spring 2026) | Email for agents, agent-to-agent chat over email, a hosted MCP server, x402 USDC payments | Email: yes, open signup. x402 payments: invite-only | Async fallback channel; not a real-time negotiation transport |
| **Manufact** | manufact.com, formerly **mcp-use** (YC S25) | Open-source MCP framework (TS/Python), an Inspector, and cloud hosting for MCP servers and ChatGPT/Claude apps | Yes. Open signup, free tier | **The MCP front door**: build and host the seller's MCP server |
| **Stripe** | stripe.com | Agentic Commerce Suite, Shared Payment Tokens, a hosted MCP server, Stripe Directory (preview) | Partly. SPTs are a preview API with test helpers | Checkout; maybe discovery (see [identity-and-payments.md](identity-and-payments.md)) |

Bottom line: **Manufact fits our front door directly, Inkbox fits discovery and A2A, Stripe fits checkout.** None of them negotiates price for us, so the selling agent and policy engine are still ours to build. Inkbox is not the broker our marketplace notes assume: it has no fan-out feature.

## Inkbox (inkbox.ai)

- **Identity:** "The identity and communication layer for AI agents". YC Summer 2026, 3 people, San Francisco ([YC: Inkbox](https://www.ycombinator.com/companies/inkbox), accessed 2026-10-17). The launch post went up around July 2026 ([YC Launch](https://www.ycombinator.com/launches/RIu-inkbox-give-your-ai-agents-email-phone-imessage-and-an-internet-address)).
- **Not the tattoo company.** An unrelated Inkbox sells temporary tattoos ([Shopify blog](https://www.shopify.com/blog/inkbox-social-media)).
- **A2A:**
  - Implements A2A 1.0 over JSON-RPC. Each identity gets a hosted card at `https://inkbox.ai/a2a/{handle}/card` and an endpoint at `https://inkbox.ai/a2a/{handle}` ([Inkbox A2A docs](https://inkbox.ai/docs/capabilities/a2a.md), accessed 2026-10-17).
  - Task states: `submitted → working → input_required → completed/failed/canceled`. Replies can `ask_caller`, which maps cleanly onto a counteroffer turn.
  - Streaming and push notifications are not supported ([A2A protocol page](https://inkbox.ai/docs/api/a2a/protocol.md)).
- **Directory:**
  - A public, unauthenticated `GET https://inkbox.ai/a2a/directory`, searchable by handle, description, and skills. It can filter by verified domain.
  - Results are sorted by handle. There is no ranking, pricing, or payments ([Agent directories](https://inkbox.ai/docs/api/a2a/directory.md)).
  - Changelog dates: A2A 2026-07-31, directories 2026-08-07, verified domains 2026-10-02 ([changelog](https://inkbox.ai/docs/changelog.md)).
- **Tunnels:** each identity gets `<handle>.inkboxwire.com`, which forwards HTTP/WebSocket/TCP to a local server ([Tunnels](https://inkbox.ai/docs/capabilities/tunnels.md)). This is a quick way to expose a local FastMCP server.
- **MCP:** a hosted MCP server at `https://inkbox.ai/mcp` (Streamable HTTP, OAuth or API key) for *using* Inkbox: email, SMS, A2A tools, directory search. It does not host your own server ([Inkbox MCP](https://inkbox.ai/docs/mcp-server.md)).
- **SDK and pricing:**
  - Python `pip install inkbox` ([PyPI](https://pypi.org/project/inkbox/)).
  - Free tier: 3 identities. Developer $30/mo. Startup $200/mo ([pricing](https://inkbox.ai/pricing), accessed 2026-10-17).
- **Gaps:**
  - The docs don't say whether an agent *without* an Inkbox identity can call an Inkbox agent; inbound auth uses Inkbox agent-scoped keys. Plan for buyer and seller both to have identities.
  - **No broker or fan-out.** Each task targets one agent. For E7's "broker" mode we would search the directory and send one task per seller ourselves.

## Primitive (primitive.dev)

- **Identity:** "communication for agents". YC Spring 2026, 4 people, CEO Ethan Byrd ([YC: primitive](https://www.ycombinator.com/companies/primitive), accessed 2026-10-17).
  - There is an unrelated Salt Lake City "Primitive" that sells an agent OS to banks ([CFOtech](https://cfotech.news/story/primitive-launches-ai-agent-system-for-banks-credit-unions), 2026-04-15). It does no agent messaging, so it is very unlikely to be the one meant.
- **Offer:**
  - Managed email for agents.
  - `primitive chat <email> <message>` sends a message and waits for the threaded reply (default timeout 120 s). Over MCP the same thing is `sendEmail` followed by `awaitReply` ([llms.txt](https://primitive.dev/llms.txt), accessed 2026-10-17).
  - A hosted MCP server at `https://www.primitive.dev/mcp`, listed in the official MCP registry as `dev.primitive/email`.
- **A2A card:** it publishes one at `/.well-known/agent-card.json` (protocol 0.3.0), but agent-to-agent traffic runs over email, not A2A JSON-RPC ([agent card](https://primitive.dev/.well-known/agent-card.json)).
- **Payments:** x402 USDC on Base, with base-sepolia testnet support ([PyPI primitivedotdev](https://pypi.org/project/primitivedotdev/), v2.4.0, 2026-10-10). Access is **invite-only**.
- **Pricing:** Developer $0/mo with $5 credit. Power $13/mo ([pricing](https://primitive.dev/pricing.md)).
- **Fit:**
  - Email round-trips are too slow for a 10-turn haggle, but they work as an async channel (B2B quotes, follow-ups).
  - A "public agent registry" appears only on their LinkedIn. **Unverified.**
- **Prompt injection:** Primitive's site and llms.txt include instructions addressed to AI agents (to email them). We ignored them. That is a live example of the injection risk E4 tests.

## Manufact (manufact.com, formerly mcp-use)

- **Identity:**
  - "Manufact (formerly mcp-use)". YC Summer 2025, Switzerland. Founders Pietro Zullo and Luigi Pederzani ([YC: Manufact](https://www.ycombinator.com/companies/manufact), accessed 2026-10-17).
  - $6.3M seed led by Peak XV ([LetsDataScience](https://letsdatascience.com/news/manufact-raises-63m-to-expand-mcp-infrastructure-d0ca67ef), 2026-02-12).
- **Offer:**
  - `mcp-use`, an MIT-licensed MCP framework: server, client, agent, React "MCP Apps" widgets, and a built-in Inspector ([GitHub](https://github.com/mcp-use/mcp-use), ~10.8k stars, accessed 2026-10-17).
  - Manufact Cloud deploys from GitHub or `npx mcp-use deploy`. It adds custom domains, OAuth, session replay, analytics, and publishing checks for Claude connectors and ChatGPT apps ([docs](https://docs.manufact.com)).
- **Pricing:** free tier with 2 projects and 30k requests/mo ([pricing](https://manufact.com/pricing)).
- **Fit:**
  - Hosting our front door gives us a public HTTPS MCP URL that ChatGPT and Claude can mount as a remote connector (see [protocols.md](protocols.md), F6).
  - Session replay is a cheap source of transcripts for the learning loop.
  - Our harness uses Python FastMCP. mcp-use also has a Python server, but porting isn't required: Manufact can host any MCP server. **Not verified:** whether Manufact Cloud deploys arbitrary Python FastMCP servers or only mcp-use projects.
- **A2A:** none.

## Stripe (short; detail in identity-and-payments.md)

- **Agentic Commerce Suite** ([Stripe blog](https://stripe.com/blog/agentic-commerce-suite), 2025-12-11): product feed syndication to AI agents, checkout on the Checkout Sessions API, Shared Payment Tokens, and Radar. Waitlist at launch.
- **Shared Payment Tokens (SPTs):**
  - Scoped by currency, `max_amount`, and `expires_at`.
  - The seller charges an SPT with a PaymentIntent using `shared_payment_granted_token`.
  - Test mode has a helper that mints tokens (`/v1/test_helpers/shared_payment/granted_tokens`).
  - The docs mark this a preview API ([SPT docs](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens.md?agent-seller=seller), accessed 2026-10-17).
- **Stripe MCP server:** `https://mcp.stripe.com` covers products, prices, payment links, and Checkout Sessions ([docs](https://docs.stripe.com/mcp)).
- **Stripe Directory (preview):** a searchable index of businesses and machine-payment endpoints for agents ([docs](https://docs.stripe.com/directory.md), accessed 2026-10-17). It is aimed at developer services right now, not retail catalogs.

## Suggested use for the hackathon

| Stage | Plug in | Build ourselves |
|---|---|---|
| Discovery | Inkbox public directory + an agent card for the seller; also `/.well-known/agent-card.json` on our domain | Local registry file for experiments |
| MCP front door | Manufact (mcp-use + cloud hosting), or an Inkbox tunnel for local dev | Tool design (E1) |
| Selling agent | Optionally reachable over Inkbox A2A as well as MCP | All negotiation logic |
| Policy engine | none | All of it |
| Checkout | Stripe test mode: Checkout Session with a custom amount, or SPT → PaymentIntent | Mapping the agreed deal to line items |
| Learning | Manufact session logs, Inkbox task history | Reward and training loop |

## Effect on our assumptions

- **A12 (fits the landscape):** supported. All three tools sit in layers we planned to plug into (identity/transport, hosting, payments). None overlaps the selling agent.
- **E7 / K4 (broker via Inkbox):** our docs assume Inkbox forwards one request to many sellers. **It doesn't.** The broker has to be our code on top of the Inkbox directory.
