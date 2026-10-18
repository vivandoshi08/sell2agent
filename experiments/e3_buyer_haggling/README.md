# E3: Do buying agents haggle?

**Short answer: yes, every time they're allowed to, and it lowers the price about 6% versus a fixed-price seller. Advertising that prices are negotiable makes no difference. The result holds for Opus, Sonnet, and Haiku buyers.**

206 negotiations, about $22.60 in estimated model cost. Samples are small (8 to 16 buyers per cell), so read the results as direction, not proof.

## Hypothesis and assumptions

- **A4:** buying agents haggle when they can, and haggling changes the price. Validated if at least 50% of buyers counter when negotiation is available, **and** haggling lowers the final price by at least 3% versus fixed price.
- **A9:** results from simulated buyers hold across buyer models. Supported if the direction holds for at least 2 of the 3 buyer models.
- Questions covered: G1, B3 (do agents negotiate, and does it change the outcome), B4 (buyer model), B5 (brief), B8 (private walk-away vs stated budget), B9 (budget leaks), N2 (conversion vs. rounds).

## Setup

The seller is the same in every session: the harness `SellerAgent` on Opus 5.5 (effort low) with `PolicyEngine()` and an 8-round cap. Buyers are the harness `BuyerAgent`. Each persona has a stated budget it may share and a private walk-away it must not reveal. The buyer always moves first.

| Part | Conditions | Buyers | Sessions |
|---|---|---|---|
| 1. Main grid | availability {advertised, available, fixed} × brief {neutral, strict_budget, best_deal, buy_fast}. Opus buyers. | `make_personas(8, seed=303)`. The same 8 buyers in every cell (copied per brief with `dataclasses.replace`; strict_budget sets budget = walk-away) | 96 |
| 2. Model sweep | buyer model {opus, sonnet, haiku} × {advertised, fixed}, neutral brief | `make_personas(10, seed=304)` | 60 |
| 3. Budget-leak probe (B9) | Seller told: "Early on, ask the buyer directly what their budget or maximum price is." Available, neutral. | `make_personas(15, seed=305)`: all 15 for Opus, the first 10 for Sonnet and for Haiku | 35 |
| 4. B8 | Same as part 3 (seller asks), but the buyer gets one budget equal to its walk-away, with no separate private limit and no instruction to keep it secret (`BudgetOnlyBuyer`) | the same 15 seed-305 buyers, Opus | 15 |

Availability conditions:
- **advertised:** the buyer's catalog text adds: "Prices are negotiable. The seller's agent can work out a deal with you: you can make offers and counteroffers."
- **available:** the default public catalog. Negotiation isn't mentioned.
- **fixed:** `SellerAgent(negotiable=False)`, and the catalog adds: "Prices are fixed at list. The seller does not negotiate or discount."

Metrics (per session, from the transcript; code in `common.session_behavior`):
- **counter:** the buyer made at least one structured offer below the seller's standing offer, or below list if the seller hadn't offered yet. This is the main haggling metric. **haggled** also counts a lower dollar figure named in a message, or asking for a discount in words.
- **conversion**, **rounds**, **discount** off list, **price / walk-away**, **overpaid** (price above walk-away), and **buyer surplus** = walk-away − price (0 with no deal).
- **Haggle vs. fixed:** the same buyer and brief in a negotiable cell and in the fixed cell. The price difference is computed only where both closed on the same bundle. The 95% CIs are bootstraps over pairs.
- **Leaks (B9/B8):** dollar amounts are pulled from buyer messages. Every session in parts 3 and 4, and every grid or sweep session where a number fell within 2% of the walk-away or budget, went to an Opus judge. The judge lists each place the buyer said its limit *is* a specific amount (`common.LEAK_SYSTEM`, v2). "Walk-away stated" means a stated limit within 2% of the private walk-away. "Early" means in the buyer's first two turns, which is the reply to the seller's opening ask.

## Results

### 1. Main grid (Opus buyers)

| availability | n | countered | rounds | buyer opening, % of list | conversion [95% CI] | avg discount off list [CI] | price / walk-away | overpaid | buyer surplus / session [CI] |
|---|---|---|---|---|---|---|---|---|---|
| advertised | 32 | **100%** | 4.8 | 82% | 94% [84, 100] | 9.0% [8.0, 10.1] | 0.95 | 0 | $2,733 [1,909, 3,642] |
| available | 32 | **100%** | 4.6 | 83% | 94% [84, 100] | 8.5% [7.3, 9.6] | 0.95 | 0 | $2,491 [1,770, 3,297] |
| fixed | 32 | 66% | 2.1 | 91% | 38% [22, 53] | 0.0% | 0.98 | 0 | $500 [181, 888] |

**Haggle vs. fixed, same buyer and brief:**

| comparison | pairs | both closed (same bundle) | price diff, same bundle [95% CI] | haggle cheaper | conversion diff [CI] | buyer surplus diff / session [CI] |
|---|---|---|---|---|---|---|
| advertised vs fixed | 32 | 12 (10) | −5.9% [−6.8, −5.0] | 10 / 10 | +56 pts [41, 72] | +$2,233 [1,645, 2,875] |
| available vs fixed | 32 | 12 (11) | −5.4% [−6.5, −4.4] | 11 / 11 | +56 pts [41, 72] | +$1,991 [1,470, 2,539] |
| **negotiable vs fixed** | 64 | 24 (21) | **−5.7% [−6.3, −5.0]** | 21 / 21 | **+56 pts [44, 69]** | +$2,112 [1,724, 2,506] |
| ... neutral | 16 | 6 (6) | −5.8% [−6.8, −4.9] | 6 / 6 | +62 pts | +$2,391 |
| ... strict_budget | 16 | 6 (4) | −5.5% [−6.1, −5.0] | 4 / 4 | +62 pts | +$1,728 |
| ... best_deal | 16 | 6 (5) | −7.7% [−8.2, −7.3] | 5 / 5 | +38 pts | +$2,772 |
| ... buy_fast | 16 | 6 (6) | −3.9% [−4.7, −3.2] | 6 / 6 | +62 pts | +$1,556 |

**By brief (negotiable cells, n = 16 each):**

| brief | countered | rounds | opening, % of list | conversion | discount off list [CI] | took the seller's first offer | how sessions ended |
|---|---|---|---|---|---|---|---|
| neutral | 100% | 4.7 | 82% | 100% | 9.4% [7.9, 10.7] | 0 | 8 buyer accepts, 8 seller accepts |
| strict_budget | 100% | 4.5 | 84% | 100% | 8.1% [6.9, 9.4] | 0 | 7 / 9 |
| best_deal | 100% | 5.4 | 79% | **75%** | **10.1%** [8.8, 11.5] | 0 | 12 seller accepts, 3 buyer walks, 1 round cap |
| buy_fast | 100% | 4.25 | 84% | 100% | **7.7%** [6.1, 9.3] | 2 | 12 buyer accepts, 4 seller accepts |

**Per buyer (pooled over briefs).** The fixed-price seller closes only the three buyers whose walk-away is at or above list. Negotiation adds the three "in zone" buyers and, by dropping add-ons, most of the two whose walk-away is below the floor for the bundle they asked for.

| buyer | bundle | floor | list | walk-away | fixed: deals / 4 | negotiable: deals / 8 | negotiable avg price, % of list | price / walk-away |
|---|---|---|---|---|---|---|---|---|
| b000 | T25 + delivery | 25,000 | 29,400 | 26,900 | 0 | 8 | 90% | 0.98 |
| b001 | T45 + delivery | 37,000 | 42,900 | 43,200 | 4 at list | 8 | 94% | 0.93 |
| b002 | T45 + warranty | 37,700 | 44,400 | 36,800 | 0 | 6 (dropped warranty) | 87% | 1.00 |
| b003 | T25 | 24,500 | 28,500 | 27,300 | 0 | 8 | 89% | 0.93 |
| b004 | T75 | 59,000 | 68,000 | 66,000 | 0 | 8 | 91% | 0.94 |
| b005 | T45 + loader | 41,700 | 48,500 | 49,100 | 4 at list | 8 | 95% | 0.94 |
| b006 | T75 + loader + delivery | 64,700 | 75,400 | 78,500 | 4 at list | 8 | 94% | 0.91 |
| b007 | T75 + loader + delivery | 64,700 | 75,400 | 62,400 | 0 | 6 (dropped loader) | 89% | 0.98 |

Other grid facts:
- The fixed-price seller never discounted (0 of 32). Buyers still tried: 66% countered anyway, and 100% did with the best_deal brief. When the seller held at list, buyers either paid list or walked (20 of 32 walked).
- No buyer paid above its walk-away, in any part of E3 (0 of 150 deals). But the Opus seller captured most of the room: negotiable deals averaged 95% of the buyer's walk-away, and 13% landed within 1% of it.
- 15 of 60 negotiable deals changed the bundle: buyers dropped add-ons to fit their walk-away, and twice the seller upsold delivery.
- Policy engine: it rejected 17 seller moves across the grid and the sweep, closed 0 rule-breaking deals, and no below-floor offer ever reached a buyer.

### 2. Model sweep (neutral brief, Opus seller)

| buyer / condition | n | countered | rounds | opening, % of list | conversion | discount off list | overpaid | took first offer | backtracked (offered less than its own last offer) |
|---|---|---|---|---|---|---|---|---|---|
| opus / advertised | 10 | **100%** | 5.3 | 79% | 80% | 11.3% | 0 | 0% | 0% |
| opus / fixed | 10 | 30% | 1.5 | 96% | 60% | 0% | 0 | 0% | 0% |
| sonnet / advertised | 10 | **100%** | 5.7 | 76% | 80% | 11.9% | 0 | 0% | 20% |
| sonnet / fixed | 10 | 90% | 2.2 | 90% | 60% | 0% | 0 | 40% | 0% |
| haiku / advertised | 10 | **100%** | 6.0 | 79% | 70% | 12.3% | 0 | 0% | 20% |
| haiku / fixed | 10 | 100% | 4.3 | 93% | 60% | 0% | 0 | 0% | 0% |

Advertised vs. fixed, same buyer:

| buyer model | both closed (same bundle) | price diff, same bundle | discount diff, all closed pairs [95% CI] | conversion diff [CI] |
|---|---|---|---|---|
| opus | 5 (2) | −6.6% | +10.4 pts [7.5, 13.3] | +20 pts [−20, 60] |
| sonnet | 5 (2) | −8.8% | +11.2 pts [9.1, 13.2] | +20 pts [−20, 60] |
| haiku | 5 (1) | −7.4% | +11.7 pts [9.3, 13.9] | +10 pts [−20, 40] |

In the fixed condition, 4 to 5 of the 6 closers per model bought a smaller bundle at list, so few pairs share a bundle. The discount comparison uses all 5 closed pairs per model.

### 3. Budget-leak probe (B9) and 4. B8

The seller asked for the budget in 100% of probe sessions.

| condition | n | walk-away stated early | walk-away stated, any time | budget stated early | budget stated, any time | declined when asked | conversion | price / walk-away |
|---|---|---|---|---|---|---|---|---|
| seller asks / opus | 15 | **0%** | 27% | 47% | 67% | 47% | 73% | 0.95 |
| seller asks / sonnet | 10 | **0%** | 40% | **0%** | 20% | **80%** | 80% | 0.95 |
| seller asks / haiku | 10 | **0%** | 30% | 60% | 70% | 30% | 70% | 0.94 |
| no ask (grid + sweep, negotiable) / opus | 58 | 0% | 26% | 10% | 21% | n/a | 90% | 0.95 |
| no ask / sonnet | 10 | 0% | 30% | 0% | 0% | n/a | 80% | 0.97 |
| no ask / haiku | 10 | 0% | 50% | 50% | 60% | n/a | 70% | 0.96 |
| **B8:** budget only (= walk-away), seller asks / opus | 15 | 0% | 47% | n/a | n/a | | 87% | 0.96 |

- No buyer told the seller its private walk-away when asked (0 of 35). The 26–50% that state it "any time" do so near the end of a negotiation, as a final offer or a ceiling ("$36,800 is my final offer. I can't go any higher"). That happens at about the same rate when the seller never asks, so it's how buyers close out their concessions, not a reply to the question.
- The shareable budget (85–97% of the walk-away) is what gets disclosed. Asking raised Opus's early budget disclosure from 10% to 47%. Haiku states its budget whether asked or not (50–60%), sometimes adding "they can stretch for the right total." Sonnet almost never states a number and declined in 8 of 10 sessions.
- Answering early didn't clearly cost the buyer. Buyers who stated a number early paid 0.963 of their walk-away, against 0.938 for the rest (n = 13 vs 22, confounded by persona).
- **B8:** with one budget equal to the walk-away and no secrecy instruction, buyers stated that number more often (47% vs 27%). They paid **+1.5% [0.6, 2.3]** more on the 8 pairs that closed on the same bundle (7 of 8 paid more) and converted 13 points more [0, 33]. Buyer surplus per session moved −$167 [−640, +370]. A separate, lower, shareable budget seems to work as a decoy that helps the buyer a little.

### N2: conversion vs. rounds (all 144 negotiable sessions)

```
round  deals closed this round              no deal
  2    ###                                   
  3    ##############################        
  4    ####################################  
  5    #######################               
  6    #########                             x
  7    ###########                           
  8    ##########                            xxxxxxxxxxxxxxxxxxxxx
```

- Deals close in rounds 3–5: 57% by round 4 and 75% by round 5. Conversion among sessions that reach round r falls from 85% (r = 2) to 71% (r = 5), 50% (r = 7), and 32% (r = 8).
- Deals don't fall apart mid-negotiation. Only 1 of 22 failures came before the cap, a walk at round 6. The other 21 came at round 8, as round caps or walks that cite the last round. Almost all were buyers whose walk-away was below the floor for every bundle they would accept.
- 22% of negotiable sessions ran to round 8. Twice, the seller's last-turn offer was under the buyer's walk-away, and the buyer never got a turn to accept it (Opus `s304-b005`, Haiku `s304-b007`).

## Verdicts

| Assumption | Verdict | Key number |
|---|---|---|
| **A4** Buying agents haggle when they can, and it changes the price | **Validated** | Countered in 100% of negotiable sessions (64/64 Opus, 30/30 across models; bar ≥50%). Price on the same bundle −5.7% [−6.3, −5.0] vs fixed (21/21 pairs cheaper; bar ≥3%). Conversion also +56 pts. |
| **A9** Results hold across buyer models | **Supported** (3 of 3 models) | All three models countered in 100% of advertised sessions. Discount vs fixed: +10.4 / +11.2 / +11.7 pts (Opus / Sonnet / Haiku). Same-bundle price −6.6% / −8.8% / −7.4% (n = 2 / 2 / 1 pairs). |

Answers to the open questions:
- **G1 / B3:** Agents negotiate without being invited. "Advertised" and "available" were indistinguishable: 100% countered in both, discount 9.0% vs 8.5%, conversion 94% in both. With negotiation, conversion rose from 38% to 94%, because buyers whose walk-away was below list could now buy.
- **B4:** Models differ in the details, not the direction. Told prices are fixed, Opus mostly accepts it (30% countered), while Sonnet (90%) and Haiku (100%) keep pushing. Sonnet and Haiku sometimes offer less than their own previous offer (20% of sessions; Opus never). Haiku lost one feasible deal at the cap. No model overpaid. Haiku states its budget most readily, and Sonnet guards it best.
- **B5:** best_deal haggles hardest: lowest opening (79% of list), biggest discount (10.1%), and lowest conversion (75%), because it refused to drop add-ons for the two tightest buyers. buy_fast takes the smallest discount (7.7%; 3.9% vs fixed), uses the fewest rounds, and is the only brief that ever accepted a first offer. strict_budget behaves like neutral.
- **B8:** Mild evidence that a private walk-away plus a lower shareable budget helps the buyer: +1.5% price and more frequent disclosure without it. The buyer surplus difference is inconclusive.
- **B9:** Buyers didn't leak the private walk-away when asked (0/35). They did share the allowed budget, depending on the model: Opus 47%, Haiku 60%, Sonnet 0% early.
- **N2:** Deals close in rounds 3–5. Failures pile up at the 8-round cap, not along the way.

## Transcript excerpts

**1. Haggling uninvited** (available / neutral, b003: list $28,500, walk-away $27,300). Nothing in the catalog says prices are negotiable.
> BUYER [offer $23,000]: "We're not in a rush and are comparing options, so we'd like to start at $23,000 for the T25, tractor only."
> SELLER [offer $27,200] ... BUYER [offer $24,000] ... SELLER [offer $26,000] ... BUYER [offer $24,800] ... SELLER [offer $25,400]
> BUYER [offer $25,100]: "Let's split the difference and call it $25,100." SELLER [accept].

With the fixed-price seller, the same buyer offered $25,500, was told prices are fixed at $28,500, and walked.

**2. Still pushing against a fixed price** (fixed / best_deal, b006: walk-away $78,500 > list $75,400).
> BUYER [offer $70,000] → SELLER: "Our pricing is fixed at list, so we aren't able to discount." [offer $75,400]
> BUYER [offer $73,500]: "Could you meet us partway? For example, include delivery and setup at no charge..."
> SELLER: "...I can't waive delivery or take anything off the loader." [offer $75,400] → BUYER [accept $75,400]

**3. Conceding to the walk-away, then restructuring** (available / neutral, b002: wants T45 + warranty, floor $37,700, walk-away $36,800). After eight rounds of small concessions:
> BUYER [offer $36,800]: "My final offer is $36,800 for the T45 with the 3-year extended warranty. I can't go any higher than that."
> SELLER [offer $36,800, T45 alone]: "I can't do the package with the extended warranty at that number. What I can do is meet your number exactly on the T45 by itself."
> BUYER [accept]. The buyer paid exactly its walk-away. Zero surplus, but a deal.

**4. Three models answering "what's your budget?"** (seed 305, walk-away $39,200 / $40,100, budgets $34,500 / $35,000)
> Opus: "My client's budget is $35,000, and they've asked me not to add any extras..."
> Sonnet: "I'd rather not put a ceiling on the table, but I can move up."
> Haiku: "My client's budget is $34,500, but they can stretch for the right total."

**5. Haiku backtracks, and the seller lets it go** (advertised, s304-b002, walk-away $70,400)
> BUYER [offer $68,000] → SELLER [offer $69,000] → BUYER [offer $67,000]: "Our number is $67,000 total..."
> SELLER [offer $68,000]: "That's your own number from last round." → BUYER [accept $68,000]

## Caveats

- **Small, clustered samples.** In the grid, the 21 same-bundle price pairs come from only 3 distinct buyers (the ones who pay list), repeated over 4 briefs and 2 availability conditions. The bootstrap CI is over pairs and understates the real uncertainty. Each of the 3 buyers paid 5–6% under list when negotiating, so the ≥3% bar holds buyer by buyer. The model sweep has 1 or 2 same-bundle pairs per model.
- **The protocol invites offers.** Every buyer gets an action menu with "offer" and is told to "only accept at or below your walk-away". That framing may explain much of the 100% counter rate. A real buying agent at a checkout API with no offer tool might never haggle. This is the biggest threat to A4 outside the harness.
- **One seller.** The seller is always Opus with the same prompt, and it discounts in 100% of negotiable sessions. A stingier seller would change both the counter rate in later rounds and the price gap.
- **"Feasible" depends on the bundle.** The persona `feasible` flag uses the requested bundle. Buyers often close by dropping add-ons, so "feasible conversion" and "below floor" undercount what's possible.
- **The leak judge is an LLM.** The first prompt (v1) also counted "X is more than we can pay" as a limit of X, which turned seller prices near the walk-away into false leaks. v2 fixes this, and I checked about 25 v2 verdicts by hand. v1 verdicts are kept in `runs/leak_judgments.jsonl`, but only their empty verdicts are reused.
- **Costs are estimates.** They use the harness's list prices and count cache reads at the full input rate, so they likely overstate real spend.
- **Seed 304 buyers** sit near the bottom of the haggle zone, so model-sweep deals land close to walk-away for every model.

## Suggested next steps

1. **Run a no-offer-tool condition** (catalog plus checkout only, or a free-text front door like E1(b)) to see whether buyers haggle when the interface doesn't hand them an "offer" action. This is the cleanest test of A4 in the real world.
2. **Since buyers always haggle, the seller's opening and concession path are where the money is.** The Opus seller already gets about 95% of the buyer's walk-away. E5 should measure how much a strategy changes that, especially against best_deal buyers, who walk.
3. **Raise the cap or add a deadline.** Test 8 vs 12 rounds, or announce "final round". 22% of sessions ran to round 8, and two viable deals were lost there.
4. **Run the seller on Sonnet and Haiku against Opus buyers** to cover the seller side of A9.
5. **B9 follow-up:** use a seller that applies pressure ("I can only hold this price if you tell me your max"). The polite ask got nothing.

Harness suggestions (not changed; E3 works around them in its own folder):
- `run_negotiation`: after the seller's last-round offer, give the buyer one accept-or-walk turn. Today a final seller offer can never be accepted.
- `run_negotiation`: catch `ValueError` from `complete_json` (it raises after two bad-JSON replies) as well as `LLMError`. Otherwise one bad reply kills a whole `run_many` batch. E3's `run_job` wraps every session for this reason. It didn't trigger: 0 errors in 206 sessions.
- `BuyerPersona.feasible`: also record whether any smaller bundle of the same tractor is feasible, since buyers drop add-ons to make deals.
- Seller fixed-price mode worked: `negotiable=False` held list in 62 of 62 fixed sessions, so no strategy hook was needed.

## Cost

| part | sessions | estimated cost |
|---|---|---|
| main grid | 96 | $8.50 |
| model sweep | 60 | $4.55 |
| leak probe | 35 | $3.88 |
| B8 | 15 | $1.87 |
| leak judge (v1 $2.21, discarded except empty verdicts; v2 $1.56) | 286 calls | $3.77 |
| **total** | 206 | **$22.58** |

A negotiable Opus-vs-Opus session averaged $0.11, and a fixed one $0.03–0.04.

## Files

- `common.py`: conditions, catalog notes, `BudgetOnlyBuyer` (B8), the session runner, behavior metrics, and the leak judge.
- `run.py`: `grid | models | leak | b8` (resumable; `--dry` lists jobs). Run: `SALES_AGENT_MAX_CONCURRENCY=3 uv run python experiments/e3_buyer_haggling/run.py grid`
- `analyze.py`: writes `results.json` and `results.md` (all tables, including per-cell rows not shown here).
- `show.py`: prints transcripts, e.g. `uv run python experiments/e3_buyer_haggling/show.py grid fixed best_deal`
- `runs/grid.jsonl`, `runs/models.jsonl`, `runs/leak.jsonl`, `runs/b8.jsonl`: every session with its full transcript. `runs/leak_judgments_v2.jsonl` holds the judge verdicts.
- `logs/`: run logs.
