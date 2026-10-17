# Open Questions

> Feeds into [NORTHSTAR.md](../NORTHSTAR.md).
> Goal: list what we don't know, and for each question say how we'll answer it, so we can see how much is online research and how much needs real experiments.

## What we're assuming

We're taking the North Star as given: buying agents are real and growing, merchants want a selling agent, and someone will pay for it. So we're skipping market and customer questions for now (they're listed under [Parked](#parked) so we don't lose them).

That leaves two things we care about:

- **Behavioral:** how buying agents and selling agents actually act.
- **Technical:** how we build the seller side, and how it plugs into what already exists.

## How each question gets answered

| Tag | Meaning |
|---|---|
| **Research** | We can answer it from online sources: docs, specs, papers, existing tools. |
| **Experiment** | We have to run it ourselves: in the harness, or by building something. |
| **Decide** | A team call. Research can inform it but won't settle it. |

Some questions have two tags. The first tag is where we start.

## General questions

The big ones. Everything below hangs off these.

| # | Question | Why it matters | Answer by |
|---|---|---|---|
| G1 | Will buying agents negotiate at all, or just compare fixed prices and buy? | Haggling is half our approach. | Research, Experiment |
| G2 | Does an interface built for agents sell more than a normal product page? | This is our core claim. | Experiment |
| G3 | Given both options, does a buying agent use a seller's agent endpoint or just read the page? | If buyers ignore the endpoint, nothing else matters. | Experiment, Research |
| G4 | Where do we sit relative to existing protocols (MCP, A2A, OpenAI/Stripe's Agentic Commerce Protocol, Google's AP2)? Do we build on them or around them? | So we don't rebuild what exists, and so we find the gap. | Research |
| G5 | How does a buying agent find a seller's endpoint in the first place? | Discovery is how every deal starts. | Research |
| G6 | What counts as "safe" in safe conversion rate? | It's our main KPI and it has no definition yet. | Decide |
| G7 | Do simulated buyers behave like real ones? | Our whole eval story rests on the harness. | Experiment, Research |

## Behavioral questions

### Buying agents

| # | Question | Answer by | First step |
|---|---|---|---|
| B1 | Does the way a product is presented (structured data vs. prose vs. full page) change whether an agent buys? | Experiment | Same product in three formats; compare conversion. |
| B2 | How much do framing tactics (anchoring, bundles, scarcity) move an agent's decision? | Experiment | Test each tactic against a plain offer. |
| B3 | If we offer to negotiate, do agents take it, and does it change the outcome? | Experiment | Negotiation offered vs. fixed price. |
| B4 | Do results change across buyer models (Claude, GPT, Gemini, open-weight)? | Experiment | Run the same scenario on each model. |
| B5 | How do the buyer's instructions ("strict budget", "best deal", "buy fast") change behavior? | Experiment | Vary the buyer's brief. |
| B6 | What does a buying agent need to see before it trusts a seller (reviews, return policy, verified identity)? | Research, Experiment | Check what live agents look for, then test it. |
| B7 | Does tailoring the interface to each buying agent beat one good structured endpoint for everyone? | Experiment | Tailored vs. generic, same products. |

### Negotiation

| # | Question | Answer by | First step |
|---|---|---|---|
| N1 | Which negotiation strategy gives the best profit without hurting conversion? | Experiment | Compare a few fixed strategies. |
| N2 | How many back-and-forth turns before deals start falling through? | Experiment | Track conversion against turn count. |
| N3 | Can a buying agent push the seller below its price floor, or into terms it shouldn't give, through pressure or prompt injection? | Experiment | Red-team with adversarial buyers. |

## Technical questions

| # | Question | Answer by | First step |
|---|---|---|---|
| T1 | How do buying agents interact with stores today: browser automation, screenshots, APIs, checkout protocols? | Research | Survey ChatGPT, Perplexity, Google, Amazon, and the main agent frameworks. |
| T2 | How do sites detect and block agents, and how can an agent prove who it is? | Research | Look at bot-management vendors and signed-agent standards (e.g. Cloudflare's Web Bot Auth). |
| T3 | What do Inkbox, Primitive, Stripe, and Manufact give us, and what can we use right now? | Research | Read their docs and note anything behind a waitlist or approval. |
| T4 | What exactly is the "dynamic interface": per-buyer MCP tools, a structured feed, a generated page, or a mix? | Decide, Research | See how agents use MCP and product feeds today, then pick one for v1. |
| T5 | What is the selling agent allowed to change: price, bundles, shipping, terms, add-ons? | Decide | Start narrow: price and bundles. |
| T6 | Where do we enforce hard limits like the price floor: in the agent's prompt, or in code it can't override? | Decide, Experiment | Default to code-level checks; N3 tells us how much it matters. |
| T7 | How does an agreed deal turn into an order and a payment? | Research | Check Stripe's and the checkout protocols' flows for agent payments. |
| T8 | Does the model cost and latency of negotiating eat the margin it wins? | Experiment | Log tokens and time per deal next to profit. |

## Harness and evals

| # | Question | Answer by | First step |
|---|---|---|---|
| H1 | What population of buyers do we simulate (goals, budgets, models, how strict they are)? | Research, Decide | Base the personas on what T1 shows real agents doing. |
| H2 | What's the baseline: conversion, profit, and margin with a plain static page? | Experiment | The first thing we run. |
| H3 | Which product category and catalog do we use, with costs, so that profit and margin mean something? | Decide | A small, realistic catalog in one category that suits negotiation. |
| H4 | How many runs per scenario until we trust the results, and what does that cost? | Experiment | Pilot run; measure variance and spend. |
| H5 | How do we score "safe" automatically: rule checks, an LLM judge, or both? | Decide | Waits on G6. |
| H6 | Where's the line between persuading a buying agent and misleading it? | Decide | Write it down. It feeds into G6. |

## Where this leaves us

Counting each question by its first tag:

| | General | Behavioral | Technical | Harness | Total |
|---|---|---|---|---|---|
| Research | 3 | 1 | 4 | 1 | 9 |
| Experiment | 3 | 9 | 1 | 2 | 15 |
| Decide | 1 | 0 | 3 | 3 | 7 |

With the market questions parked, this is now mostly experiments:

- **Behavioral questions are almost all experiments.** They need the harness, and most need the H2 baseline to compare against.
- **Technical questions are mostly research and design calls.** We can start them now, and their answers shape how we build the harness.
- **A few decisions block the harness** (G6, T4, T5, T6, H3). We should make them early, even if only roughly.

### Suggested order

1. **Now, in parallel:** the technical research (G4, G5, T1, T2, T3, T7), plus rough calls on G6, T4, T5, T6, and H3.
2. **Build a minimal harness** and run the H2 baseline.
3. **First experiments:** B1 (presentation), B3 (negotiation offered or not, which also answers G1), and N3 (red-team the seller). Together they test the core claim (G2) and the "safe" part of our main KPI.
4. **Then:** T8 (does negotiating pay for itself), B4 (does it hold across models), and N1 (which strategy wins).

## Parked

We're assuming these for now. We'll come back to them if an experiment calls the North Star into question.

- Are buying agents actually buying today, and at what volume?
- Who pays us: merchants, marketplaces, or commerce platforms?
- Will merchants let an agent change price and terms for them?
- Marketplace, or not?
- Who else is building seller-side agents?
- Are there legal limits on pricing differently per buyer or per agent?
- How do we charge: share of uplift, per transaction, or subscription?
- What would a merchant need to see before turning this on?
