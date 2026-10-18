# Discovery: how buying agents find sellers (G5, D1)

> E8 research, 2026-10-17. Pages without a date of their own are marked "accessed 2026-10-17".

## Answer

**Today, consumer buying agents find sellers through platform-held catalogs and feeds, not by crawling seller endpoints.** The catalogs and feeds are:
- OpenAI's ACP product feed
- Google Merchant Center / Shopping Graph (with UCP for checkout)
- Shopify Catalog
- Microsoft's Copilot Merchant Program
- PayPal store sync (Perplexity)
- Klarna's product API

Web search is the fallback. In ChatGPT it is losing ground fast to feeds.

**We found no evidence that any consumer shopping agent automatically queries:**
- A2A agent cards
- The MCP Registry
- llms.txt
- `/.well-known/` MCP server cards

The standards exist, but they are mostly used for developer tools and enterprise agent catalogs.

**The one live path from a merchant's own domain to a buying agent over MCP is UCP.** A `/.well-known/ucp` profile can list an `mcp` transport, and Shopify serves UCP-over-MCP for every store.

**For us:** our local registry file is a fair stand-in for E1/E7. But the realistic go-to-market discovery path is: get into the feeds, publish `/.well-known/ucp` and an A2A card, and become a ChatGPT/Claude app. **No standard field says "this seller negotiates."**

## Mechanisms

| Mechanism | What it is | Status (Oct 2026) | Do buying agents use it? |
|---|---|---|---|
| **Product feeds (ACP)** | Merchant pushes a catalog (`item_id, title, price, availability, …`, plus `is_eligible_checkout`) to OpenAI over SFTP, at least daily ([feed spec](https://developers.openai.com/commerce/specs/feed)) | Live. Since 2026-03-24 ACP also carries catalogs and promotions for discovery; Target, Best Buy, Home Depot, Wayfair and others integrated; Shopify merchants auto-connected ([The Decoder](https://the-decoder.com/chatgpt-is-turning-into-a-shopping-platform-with-product-images-prices-and-comparisons-but-no-checkout/), 2026-03-24) | **Yes, the main path into ChatGPT.** Non-Shopify/Etsy merchants go through a waitlist ([ALM Corp](https://almcorp.com/news/chatgpt-shopping-pulls-product-picks-merchant-feeds/), 2026-10-08) |
| **Google Merchant Center + Shopping Graph** | Feeds plus crawl; 50B+ listings, 2B updated per hour ([Google](https://blog.google/products-and-platforms/products/shopping/agentic-checkout-holiday-ai-shopping/), 2025-11-13) | Live. UCP checkout onboarding uses existing Merchant Center feeds (waitlist, early access) ([Merchant UCP](https://developers.google.com/merchant/ucp)) | **Yes** for AI Mode and Gemini. Google says no special markup or files are needed ([AI features doc](https://developers.google.com/search/docs/appearance/ai-features), 2025-12-10) |
| **Shopify Catalog / UCP MCP** | Global Catalog, Storefront Catalog, Cart/Checkout/Order MCP servers implementing UCP. Agents authenticate with a hosted profile; trust tiers ([shopify.dev/docs/agents](https://shopify.dev/docs/agents)) | Live. Endpoints moved to `/api/ucp/mcp` ([Storefront MCP](https://shopify.dev/apps/build/storefront-mcp/servers/storefront)) | **Yes:** feeds ChatGPT, Copilot, AI Mode, Gemini |
| **`/.well-known/ucp`** | Business profile listing transports (REST, **MCP**, **A2A**, embedded), capabilities, payment handlers, and signing keys ([UCP spec](https://ucp.dev/latest/specification/overview/), v2026-08-25) | Live spec | Used by Google and Shopify surfaces. **The best place to advertise our MCP endpoint.** |
| **`/.well-known/acp.json`** | ACP discovery file, added 2026-04-17 ([ACP changelog](https://raw.githubusercontent.com/agentic-commerce-protocol/agentic-commerce-protocol/main/changelog/2026-04-17.md)) | Live spec | Unclear. No evidence of crawling. |
| **A2A agent card** | `https://{domain}/.well-known/agent-card.json`; v1.0 adds `supportedInterfaces[]` and optional JWS signatures ([discovery](https://a2a-protocol.org/latest/topics/agent-discovery/), [v1.0](https://a2a-protocol.org/latest/whats-new-v1/)) | Live spec. The spec says there is no standard registry API yet. Google Cloud Agent Registry indexes cards, but per project ([docs](https://docs.cloud.google.com/agent-registry/json-schemas), 2026-10-13) | **No evidence** that ChatGPT, Gemini, Perplexity, or Copilot read merchant agent cards. Inkbox runs a public A2A directory ([stack.md](stack.md)). |
| **MCP Registry** | Official catalog at registry.modelcontextprotocol.io; `server.json` with `remotes[{type:"streamable-http",url}]`; namespace verified by DNS/HTTP/GitHub ([README](https://github.com/modelcontextprotocol/registry)) | **Still preview**, API frozen at v0.1 since 2025-10-24 ([launch post](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/), 2025-09-08) | Meant to feed client marketplaces, not shopping agents directly. No evidence of automatic queries. |
| **MCP Server Cards (SEP-2127)** | Pre-connection metadata, a subset of `server.json` | Accepted 2026-10-05. Exact path (`/.well-known/…` vs `<mcp-url>/server-card`) still in flux ([PR](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127)) | Too new; no clients found |
| **ARD (Agentic Resource Discovery)** | `/.well-known/ard.json` (successor to `ai-catalog.json`), JSON-LD entries for MCP server cards and A2A cards, registries with `POST /search` ([spec v0.91](https://agenticresourcediscovery.org/spec/), 2026-08-26) | Proposal. Authors from Google and Hugging Face, plus R.V. Guha. No commerce fields. | No |
| **llms.txt** | Markdown summary for LLMs | 28% of 137k domains publish one; **97% got zero requests** in May 2026; the main readers are coding agents ([Ahrefs](https://ahrefs.com/blog/llmstxt-study/), 2026-06-15) | No, for shopping |
| **schema.org Product/Offer** | Structured data on pages | Google: no special schema is needed for AI features (same doc). ChatGPT used "structured metadata" from providers ([Botify](https://www.botify.com/insight/what-we-have-learned-about-chatgpt-enhanced-shopping-experience), 2025-05-05) | Indirectly, via search indexes and feeds. No study measures its effect. |
| **Web search / crawl** | Bing, Google, and OpenAI's own index; OAI-SearchBot must be allowed | Profound tracking: the share of ChatGPT product picks coming from feeds jumped from 8% to 62% on 2026-07-10, and reached ~65% by September. Top-10 merchants' share of references rose from 22.5% to 41.8% ([ALM Corp citing SEJ](https://almcorp.com/news/chatgpt-shopping-pulls-product-picks-merchant-feeds/), 2026-10-08) | Yes, but shrinking relative to feeds. **Third-party tracking data, not OpenAI's.** |
| **Other directories** | AGNTCY Agent Directory (open-source, OASF records); NANDA index (MIT research pilot); Stripe Directory (preview, dev services); Pier39 Nash directory (`/.well-known/negotiate.json`) | Early / niche | No consumer agent uses them |

## What this means for each discovery path we could build

1. **Feeds (realistic go-to-market).** Getting into ChatGPT, Google, and Copilot means submitting product feeds. A feed carries a **fixed price**, so a negotiating seller would list at (or near) list price H and negotiate after first contact. The feed is the bait, not the deal.
   - ACP feeds already carry promotions.
   - Google Direct Offers lets merchants preset discounts that Google's AI shows when relevant.
   - Both are fixed, merchant-set levers, not haggling.
2. **UCP profile + MCP transport.** Publish `/.well-known/ucp` listing our MCP endpoint. This is the standard way a seller's domain points an agent at its MCP server. Negotiation tools would be non-standard extras on that server.
3. **Agent card + Inkbox directory.** Cheap to add and helps the marketplace experiments, but no mainstream buying agent reads them yet.
4. **ChatGPT / Claude app.** OpenAI moved purchases into merchant ChatGPT apps (MCP-based) in March 2026 ([Digital Commerce 360](https://www.digitalcommerce360.com/2026/03/06/openai-shifts-checkout-plans-agentic-commerce-strategy/), 2026-03-06). A merchant app *is* an MCP front door that the user explicitly adds. The catch: the user (or the assistant's app directory) has to pick our app, so this is opt-in discovery.

## Gaps and risks

- **No "negotiable" signal anywhere.** No field in agent cards, UCP profiles, ACP feeds, or server cards tells a buyer that a seller will haggle. D3 (what the card should say) is an open design question, and the answer is ours to propose.
- **Concentration.** Feed-based discovery is shifting share toward big merchants (top-10 share nearly doubled in ChatGPT). A small merchant's negotiating agent may not get found at all without the feeds.
- **Card-text steering (D4) is real.** Seller-written descriptions moved agent choice by up to ~15 points in the ACES study ([arXiv 2508.02630](https://arxiv.org/abs/2508.02630), 2025). We saw prompt-injection text aimed at agents on two vendor sites while doing this research ([stack.md](stack.md)).

## Unverified

- MCP Registry size (~17k servers, July 2026).
- The IETF MCP discovery drafts and SEP-1960 (`/.well-known/mcp`): snippets only.
- Whether ChatGPT/Gemini read `/.well-known/acp.json` or ARD files.
- Shopify "Agentic Storefronts default-on, March 2026": third-party sources only.

## Effect on our assumptions

- **A12:** supported for discovery. Every mechanism we planned exists as a standard, and UCP gives a standard pointer to an MCP endpoint.
- **A2 / G3 (buyers use the endpoint if there is one):** **at risk in the real world.** Live agents mostly don't look for seller endpoints; they read feeds and pages, or use apps the user installed. E1/E7 can show buyers *prefer* an endpoint when it's in front of them. Getting in front of them is a distribution problem the harness doesn't test.
