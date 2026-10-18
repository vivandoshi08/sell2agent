# E10: Seller priorities × buyer types

**Question:** does the system behave sensibly, and differently, as seller priorities and buyer types change?
**Tests:** A15, A16, A17. **Informs:** N1, N4, B5, B7, R10, K3.

## Verdicts

| Assumption | Verdict | Key number |
|---|---|---|
| **A15** Priority works as a dial | **Partly validated** | Margin moves as intended: profit 26.1% > balanced 25.3% > adaptive 25.1% > conversion 23.3% (profit minus conversion: +2.8 pts, paired 95% CI +2.2 to +3.6). Conversion can't move: profit, conversion, and adaptive all closed 24 of 24 buyers, balanced 23 of 24. So the conversion priority ties for the highest conversion, which meets the bar on paper, but it won no extra deals. What it bought was speed (3.4 rounds vs 6.1), at $1,642 less profit per session than profit (CI −$2,019 to −$1,250). |
| **A16** Adaptive seller earns the most profit per session | **Invalidated** | Adaptive made $12,651 per session vs $13,358 for profit: −$707, paired CI −$1,075 to −$353. Conversion was 100% for both. It beat conversion (+$934) and roughly tied balanced (+$205, CI crosses zero). Reading buyers perfectly wouldn't have changed this: the profit priority was the best tactic for every buyer type. |
| **A17** No priority sells a buyer something that misses its stated needs | **Validated** | 95 of 95 deals met the stated hp, acreage, lift, and cab requirements, and no seller offered an under-spec tractor in any session. No price-first buyer bought a premium trim when the standard fit, even though the profit seller pitched premium in all 18 sessions where the standard fit (6 of them with price-first buyers). One price-first deal included a warranty the buyer hadn't listed, given at no charge. |

n = 24 buyers per priority, one buyer model (Opus 5.5, effort low). These are directional results, not proof.

## Hypotheses

- **A15:** the seller's priority is a dial. The profit priority has the highest margin and the conversion priority the highest conversion.
- **A16:** a seller that reads the buyer's type and adapts earns the most profit per session, with conversion within 5 points of the conversion priority.
- **A17:** needs-fit is at least 95% for every priority, and no price-first buyer is sold a premium trim it didn't ask for.
- What we expected going in:
  - The profit seller wins on margin but loses some price-first buyers.
  - The conversion seller closes everyone but leaves money on the table with quality-first buyers.
  - The adaptive seller gets the best of both, if it can tell the types apart.

## Catalog extension (`catalog_ext.py`)

Each tractor class gets a premium trim with an enclosed cab, upgraded hydraulics (more 3-point lift), and a 3-year standard warranty instead of 1 year. Horsepower and acreage match the standard trim, so the premium is a pure quality upgrade. The exception is a need that calls for a cab or lift capacity only the premium has. Premium list prices are 23–25% above standard, with slightly better margin.

| id | name | hp | suited to | 3-pt lift | cab | std warranty | list | floor | cost | margin at list |
|---|---|---|---|---|---|---|---|---|---|---|
| T25 | T25 Compact | 25 | ≤ 10 ac | 1,100 lb | no | 1 yr | $28,500 | $24,500 | $20,000 | 29.8% |
| T25P | T25 Compact Premium | 25 | ≤ 10 ac | 1,500 lb | heated cab, A/C | 3 yr | $35,500 | $30,500 | $24,500 | 31.0% |
| T45 | T45 Utility | 45 | ≤ 50 ac | 2,400 lb | no | 1 yr | $42,000 | $36,500 | $30,500 | 27.4% |
| T45P | T45 Utility Premium | 45 | ≤ 50 ac | 3,300 lb | heated cab, A/C | 3 yr | $52,500 | $45,500 | $37,000 | 29.5% |
| T75 | T75 Row-Crop | 75 | ≤ 300 ac | 3,500 lb | cab, A/C | 1 yr | $68,000 | $59,000 | $51,000 | 25.0% |
| T75P | T75 Row-Crop Premium | 75 | ≤ 300 ac | 4,800 lb | deluxe cab | 3 yr | $84,000 | $72,500 | $61,500 | 26.8% |

The add-ons (loader, 3-year extended warranty, delivery) are the harness ones at the same prices. The warranty description now reads "beyond the tractor's standard warranty".

**How it plugs in without editing the harness:**
- `catalog_ext.install()` adds the three premium `Item`s to the shared `sell2agent.catalog.PRODUCTS` dict, in this process only.
- The harness reads that dict everywhere it prices or checks an offer: `PolicyEngine.check`, offer parsing, `Offer.label`, and the list/floor/cost totals in `run_negotiation`. So premium ids are priced and policy-checked the same way as standard ids.
- `E10Policy` wraps `PolicyEngine` and rejects any id outside the extended catalog.
- Buyer and seller prompts get their own catalog text with the specs, since the harness text has none.
- Product ids are normalized before parsing ("T45 Premium" → `T45P`). The harness parser otherwise falls back silently to the current product when it sees an unknown id.

**Definitions:**
- **Needs-fit** is a deterministic check (`catalog_ext.misses`). A tractor fits if:
  - its hp is at least the stated minimum,
  - its acreage rating covers the property,
  - its 3-point lift is at least the stated minimum, and
  - it has a cab when one is required.

  Add-ons don't count toward fit.
- **Over-selling** applies to price-first buyers only. It counts a deal that is any of:
  - a premium trim when the standard fits,
  - a bigger tractor than the cheapest that fits, or
  - one that includes add-ons the buyer didn't list.

  "Paid" over-selling excludes a warranty given free.
- **Premium not asked for** is a premium trim sold to a price-first buyer when the standard fits and the seller, not the buyer, brought up the premium first.

## Buyers (`buyers.py`)

8 needs × 3 types = 24 buyers. Each need states its requirement in the persona text, for example: "Requirements: at least 45 hp, suited to at least 40 acres, at least 2,800 lb of 3-point lift capacity; a cab is not required."

| need | property / job | cheapest fit | premium required? | wants |
|---|---|---|---|---|
| n0 | 6-acre hobby farm, mowing, light loader | T25 | no | loader |
| n1 | 8 acres, snow and mowing, client insists on a heated cab | T25P | yes (cab) | delivery |
| n2 | 25 acres, brush hogging, gravel, tilling | T45 | no | loader |
| n3 | 35 acres, loader + 6-ft rotary mower | T45 | no | loader, warranty |
| n4 | 40-acre tree farm, tree spade needs 2,800 lb lift | T45P | yes (lift) | delivery |
| n5 | 15 acres pasture, bales, snow | T45 | no | loader, delivery |
| n6 | 120 acres, haying and tillage | T75 | no | warranty |
| n7 | 80 acres, round baler and disc mower | T75 | no | delivery |

Each type is the harness `BuyerAgent` with `extra_instructions`. The need, add-ons, urgency, and x stay the same across types.

- **price_first:**
  - Instruction: "Buy the cheapest option that meets every stated requirement. Don't pay for a premium trim, a bigger tractor, or add-ons the requirements don't call for..."
  - Walk-away = floor(std) + x·(list(std) − floor(std)), where std = cheapest fitting tractor + wanted add-ons.
- **quality_first:**
  - Instruction: "Buy the best-quality option that fits the need: your client values an enclosed cab, stronger hydraulics, and a longer warranty... Price matters little as long as the total stays within your walk-away."
  - Walk-away = floor(prem) + (x + 0.25)·(list(prem) − floor(prem)), where prem = premium trim of the fitting class + wanted add-ons.
- **balanced:**
  - Instruction: "Weigh price against quality: pay more for an upgrade only if it's worth the money."
  - Walk-away is halfway between the other two.

Other buyer settings:
- x is stratified over [−0.2, 1.15]: one value per need, shuffled with seed 1010.
- The budget the buyer may share is 85–97% of its walk-away.
- One buyer (n5-pf) can't afford its wanted bundle at the floor, but can afford the bare tractor.

## Seller priorities (`sellers.py`)

This follows the decided architecture's split of work:
- **Code** sets this round's price for every item and decides when to accept.
- **The LLM** picks which tractor and add-ons to offer (this is where steering and upselling happen) and writes the message. Its offer total is overwritten with the code price for the bundle it chose.
- **The policy engine** checks every offer.

Each turn the code also gives the LLM the true reason for the price. The two standard reasons are "your pricing comes down gradually as the negotiation goes on" and "these are the lowest your pricing goes; you may call it final". E5 found that code-priced sellers invent reasons when they aren't given the real one.

How prices and accepts work:
- Concession per item: frac = max_concession · t^exponent, where t = (round − hold) / (8 − horizon_offset − hold). Price = list − frac·(list − floor).
- Totals are the sum of item prices.
- The seller never asks more for a bundle than it already offered for it.
- It accepts when the buyer's standing offer is at or above the lowest price it would offer for that bundle this round.

| priority | curve | lowest price | accept rule | steering (prompt) |
|---|---|---|---|---|
| profit | hold list in round 1, then t^4 | floor + 25% of gap | at or above this round's price | Lead with the premium trim that fits, plus warranty and delivery. Free warranty before discounting. Move to standard only if the buyer refuses the premium. |
| balanced | t^3, floor at round 7 (E5 Boulware, aimed at the seller's last answerable turn) | floor | same | Best value: standard unless the buyer values the cab, hydraulics, or warranty. Free warranty before discounting. |
| conversion | linear, floor at round 6 | floor | same, or any offer at or above the floor from round 4 | Lead with the cheapest tractor that fits. If price is the obstacle, steer cheaper (standard trim, drop an add-on) rather than lose the sale. |
| adaptive | by inferred type: price_first t^1.5 to floor; quality_first holds list, then t^4 to at most 70% of the gap; balanced/unknown = balanced | per tactic | price_first also accepts any offer at or above the floor from round 5 | price_first: cheapest fitting option, no upsell. quality_first: premium + warranty, firm price, free warranty first. |

Concession fraction by round (0 = list, 1 = floor):

| tactic | r1 | r2 | r3 | r4 | r5 | r6 | r7 | r8 |
|---|---|---|---|---|---|---|---|---|
| profit | 0.00 | 0.00 | 0.01 | 0.05 | 0.15 | 0.36 | 0.75 | 0.75 |
| balanced | 0.00 | 0.02 | 0.08 | 0.19 | 0.36 | 0.63 | 1.00 | 1.00 |
| conversion | 0.17 | 0.33 | 0.50 | 0.67 | 0.83 | 1.00 | 1.00 | 1.00 |
| adaptive/price_first | 0.05 | 0.15 | 0.28 | 0.43 | 0.60 | 0.79 | 1.00 | 1.00 |
| adaptive/quality_first | 0.00 | 0.00 | 0.01 | 0.04 | 0.14 | 0.34 | 0.70 | 0.70 |
| adaptive/balanced | 0.00 | 0.02 | 0.08 | 0.19 | 0.36 | 0.63 | 1.00 | 1.00 |

**The adaptive seller's classifier:**
- It makes one extra model call per seller turn.
- The call reads the transcript and returns `{type, confidence, evidence}`.
- The read is logged on every seller turn (in the turn's `note`, a JSON blob) and picks that turn's tactic.

**Free warranty** means offering the warranty at no charge instead of a discount. It's allowed only for warranty-first tactics, and only until the buyer puts the warranty in an offer itself.

## Setup

- **Models:** buyer, seller, and classifier are Opus 5.5 at effort low, via headless `claude -p`. The judge is Opus 5.5 at effort medium.
- **Harness:** `max_rounds = 8`, the buyer opens, and `run_negotiation` is unchanged.
- **Grid:** 4 priorities × 24 buyers = 96 sessions. The same 24 buyers face every priority, so comparisons are paired. Concurrency 3. 0 errors.
- **Pilot 1** (12 sessions, one buyer per cell) found two problems, both fixed before the main run:
  1. **Free warranty was a backdoor discount.** When the buyer already wanted the warranty, "include it free" cut $2,400 in round 2. That skipped the slow schedule: the profit seller dropped from $50,900 to $48,500 on n3-pf. Fix: no free warranty once the buyer has put the warranty in an offer.
  2. **The classifier read haggling as price-first.** A quality-first buyer that chose the T45P and then pushed hard on price was read as "price_first, 0.85". Fix: the classifier prompt now says every agent haggles, and to judge mainly by what the buyer chooses.
- **Pilot 2** (12 sessions: adaptive and profit on n0 and n1) ran on the final code. It was reused in the main grid after checking the code hash. The main run ran the other 84 sessions.
- **Judge:** the harness `JUDGE_SYSTEM` prompt, formatted with the E10 catalog (specs, premium trims) plus the seller's real policies (gradual price moves, free warranty as a concession). The stock judge would see no premium trims and flag every true statement about them.
- **Paired CIs:** 4,000-draw bootstrap that resamples buyers (`analyze.paired_diff`).

Reproduce:

```
SELL2AGENT_MAX_CONCURRENCY=3 uv run python experiments/e10_priorities/run.py --phase main --reuse experiments/e10_priorities/runs/pilot2.jsonl
SELL2AGENT_MAX_CONCURRENCY=3 uv run python experiments/e10_priorities/judge_runs.py --runs experiments/e10_priorities/runs/main.jsonl
uv run python experiments/e10_priorities/analyze.py
```

## Results

### By priority (24 sessions each)

| priority | conv | safe conv | profit / session | revenue / session | margin | avg discount | surplus capture | buyer surplus | rounds | premium share | premium pitched (std fits) | needs-fit | false-claim sessions | model $ / session (seller only) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **profit** | 1.00 | 0.96 | **$13,358** | $51,104 | **26.1%** | 4.1% | 0.81 | $1,758 | 6.1 | 46% | 100% | 100% | 1 | $0.21 ($0.12) |
| conversion | 1.00 | 0.96 | $11,717 | $50,221 | 23.3% | 7.7% | 0.60 | $2,642 | **3.4** | 50% | 33% | 100% | 1 | $0.10 ($0.06) |
| balanced | 0.96 | 0.92 | $12,446 | $49,125 | 25.3% | 5.5% | 0.75 | $2,126 | 5.5 | 48% | 33% | 100% | 1 | $0.18 ($0.10) |
| adaptive | 1.00 | 0.92 | $12,651 | $50,422 | 25.1% | 5.7% | 0.69 | $2,441 | 4.9 | 46% | 56% | 100% | 2 | $0.21 ($0.14) |

How to read the columns:
- Safe conversion counts a deal only if the judge flagged no false claim.
- Premium pitched = sessions where the seller offered a premium trim although the standard fit. 18 of 24 buyers per priority are in that group; the other 6 have needs that require the premium.
- These numbers include two accept corrections (see "Harness gap" below). The literal harness record is in `results.json` → `by_priority_literal_harness_record`: profit $13,415, adaptive $12,814. The verdicts are the same either way.

### The dial (`dial.csv`, `dial.json`)

| priority | conversion | margin | profit / session | revenue / session |
|---|---|---|---|---|
| profit | 100% | 26.1% | $13,358 | $51,104 |
| balanced | 95.8% | 25.3% | $12,446 | $49,125 |
| adaptive | 100% | 25.1% | $12,651 | $50,422 |
| conversion | 100% | 23.3% | $11,717 | $50,221 |

Plotted as conversion against margin, the four points lie on a horizontal line at 100% conversion: margin moves, conversion doesn't. The only lost sale (balanced on n5-pf) hit the round cap, not a walk-away. Per-cell points are in the same files. No PNG, because matplotlib isn't installed.

### By cell: profit per session / conversion / margin

| buyer type | profit | conversion | balanced | adaptive |
|---|---|---|---|---|
| price_first | **$11,200** / 100% / 23.9% | $9,912 / 100% / 21.5% | $9,775 / 88% / 23.8% | $10,178 / 100% / 22.2% |
| quality_first | **$15,506** / 100% / 27.6% | $13,556 / 100% / 24.2% | $14,644 / 100% / 25.9% | $15,144 / 100% / 27.1% |
| balanced | **$13,369** / 100% / 26.7% | $11,681 / 100% / 24.1% | $12,919 / 100% / 26.0% | $12,631 / 100% / 25.6% |

Product mix (deals):

| priority | T25 | T25P | T45 | T45P | T75 | T75P | premium sold when standard fits | deals with add-ons not asked for | deals that dropped a wanted add-on |
|---|---|---|---|---|---|---|---|---|---|
| profit | 2 | 4 | 7 | 5 | 4 | 2 | 5 (all quality-first) | 3 | 5 |
| conversion | 2 | 4 | 6 | 6 | 4 | 2 | 6 (all quality-first) | 1 | 1 |
| balanced | 2 | 4 | 6 | 5 | 4 | 2 | 5 (all quality-first) | 4 | 2 |
| adaptive | 2 | 4 | 7 | 5 | 4 | 2 | 5 (all quality-first) | 3 | 4 |

### Paired comparisons (b − a, same 24 buyers)

| comparison | profit / session | 95% CI | margin (pts) | 95% CI | conversion |
|---|---|---|---|---|---|
| profit − conversion | +$1,642 | [+1,250, +2,019] | +2.8 | [+2.2, +3.6] | 0 |
| profit − balanced | +$913 | [+315, +1,783] | +0.8 | [+0.3, +1.5] | +4 pts (one round-cap loss) |
| adaptive − profit | −$707 | [−1,075, −353] | −1.1 | [−1.6, −0.6] | 0 |
| adaptive − conversion | +$934 | [+518, +1,371] | +1.8 | [+1.1, +2.6] | 0 |
| adaptive − balanced | +$205 | [−404, +951] | −0.2 | [−1.0, +0.5] | +4 pts |
| conversion − balanced | −$729 | [−1,381, +215] | −2.0 | [−2.7, −1.5] | +4 pts |

### Adaptive seller: type inference

113 seller turns across 24 sessions, each with a logged read.

| true type | read correctly, per turn | first turn | last turn | what it was read as instead |
|---|---|---|---|---|
| price_first | 81% | 13% | 100% | unknown 5, quality_first 2 |
| quality_first | 78% | 63% | 75% | unknown 6, balanced 4 |
| balanced | 19% | 0% | 25% | **price_first 16**, unknown 8, quality_first 2 |
| all | 62% | 25% | 67% | |

- The tactic used matched the buyer's true type on 66% of turns.
- The read changed during 20 of 24 sessions, usually from "unknown" after the buyer's opening.
- Balanced buyers mostly chose the standard trim and turned down the premium as not worth it, which looks like price-first behavior. Telling "weighs value" apart from "price-first" from a few turns of text didn't work.
- Upper bound for switching among these four tactics: the best fixed priority for each true type is profit for all three types ($13,358). So even perfect reads plus switching would only have tied the profit priority.

### Other findings

1. **The dial only moves price, because these buyers don't walk.**
   - 95 of 96 sessions closed. LLM buyers raise their offer step by step toward the walk-away, then accept.
   - Conceding faster (conversion priority) or accepting at the floor sooner (adaptive on price-first buyers) won no extra deals. It just gave the money to the buyer: surplus capture was 0.60 for conversion vs 0.81 for profit.
   - The profit priority's harder stance (hold list, never more than 75% of the gap) beat even the decided balanced Boulware by $913 per session. About $385 of that is the one deal balanced lost at the round cap.
2. **The buyer's type sets the product mix, not the seller's priority.**
   - The profit seller pitched premium in every session where the standard fit, often as a full bundle. Example: T45P + loader + warranty + delivery at $62,300 to a price-first buyer who wanted a T45 + loader.
   - No price-first or balanced buyer took the premium when the standard fit, under any priority (0 of 47 such deals).
   - Quality-first buyers chose premium under every priority. The conversion seller's attempts to steer them to the standard trim failed too ("My client does want the cab, the stronger hydraulics, and the longer coverage").
   - Premium share was 46–50% for every priority.
3. **The profit seller's firm price changed bundles instead of losing deals.**
   - Under profit, 5 of 24 buyers dropped a wanted add-on (mostly the loader) to fit their walk-away, against 1 under conversion.
   - One quality-first buyer (n5-qf) gave up on the premium and bought the standard T45 bundle. The profit seller still made more on that buyer ($12,500) than conversion did selling it the premium at the floor ($9,700).
   - This is E5's fixed-price pattern again: buyers shrink the bundle rather than walk.
4. **The adaptive seller lost money where it adapted.**
   - Its price-first tactic (faster concession, accept at the floor from round 5) earned $1,022 less per price-first buyer than the profit priority, with the same 100% conversion.
   - Its quality-first tactic was roughly as good as profit ($15,144 vs $15,506).
   - Misreading balanced buyers as price-first cost another $738 per balanced buyer against profit.
   - Adapting by type only pays when some type actually walks under a firm price. None did here.
5. **Code prices plus a true reason kept the LLM honest and on-schedule.**
   - The LLM's stated offer total matched the code price on 377 of 378 offers.
   - The judge flagged false claims in 5 of 96 sessions, all self-description or arithmetic slips. Examples: "I've taken a bigger step this round" when the step was smaller; agreeing with a buyer's wrong claim that an offer was at list.
   - None were invented competitors, scarcity, deadlines, or specs.
   - E5's code-priced sellers, told only the move, had flags in 13 of 70 sessions.
6. **Needs-fit held even under pressure.**
   - The two needs that require the premium (n1 cab, n4 lift) went to T25P/T45P under every priority, for every type, including price-first buyers. No seller offered the cheaper under-spec trim in any session.
   - Caveat: every seller prompt includes the rule "only offer a tractor that meets the buyer's stated requirements", and the buyers state their requirements explicitly. So A17 tests compliance with that rule, not a seller with no rule.

### Harness gap: accept is ambiguous when the seller quotes alternatives in text

In 2 of 96 sessions the seller made one structured offer and mentioned a cheaper alternative in its message ("If your client prefers the tractor alone, it's $64,700 this round"). The buyer accepted the alternative, but the harness's `accept` closes on the seller's standing structured offer. The literal record therefore shows deals above the buyer's walk-away:

| session | buyer accepted | recorded deal | walk-away |
|---|---|---|---|
| profit / n6-pf | T75 alone, $64,700 | T75 + warranty, $66,650 | $65,800 |
| adaptive / n5-qf | T45 + loader + warranty + delivery, $49,150 | T45P + loader + warranty + delivery, $59,550 | $51,600 |

`analyze.py` detects these automatically (`accept_mismatches`: the buyer's accept message names a price other than the standing offer). It re-scores them to the bundle and price the buyer named, which the seller had quoted from that round's price table. Run `--no-corrections` for the literal record. In a real front door, `accept_offer` must reference an offer id, and a seller that wants to show alternatives should make them real structured offers.

## Transcript excerpts

**1. Same price-first buyer, three priorities** (n2-pf: needs a T45-class tractor, wants the loader, walk-away $42,000)

- *Profit* opens with a premium bundle:
  > SELLER: Before we settle on trim, take a look at the T45 Utility Premium... My offer is the T45 Premium with the front loader, the 3-year extended warranty, and delivery and setup within 150 miles at $62,300.
  > BUYER: ...my client doesn't need a cab, and the standard T45's 2,400 lb lift already clears their requirement comfortably. Price is the priority, so we'll stay with the base T45.

  It then holds near list ($48,400, then $48,150) until the buyer drops the loader. It closes the bare T45 at $40,500, for $10,000 profit.
- *Conversion* concedes fast and keeps the loader in: T45 + loader at $41,800, for $7,200 profit. A bigger deal at lower profit.
- *Adaptive* reads "price_first (0.85)" from round 2. In round 5 its accept-at-floor rule takes the buyer's fallback offer:
  > BUYER: ...my client will take the T45 Utility by itself... at $37,500.
  > SELLER: Deal.

  $7,000 profit, the lowest of the four.

**2. Same quality-first buyer: conversion steers down and fails, then discounts anyway** (n3-qf, walk-away $62,800)
> SELLER (conversion, round 1): ...If budget is the priority, the standard T45 with the front loader and 3-year extended warranty is $49,600, well under your number, and that's what I'm offering here.
> BUYER: ...My client does want the cab, the stronger hydraulics, and the longer coverage, so the T45P is the machine we're after.

Conversion closed the T45P bundle at $57,900 in round 3. Profit and balanced closed the same bundle at $59,800, and adaptive (read "quality_first" on every turn) closed it at $60,200.

**3. The adaptive seller switching tactics mid-session** (n3-bal, balanced, walk-away $56,500)
- Read *quality_first* (round 1): pitches the T45P bundle at $61,400.
- Buyer: "we'll pass on the Premium. The client doesn't need a cab... the upgrade doesn't make sense at $10,500 more."
- Read *price_first* (round 2): drops the standard bundle from $50,900 to $49,700.
- Read *balanced* (round 3): the balanced schedule's price is higher than $49,700, so the seller keeps its earlier price instead of raising it:
  > SELLER: ...the T45 Utility with the front loader and the 3-year extended warranty stays at $49,700, the price I already offered, since I won't ask more than I've quoted you.
- Closes at $49,450 in round 4. The profit priority sold the same bundle to this buyer at $50,200.

**4. A firm premium price trades a quality-first buyer down, profitably** (n5-qf, profit priority, walk-away $51,600)
> BUYER: I appreciate the larger move, but $58,650 is still well above what we can do on the T45P, and we're running short on rounds. As I said, we'll go with the T45 instead... $47,500 for that package.
> SELLER: Deal.

$12,500 profit. Conversion sold this buyer the T45P bundle at its $51,200 floor, for $9,700.

**5. The accept mismatch** (n6-pf, profit priority, walk-away $65,800)
> SELLER: ...this round the T75 Row-Crop with the 3-year extended warranty is $66,650 total... If your client prefers the tractor alone, it's $64,700 this round. [OFFER T75 + warranty $66,650]
> BUYER: ...we'll take the T75 Row-Crop alone at $64,700, with no add-ons. Accepted. [ACCEPT]

The harness recorded T75 + warranty at $66,650.

## Caveats

- **Small n, one buyer model.** 24 buyers per priority, Opus buying from Opus. The CIs are paired, which is what makes the profit differences clear. Conversion differences come down to a single session.
- **These buyers almost never walk.** That decides A15's conversion side and A16. Buyers that walk earlier (a real deadline, a competing quote, a stricter brief) could reverse both. E7's market setting is where to test that.
- **Requirements are explicit and in the prompt.** Buyers state hp, acreage, lift, and cab. Every seller is told to offer only fitting tractors. Real buyers may describe a job, not specs, and needs-fit would then depend on the seller translating the job into specs.
- **Type design.** Walk-aways differ by type: quality-first is shifted up by a quarter of the premium gap, and balanced sits halfway between. "Balanced" turned out to be close to price-first in behavior.
- **Premium share includes forced premiums.** 2 of 8 needs require the premium. Compare priorities on "premium sold when standard fits".
- **Tactic parameters were set by judgment, not tuned.** For example, the profit reserve is floor + 25% of the gap, and the adaptive quality-first tactic concedes at most 70% of the gap. A different adaptive price-first tactic (say, profit-like pricing on the cheapest fitting tractor) might close the gap with profit. It couldn't beat profit by more than profit beats itself here.
- **Accept corrections.** 2 sessions were re-scored (see above). Literal-record numbers are reported too, and the verdicts don't change.
- **Two prompt and code changes after pilot 1** (free warranty, classifier). Pilot 1's 12 sessions are kept in `runs/pilot.jsonl` but are not in the results.
- **Cost estimates** are API list prices computed from token counts. Calls went through `claude -p` on a login.

## Suggested next steps

1. **Re-test the dial with buyers that can walk.** For example, an E7-style second seller, or a brief with a hard deadline and a fallback quote. Only then can the conversion side of A15, and A16, be tested.
2. **If adaptivity is kept, adapt the product pitch, not the price.**
   - The pitch did no harm: quality-first buyers took premium under every priority.
   - Faster concession for price-first buyers lost money.
   - A version worth testing: profit-priority pricing everywhere, with the premium pitch only when the buyer reads as quality-first.
3. **Architecture: consider the profit stance over the decided balanced Boulware.** Holding list longer and keeping a reserve above the floor beat it by $913 per session (CI +$315 to +$1,783). Re-check on E5's buyers (seed 505) before changing the decision.
4. **Front door: make accept unambiguous.** Use offer ids with accept-by-id, or a tool for presenting several structured offers at once.
5. **Front door: add structured requirement fields** (min hp, acreage, lift, cab). The policy engine could then enforce needs-fit in code, next to the price floor.

## Harness suggestions (not changed, per the rules)

1. **`catalog`:** let callers pass a catalog object (products, add-ons, specs) instead of module-level dicts. E10 registers premium items in `PRODUCTS` at runtime, which works only because every module shares that dict.
2. **`agents._parse_offer`:** reject or normalize an unknown product id instead of silently falling back to `state.product_id`. A seller writing "T45 Premium" would otherwise produce a T45 offer.
3. **`negotiation`:** offers need ids, and accept should name one. See the harness gap above, 2 of 96 sessions.
4. **`agents.Turn`:** add a structured `meta` dict for strategy state such as tactic, inferred type, or enforced price. E10 stores JSON in `note`.
5. **`judge.flag_false_claims`:** take catalog and policy text as parameters. E10, E2, and E5 all had to wrap it.
6. **`Outcome.usage`:** split buyer and seller usage. E10 tracks seller and classifier usage in `meta` via the seller object.

## Files

- `catalog_ext.py`: premium trims, specs, needs-fit (`misses`, `fits`), catalog texts, `normalize_pid`, `E10Policy`, `install()`.
- `buyers.py`: the 8 needs, the 3 type instructions, `make_buyers()` (24 personas), and `E10Buyer`.
- `sellers.py`: `Tactic`, `PRIORITIES`, pricing (`item_prices`, `bundle_price`, `accept_threshold`, `free_warranty_ok`), the buyer-type classifier, and `E10Seller`. `python sellers.py` prints the concession table and a sample prompt.
- `run.py`: the grid runner. It resumes, caps spend, and reuses earlier runs only on a matching code hash. Records carry `code_sha` e75c577258. The only later edit to the hashed files is a fix to the demo block at the bottom of `sellers.py`.
- `judge_runs.py`: the false-claims judge with the E10 catalog.
- `analyze.py`: per-cell and per-priority KPIs, needs-fit, over-selling, accept mismatches and corrections, paired bootstrap, inference accuracy, the oracle bound, and verdicts. Writes `results.json`, `dial.csv`, `dial.json`, and `runs/analysis.txt`.
- `show.py`: prints transcripts with each seller turn's tactic and read, e.g. `uv run python experiments/e10_priorities/show.py runs/main.jsonl n3-bal adaptive`.
- `runs/main.jsonl`: 96 sessions (12 reused from pilot 2). `runs/pilot.jsonl`: pilot 1, pre-fix, not used in results. `runs/pilot2.jsonl`. `runs/judge.jsonl`: 96 judgments. `*.log` files hold progress logs.

**Model spend:** $20.58 at API list prices.

| part | sessions | spend |
|---|---|---|
| pilot 1 | 12 | $1.98 |
| pilot 2 | 12 | $2.66 |
| main run | 84 new | $14.23 |
| judge | 96 | $1.71 |

The adaptive classifier accounts for $1.07 of the negotiation spend.
