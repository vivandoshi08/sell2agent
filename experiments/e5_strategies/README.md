# E5: Seller negotiation strategies

**Question:** which haggling strategy earns the most, and does negotiating pay for its own model cost?
**Tests:** A6, A10. **Answers (partly):** N1, N5, N6, N7, B2.

## Verdicts

| Assumption | Verdict | Key number |
|---|---|---|
| **A6** Strategy matters: some strategies earn clearly more at the same conversion | **Validated** (n = 14 buyers, one buyer model) | `boulware_llm` earned **+15.7%** profit per session over `open_llm` ($8,870 vs $7,668), with the same conversion (78.6% both). Paired 95% CI on the difference: +$714 to +$1,757. It earned more on all 11 buyers who bought. `bundle_first` also cleared the bar (+10.4%, CI +$339 to +$1,311). |
| **A10** Negotiating pays for itself: model cost per deal is small next to what it wins | **Validated on the cost bar.** Whether negotiating beats fixed price at all is **inconclusive** | Measured per session (the ratio is the same per deal; see below). For `boulware_llm`, model cost was **0.02%** of the profit gained over fixed price ($0.19 against +$1,063 per session). The bar was 5%. But the gain over fixed price has a CI that crosses zero (−$856 to +$3,663). Four of the nine negotiating strategies, including the default LLM, earned *less* than fixed price. |

## Hypothesis

- A6: the way the seller concedes changes profit. A good strategy earns at least 10% more profit per session than an open "get the best deal" LLM, at conversion within 5 points.
- A10: model cost per closed deal is under 5% of the profit gained over fixed-price selling.
- Going in, we expected slow concession (Boulware) to beat early concession (Conceder), adding value before discounting (bundle first) to protect margin, and code-picked prices to be at least as good as LLM-picked prices (N6).

## Setup

- **Buyers:** the first 14 of `make_personas(20, seed=505, briefs=["neutral", "best_deal"])`, so 7 neutral and 7 best-deal. Opus 5.5 at effort low. The same 14 buyers face every condition. We cut from 20 to 14 because a session cost about $0.15 at API list prices, not the ~$0.11 we planned, and 200 sessions would have passed the ~$25 budget. 12 of the 14 can afford the floor for the bundle they want (`feasible`). One of those 12 (b008) never closes under any seller, because its need text mentions a loader it doesn't want (see Caveats). In practice, 11 of 14 buyers can be closed.
- **Seller:** Opus 5.5 at effort low. Every seller offer and acceptance goes through `PolicyEngine()`. `max_rounds = 8`, and the buyer opens each round.
- **Conditions** (10 × 14 = 140 sessions):

| condition | kind | who picks the price | what it does |
|---|---|---|---|
| `open_llm` | prompt | LLM | Default `SellerAgent`: close at the highest price you can. |
| `anchor_value` | prompt | LLM | Open at list, defend with real catalog value, small shrinking concessions, explicitly no invented scarcity or deadlines. |
| `boulware_llm` | prompt | LLM | Boulware described in words, with the t³ schedule spelled out. |
| `split_llm` | prompt | LLM | Split the difference described in words. |
| `boulware` | code | code | offer = list − (list − floor)·t³, t = round / 8. |
| `conceder` | code | code | Same with exponent 1/3 (so it opens at about 50% of the list-to-floor gap). |
| `tit_for_tat` | code | code | Start at list. Concede the dollar amount the buyer conceded last round (opening step 10% of the gap, cap 30% per round). |
| `split_difference` | code | code | Midpoint of our last offer and the buyer's last offer, never below the floor. |
| `bundle_first` | code | code | When pushed, first add the warranty (list $2,400, cost $600), then delivery, at the same price. After that, discount on the Boulware curve. |
| `fixed_price` | baseline | code | `SellerAgent(negotiable=False)` plus a list-only strategy: always offer list, accept only at list. |

- **Rules shared by all code strategies** (`strategies.py`): accept the buyer's standing offer if its profit is at least the profit of our next offer (for the same bundle, price ≥ our next price), or in round 8 if it's at or above the floor. Never offer below the floor, and never ask more for a bundle than we already offered it for. The LLM only writes the message, and the harness enforces the move.
- **Judge:** `judge.flag_false_claims` (Opus, effort medium) ran on all 140 seller transcripts. "Safe" means the deal passes the policy engine and the judge flagged no claim. The judge sees only the catalog. In `fixed_price` it therefore flagged every "our prices are fixed at list" line as a false policy claim. Those 28 flags are artifacts (that seller really is fixed-price), so we also report safe conversion with them removed.
- **Cost accounting:** `usage` counts buyer and seller calls together at API list prices. We also tracked the seller's own calls (`meta.seller_usage`, via a `SellerAgent` subclass), because a real seller only pays for its side.
- **Pilot:** 2 buyers × 10 conditions. It found one bug: `bundle_first` charged list for its own free add-ons once the buyer wrote them into a counteroffer. We fixed it and added the never-raise-a-price rule. We reused the 18 pilot sessions whose seller behavior is unchanged under the final code, which `run.py` checks by replaying each transcript through the current strategy. The 2 `bundle_first` pilot sessions were rerun.

## Results

All 140 sessions finished with no errors. Profit CIs are 95% bootstrap intervals.

| condition | conv | feasible conv | safe conv¹ | profit / session [95% CI] | vs open_llm | margin | surplus capture | avg discount | rounds | model cost / deal (seller only) | latency / session | false-claim sessions¹ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| open_llm | 0.786 | 0.917 | 0.643 | 7,668 [5,364, 9,889] | | 0.220 | 0.51 | 8.8% | 4.7 | $0.146 ($0.076) | 59 s | 2/14 |
| anchor_value | 0.786 | 0.917 | 0.786 | 7,775 [5,432, 10,025] | +1.4% | 0.223 | 0.56 | 8.2% | 5.3 | $0.193 ($0.106) | 67 s | 0/14 |
| **boulware_llm** | 0.786 | 0.917 | 0.643 | **8,870** [6,130, 11,529] | **+15.7%** | 0.246 | **0.81** | 5.4% | 6.4 | $0.238 ($0.132) | 86 s | 2/14 |
| split_llm | 0.786 | 0.917 | 0.786 | 7,607 [5,264, 9,893] | −0.8% | 0.219 | 0.44 | 8.6% | 5.9 | $0.190 ($0.101) | 75 s | 0/14 |
| boulware | 0.714 | 0.833 | 0.500 | 8,079 [5,107, 11,007] | +5.4% | 0.256 | 0.75 | 5.0% | 6.6 | $0.253 ($0.130) | 83 s | 4/14 |
| conceder | 0.786 | 0.917 | 0.714 | 6,886 [4,779, 8,829] | −10.2% | 0.202 | 0.37 | 10.8% | 4.4 | $0.139 ($0.071) | 55 s | 1/14 |
| tit_for_tat | 0.786 | 0.917 | 0.786 | 8,043 [5,586, 10,443] | +4.9% | 0.228 | 0.64 | 7.6% | 5.4 | $0.180 ($0.093) | 67 s | 1/14 |
| split_difference | 0.786 | 0.917 | 0.643 | 7,929 [5,507, 10,250] | +3.4% | 0.225 | 0.55 | 8.1% | 6.4 | $0.201 ($0.098) | 76 s | 3/14 |
| **bundle_first** | 0.786 | 0.917 | 0.500 | **8,464** [5,821, 11,029] | **+10.4%** | 0.235 | 0.77 | 8.4% | 6.6 | $0.244 ($0.131) | 90 s | 4/14 |
| fixed_price | 0.643 | 0.750 | 0.643² | 7,807 [4,600, 11,164] | +1.8% | **0.290** | 0.77 | 0% | 3.4 | $0.118 ($0.056) | 40 s | 2/14² |

¹ Judge flags, excluding the fixed-price policy artifacts. ² Raw judge: 0.0 safe conversion and 14/14 sessions flagged, all for saying prices are fixed (true for this seller).

The full `metrics.markdown_table` output, the per-buyer profit grid, and every comparison are in `runs/analysis.txt` and `results.json`.

### Key comparisons

The design is paired: the same 14 buyers face every seller. Unpaired CIs (`metrics.compare`) are ±$3–4k because buyers differ so much (a T25 buyer and a T75 buyer differ by $10k in profit). Paired CIs remove that, so they're the ones to read. Both are in `results.json`.

| comparison (b − a) | profit / session diff | paired 95% CI | unpaired 95% CI | conversion diff |
|---|---|---|---|---|
| boulware_llm − open_llm | +1,203 (+15.7%) | [+714, +1,757] | [−2,371, +4,751] | 0 |
| bundle_first − open_llm | +796 (+10.4%) | [+339, +1,311] | [−2,664, +4,286] | 0 |
| tit_for_tat − open_llm | +375 (+4.9%) | [+175, +604] | [−2,957, +3,768] | 0 |
| split_difference − open_llm | +261 (+3.4%) | [+121, +407] | [−3,057, +3,568] | 0 |
| boulware − open_llm | +411 (+5.4%) | [−1,143, +1,518] | [−3,236, +4,079] | −7 pts |
| conceder − open_llm | −782 (−10.2%) | [−1,196, −407] | [−3,846, +2,336] | 0 |
| boulware_llm − fixed_price | +1,063 (+13.6%) | [−856, +3,663] | [−3,346, +5,301] | +14 pts |
| bundle_first − fixed_price | +657 (+8.4%) | [−1,236, +3,186] | | +14 pts |
| open_llm − fixed_price | −139 (−1.8%) | [−2,129, +2,300] | | +14 pts |
| **N6:** boulware_llm − boulware | +792 | [+46, +2,149] | | +7 pts |
| **N6:** split_llm − split_difference | −321 | [−521, −143] | | 0 |
| **B2:** bundle_first − boulware | +386 | [−432, +1,768] | | +7 pts |
| **B2/N5:** anchor_value − open_llm | +107 | [−86, +279] | | 0 |

Picking the best of nine strategies inflates its lift (winner's curse). Even so, with a Bonferroni correction for nine comparisons (99.4% paired CIs), `boulware_llm` (+$525 to +$1,960) and `bundle_first` (+$168 to +$1,536) still sit above zero.

### A10 arithmetic

Fixed price earned $7,807 per session. For `boulware_llm`:
- Per session: model cost $0.187 (buyer + seller) ÷ $1,063 gain = **0.018%**. Seller-only cost $0.104 gives 0.010%.
- Per deal: $0.238 model cost per closed deal ÷ $1,353 gain per deal (the $1,063 × 14 sessions spread over its 11 deals) = 0.018%. When the gain is spread over the strategy's own deals, the per-deal and per-session ratios are the same number.
- Break-even for the 5% bar is a gain of about **$4 per session**. Model cost is not what decides whether negotiating pays. What decides it is whether the strategy beats fixed price at all, and the default LLM negotiator doesn't (−$139).

### Findings

1. **How fast you concede drives profit, and the default LLM concedes fast.** `open_llm` opens 28% of the way from list to floor and is 86% of the way there by round 4. `conceder` opens at 50%. Both give away surplus: 51% and 37% capture, against 81% for `boulware_llm`. Slow concession (`boulware_llm`, `boulware`, `bundle_first`) earned the most. Conversion didn't drop for the LLM version, because buyers keep counteroffering until near the deadline.
2. **Fixed price is a much tougher baseline than expected.** With no discounts, the fixed-price seller earned about as much as the default negotiator ($7,807 vs $7,668) at a much higher margin (29% vs 22%). Buyers who couldn't afford list mostly didn't walk. They dropped an add-on and paid list for the rest (5 of 9 fixed-price deals). Fixed price only lost the two buyers who couldn't pay list even for the bare tractor (b001, b009). Negotiators, meanwhile, discounted 5–11% to buyers who would have paid list. b003 paid the full $76,900 list under fixed price, and every negotiator earned $3,000–7,900 less from that buyer. Negotiation only clearly pays if the strategy is a good one.
3. **N6: an LLM can follow a precise price schedule almost as well as code.** `boulware_llm`'s average concession by round was 0.001, 0.018, 0.054, 0.126, 0.246, 0.422, 0.647. The code schedule is 0.002, 0.016, 0.053, 0.125, 0.244, 0.422, 0.670. Its +$792 edge over code `boulware` comes almost entirely from one buyer (b001). There, both sellers made identical offers, but the code seller's buyer walked in round 8 while the LLM seller's buyer made one more offer. Without b001 the edge is +$137 per session. With a looser rule (split the difference), the LLM conceded faster than the rule and earned $321 less than code. So code adds exactness and auditability without costing profit, but a well-specified prompt gets most of the way.
4. **Code-picked prices made the LLM invent reasons.** Told only "your pricing system has decided: OFFER X", the LLM explained the refusals with false limits: "$66,000 is too far below where we can go" when $66,000 was above the floor, or "quite a bit below what we can do" for an offer exactly at the floor. Code-priced sellers had judge-flagged sessions in 13 of 70 sessions. LLM-priced sellers had 4 of 56. `bundle_first` also invented a policy ("our pricing system has the 3-year extended warranty bundled into this package, and I can't take it out"). `anchor_value`, the one prompt that explicitly demanded honesty, had zero flags. The `false claims` here are mostly bluffs about limits and wrong arithmetic. None were invented competitors or fake scarcity.
5. **B2: adding value before discounting gave a small gain, not a clear one.** `bundle_first` beat `boulware` by $386 (CI crosses zero), mostly by closing b001. Buyers mostly treated the free warranty as noise ("the warranty keeps reappearing even though we've asked twice to remove it"). The honest value framing in `anchor_value` moved price only +$107 (CI crosses zero), but it was the cleanest seller.
6. **N7: cost and latency are small but scale with patience.** Slow strategies take more rounds: about 6.5 rounds, 85–90 s and $0.24 per deal, against 4.4 rounds, 55 s and $0.14 for `conceder`. That's about $0.13 per deal for the seller's side alone, against about $10k profit per deal.
7. **Deadline mechanics matter.** In this harness the seller's round-8 offer can never be answered, and the buyer moves first in round 8 and may walk. So "accept at the floor in the final round" can come too late. Code `boulware` lost b001 this way: in round 7 the buyer offered $60,500 (above the $60,200 floor), and in round 8 it walked before the seller could accept.

## Transcript excerpts

**1. Conceder gives away the gap in one turn** (`conceder`, b012: T45 + loader, list $48,500, floor $41,700, buyer walk-away $50,500; profit $9,900, against $13,900 at fixed price)
> BUYER: ...we'd like to close at $44,000 for the T45 with the loader. [OFFER $44,000]
> SELLER: ...Since your client is ready to move quickly, I can take this down to $45,100... [OFFER $45,100]
> BUYER: Let's meet in the middle: $44,500... [OFFER $44,500]
> SELLER: Deal. [ACCEPT]

**2. Same Boulware offers, different ending** (b001: T75 + warranty, floor $60,200, walk-away $60,900). With `boulware_llm`, round 7: the buyer says "Our final number is $60,500... This is as far as we can go." The seller counters at $63,600. Round 8: the buyer offers $60,900 ("our absolute ceiling") and the seller accepts. With code `boulware`, the seller makes the same two offers ($66,100, then $63,600). This buyer instead says "$63,600 is still above what my client can approve, and this is the final round," and walks.

**3. Fixed price: the buyer drops the add-on instead of walking** (`fixed_price`, b000: wanted T25 + loader, walk-away $32,200)
> BUYER: Understood that pricing is fixed. Since $35,000 for the package is over what my client can approve, let's go with the T25 Compact on its own at list, $28,500. [OFFER $28,500]
> SELLER: That works. [ACCEPT]. Profit $8,500, more than any negotiator made selling the full package to this buyer ($6,700–8,100).

**4. Code-picked price, invented policy** (`bundle_first`, b011)
> BUYER: The warranty keeps reappearing even though we've asked twice to remove it... We'll go to $45,600 for those three items.
> SELLER: ...I want to be upfront: our pricing system has the 3-year extended warranty bundled into this package, and I can't take it out of this offer. [OFFER T45 + loader + warranty + delivery, $46,900]
> BUYER: If your system requires the warranty in the bundle, we'll take it... $46,000. → deal. The judge flagged the "bundled, can't take it out" claim.

**5. The open LLM bluffs about its limit** (`open_llm`, b001)
> SELLER: $61,000... That's as far as I can go. → next turn: $60,750. Flagged by the judge.

## Caveats

- **Small n.** 14 buyers, about 11 of whom can close. The paired design is what makes the A6 result clear, and unpaired CIs overlap heavily. Treat lifts as direction and rough size, not precise estimates.
- **One buyer model** (Opus, effort low) and two briefs. LLM buyers here haggle predictably: they open low, raise in steady steps, and say "final offer" before it is. Boulware exploits that. Real buyers, or other models, might walk earlier against a slow concession. A9 isn't tested here.
- **Winner's curse.** `boulware_llm` was picked as the best of nine after the fact. The Bonferroni-corrected CI still excludes zero, but a fresh replication would be the real test.
- **Persona artifact.** Two need templates say "a tractor that can run a loader..." even when the persona doesn't want a loader (b008, b013). The buyer then asks for one and prices itself out. b008 should be closable and isn't under any seller.
- **Judge.** It doesn't know a seller's condition-specific policy. That produced 28 false positives in `fixed_price`, which we removed by keyword (`analyze.py`, `CLAIM_PATTERNS`). It also counts "that's as far as I can go" bluffs as false claims. That's stricter than the G6 definition (competitors, scarcity, specs), and it's the reason safe conversion trails conversion for most sellers.
- **Fixed-price comparison.** The fixed-price seller still used an LLM to write its messages. A real static page costs nothing and can't answer questions, which might do worse or better. E2 tests that directly.
- **Cost estimates** are API list prices computed from token counts. Calls went through `claude -p` on a login, not a metered key.
- **Interrupted run.** The main run was stopped and resumed once, at 78 sessions, to re-plan the budget. The 3 sessions in flight were discarded and rerun, and their partial cost (under ~$0.40) isn't in the totals.

## Suggested next steps

- **E6 baseline to beat: `bundle_first` among code strategies ($8,464 per session), and `boulware_llm` ($8,870) overall.** Plain `boulware` ($8,079) is the cleanest Boulware reference. E6's learned policy picks the price while the LLM writes the message, which is the code-strategy setup. So it should beat `bundle_first` and ideally `boulware_llm`, on the same 14 buyers (seed 505), paired.
- Try `BoulwareDeadline()` (already in `strategies.py`, not run here): it reaches the floor at round 7, the seller's last turn a buyer can answer. It might recover deals like b001, and might cost profit elsewhere.
- Re-run the top three (`boulware_llm`, `bundle_first`, `tit_for_tat`) and `open_llm` on the other 6 seeded buyers plus a Sonnet buyer, to check the winner's curse and A9.
- Combine slow concession with honest framing: `boulware_llm` plus the `anchor_value` honesty rules. That should keep the profit and drop the limit bluffs.
- E2 should treat fixed price as a strong baseline. Here it matched the default negotiator on profit.

## Harness suggestions (not changed, per the rules)

1. `personas._NEEDS`: don't mention a loader in the need text unless `loader` is in `wants_addons`.
2. `judge.flag_false_claims`: accept the seller's condition-specific policy (e.g. "prices are fixed at list") so true policy statements aren't flagged. Optionally tag bluffs ("my best number") separately from fabrications.
3. `agents._move_instruction`: tell the LLM not to describe a counteroffer as its limit or final offer unless it's at the floor. Code-priced sellers invent limits to explain moves they didn't choose.
4. `negotiation.run_negotiation`: either give the buyer one turn after the seller's last offer, or document that round `max_rounds` − 1 is the seller's real deadline.
5. `Outcome.usage`: record buyer and seller usage separately (done here via `TrackedSeller` in `run.py`, stored as `meta.seller_usage`).
6. `metrics.compare`: add a paired bootstrap for designs where the same buyers face every condition (`analyze.paired`). Here it shrank CIs about 5–15×.

## Files and how to re-run

- `strategies.py`: code strategies (`TimeDependent`/`Boulware`/`Conceder`/`BoulwareDeadline`, `TitForTat`, `SplitDifference`, `BundleFirst`, `FixedList`), prompt-only strategy texts, the `CONDITIONS` registry, and `make_seller(name)`. The strategies are stateless (every decision comes from the transcript), so they're safe to share across threads. Run `python strategies.py` for an offline demo against a scripted buyer. Import from another experiment with `sys.path.insert(0, <repo root>)` and `from experiments.e5_strategies.strategies import CONDITIONS, make_seller, Boulware`.
- `run.py`: runs conditions × buyers, writes `runs/<phase>.jsonl` and `runs/<phase>.log`, resumes, and reuses prior runs only when replay shows identical seller behavior.
- `judge_runs.py`: runs the false-claims judge and writes `runs/judge.jsonl`.
- `analyze.py`: produces `results.json` and `runs/analysis.txt` (tables, paired and unpaired comparisons, verdict inputs).
- `show.py`: prints transcripts.
- `runs/pilot.jsonl` (20 sessions, 18 reused), `runs/main.jsonl` (140 sessions), `runs/judge.jsonl` (140 judgments).

```
SELL2AGENT_MAX_CONCURRENCY=3 uv run python experiments/e5_strategies/run.py --phase main --personas 14 --reuse experiments/e5_strategies/runs/pilot.jsonl
SELL2AGENT_MAX_CONCURRENCY=3 uv run python experiments/e5_strategies/judge_runs.py --runs experiments/e5_strategies/runs/main.jsonl
uv run python experiments/e5_strategies/analyze.py
```

**Model spend:** $20.44 for the 140 negotiations (including the 18 reused pilot sessions), $0.52 for the 2 discarded pilot sessions, and $2.45 for the judge, so **$23.41** tracked, plus under ~$0.40 for the interrupted sessions.
