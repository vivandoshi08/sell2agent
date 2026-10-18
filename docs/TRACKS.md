# Prize Tracks

> Which tracks to enter, and how each sponsor's tech fits into our architecture. Drafted 2026-10-17 while E1–E7 are still running; marked items get revised when their results land.
> Two tests for every track: **is our project close to 1:1 with what the track asks for**, and **does the sponsor's product do real work in our architecture** (not wrapped around it for the prize). The organizers also said they won't get excited about teams entering every track, so we pick few and go deep.

## Recommendation

| Call | Track | Why |
|---|---|---|
| **Enter** | **Manufact: Best MCP Server for Agents** | Our product *is* an MCP server whose primary customer is a buying agent. Manufact builds and hosts it. |
| **Enter** | **Armature: Best Agent Experience** | Our whole thesis is agent experience for commerce, and our eval harness measures it with numbers. |
| **Enter** | **Stripe: agents safely in the economy** | Our checkout step, with controls on both sides: the merchant's policy engine and the buyer's spend cap. Real test-mode payment (Shared Payment Token → PaymentIntent). |
| Skip | Inkbox | Closest of the rest: A2A plus a directory would be a second front door. Stretch use only: the seller texts the merchant for approval. |
| Skip | Primitive | Email is too slow for a 10-turn haggle. Async quoting is a different product. |
| Skip | Blaxel | The theme fits ("a store no human would want"), but their sandboxes wouldn't do real work for us. |
| Skip | InsForge | We don't need agent computers or a separate backend. |

**Decided 2026-10-17: Armature, Stripe, Manufact.** It's one build seen three ways: Manufact judges the server, Armature judges the experience agents have using it, and Stripe judges how safely money moves at the end of the same flow. None of the three is a bolt-on.

## Integration check (verified against sponsor docs, 2026-10-17)

Each sponsor gets **one job it is built for**, and the demo shows that job once. Nothing is added just to name-drop a sponsor.

| Sponsor | Its one job in our build | Features we actually use | What we don't claim |
|---|---|---|---|
| **Manufact** | Build, host, and publish the MCP front door | Manufact Cloud deploy (Python projects are detected from `pyproject.toml`; a Dockerfile is the fallback), gateway URL and slug, Inspector, MCP Apps deal-card widget, publish checks and submission pack for Claude/ChatGPT listing, Sessions with payload capture as raw transcripts for the learning loop | We don't use the mcp-use framework (see below). Manufact Sessions labels outcomes but doesn't judge AX; that's Armature's job. |
| **Armature** | Judge and evaluate the agent experience of the front door | **Evals:** tester agents run goal cases against our deployed URL, a judge model scores each criterion and the run 0–5. No SDK needed. This is our before/after gate for tool changes. **MCP Analytics:** an LLM judge scores every real session Succeeded / Partial / Failed with evidence, and groups failures into issues. | Armature is **not** a discovery channel. Its discoverability product is a paid managed service that measures which dev tools coding agents pick; it doesn't apply to shopping agents. Our discovery files are open standards (UCP, agent card). |
| **Stripe** | Move the money, with controls on both sides | Shared Payment Token capped at the deal total, PaymentIntent, test-mode token helper, idempotency keys | The buyer-side token is simulated in test mode, and the demo says so. |

**Verified facts and the trade-offs they create:**
- **Armature's analytics SDK supports our exact stack:** the official MCP Python SDK (`FastMCP` 1.27+ and `MCPServer` 2.x) via `pip install "armature-mcp-analytics[mcp]"`. Its TypeScript SDK supports the official TS SDK; **mcp-use isn't listed for either**. So staying on the official Python SDK is what lets Manufact hosting and Armature analytics coexist.
- **The SDK changes our tool surface.** It adds a `telemetry` input (user intent, agent thinking, frustration) to every tool, which can't be switched off, and injects a `request_capability` tool (which can be). We'll A/B it against an E1 subset before keeping it, and we keep `request_capability` because it records what buyers asked for that we don't offer.
- **We don't feed Armature's telemetry to the selling agent.** A buyer's reported intent or frustration is for measuring our AX, not for negotiating against that buyer.
- **Stateless HTTP needs Armature's `StatelessHttpSessionMiddleware`**, or sessions can't be told apart.
- **Armature evals are switched on per workspace on request** (email or booth). Free tier: 100 runs a month, 1 model target per case, no scheduling.
- **Manufact Cloud hosts Python**, but its docs don't mention the official SDK by name; the Dockerfile path is the guaranteed fallback.
- **Open question for Manufact's booth, first thing:** do the judges expect mcp-use itself? If yes, the fallback is an mcp-use TypeScript front door calling our Python seller as a backend, with Armature limited to evals (which are framework-agnostic).

## Scoring

| Track | Matches the brief | Sponsor tech does real work | Evidence so far | Work left by 10am |
|---|---|---|---|---|
| Manufact | 5/5: "MCP server built for agents as the primary customer" is our front door | 5/5: mcp-use framework, Cloud hosting (public HTTPS + OAuth), MCP Apps widget, session replay | E1 (real Claude buyer completed purchases over MCP), E4, E8 | Medium: port or deploy the server, add OAuth, build one widget |
| Armature | 5/5: "a dedicated agent-facing interface… the best experience for them" | n/a: the track judges the experience itself, not use of their product | E1 (tool errors, completion), E2 (agent interface vs. static page), E3 (buyer behavior) | Low: package the evidence, tune tool descriptions, publish discovery files |
| Stripe | 4/5: "agents that safely participate in the economy… clear control over what they can do and spend" | 4/5: SPT capped at the agreed price → PaymentIntent; policy engine as the merchant's control | E4 (policy engine), E8 (payment flow) | Medium: test-mode SPT flow; preview API access is unverified |
| Inkbox | 2/5: identity and communication; our core is selling, not identity | 3/5: A2A tasks map onto counteroffers; directory = discovery; iMessage for merchant approval | E8 only (E7 pending) | High: a second transport, and both sides need identities |
| Primitive | 2/5 | 2/5: async quotes with PDF attachments | None | Medium |
| Blaxel | 3/5 on theme | 1/5 | None | Low, but it would be a wrapper |
| InsForge | 1/5 | 1/5 | None | n/a |

## How each track fits the architecture

```
Discovery ──> MCP front door ──> Selling agent ──> Policy engine ──> Checkout ──> Learning
 open          Manufact: build,   (ours)            (ours) Stripe     Stripe:      Manufact
 standards     host, publish,                       judges it as      token →      session
 (UCP, card)   widget                               merchant control  PaymentIntent replay
               Armature: judge
               + eval the AX
```

### Manufact: the front door, built and hosted on their stack

What we build:
1. Move the seller's MCP server onto **mcp-use** (it has a Python server), or deploy our FastMCP server on **Manufact Cloud** if it accepts one (unverified). Either way we get a public HTTPS URL with **OAuth**, which real buyers need: ChatGPT only mounts remote MCP servers (E8).
2. Tools from **E1's winning design** (structured offers vs. free-text negotiate; pending). The negotiation ID travels as a tool argument because the current MCP spec has no session header (E8).
3. One **MCP App widget**: a deal card for the human behind the buying agent (what's included, price, savings vs. list, approve and pay). Real payment flows still keep a human approval step (E8), so this is where it lives.
4. Test as a remote connector in **Claude and ChatGPT**.
5. Use **session replay** as transcript data for the learning loop (E6).

What proves it: E1's completion rate and tool-error numbers, E4's zero-violation result (pending), a live run in Claude.

### Armature: agent experience, measured

What we build:
1. An **AX scorecard** from the experiments: purchase completion, tool errors, rounds to close, structured vs. free-text tools (E1), agent interface vs. static page vs. JSON feed (E2), behavior across buyer models (E3).
2. **Discoverability**: `/.well-known/ucp` listing our MCP endpoint (the one live standard pointer, per E8), plus an agent card. No standard field says a seller negotiates, so we propose one (D3).
3. **Tool descriptions** rewritten from E1's failure modes.
4. **"What the agent sees"**: annotated traces of a real buying agent going from need to paid order (E1's trace_example.md).
5. Ask Armature at their booth whether their platform can run against our MCP server. If it can, include their read of it.

What proves it: the numbers above. This is the track where our experiments are the submission, not just support for it.

### Stripe: checkout with controls on both sides

What we build:
1. `pay_deal(deal_id, spt)`: the buyer agent sends a **Shared Payment Token** capped at the agreed total, and we charge it with a **PaymentIntent** in test mode. The test helper mints tokens. Negotiation has to end before the token exists, which fits our flow: deal locked, then pay.
2. Fallback: a **Checkout Session** with a custom amount if SPT access isn't available. That puts a human on a hosted page, so it's weaker for this track.
3. **Controls, shown**: the merchant's policy engine (floor, max discount, allowed terms) and the buyer's spend cap (SPT `max_amount`, expiry). Demo both refusing: the seller won't go below floor, and the payment fails above the buyer's cap.

What proves it: a real test-mode payment ID for a negotiated price, plus E4's red-team numbers.
Needs from us: a Stripe test-mode secret key set as an environment variable, and confirmation that the SPT preview works on our account.

## What still depends on running experiments

| Pending | What it decides |
|---|---|
| E1 | Which tool design the front door ships with, and our completion-rate claim |
| E2 | The headline: does the agent interface earn more than a static page? |
| E4 | Whether we can claim "safe" for Stripe and Armature |
| E5 / E6 | Which haggling strategy powers the seller (split-the-difference leads on scripted buyers so far) |
| E3 | Whether the AX story holds across buyer models |
| E7 | Only matters if we revisit Inkbox or a broker; otherwise background |

## Risks

- **Manufact Cloud and Python:** unverified whether it hosts a plain FastMCP server. If not, port to mcp-use's Python server (same tool code) or ask Manufact's team.
- **Stripe SPTs are a preview API.** If our account can't use them, fall back to a Checkout Session with a custom amount and keep the controls story; check SPT access first thing.
- **Time:** submissions are due 10:00 tomorrow. Manufact + Armature is one build; Stripe is the one extra integration, and nothing else gets added.
