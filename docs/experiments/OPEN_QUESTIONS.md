# Open Questions

> Feeds into [NORTHSTAR.md](../NORTHSTAR.md).
> Goal: list what we don't know, and for each question say how we'll answer it, so we can see how much is online research and how much needs real experiments.

## How each question gets answered

| Tag | Meaning |
|---|---|
| **Research** | We can answer it from online sources: docs, papers, news, competitor sites. |
| **Experiment** | We have to run it ourselves: in the harness, or by building something. |
| **Talk** | Needs conversations with merchants or people building buying agents. |
| **Decide** | A team call. Research can inform it but won't settle it. |

Some questions have two tags. The first tag is where we start.

## General questions

These are the big ones. If one of these comes back with the wrong answer, the North Star changes.

| # | Question | Why it matters | Answer by |
|---|---|---|---|
| G1 | Are buying agents actually buying today? At what volume, and who runs them? | If there are no buyers yet, this tells us how early we are. | Research |
| G2 | Who pays us: merchants, marketplaces, or commerce platforms? | Decides what we build and who we demo to. | Talk, Decide |
| G3 | Will buying agents negotiate at all, or just compare fixed prices and buy? | Haggling is half our approach. | Research, Experiment |
| G4 | Why would a buying agent use our seller endpoint instead of reading the page or using an existing checkout protocol? | If buyers have no reason to come to us, nothing else matters. | Research, Experiment |
| G5 | Will merchants let an agent change price and terms for them? | Trust is the main adoption blocker on the seller side. | Talk |
| G6 | Does an interface built for agents actually sell more than a normal product page? | This is our core claim. | Experiment |
| G7 | Where do we sit relative to existing protocols (MCP, A2A, OpenAI/Stripe's Agentic Commerce Protocol, Google's AP2)? Do we build on them or around them? | So we don't rebuild what exists, and so we find the gap. | Research |
| G8 | How does a buying agent find a seller's endpoint in the first place? | Discovery is how every deal starts. | Research |
| G9 | What counts as "safe" in safe conversion rate? | It's our main KPI and it has no definition yet. | Decide |
| G10 | Do results from simulated buyers tell us anything about real buyers? | Our whole eval story rests on the harness. | Experiment, Research |
| G11 | Marketplace, or not? | Big change in scope. Answer it after G1–G4. | Decide |

## Specific questions

### Market and landscape

| # | Question | Answer by | First step |
|---|---|---|---|
| M1 | Which buying agents are live, what do they buy, and how do they check out (browser automation, APIs, checkout protocols)? | Research | Survey ChatGPT, Perplexity, Google, Amazon, and the main agent frameworks. |
| M2 | How often do buying agents get blocked, and how do sites detect them? | Research | Look at bot-management vendors and signed-agent standards (e.g. Cloudflare's Web Bot Auth). |
| M3 | Who else is building seller-side agents or storefronts for agents? | Research | Competitor list, one line each. |
| M4 | What do Inkbox, Primitive, Stripe, and Manufact give us, and what can we use right now? | Research | Read their docs and note anything behind a waitlist or approval. |
| M5 | Which product categories suit agent buying and negotiation (commodity vs. considered purchase, B2B vs. consumer)? | Research, Talk | Pick 1–2 categories for the harness. |
| M6 | Are there legal limits on pricing differently per buyer or per agent? | Research | Check price-discrimination and algorithmic-pricing disclosure rules. |

### Buying agents: how they behave

| # | Question | Answer by | First step |
|---|---|---|---|
| B1 | Does the way a product is presented (structured data vs. prose vs. full page) change whether an agent buys? | Experiment | Same product in three formats; compare conversion. |
| B2 | How much do framing tactics (anchoring, bundles, scarcity) move an agent's decision? | Experiment | Test each tactic against a plain offer. |
| B3 | If we offer to negotiate, do agents take it, and does it change the outcome? | Experiment | Negotiation offered vs. fixed price. |
| B4 | Do results change across buyer models (Claude, GPT, Gemini, open-weight)? | Experiment | Run the same scenario on each model. |
| B5 | How do the buyer's instructions ("strict budget", "best deal", "buy fast") change behavior? | Experiment | Vary the buyer's brief. |
| B6 | What does a buying agent need to see before it trusts a seller (reviews, return policy, verified identity)? | Research, Experiment | Check what live agents look for, then test it. |

### Selling agent and negotiation

| # | Question | Answer by | First step |
|---|---|---|---|
| S1 | What is the selling agent allowed to change: price, bundles, shipping, terms, add-ons? | Decide | Start narrow: price and bundles. |
| S2 | Can a buying agent talk the seller below its price floor, or into terms it shouldn't give? | Experiment | Red-team with adversarial buyers and prompt injection. |
| S3 | Which negotiation strategy gives the best profit without hurting conversion? | Experiment | Compare a few fixed strategies. |
| S4 | How many back-and-forth turns before deals start falling through? | Experiment | Track conversion against turn count. |
| S5 | Where's the line between persuading a buying agent and misleading it? | Decide | Write it down. It feeds into G9. |

### Agent-facing interface

| # | Question | Answer by | First step |
|---|---|---|---|
| I1 | What exactly is the "dynamic interface": per-buyer MCP tools, a structured feed, a generated page, or a mix? | Decide, Research | See how agents use MCP and product feeds today, then pick one for v1. |
| I2 | Does tailoring the interface to each buying agent beat one good structured endpoint for everyone? | Experiment | Tailored vs. generic, same products. |
| I3 | How does the seller know which agent it's talking to? | Research | Check agent identity and request-signing standards. |

### Harness and evals

| # | Question | Answer by | First step |
|---|---|---|---|
| H1 | What population of buyers do we simulate (goals, budgets, models, how strict they are)? | Research, Decide | Base the personas on what M1 shows real agents doing. |
| H2 | What's the baseline: conversion, profit, and margin with a plain static page? | Experiment | The first thing we run. |
| H3 | What product catalog do we use, with costs, so that profit and margin mean something? | Decide | A small, realistic catalog in one category. |
| H4 | How many runs per scenario until we trust the results, and what does that cost? | Experiment | Pilot run; measure variance and spend. |
| H5 | How do we score "safe" automatically: rule checks, an LLM judge, or both? | Decide, Experiment | Waits on G9. |

### Business

| # | Question | Answer by | First step |
|---|---|---|---|
| X1 | How do we charge: share of uplift, per transaction, or subscription? | Decide, Talk | Park it until G2 is answered. |
| X2 | What would a merchant need to see before turning this on? | Talk | Ask in merchant conversations. |

## Where this leaves us

Counting each question by its first tag:

| | General | Specific | Total |
|---|---|---|---|
| Research | 5 | 9 | 14 |
| Experiment | 2 | 11 | 13 |
| Decide | 2 | 6 | 8 |
| Talk | 2 | 1 | 3 |

It's roughly an even split, but the two halves answer different things:

- **Research tells us whether the market is real** (G1, G3, G4, G7, G8). We can start it now, in parallel, with no code.
- **Experiments tell us whether our product works** (G6, plus the B, S, and I sections). They need the harness first, and most of them need the H2 baseline to compare against.
- **A few decisions block the harness** (G9, S1, I1, H3). We should make them early, even if only roughly.

### Suggested order

1. **Now, in parallel:** the research batch (G1, G7, G8, M1–M4), plus rough calls on G9, S1, I1, and H3.
2. **Build a minimal harness** and run the H2 baseline.
3. **First experiments:** B1 (presentation), B3 (negotiation offered or not), and S2 (red-team the seller). Together they test the core claim (G6) and our main KPI.
4. **Talk to merchants** (G2, G5, X2) once we have a demo to show them.
