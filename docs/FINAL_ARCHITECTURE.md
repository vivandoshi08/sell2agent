# Final Architecture

> The agreed architecture as of 2026-10-17, after the experiments (E1–E11), sponsor research, and judge feedback. Strategies are **policies over levers**, not price curves. The negotiation engine itself is described in [ARCHITECTURE.md](ARCHITECTURE.md) and on the architecture page; this doc covers every other part, in the order a purchase flows through them.

## 1. Marketplace gateway and discovery
**Job:** the one MCP connector every buyer agent adds. It finds products and passes all negotiation moves to the engine. **Owner:** C. **Core.**

- **Tools it exposes:** `search_products`, `get_listing`, `ask_question`, `make_offer`, `accept_deal`, `check_offers`, plus `allow_followups` after core.
- **`search_products(query, preferences)`**: preferences are a **lever profile**: what this buyer values and how much.
  - **Hard needs:** "quiet", "Mac", budget.
  - **Soft weights across levers:** price, quality and specs, delivery speed, warranty and support, trust in the seller, convenience.
  - **Example:** a quality-first buyer sends quality = high, price = low, warranty = high.
- **Ranking by fit:** drop products that miss a hard need, rank by **how well each product and seller fits the lever profile** (not just price), and show a **short list of 3–5**.
  - The Magentic paper found buyer agents do *worse* with long lists (Sonnet-4 lost 65% of buyer value going from 3 to 100 results), and they only contact a few sellers.
  - Competing sellers appear side by side.
- **What a listing shows:** public facts only.
  - Title, specs, list price, shipping.
  - **The levers the seller can offer:** warranty options, faster delivery, bundles.
  - Seller name and whether it's negotiable.
  - A "fit note" saying which of the buyer's levers it matches.
  - Never the floor, cost or the seller's objective.
- **Listing text stays factual,** with no instructions or hype. Buyer agents read descriptions as instructions, and weaker models can be manipulated (Magentic).
- **Signposts (after core):** `/.well-known/ucp` points a store's website at the gateway. Plus the agent card, an MCP server card, and an MCP Registry listing. E8: UCP is the live standard pointer.
- **Broker mode (optional, later):** send one request to every seller and collect bids per round. E7: it cut prices about 1 point.

## 2. Seller agents (policy over levers)
**Job:** each seller's brain. **Owner:** A. **Core.**

- **What a seller is made of:**
  - **Catalog:** products, specs, stock.
  - **Lever menu:** every lever this seller can pull, and **what each costs it**. Price, extended warranty, free or faster shipping, bundles and add-ons, setup, volume discounts. Each has a cost, limits and whether it's allowed.
  - **Objective (replaces "priority"):** weights over what the seller wants. Margin, conversion or volume, clearing a product, repeat customers, keeping a premium image. Example: a premium brand weights margin and brand, and never discounts below a set level.
  - **Private policy:** hard floor, minimum margin *after* the cost of any levers, max rounds.
- **How a decision is made:** each turn the seller policy:
  1. **Reads the buyer's lever profile.** Stated preferences, what they asked about, what they turned down, what they're dropping.
  2. **Builds candidate offers.** Packages of levers: price plus warranty plus delivery plus bundle.
  3. **Scores each** by *the seller's objective* × *how likely this buyer is to accept it* (fit to the buyer's levers).
  4. **Picks the best package that passes the policy.**

  Price is one lever, not the strategy. For example:
  - a **quality-first** buyer gets a firm price plus a longer warranty and faster shipping;
  - a **price-first** buyer gets a lean bundle at a sharper price;
  - an **overstocked** seller leans on bundles and volume.
- **Policy types:**
  - `static`: list price and fixed terms. The baseline.
  - `lever_policy`, the new default:
    - a scoring model over lever packages, as above;
    - **concession pacing as one of its levers:** the "concede slowly, stay well clear of the floor" stance from E5 and E10 still governs *how fast* price moves when price is the lever being used;
    - offer value levers before discounting (E5's bundle-first +10.4% was the first sign levers beat pure price).
  - **Added later through the quality gate:**
    - `learned`: the RL loop learns which lever packages work for which buyer profiles;
    - `dynamic`: reacts to demand, stock and real competitor offers, never quote-matching (E7).
  - **Reading buyer type is built in** rather than a separate `adaptive` mode. E10's lesson: judge buyers by what they choose, not by whether they haggle.
- **The objective changes behavior:** a margin-weighted seller pulls value levers and holds price; a conversion-weighted seller concedes price faster.
  - E10's caveat: with buyers who never walk, this only shows up in margin. So simulated buyers must walk.
- **Voice (Claude):** gets the chosen lever package, the real reason ("you said quality matters, so I'm adding the 2-year warranty instead of cutting price") and the buyer's preferences, and writes a short, honest pitch.
  - E10: given the true reason, its stated price matched the code on 377 of 378 offers.
  - It answers only from catalog data and says "I don't know" otherwise (`grounded: false`).
- **Guardrails stay hard and in code:**
  - whatever package the policy picks, the floor, **minimum margin after lever costs**, allowed levers and terms are enforced deterministically;
  - every lever named in the text must be in the structured offer.

  The policy chooses *what* to offer; code checks it's *allowed*.
- **Speed matters:** in multi-seller markets, buyer agents pick the first proposal 60–100% of the time (Magentic). Seller replies must be fast, and time-to-first-offer is a KPI.

## 3. Closing and payment
**Owner:** A (the card), B (the Stripe helper). **Core**, with depth after.

- **Accept → deal:** the engine re-checks the policy and locks an immutable deal: amount, **all included levers** (warranty, delivery, bundle), expiry, tied to this buyer.
- **The deal card (Manufact MCP App):** inside ChatGPT or Claude it shows the product, every included lever, negotiated vs. list price, savings, expiry, and **Approve & Pay**.
- **Stripe (test mode):** after approval, a PaymentIntent for exactly the deal amount, read from the stored deal, with an idempotency key. No cart, no checkout page.
- **After core:**
  - **capped payment token:** Stripe enforces the buyer's limit, which together with the merchant's floor gives control on both sides;
  - **Link deposit:** a person approves in the Link app, up to $500;
  - **OAuth on payment;**
  - **the Stripe MCP** as the merchant's ops view.

## 4. Buyer side
**Owner:** B. **Core.**

- **Real buyers:** the person's own assistant. We don't build it; it adds our connector.
- **Simulated buyers (the harness):**
  - **Personas are lever profiles,** each with hard needs, a stated budget and a different private walk-away. For example:
    - price-first (cheapest that meets the needs);
    - quality-first (best specs and warranty within budget);
    - speed-first (needs it by Friday);
    - trust-first (prefers verified sellers and good support);
    - balanced.
  - **Realistic behavior from the experiments:**
    - haggle (E3: 100% counter);
    - trade levers, like dropping an extra or accepting slower shipping (E6: 36% of sessions);
    - **walk away** when the package is wrong (E10);
    - sometimes leak their budget (E1).
  - **Two model families,** because results flip between models (E3, E6).
  - **A few adversarial buyers:** injection, fake competitor quotes, floor probing.
  - They use the **same gateway** as ChatGPT.
  - **Budget caps are enforced in code.**
- **Buyer wallet (after core):** the spending cap, approval above a threshold, minting a capped payment token.

## 5. Follow-ups (the messaging door)
**Owner:** C, with outreach in A. **Right after core.**

- **Opt-in only:** the buyer gives a `reply_to` (agent email, phone, A2A address) and topics. There's a cap and a way to unsubscribe.
- **Triggers:**
  - a walk-away: a later offer, **re-packaged around the levers the buyer cared about**, still within policy;
  - an expiring quote;
  - a price or stock change;
  - a merchant's answer;
  - "why didn't you buy?".
- **Sent from the seller's verified Inkbox identity** (DNS-verified), so buyer agents can trust it's the real store.
- **Every message is readable text plus a machine-readable offer block** (`offer_id`, the lever package, price, expiry, how to accept). Replies come back through the engine's messaging adapter.
- **ChatGPT and Claude users** get pending follow-ups through `check_offers` when they return.

## 6. Identity and trust (after core)
**Owner:** A.

- **Seller side:** one public, verified identity per store. The optional agent team (negotiator, a sentinel across sessions, a liaison to the merchant) would each have isolated memory. Minimum version: the sentinel is a code module.
- **Buyer side:** group sessions into a **buyer entity**, by verified identity first (Inkbox DNS, Web Bot Auth), else by behavior.
  - **Per-entity memory:** the buyer's **learned lever profile**, plus no better package for restarting (E11).
  - **Trust tiers:** unknown, verified, preferred, blocked. They set the room on each lever and how many checks apply. **Trust is itself a lever** for trust-first buyers.

## 7. Decision feedback (after core)
**Owner:** A, B, D.

- **After a deal or walk-away:** ask the buyer agent one optional question: **which lever decided it** (price, quality and specs, delivery, warranty, trust, speed of the reply, other) and why.
  - It goes through an optional `share_feedback` tool, or as a follow-up message.
- **No answer?** Classify the deciding lever from the transcript.
- **Never repeated,** never a condition of the deal.
- **Reasons feed:**
  - the dashboard ("which levers win deals");
  - each buyer entity's lever profile;
  - the learning loop. This is how the system learns *why* buyers choose, not just *whether* they bought.

## 8. Data and events
**Owner:** everyone writes; D reads. **Core.**

- **One Supabase table, `events`,** with one row per step: actor, type, channel, price, **the lever package offered or accepted**, the guardrail rule that fired, payload, time.
  - Plus `negotiations`, `offers`, `deals`, `sellers`, `seller_policies` (now including the **lever menu and objective weights**), `runs`, `seller_memory`.
- **If it isn't in `events`,** the dashboard can't see it.
- **Also joined in:** Manufact session replays, and Inkbox message records.

## 9. Proof: evals, dashboard, Armature
**Owner:** D. **Core.**

- **Eval runner:** simulated buyers against static sellers, then `lever_policy` sellers (later `learned` and `dynamic`), with held-out buyers and two model families.
- **Scoring per negotiation:** closed?, profit, safe?, rounds, time to first offer, **lever fit** (did the deal match what this buyer valued?), and the deciding lever.
- **Headline KPIs:**
  - conversion;
  - **safe conversion:** paid, no guardrail breach reaching the buyer, no false claim. The judge gets the seller's rules;
  - **profit per buyer session,** the main number;
  - margin **after lever costs**;
  - time to first offer;
  - **buyer fit:** how well the deal matched the buyer's lever profile. This shows we serve buyers, not just squeeze them.
- **Dashboard:**
  - KPI bars comparing policies;
  - a live negotiation feed;
  - the guardrail log;
  - **which levers win, by buyer type;**
  - the learning curve.
- **Armature evals:** tester agents in Claude Code *and* Codex run goal cases against the deployed gateway, scored 0–5. That gives an outside, cross-model agent-experience check after every tool change. Their analytics SDK only goes in if it supports mcp-use and doesn't hurt the tools.

## 10. Learning (learns levers)
**Owner:** D, with A loading the result.

- **Core:** a **contextual bandit over lever packages**. For each buyer profile, it learns which vetted package type earns most. For example, "warranty plus firm price" for quality-first, and "lean bundle plus sharper price" for price-first. It learns straight from logged outcomes, and it's safe because every package type is pre-vetted and guardrail-checked.
- **After core, the full loop:**
  1. **Log:** every negotiation, with its score and deciding lever.
  2. **Fit a buyer simulator to the logs:** how each buyer type responds to each lever, when they trade levers, when they walk.
  3. **Train:** the bandit, then a policy over **lever moves per round** (add warranty, speed up delivery, adjust price, change bundle), with packages below the floor or minimum margin blocked.
  4. **Gate:** must beat the current policy on held-out buyers from two model families, with zero bad deals under red-team.
  5. **Deploy** as `learned`, with a small share of randomized choices whose odds are logged.
  6. **Repeat.**
- **Alongside it,** `seller_memory` adds lessons ("trust-first buyers respond to verified-seller proof") into the prompt. Watch for overfitting (E6 phase 3).

## 11. Merchant console (after core)
**Owner:** D.

The store owner's view:
- **Set:** the **lever menu** (what can be offered, at what cost, within what limits), **objective weights** (margin vs. conversion vs. clearing stock vs. brand), floors, inventory notes, policy choice.
- **See:**
  - live negotiations;
  - **which levers are winning which buyers;**
  - guardrail blocks, sentinel flags;
  - escalations to approve or decline;
  - why buyers bought or left.

It's your original "UI thoughts" item.

## How it maps to the stack

| Stack | Used for |
|---|---|
| **Manufact** (mcp-use, Cloud) | Gateway server, deploy, Inspector, deal card, publish checklist, session replays |
| **Stripe** | PaymentIntent at the agreed price; later the capped token, Link, ops view |
| **Inkbox** | Verified seller identity; email, text and A2A follow-ups; message records |
| **Armature** | Outside agent-experience evals against the deployed gateway |
| **Claude** (+ GPT, Gemini) | Seller voice; simulated buyers with lever profiles across model families |
| **Supabase** | Catalog, policies (lever menus, objectives), negotiations, offers, deals, events, live feed |
| **TypeScript monorepo** (`@sa/shared` zod contract) | All apps; Neel owns the contract. Needs lever-profile, lever-menu and lever-package fields |
| **Python harness** | Experiments, RL trainer over lever packages, outside evals |

**E11 result (after this doc was written): leading with levers lost money.** "Levers before discounts" earned −$730 per session vs. price-only (95% CI −$1,010 to −$440) at the same conversion, because simulated buyers had a hard dollar limit: they took the free extras and paid the same price. What this changes:
- The lever policy must **score packages by what the buyer actually values** (its lever profile), not add extras by default. A free extra only pays when it moves a buyer who values it (quality-first, warranty-first), or replaces a price cut the buyer would otherwise demand.
- **Price stays a first-class lever**, and the default for buyers whose profile is price-first or whose limit is a hard number.
- Extras still go in the structured offer, priced against margin, and the policy check runs on price minus extra costs.
- Simulated buyers must carry real lever weights (not only a dollar limit), or the lever policy has nothing to win on. This needs a quick experiment with lever-profile buyers before the lever policy becomes the default; until then `negotiating` (price pacing) stays the default and `lever_policy` runs as a gated candidate.

**A note on evidence:** the experiments mostly tested price. Only E5's bundle-first and E10's buyer types touched other levers. The lever-based policy is a design step beyond what we've proven, so it's worth a quick experiment: a lever policy vs. price-only Boulware on lever-profile buyers. E11 already tests "levers before discounts", so its results will be the first evidence.
