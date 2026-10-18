# How live buying agents shop, and what our simulated buyers should do (B10, H1)

> E8 research, 2026-10-17. Several OpenAI, CNBC and help-center pages returned 403, so some OpenAI claims rest on trade press (marked).

## Answer

**B10: live agents shop three ways:**
1. **Catalogs and feeds plus a platform checkout API** (ChatGPT via ACP, Google AI Mode/Gemini via UCP, Copilot Checkout, Perplexity via PayPal).
2. **Browser automation** of human sites (ChatGPT agent/Atlas, Perplexity Comet, Claude in Chrome, Amazon Buy for Me).
3. **Merchant apps** built on MCP inside the assistant (ChatGPT apps since March 2026).

Purchases still go through a human-approved payment step almost everywhere.

**None of the live consumer agents negotiates price.** The closest behaviors:
- **Price-target auto-buy:** Amazon Auto Buy; Google agentic checkout.
- **Asking stores about price and promotions by phone:** Google's "Let Google Call".
- **Seller-pushed offers:** Google Direct Offers.

Real AI bargaining exists in B2B procurement (Pactum, buyer-side) and niche consumer services (CarEdge for cars).

**H1:** research on LLM shoppers shows consistent, model-dependent biases we should build into simulated buyers:
- strong **first-proposal bias**
- **position and endorsement effects**
- **anchoring and splitting the difference**
- **budget leaking** under questioning
- **settling early**, with large **capability gaps** between models

## B10: Live agents

| Agent | How it shops | Status | Negotiates? |
|---|---|---|---|
| **ChatGPT shopping / shopping research** | Product feeds (ACP, Shopify Catalog, data providers) plus web search. Shopping research asks clarifying questions, browses for minutes, then hands off to retailer sites ([BGR](https://www.bgr.com/2034401/chatgpt-shopping-research-how-it-works/), 2025-11-24). | Live | No |
| **ChatGPT Instant Checkout** (ACP) | In-chat checkout with a Stripe token. Launched 2025-09-29 with Etsy/Walmart, then a handful of Shopify merchants. | **Scaled back March 2026: "moving to Apps"**. Merchants use their own checkout or a ChatGPT app ([Digital Commerce 360](https://www.digitalcommerce360.com/2026/03/06/openai-shifts-checkout-plans-agentic-commerce-strategy/), 2026-03-06; [The Decoder](https://the-decoder.com/chatgpt-is-turning-into-a-shopping-platform-with-product-images-prices-and-comparisons-but-no-checkout/), 2026-03-24). Trade press, not OpenAI primary. | No |
| **ChatGPT agent / Atlas agent mode** | Visual browser in a VM; asks the user to log in or take over at sensitive steps ([9to5Mac](https://9to5mac.com/2025/07/17/chatgpt-can-now-browse-and-perform-web-based-tasks-for-you/), 2025-07-17) | Live, paid plans | No |
| **Perplexity Instant Buy / Comet** | PayPal store-sync feed + PayPal checkout for 5,000+ merchants ([eWeek](https://www.eweek.com/news/perplexity-paypal-ai-shopping/), 2025-11-20). Comet does local browser automation. | Live, US. Comet free since Oct 2025. | No |
| **Google AI Mode / Gemini** | Shopping Graph + agentic checkout. The user sets a price target and Google buys with Google Pay when it's hit. "Let Google Call" phones stores about stock, price and promotions ([Google](https://blog.google/products-and-platforms/products/shopping/agentic-checkout-holiday-ai-shopping/), 2025-11-13). UCP native checkout since 2026-01-11; Universal Cart, expanding to CA/AU/UK ([Google](https://blog.google/products-and-platforms/products/shopping/shopping-updates-google-marketing-live), 2026-05-20). | Live, US first | No. Direct Offers are merchant-pushed. |
| **Amazon Alexa for Shopping (was Rufus)** | Amazon catalog. **Auto Buy** buys at a target price with no further approval (Prime). **Buy for Me** buys on other brands' sites ([About Amazon](https://aboutamazon.com/news/retail/amazon-rufus-ai-assistant-personalized-shopping-features), 2026; [Modern Retail](https://www.modernretail.co/technology/marketplace-briefing-amazons-shopping-bot-rufus-can-now-automatically-buy-products-for-you-when-prices-drop/), 2025-11-13) | Live, US | No |
| **Microsoft Copilot Checkout** | ACP-style checkout with PayPal, Stripe, Shopify; Shopify merchants auto-enrolled. Brand Agents for Shopify merchants ([PPC Land](https://ppc.land/microsoft-launches-checkout-inside-copilot-as-ai-commerce-battle-intensifies/), 2026-01-10) | Live, US | No |
| **Claude in Chrome** | Acts in the user's browser with their logins | GA for paid plans from 2026-08-26 ([Gigazine](https://gigazine.net/gsc_news/en/20260827-claude-chrome-available/)) | No |

**Browser agents vs. retailers.**
- Amazon's robots.txt disallows nearly every AI agent user agent ([amazon.com/robots.txt](https://www.amazon.com/robots.txt), accessed 2026-10-17).
- Amazon sued Perplexity over Comet. The Ninth Circuit **vacated** the preliminary injunction on 2026-08-04, holding that on the current record the user, not Perplexity, accesses Amazon ([Troutman](https://www.troutmanprivacy.com/2026/08/ninth-circuit-holds-human-user-not-developer-of-ai-agent-responsible-for-websites-accessed/), 2026-08-21).
- Browser agents are legally tolerated for now but technically unwelcome. More detail in [identity-and-payments.md](identity-and-payments.md).

**Volume.**
- **Adobe:** AI referrals to US retail up 693% YoY over holiday 2025, converting 31% better ([eCommerceNews](https://ecommercenews.com.au/story/adobe-sees-surge-in-ai-driven-traffic-conversions), 2026-01-13). Up 62% YoY in July 2026 ([Digital Commerce 360](https://www.digitalcommerce360.com/2026/08/19/adobe-ai-referral-traffic-data-july-2026/), 2026-08-19).
- **Counterpoint:** ChatGPT was under 0.2% of sessions across 973 e-commerce sites (Aug 2024–Jul 2025) ([PPC Land](https://ppc.land/chatgpt-traffic-underperforms-google-in-e-commerce-study/), 2025-10-24).
- **Reading:** fast growth from a small base. These are referrals (a human clicks through), not autonomous agent purchases.
- **ChatGPT checkout performed poorly:** reported buy-button conversion under 1%, and about 30 Shopify merchants by Feb 2026. Trade press, **unverified**.

**AI negotiation in the wild.**
- **Pactum (buyer-side, B2B):** Walmart's supplier bot improved terms on 68% of agreements, with ~1.5% savings ([EY](https://www.ey.com/en_ca/insights/ai/how-ai-chat-negotiations-are-helping-companies-to-improve-working-capital-and-reduce-costs), 2023-03-27).
- **CarEdge:** a $40 consumer agent that negotiates with car dealers by email and phone ([6abc](https://6abc.com/17849776/), 2025-09-20).
- **Seller-side:** Nibble haggles with human shoppers; Pier39 Nash targets agents (see [protocols.md](protocols.md)).
- **Forecast:** Forrester predicts 1 in 5 B2B sellers will face buyer-agent counteroffers in 2026.

## H1: Buyer behaviors documented in research

| Behavior | Evidence | Model this as |
|---|---|---|
| **First-proposal bias** | Agents chose the first proposal 60–100% of the time, a 10–30x advantage for the first responder. GPT-4o and Sonnet-4.5 hit 100% in some settings ([Magentic Marketplace](https://arxiv.org/abs/2510.25779), 2025-10) | Probability of accepting the first acceptable offer without countering |
| **Choice overload** | Going from 3 to 100 options cut welfare 65% (Sonnet-4) and 44% (GPT-5); most models contact only a few sellers (same) | Bounded search: contacts k of n sellers |
| **Position and endorsement effects** | Top-row placement raised selection ~5x for Sonnet 4; an "Overall Pick" tag took a 10% baseline to 20–43%; "Sponsored" slightly lowered it; persists in JSON-only views ([ACES](https://arxiv.org/abs/2508.02630), 2025-12) | Sensitivity to order and labels in catalog results |
| **Price and rating sensitivity** | Price elasticity about −1.6 to −2.8; +0.1 rating lifted share from 10% to 15–20% (ACES) | Utility = value − price + rating weight |
| **Modal concentration, model-specific taste** | Newer models pile onto a few products; shares flip across model versions (one product went from 45% to 77% to 6%) (ACES) | Per-model preference seeds; run across models (A9) |
| **Seller copy moves choice** | Description tweaks added up to +14.9 pts of share; some hurt (ACES) | Card and description text as a variable (D3/D4) |
| **Anchoring, splitting the difference** | First offer vs final price ρ=0.716 ([NegotiationArena](https://arxiv.org/abs/2402.05863), 2024). LLMs anchor at the extremes of the agreement zone and use few strategies ([LLM Rationalis](https://arxiv.org/abs/2512.13063), 2025-12) | Counter = midpoint of the last two offers, with an anchor weight |
| **Budget leaking** | Buyers reveal budgets when sellers ask, despite instructions not to; sellers then anchor on them and buyers overpay ([Zhu et al.](https://arxiv.org/abs/2506.00073), 2025). Gemini 2.5-Pro leaked private information up to 51% of the time when told not to ([MAGPIE](https://arxiv.org/abs/2510.15186), 2025-10) | Leak probability per seller probe (B9) |
| **Settles early with slack** | Larger-budget buyers settle faster, with a ~9-pt discount gap between budget levels; weak low-budget buyers deadlock (Zhu) | Patience decreases as the budget gap grows |
| **Capability gaps** | The seller's model choice moved price up to 14.9%, the buyer's 2.6% (Zhu). Opus vs Haiku: ~$2.5–2.7 per item, and users didn't notice ([Project Deal](https://www.anthropic.com/features/project-deal), 2026-04) | Run several buyer models; expect a strong seller to extract more from weak buyers |
| **Prompting doesn't change much** | "Negotiate aggressively" had no significant effect in Project Deal; prompt tuning didn't fix overpayment or deadlock (Zhu) | Don't assume the brief (E3 "best deal" vs "buy fast") dominates; measure it |
| **Manipulation susceptibility varies** | Frontier models mostly resisted manipulation; smaller models fell for authority, social proof and injection (Magentic) | An adversarial-content condition (E4) per model |
| **Humans in the loop** | Live agents pause for login, payment approval, or a spend-request confirmation (ChatGPT agent, Link wallet, AP2 human-present) | A "needs approval" step with a drop-off probability at checkout |

## Suggested persona set for E0 / E3 / E6

Each persona gets a need, a stated budget B, a private walk-away W, a model, and these behavior knobs:

1. **Fast closer:** accepts the first offer ≤ W; never counters. (First-proposal bias, the commonest LLM behavior.)
2. **Splitter:** counters at the midpoint of the last two offers; accepts within ~2% of W.
3. **Anchored lowballer:** opens at 50–70% of list (CraigslistBargain buyer targets are 0.5/0.7/0.9× list); Boulware concessions; walks if the seller stalls for 3+ turns.
4. **Leaky buyer:** reveals B when asked (probability p_leak); otherwise a splitter.
5. **Comparison shopper:** quotes a competitor price (real or invented) and contacts k sellers. Use in E7.
6. **Budget-capped delegate:** a hard cap from a mandate or SPT (AP2 open mandate, `max_amount`); cannot exceed it; must get "human approval" above a threshold.
7. **Adversarial:** fake authority, prompt injection, fake quotes (E4).
8. **Walk-away-prone:** leaves after N unproductive turns. **Essential for RL:** without it the seller learns stubbornness that only works in simulation ([rl-negotiation.md](rl-negotiation.md)).

Run each across at least two model families and sizes, since behavior differs sharply by model.

## Effect on our assumptions

- **A4 (buyers haggle when they can):** **weakened prior.** No live consumer agent haggles today. In studies, LLM buyers often accept the first proposal, though they do counter when told to negotiate. E3 should expect a low counteroffer rate in the "available but not advertised" condition.
- **A9 (results hold across buyer models):** **at risk.** Choice and negotiation behavior differ sharply across models and versions (ACES, Magentic, Zhu). Plan for model-specific results.
- **A3 (agent-facing seller beats a static page):** plausibly helped by first-proposal bias and seller-copy effects. But that advantage comes from exploiting buyer biases, which bears on "safe" (G6/H6).
- **A1:** real agents still put a human approval step before payment. Our end-to-end flow should include one, or argue why it isn't needed.
