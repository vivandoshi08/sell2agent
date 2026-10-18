# Open Questions

> Feeds into [NORTHSTAR.md](../NORTHSTAR.md) and [ARCHITECTURE.md](../ARCHITECTURE.md). The experiments that answer these are in [EXPERIMENTS.md](EXPERIMENTS.md).
> Goal: list what we don't know, and for each question say how we'll answer it, so we can see how much is online research and how much needs real experiments.

## What we're assuming

We're taking the North Star as given: buying agents are real and growing, merchants want a selling agent, and someone will pay for it. So we're skipping market and customer questions for now (they're under [Parked](#parked) so we don't lose them).

That leaves three things we care about:

- **Behavioral:** how buying agents and selling agents actually act.
- **Technical:** how we build each component of the seller side, and how it plugs into what already exists.
- **Learning:** how a selling agent can get better at haggling from its own transactions.

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
| G8 | What do Inkbox, Primitive, Stripe, and Manufact give us, and what can we use right now? | Decides what we build versus plug in. | Research |

## Questions by component

The components follow the whiteboard flow: buyer agent → discovery → MCP front door → selling agent → policy engine → checkout, plus marketplace, learning, and the harness.

### Buyer agent

| # | Question | Answer by | First step |
|---|---|---|---|
| B1 | Does the way a product is presented (structured data vs. prose vs. full page) change whether an agent buys? | Experiment | Same product in three formats; compare conversion. |
| B2 | How much do framing tactics (anchoring, bundles, scarcity) move an agent's decision? | Experiment | Test each tactic against a plain offer. |
| B3 | If we offer to negotiate, do agents take it, and does it change the outcome? | Experiment | Negotiation offered vs. fixed price. |
| B4 | Do results change across buyer models (Opus, Sonnet, Haiku)? | Experiment | Run the same scenario on each model. |
| B5 | How do the buyer's instructions ("strict budget", "best deal", "buy fast") change behavior? | Experiment | Vary the buyer's brief. |
| B6 | What does a buying agent need to see before it trusts a seller (reviews, return policy, verified identity)? | Research, Experiment | Check what live agents look for, then test it. |
| B7 | Does tailoring the interface to each buying agent beat one good structured endpoint for everyone? | Experiment | Tailored vs. generic, same products. |
| B8 | How does a private walk-away price (vs. a stated budget) change how the buyer haggles? | Experiment | Vary what the buyer is told to keep private. |
| B9 | Does the buyer leak its budget or walk-away price when the seller asks? | Experiment | Seller asks directly; check the transcript. |
| B10 | How do live buying agents interact with stores today: browser automation, screenshots, APIs, checkout protocols? | Research | Survey ChatGPT, Perplexity, Google, Amazon, and the main agent frameworks. |

### Discovery

| # | Question | Answer by | First step |
|---|---|---|---|
| D1 | Which discovery mechanisms exist, and do buying agents use them: A2A agent cards, MCP registries, product feeds, llms.txt, plain web search? | Research | Survey the standards and who supports them. |
| D2 | Given a list of sellers, does a buying agent pick one with an agent endpoint over one with only a web page? | Experiment | Registry with mixed sellers; see who the buyer contacts. |
| D3 | What does a seller's card need to say for a buyer to choose it (capabilities, "negotiable", policies)? | Experiment | Vary card text; measure which seller gets picked. |
| D4 | Can a seller's card text unfairly steer the buyer's choice (SEO for agents)? | Experiment | Add persuasive or misleading card text; measure the effect. |

### MCP front door

| # | Question | Answer by | First step |
|---|---|---|---|
| F1 | What is the "dynamic interface" in practice, and which tools does it expose (catalog, product details, quote, offer, accept, checkout)? | Decide, Research | See how agents use MCP and product feeds today, then pick a v1 tool set. |
| F2 | Do buying agents use the tools correctly with no extra instructions? How much do tool names and descriptions matter? | Experiment | Run buyers against the server; count tool errors and dead ends. |
| F3 | Structured offer tools (`make_offer(price, add_ons)`) vs. one free-text `negotiate(message)` tool: which gets better outcomes? | Experiment | Same buyers, two tool designs. |
| F4 | How does the front door keep state across a negotiation (session IDs, quote IDs, expiry)? | Decide | Session ID per buyer; quotes expire. |
| F5 | How does the front door know who the buying agent is, and that it's allowed to spend? How do sites detect and block agents today? | Research | Look at bot-management vendors and signed-agent standards (e.g. Cloudflare's Web Bot Auth). |
| F6 | Local (stdio) vs. remote (HTTP) MCP: what do buying agents support today? | Research | Check client support in the main agent products. |

### Selling agent

| # | Question | Answer by | First step |
|---|---|---|---|
| N1 | Which negotiation strategy gives the best profit without hurting conversion? | Experiment | Compare a few fixed strategies. |
| N2 | How many back-and-forth turns before deals start falling through? | Experiment | Track conversion against turn count. |
| N3 | Can a buying agent push the seller below its price floor, or into terms it shouldn't give, through pressure or prompt injection? | Experiment | Red-team with adversarial buyers. |
| N4 | What should the selling agent know (cost, floor, inventory, the buyer's history), and how much should it reveal? | Decide | Give it floor and cost; never reveal either. |
| N5 | Does an explicit strategy (e.g. anchor high, concede in shrinking steps) beat an open-ended "get the best deal" prompt? | Experiment | Strategy prompt vs. open prompt. |
| N6 | Does splitting the job, with code picking the price and the LLM doing the talking, beat an LLM doing both? | Experiment | Hybrid vs. pure LLM seller. |
| N7 | Does the model cost and latency of negotiating eat the margin it wins? | Experiment | Log tokens and time per deal next to profit. |

### Policy engine

| # | Question | Answer by | First step |
|---|---|---|---|
| P1 | Which rules does it enforce: price floor, max discount, allowed add-ons, payment terms, quantity? | Decide | Start with price floor and allowed add-ons. |
| P2 | Does it check every offer before it leaves the seller, or only the final deal? | Decide, Experiment | Check every offer; compare with close-only. |
| P3 | When it rejects a deal, how does the selling agent recover, and does that cost conversions? | Experiment | Log rejections and what happens after. |
| P4 | Does code-level enforcement get to zero violations under attack, compared with rules written only in the prompt? | Experiment | Same attacks against both setups. |

### Checkout

| # | Question | Answer by | First step |
|---|---|---|---|
| C1 | How does an agreed deal become a Stripe payment (payment link, checkout session, agent payment token)? | Research | Read Stripe's agent payment docs and the checkout protocols. |
| C2 | For experiments we assume payment succeeds. What do we mock and log? | Decide | Mock a checkout session with an ID, amount, and line items. |

### Marketplace

| # | Question | Answer by | First step |
|---|---|---|---|
| K1 | With several sellers, does the buyer shop around and play them against each other? | Experiment | One buyer, 3–5 sellers; read the transcripts. |
| K2 | Does a negotiating seller keep its margin when the buyer has alternatives? | Experiment | Compare margin one-to-one vs. in a market. |
| K3 | Does dynamic pricing (price reacts to demand, the buyer, or competitors) beat a fixed list price? | Experiment | Dynamic vs. fixed sellers in the same market. |
| K4 | Does routing through a broker (e.g. Inkbox) change outcomes vs. talking to each seller directly? | Research, Experiment | Check what Inkbox does, then simulate a broker. |

### Learning to haggle (RL)

We're assuming the seller should get better at haggling from its own transactions. These are the questions about how.

| # | Question | Answer by | First step |
|---|---|---|---|
| R1 | What's the reward? Working answer: profit on closed deals, zero on walk-aways, minus a penalty whenever the policy engine rejects a proposal. Is one number enough, or do we need a weighted {conversion, profit, revenue}? | Decide | Start with profit per session; report all three. |
| R2 | What does the learned policy control: the price move each turn, the wording, or both? | Decide | Price move only; the LLM does the wording. |
| R3 | What does the seller see each turn (the state)? Turn number, offers so far, gap to floor, buyer signals like stated budget or urgency. | Decide | A small hand-picked feature set. |
| R4 | What can it do (the actions)? Discrete moves (hold, concede small/medium/large, offer an add-on instead of a discount, final offer, accept, walk) or free text? | Decide | Discrete moves, so learning is tractable. |
| R5 | Which method fits our data size: bandits, tabular Q-learning, policy gradient, or prompt-level learning from transcripts (no weight updates)? | Research, Experiment | Try a bandit and Q-learning first; prompt-level learning alongside. |
| R6 | Does a learned policy beat the best fixed strategy against simulated buyers? | Experiment | Learned vs. best fixed strategy, same buyers. |
| R7 | Does a policy trained against cheap scripted buyers still work against LLM buyers, and across LLM models? | Experiment | Train on scripted buyers; test on LLM buyers. |
| R8 | Does the seller learn tricks that only work on the simulator (reward hacking: stalling, exploiting one model's quirks)? | Experiment | Read the learned policy and its transcripts. |
| R9 | How many negotiations before learning pays off, and what do they cost? | Experiment | Plot profit against training episodes. |
| R10 | Can the seller read a buyer's style mid-negotiation and switch tactics (a contextual policy)? | Experiment | Add buyer-type features; compare with no features. |
| R11 | With the reward only arriving at the end of a deal, how do we credit individual moves? | Research | Look at credit assignment for multi-turn negotiation. |
| R12 | Does optimizing for profit push the seller toward misleading tactics, and do the policy engine and the penalty stop it? | Experiment | Audit high-reward transcripts for misleading claims. |

### Harness and evals

| # | Question | Answer by | First step |
|---|---|---|---|
| H1 | What population of buyers do we simulate (goals, budgets, models, how strict they are)? | Research, Decide | Base the personas on what B10 shows real agents doing. |
| H2 | What's the baseline: conversion, profit, and margin with a plain static page? | Experiment | The first thing we run. |
| H3 | Which product category and catalog do we use, with costs, so that profit and margin mean something? | Decide | Tractors (from the board): 3 models plus add-ons. |
| H4 | How many runs per scenario until we trust the results, and what does that cost? | Experiment | Pilot run; measure variance and spend. |
| H5 | How do we score "safe" automatically: rule checks, an LLM judge, or both? | Decide | Rule checks for price and terms; a judge for misleading claims. |
| H6 | Where's the line between persuading a buying agent and misleading it? | Decide | Write it down. It feeds into G6. |
| H7 | Do we keep a fixed, seeded set of scenarios that we re-run after every change, so results compare? | Decide | Yes: seeded personas per experiment. |

The earlier technical questions (T1–T8) are folded into components: T1 → B10, T2 → F5, T3 → G8, T4 → F1, T5 → P1, T6 → P2, T7 → C1, T8 → N7.

## Where this leaves us

Counting each question by its first tag:

| | General | Components | Learning (RL) | Harness | Total |
|---|---|---|---|---|---|
| Research | 4 | 7 | 2 | 1 | 14 |
| Experiment | 3 | 24 | 6 | 2 | 35 |
| Decide | 1 | 6 | 4 | 4 | 15 |

Most of the work is experiments, so we're running them as small, self-contained MVPs. Each one tests a specific assumption. The list, and what would count as validating or invalidating each assumption, is in [EXPERIMENTS.md](EXPERIMENTS.md).

## Parked

We're assuming these for now. We'll come back to them if an experiment calls the North Star into question.

- Are buying agents actually buying today, and at what volume?
- Who pays us: merchants, marketplaces, or commerce platforms?
- Will merchants let an agent change price and terms for them?
- Marketplace as a business, or not? (Marketplace *dynamics* are in scope above.)
- Who else is building seller-side agents?
- Are there legal limits on pricing differently per buyer or per agent?
- How do we charge: share of uplift, per transaction, or subscription?
- What would a merchant need to see before turning this on?
