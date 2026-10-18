# E8 research: protocol, discovery, and prior-work landscape

> Online research, done 2026-10-17. Each file starts with its answer, then the evidence, with sources and dates inline. Claims we couldn't verify are flagged in each file. Part of the research ran out of web-search budget, so a few items rest on secondary sources only (marked there).

| File | Questions |
|---|---|
| [protocols.md](protocols.md) | G4, F6 |
| [discovery.md](discovery.md) | G5, D1 |
| [buying-agents.md](buying-agents.md) | B10, H1 |
| [identity-and-payments.md](identity-and-payments.md) | F5, C1 |
| [a2a-stripe-flow.md](a2a-stripe-flow.md) | Craigslist A2A: buyer pay paths, Connect, identity, pickup |
| [stack.md](stack.md) | G8 |
| [rl-negotiation.md](rl-negotiation.md) | R11 (plus R5, R8, R12) |

## Answers

**G4: Where we sit relative to the protocols.**
- No major protocol covers price negotiation: MCP, A2A, ACP, AP2, UCP, x402, Visa, Mastercard, and Shopify all leave it out. Their "negotiation" means matching capabilities or versions.
- We sit on top: an MCP front door, our own negotiation tools, and a hand-off of the agreed price to standard checkout (ACP/UCP session or a UCP locked discount code), paid with a Stripe Shared Payment Token.
- The closest prior art:
  - Pier39's Nash, a small open seller-agent negotiation protocol from May 2026.
  - IAB Tech Lab's Seller Agent, which does quote/counter over MCP for ad deals.
  - ACP's Intent Traces RFC, which names future bidding and reconsideration offers.

**G5 / D1: How buyers find sellers.**
- Mostly through platform catalogs and feeds: the ACP feed, Google Merchant Center, Shopify Catalog, the Copilot and PayPal programs. Web search is the fallback.
- We found no evidence that consumer agents read A2A cards, the MCP Registry (still preview), or llms.txt (97% of files got zero requests).
- The standard way for a seller domain to point at its MCP endpoint is a `/.well-known/ucp` profile.

**B10: How live agents shop.**
- Three routes: feeds plus platform checkout (Google UCP, Copilot, Perplexity/PayPal), browser automation (ChatGPT agent, Comet, Claude in Chrome, Amazon Buy for Me), and MCP-based merchant apps.
- ChatGPT's Instant Checkout was scaled back in March 2026 in favor of merchant apps.
- None of them haggles. The nearest are price-target auto-buy (Amazon, Google) and merchant-preset offers (Google Direct Offers).

**F5: Detection and identity.**
- Sites block agents at the CDN, bot-management, and terms-of-service layers: Cloudflare, Akamai, DataDome, Amazon.
- Web Bot Auth (an IETF WG draft, Sept 2026) proves which operator sent a request. ChatGPT agent signs today; Google is experimenting.
- Authority to spend comes from payment credentials instead: SPT limits, Visa TAP and Mastercard Agent Pay tokens, AP2 mandates (now at FIDO).
- On our own MCP server, MCP OAuth identifies the client.

**F6: Remote vs local MCP.**
- ChatGPT, Claude, Copilot, Perplexity, Cursor, VS Code, and OpenAI's API all support remote MCP over Streamable HTTP with OAuth. ChatGPT supports remote only.
- Our `claude -p` stdio harness is fine for experiments. A demo needs public HTTPS with OAuth 2.1.

**C1: Deal to Stripe payment.**
- Primary: the buyer agent issues a Shared Payment Token capped at the agreed total, and we charge it with a PaymentIntent. This is a preview API, with a test helper for minting tokens.
- Fallback: a Checkout Session with a `price_data` amount, which a human pays.
- The price must be final before the token is minted, so negotiation ends before checkout starts.

**G8: Inkbox, Primitive, Manufact, Stripe.**
- **Inkbox** (inkbox.ai, YC S26): agent identities with A2A 1.0 endpoints and a public agent directory.
- **Primitive** (primitive.dev): email-based agent-to-agent messaging, plus invite-only x402 payments.
- **Manufact** (formerly mcp-use): an MCP framework and hosting, which is the obvious host for our front door.
- All three have open signup and free tiers. None negotiates. Inkbox has no broker or fan-out.

**R11: Credit assignment and prior work.**
- Keep "policy picks the move, LLM writes the message". It is the best-supported design (He 2018, OG-Narrator, CICERO); word-level RL drifts.
- Start with a bandit over whole strategies, then tabular Q with Monte Carlo returns. Add counterfactual per-move rollouts against scripted buyers and a critic that sees the buyer's walk-away price, used as potential-based shaping.
- Penalize rule-breaking and bad deals below the walk-away reward. A reward that scores both as 0 teaches the seller to close at any price.

**H1: Buyer behaviors to simulate.**
- First-proposal bias (60–100%), choice overload, position and endorsement effects, anchoring and splitting the difference, budget leaking under questioning, early settling, large gaps between models, and walk-aways from stubborn sellers.
- That last one is the behavior whose absence broke earlier RL negotiators when they met humans.
- [buying-agents.md](buying-agents.md) proposes 8 personas.

## Verdict on A12

**Validated, with two caveats.**

A12 says our setup fits the existing protocol landscape instead of fighting it. E8's criterion: validated if our components map onto existing standards with a clear gap for the selling agent; invalidated if an existing protocol already covers seller-side negotiation.

**Why it's validated:**
- Every component except the selling agent and the policy engine maps onto a standard:
  - Discovery: A2A cards, `/.well-known/ucp`, product feeds.
  - Front door: MCP 2026-07-28.
  - Checkout: ACP's MCP checkout tools or UCP checkout.
  - Payment: Stripe SPT.
  - Identity: MCP OAuth, Web Bot Auth.
- None of the widely adopted protocols (ACP, UCP, AP2, A2A, MCP, x402, card-network specs) defines offers, counteroffers, or bilateral price negotiation. A third-party capability mapping (ACWorld, Aug 2026) reached the same conclusion.

**Caveats:**
1. **The concept isn't unique.**
   - Pier39's `nash.v1` is an open (MIT) protocol and seller agent that haggles with shopper agents over HTTP and MCP, with a hidden floor and its own directory.
   - It's tiny, self-reported, free-text only, and has no checkout. We don't count it as an established protocol, but it is a direct competitor.
   - IAB Tech Lab's Seller Agent already does quote/counter over MCP for advertising.
2. **The gap may close.** ACP's Intent Traces RFC explicitly names future reconsideration offers and bidding. OpenAI and Stripe could standardize a merchant counteroffer step. We should design our offer tools so they could become an ACP/UCP extension rather than compete with one.

## Findings that change or challenge A1–A11

| # | Finding | Effect |
|---|---|---|
| A1 | Real agent payment flows still put a human approval step before payment (Link wallet spend requests, AP2 human-present, ChatGPT agent handoffs). SPTs are a preview API. | Weakens "no human UI" as stated. Reframe as "no human browsing", and model an approval step. |
| A2 / G3 | Live agents find sellers through platform feeds, not seller endpoints. No consumer agent is known to read agent cards or MCP registries. | **Challenged for the real world.** E1/E7 can show preference when an endpoint is offered. Getting offered is a distribution problem (feeds, UCP profile, ChatGPT/Claude app) the harness doesn't test. |
| A3 | Agent buyers have strong first-proposal and seller-copy biases. | A seller-agent edge may partly come from exploiting buyer biases, which bears on "safe" (G6/H6). |
| A4 | No live consumer agent haggles. LLM buyers often accept the first proposal. Prompting "negotiate aggressively" had no significant effect (Anthropic Project Deal). | **Weaker prior.** Expect low counteroffer rates unless negotiation is advertised. E3 matters more. |
| A5 | Prompt-only sellers give discounts and sell below cost (Project Vend; Zhu et al. found below-cost deals). Recent RL work had to block below-cost seller turns in code. | Supported |
| A6 | Benchmarks: aggressive anchoring plus calibrated concession plus patience gave both the best surplus and the best deal rate; quick conceders did worst (Bergemann et al. 2026). No single strategy wins everywhere (ANAC). | Supported. Also suggests strategy should adapt to the buyer type. |
| A7 | RL negotiators repeatedly learned stubbornness that worked on simulators and failed on humans (Lewis 2017, He 2018). Some 2026 RL gains were small or concentrated on the training buyer's model family. | **Caution.** Scripted buyers must walk away from stubborn sellers. Validate against LLM buyers from several families. A bandit over strategies is the safer first bet. |
| A8 | First-proposal bias rewards whoever responds first. Feed-based discovery concentrates share in big merchants (ChatGPT's top-10 merchant share went from 22.5% to 41.8%). | Response speed is a confound in E7. Small merchants may not be found at all. |
| A9 | Choice and negotiation behavior differ sharply across models and versions (ACES, Magentic Marketplace, Zhu et al.). | **At risk.** Expect model-specific results; test at least two model families. |
| A10 | No direct data found on model cost vs. margin per negotiation. | No change |
| A11 | MCP 2026-07-28 is stateless: no session header, and cross-call state must be server-minted handles passed as tool arguments. Reference tool sets exist (ACP's MCP checkout tools; IAB's `request_quote`/`approve_or_reject`; Nash's free-text chat). | Our F4 plan ("session ID per buyer") must pass `negotiation_id` as a tool argument. Gives E1 two real-world designs to compare. |
| E7 / K4 | Inkbox has no broker or fan-out; each A2A task goes to one agent. | The broker must be our own code on top of Inkbox's directory. |
