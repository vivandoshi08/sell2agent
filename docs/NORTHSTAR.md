# North Star

> **Status:** early draft. The direction is set; the details are still loose and will change as we test.

## One line

A selling agent that represents a merchant to AI buying agents: it presents the product in a form agents can use, negotiates for the seller, and closes the deal.

## Problem

**Commerce is static because it was built for humans. The buyers are now agents.**

- A product page shows every visitor the same thing: one price, one description, one checkout flow. That made sense when every buyer was a person reading a screen.
- Agents can do things a person browsing a page can't: ask follow-up questions, compare offers instantly, negotiate, and call an API. A static page can't respond to any of that, so the seller has no way to adapt, answer, or make a deal.
- Agents are now doing the buying, but sellers still build for human shoppers. Buying agents have to work through interfaces made for people (pages, forms, checkouts), and those interfaces can block them outright.

## How it's solved today

- The buying environment is still static and built for a human.
- Buying agents can get blocked.

## Our approach

We build for agents and make sure the product gets sold.

1. **Dynamic interface for agents.** A static page can't adapt to who's buying. Our interface changes for each buying agent and is tuned to sell and close the deal.
2. **Agent-to-agent negotiation.** The seller gives the buying agent an MCP endpoint, and the two agents haggle over it directly (A2A protocol / network communication).
3. **A selling agent for your product.** It advocates for the seller and finds the best way to close each buyer.
4. **Maybe a marketplace.** Open question.

Tools and partners to look at:

- Inkbox / Primitive: A2A communication
- Stripe: payments / checkout
- Manufact

## How we show it works

We'll build a harness (the "armature") that simulates buying agents and selling agents against each other, and run it as our evals.

Primary KPIs:

- **Safe conversion rate:** how often a buyer session ends in a sale, counting only deals that stay inside the seller's rules. What "safe" means still needs a definition.
- **Profit**
- **Margin**

## UI

To come.

## Open questions

- What exactly counts as "safe" in safe conversion rate?
- Marketplace, or not?
- How does a buying agent find the seller's MCP endpoint in the first place?

## Next step

List the hypotheses we want to test, then design the first set of experiments to run in the harness.
