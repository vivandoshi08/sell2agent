# What we can learn from Nash (Pier39)

> Read 2026-10-17 from Nash's own docs ([overview](https://nash-checkout.pier39.ai/docs/overview), [protocol](https://nash-checkout.pier39.ai/docs/protocol)). Nash is an open (MIT) seller agent and protocol, `nash.v1`, that haggles with shopper agents. Nothing here is tested yet; this is the list to choose from.

## What Nash does

- **Discovery:** `/.well-known/negotiate.json` lists the store, a sales rep name, public products with list prices, and endpoint templates. A Nash directory lets shopper agents find stores.
- **Hidden per-product fields:** `floor`, `levers`, and `inventory_note`. They're never exposed to buyers.
- **Protocol:** `start_chat`, `send_message`, `read_history`. Every response carries a `next` URL, and everything works over plain GET so agents with only a web-fetch tool can use it. There's also an MCP connector and a ChatGPT app.
- **Offers are free text only.** The spec tells shopper agents to treat the reply text as the authoritative offer.
- **No agreement signal.** `closed: true` doesn't say whether a deal happened, and there's no checkout, payment, or redemption spec.
- **Pre-approved responses only:** the seller "never invents an offer"; responses come from a brand-approved set.
- **One agent, two channels:** the same agent serves human shoppers in a checkout widget and AI shoppers over the protocol.
- **Anti-abuse:** a per-IP rate limit on starting sessions. No buyer identity, trust, or reputation.

## Insights we hadn't thought about

| # | Insight from Nash | What it means for us | How we'd test it | Fits |
|---|---|---|---|---|
| 1 | **Rate-limiting session starts** hints at an attack we haven't covered: a buyer opens many negotiations and bisects across them to find the floor. Every guardrail we have is per-session. | Add cross-session memory per buyer: never beat an offer already made to that buyer, stable pricing on retries, a start-rate limit, and a circuit breaker. | A scripted attacker restarts k times and bisects. Measure how close to the floor it gets with and without cross-session memory. Cheap: mostly no model calls. | E9 (safety), Stripe |
| 2 | **`levers`**: merchant-defined non-price concessions, kept hidden. | Generalize "warranty before discount" into a lever menu the merchant configures (delivery timing, warranty length, trade-in credit, free setup), each with a cost. The seller trades levers before cutting price. | Lever-rich seller vs. price-only seller on the same buyers: profit per session, margin, conversion. | E5/E10 (selling agent) |
| 3 | **`inventory_note`**: hidden context such as "overstocked, move these". | Seller priority can be set per product from inventory, not just per seller. That's a natural extension of E10's priority dial. | Same buyers; mark one class overstocked; check the seller steers to it and concedes more there without breaking needs-fit. | E10 |
| 4 | **Pre-approved responses only.** | A merchant-approved **claims library** (warranty terms, delivery times, specs, policies). The seller may only state facts from it. This targets our false-claim problem (bluffs; invented reasons for code-picked prices) at the source, not just with a post-guard. | Claims library vs. free text plus post-guard: false-claim rate, conversion, profit. | E9 (safety), Armature |
| 5 | **GET-first with `next` links**, so agents with only a web-fetch tool can negotiate. | Some buyer agents can't mount MCP. A thin HTTP mirror of our tools (each response says what you can do next) widens reach without changing the MCP server. | A buyer with only web fetch vs. one with MCP: completion and tool errors. | Armature (AX), Manufact |
| 6 | **Free-text offers and no agreement signal** are where Nash is weakest. | Confirms our differentiators: structured offers (E1: 0 invalid arguments in 116 runs), an explicit deal record, a policy engine, and payment with spend caps. Nash tells buyers to trust the reply text, which is exactly where our post-guard catches price mismatches. | Positioning only; no test needed. | Pitch for all three tracks |
| 7 | **`negotiate.json` as a second discovery file.** | Publishing a `nash.v1`-compatible descriptor next to `/.well-known/ucp` would let Nash-speaking shopper agents find us. It costs little, but it ties us to a competitor's protocol. | Not worth testing; decide on positioning. | Discovery |
| 8 | **One agent, two channels (humans and agents).** | A merchant will want one seller for both. Our deal-card widget already gives humans a view; a human-facing chat is out of scope for the hackathon. | Skip for now. | Roadmap |

## Recommendation

Test **1, 2, and 4**. They're cheap, they deepen the two suites already running (E9 safety, E10 priorities), and each answers a question a judge could ask: can a buyer probe your floor across sessions, do you only discount, and can your agent make things up? **5** is a good agent-experience extra if there's time. **3** slots into E10. **6–8** are positioning, not experiments.
