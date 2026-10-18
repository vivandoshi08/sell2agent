# North Star

> **Status:** draft. The direction is set; details will move as we test.

## One line

A selling agent that gives every buying agent a first-class way to buy: one MCP endpoint where it can ask real questions, get grounded answers, negotiate a real price, and pay in a single call.

## The problem, from the buying agent's side

**Commerce is still built for eyes and thumbs. The buyer is now an agent, and the experience is miserable for it.**

Watch what a buying agent actually goes through on a normal storefront:

- **It has to guess.** The product is a page of marketing HTML. The agent scrapes a DOM, infers which number is the price, and hopes the spec table is current.
- **It can't ask.** "Does this ship to Oakland by Friday?" "Is the 40mm compatible with my mount?" There's nobody on the other end. The agent either digs through reviews or makes something up — and the thing it makes up becomes its user's purchase decision.
- **It can't deal.** One price, take it or leave it. The agent has a budget and a mandate to get a good outcome, and no channel to use either.
- **It gets blocked.** Bot detection, CAPTCHAs, multi-step carts, address forms, 3DS redirects. Flows designed to stop exactly what it is.
- **It pays for all of this in turns.** Every workaround is more tokens, more latency, more chances to fail. The agent's cost of buying from you is a real number, and right now it's high.

None of that friction is about the product. It's the interface. The buying agent wants to transact; the storefront makes it fight.

## How it's solved today

- The buying environment is static and built for a human, so the agent improvises against it.
- Agent traffic is treated as a threat to be blocked rather than demand to be served.
- The seller gets no signal: a buying agent that gave up looks identical to no visitor at all.

## Our approach: be the easiest thing on the internet to buy from

We are not making a prettier page. We are making the buying agent's job trivial, and we make money because an agent that can ask, negotiate, and close will choose the seller that lets it.

**1. One endpoint, typed tools — nothing to scrape.**
The agent gets `get_listing`, `ask_question`, `make_offer`, `accept_deal` with schemas, instead of a page to reverse-engineer. We build and ship this on **Manufact**: the `mcp-use` SDK for the server, the Manufact Inspector to test tools without wiring up a live agent, Manufact Cloud for deploy, auth, and scaling. That's how we go from push to a production seller endpoint without burning the weekend on infra.

**2. Grounded answers, never bluffing.**
`ask_question` answers from catalog data only. When we don't know, we return `grounded: false` and say so. A buying agent that gets an honest "I don't know" can route around it; one that gets a confident hallucination makes a bad purchase and learns not to trust sellers. Honesty is a UX feature here, not just an ethics one.

**3. A real negotiation, with a reason attached.**
`make_offer` returns a counter and a pitch, not a wall. An LLM proposes; code enforces floor price, round cap, and allowed concessions, so the agent is bargaining against something predictable rather than a jailbreakable chat box. The buying agent gets what it has never had: leverage it can actually use, and a deal it can justify to its user.

**4. A close that is one call.**
`accept_deal` mints a **Stripe** PaymentIntent at the agreed price. No cart, no shipping form, no CAPTCHA, no human checkout to drive. Stripe is also what makes the negotiated price *real* — the agreed number and the captured number are the same object, so a deal is settled, not promised. Agent-initiated payment is the part everyone hand-waves; we just do it.

**5. The interface adapts to who's buying.**
Static pages show every visitor the same thing. Our listing is assembled per buyer agent — what it asked about, what it's optimizing for, what it's already been offered. With **Manufact**'s MCP Apps we can render that back as an interactive widget inside the buyer's own client, so a human in the loop sees the live offer instead of a wall of tool JSON.

## The stack

| Partner | What we use it for | Why it matters to the agent |
|---|---|---|
| **Stripe** | TEST-mode PaymentIntent on `accept_deal`; the negotiated price is the captured price | Lets an agent finish the job itself — one call, no human checkout flow |
| **Manufact** | `mcp-use` SDK for the seller MCP, Inspector for tool-level debugging, Cloud for deploy/auth/scale, MCP Apps for the dynamic buyer-facing widget | Makes the endpoint reliable, fast to reach, and renderable inside the buyer's client |
| **Armature** | Instruments the seller MCP: session capture, replay, pass rate, issues grouped by root cause, and staged evals run from CI | Turns "the agent experience is nicer" into a number we can show |

## How we prove it

**Armature is our instrument.** It wraps the seller MCP without changing its behavior, so every buyer session becomes a scored, replayable trace: what the agent came to do, each tool call, where it stalled, whether it got what it asked for. That gives us three things a homegrown harness wouldn't:

- **Issues ranked by how many agents hit them**, including the failures that returned HTTP 200 and still left the agent stuck. That list is our UX backlog.
- **Use cases we don't support yet**, surfaced from what agents actually tried to do.
- **Staged evals**: a real agent plays the buyer, a judge scores the run against our criteria, and we run the suite on every change instead of eyeballing one demo.

We run simulated buyer agents (several models) against static baseline listings vs. our negotiating sellers, and read both halves:

**Agent-experience KPIs** — the thesis:
- **Pass rate:** share of sessions where the agent got what it came for.
- **Turns to close:** tool calls from first contact to settled payment. Lower is the whole point.
- **Grounded-answer rate:** questions answered from real data vs. punted.
- **Dead-end rate:** sessions that stall, loop, or get blocked.

**Seller KPIs** — the reason a merchant pays us:
- **Safe conversion rate:** sessions ending in a sale that stayed inside the seller's rules. ("Safe" still needs a hard definition.)
- **Profit**
- **Margin**

The demo is the two side by side: the same buyer agent fumbling a static listing, then closing with us in a fraction of the turns, with the Armature trace of both on screen.

## Open questions

- What exactly counts as "safe" in safe conversion rate?
- How does a buying agent discover the seller's MCP endpoint in the first place? (Marketplace, a registry, or something Manufact Cloud already gives us?)
- Marketplace, or not?
- Do we want the Manufact MCP App widget in the hackathon demo, or is it a post-demo bet?

## Next step

Write the hypotheses as Armature eval cases — one per agent-experience KPI — so the first experiment run is the same artifact we demo.
