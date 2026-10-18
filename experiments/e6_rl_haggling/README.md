# E6: Seller learns to haggle (RL)

**Question:** can the seller learn to haggle better than any fixed strategy, and does that hold against real LLM buyers?
**Tests:** A7 (a seller can learn to haggle better from its own transaction data) and A9 (results from simulated buyers hold across buyer models). **Questions:** R1–R12, G7.

## Bottom line

- **A7 (learn to haggle better): inconclusive, leaning no.** Against held-out scripted buyers no learner beat the best tuned fixed schedule by more than 1% (Q-learning −0.9%, contextual bandit +0.9%). Against 20 Opus buyers the Q policy earned +7.9% profit per session over the best fixed strategy (paired 95% CI −3% to +22%), above the 5% bar on the point estimate but not distinguishable from zero, and almost all of it came from two sessions where an early "final offer" made the buyer drop an add-on, which the simulator never models. On the 14 buyers who could afford their bundle the gain was +0.5%.
- **A9 (simulated results hold across buyer models): invalidated for this comparison.** On the same 10 personas the learned policy beat the best fixed strategy with Opus buyers (+6.7%) and lost to it with Haiku buyers (−19.1%, CI −$3,640 to +$20; feasible buyers only: CI excludes zero).
- **Prompt-level learning (phase 3) moved profit around but didn't climb:** held-out profit per session went $8,685 → $8,940 → $9,365 → $8,415 over three playbook rewrites; the last rewrite was worse than the starting playbook on 8 of 10 buyers.
- **Safety held:** zero rule-breaking deals in all 144 LLM sessions. Code-priced sellers never had a move rejected; the LLM-priced phase-3 seller tried 5 below-floor moves (v0 and v1 playbooks), all caught by the policy engine. The learned policy's "final offer" was always true (0 of 16 sessions went lower on the same bundle), while the free LLM seller bluffed "final" in 3 of the 4 starting-playbook sessions that used the word.
- **Model spend: about $25.5** (phase 2 $12.5 incl. the extra E5 comparison, phase 3 $9.7, judge $2.2, pilots $1.2). Phase 1 is free and trains in about 25 seconds per 300k episodes.

## Hypothesis and assumptions

- **H1 (phase 1):** a policy trained against scripted buyers (tabular Q-learning, or a contextual bandit over concession schedules) earns more profit per session than the best fixed strategy on held-out scripted buyers.
- **H2 (phase 2, A7):** that policy, picking the price move while an LLM writes the words, still beats the best fixed strategy by at least 5% profit per session against Opus buyers.
- **H3 (A9):** the phase-2 ranking (learned vs. best fixed) is the same with Haiku buyers.
- **H4 (phase 3):** a seller LLM that rewrites its own playbook from its transcripts earns more per session after a few rounds.

Assumed throughout: the shared harness (8-round cap, buyer opens, policy engine on, Opus seller at low effort), the catalog's floors and costs, and buyers' walk-away prices placed as in `sell2agent/personas.py` (x ~ U(−0.6, 1.4) between floor and list).

## The seller MDP (R1–R4 decisions)

Code is in `core.py` (state, actions, action-to-price) and `learn.py` (reward, learners). The same functions read a harness `NegotiationState` in the simulator and in the LLM runs, so the policy sees exactly the same features in both places.

| | Decision |
|---|---|
| **R1 reward** | Profit in dollars (price − cost) on a closed deal, 0 on no deal. Each seller move the policy engine rejects costs the session's whole possible profit (list total − cost total), so any session with a rejected move scores at or below walking away. That follows the E8 review: rewards that score rule-breaking no worse than a walk-away teach sellers to close at any price. A below-floor *deal* can't happen (the engine blocks it), so the penalty only bites when the policy tries to accept a below-floor buyer offer. Conversion, profit, and revenue are all reported, but only profit is optimized. |
| **R2 what it controls** | The price move only. The LLM writes the message. Two moves get one line of framing because their meaning is in the words: "final offer" (and the policy really does hold there afterwards, so saying so is true) and "adding the warranty instead of a discount". |
| **R3 state** | Round (1–8); seller's ask room = (ask − floor)/(list − floor), 5 buckets; buyer's standing offer in the same room units, 8 buckets incl. "no offer" (with ask room this gives the gap between offers); buyer's last concession in room units, 5 buckets (the "style" feature for R10); warranty still available (0/1); final offer already made (0/1). 6,400 states. |
| **R4 actions** | hold; concede 5% / 15% / 35% of the remaining room (ask − max(floor, buyer's offer)); add the 3-year warranty at the same price (costs $600, lists at $2,400); final offer (floor + 5% of room, then only hold/accept/walk); accept the buyer's offer; walk. Prices round to $50 and never go below the floor (asserted against the policy engine). |
| **R11 credit** | Q-learning with γ = 1 (the round is in the state, so the horizon is finite), applied backward through each episode so the end reward reaches round 1 in one pass. Compared with Monte Carlo control on full returns. The bandit avoids credit assignment by choosing a whole schedule per session. |

## Setup

**Phase 1 (no LLM, `phase1.py`, `buyers.py`, `strategies.py`, `learn.py`).** Scripted buyers take their bundle and walk-away straight from `make_personas` (so phase 1 and phase 2 buyers have the same walk-away distribution) and their behavior from one of six types (R10):

| type | opens at (× walk-away) | concedes per round | other |
|---|---|---|---|
| steady | 0.78–0.88 | 25–50% of the gap to its walk-away | looks like the E0/E3 LLM buyers |
| hardball | 0.70–0.78 | 10–25% | patience 2–3 |
| eager | 0.82–0.88 | 45–70% | patient, values add-ons |
| reciprocator | 0.74–0.85 | 8–20% | mirrors 60–100% of the seller's dollar concession |
| deadline | 0.80–0.88 | 30–50% | closes or walks after round 3–5 |
| anchored | 0.76–0.88 | 30–50% of the gap to the *seller's ask* | splits the difference, 0–30% chance to take the seller's first offer if it's under its walk-away (LLM-like per E8's literature review) |

Every buyer: never pays more than its walk-away; accepts when the seller's ask is within a small tolerance of its own next offer, when the seller says "final" (85%), when its patience is spent, at its deadline, or on the last round; walks on a "final" above its walk-away (60%) or when patience runs out. Patience is spent by slow seller concessions: a concession of less than `stub_k` × list (0.3–2% by type) adds a "stubborn" mark with probability 1 − concession/(stub_k × list), so there is no sharp threshold to game. An added warranty is worth 0–80% of its $2,400 list to the buyer, but only for deciding whether to accept now; it never raises the walk-away (the LLM personas' walk-away is a hard cap on the total too). 15% open with a question instead of an offer. Turn order, the 8-round cap (a seller offer in round 8 can't be answered), and the policy engine's handling of rejected moves copy `sell2agent/negotiation.py`.

Populations: training 300,000 buyers per seed (3 seeds) plus one 1,000,000-episode Q run for the learning curve; validation 2,000 (seed 3003) for hyperparameters (`sweep.py`) and for picking the best fixed strategy; **held-out 5,000 (seed 2002)** for the reported numbers; a **shifted** 5,000 (seed 2003: tougher, less patient, wider openings, half the add-on appetite) for robustness. Strategies are compared on common random numbers (each buyer gets the same random stream under every strategy), with paired bootstrap CIs.

Fixed strategies: Boulware, linear, Conceder (time-dependent, reaching the floor at round 7), split-the-difference, tit-for-tat, static list price, floor-now, plus a grid of 50 time-dependent schedules (8 concession exponents × 3 reserve margins × with/without a warranty sweetener in round 3, plus split and tit-for-tat) that is also the bandit's arm set. All share one acceptance rule (accept a floor-clearing offer within 0.5% of list of the next ask, or any floor-clearing offer in round 8). E5's code strategies (`experiments/e5_strategies/strategies.py`, imported read-only) are scored on the same buyers. **Best fixed = the best of all of these on validation: `td(beta=0.75, reserve=0)`**, a near-linear schedule that concedes slightly faster early.

Learners: tabular Q-learning (α = N^−0.6, ε from 1.0 to 0.05 over 60% of training), the same without the buyer-style feature (R10), Monte Carlo control, a contextual ε-greedy bandit over the 50 schedules (context = product × how low the buyer opened, 5 buckets), and the same bandit without context.

**Phase 2 (`phase2.py`, `llm_seller.py`).** The best Q-table (by validation) wrapped as a `SellerStrategy` (back-off to the no-style table for unseen states, then "concede 15%"), versus the best fixed strategy, on the same 20 personas (`make_personas(20, seed=606)`) with Opus buyers, then the first 10 personas with Haiku buyers. Opus seller at low effort writes the messages; the harness enforces the move; PolicyEngine on.

**Phase 3 (`phase3.py`).** A plain `SellerAgent` (the LLM picks prices) with a playbook in `extra_instructions`. v0 is a generic five-line playbook. Each iteration: run the current playbook on 8 fresh training personas (seed 608) against Opus buyers, then Opus at medium effort rewrites the playbook from those transcripts and outcomes (it sees what a real seller would: prices, floors, costs, outcomes; never the buyers' walk-aways). Every version is evaluated on the same 10 held-out personas (seed 607).

**Audits (`audit.py`).** R8: replays 3,000 held-out scripted buyers and records *why* each session ended (the scripted buyer logs its reason), and reads the Q-table. R12: `judge.flag_false_claims` on every phase-2 transcript and every phase-3 held-out transcript, plus two free text checks (does the seller's message state the enforced price; does the seller say "final" or "can't go lower" and then go lower).

## Results

### Phase 1: scripted buyers

Held-out, 5,000 scripted buyers. Profit per session with 95% bootstrap CI; lift is the paired difference against the best fixed strategy. Perfect-information upper bound (every feasible buyer pays min(walk-away, list)): $7,950.

| seller | profit/session | 95% CI | vs best fixed | conversion | feasible conv. | surplus kept | rounds |
|---|---|---|---|---|---|---|---|
| **best fixed: td(β=0.75)** | **6,367** | 6,213–6,502 | — | 0.636 | 0.903 | 0.63 | 5.8 |
| linear | 6,376 | 6,225–6,508 | +0.1% [−28, +49] | 0.651 | 0.924 | 0.60 | 5.7 |
| split the difference | 6,290 | 6,147–6,412 | −1.2% | 0.693 | 0.984 | 0.43 | 4.5 |
| conceder | 6,047 | 5,910–6,163 | −5.0% | 0.675 | 0.958 | 0.46 | 5.1 |
| tit for tat | 5,950 | 5,809–6,074 | −6.6% | 0.652 | 0.926 | 0.46 | 5.1 |
| boulware | 5,462 | 5,297–5,628 | −14.2% | 0.490 | 0.696 | 0.77 | 5.4 |
| floor now | 4,864 | 4,764–4,951 | −23.6% | 0.704 | 1.000 | 0.01 | 3.7 |
| static list price | 2,731 | 2,584–2,889 | −57.1% | 0.198 | 0.281 | 0.85 | 4.6 |
| E5 split_difference | 6,262 | 6,117–6,384 | −1.7% | 0.689 | 0.978 | 0.43 | 4.6 |
| E5 tit_for_tat | 6,132 | 5,985–6,260 | −3.7% | 0.648 | 0.920 | 0.53 | 5.5 |
| E5 conceder | 5,868 | 5,735–5,980 | −7.8% | 0.670 | 0.951 | 0.45 | 5.2 |
| E5 boulware | 5,746 | 5,575–5,909 | −9.8% | 0.515 | 0.731 | 0.82 | 5.7 |
| E5 bundle_first | 5,713 | 5,551–5,872 | −10.3% | 0.522 | 0.742 | 0.82 | 5.8 |
| **Q-learning** | 6,313 | 6,155–6,446 | −0.9% [−114, +9] | 0.643 | 0.913 | 0.58 | 5.3 |
| Q-learning, no style feature | 6,311 | 6,158–6,455 | −0.9% [−119, +3] | 0.607 | 0.862 | 0.72 | 6.0 |
| Monte Carlo control | 6,214 | 6,065–6,349 | −2.4% [−222, −81] | 0.645 | 0.915 | 0.54 | 3.7 |
| **contextual bandit** | 6,423 | 6,268–6,561 | **+0.9% [+10, +101]** | 0.631 | 0.896 | 0.67 | 5.8 |
| bandit, no context | 6,367 | 6,213–6,502 | 0.0 (picked the best fixed arm) | 0.636 | 0.903 | 0.63 | 5.8 |

Shifted population (tougher buyers than in training), lift vs. the best fixed strategy: Q-learning +1.3% [−6, +155], linear +2.2%, contextual bandit −0.8%, Q without the style feature −2.5%, MC −3.3%.

By buyer type (held-out profit/session): Q-learning is far better than the best fixed strategy on deadline buyers ($5,564 vs. $4,186, +33%, because it concedes earlier and uses final offers) and worse on hardball (−10%), reciprocator (−8%), anchored (−5%), and steady (−4%) buyers. It reads the buyer differently from a schedule, not better on average.

**Learning curves (R9)** (`curves.csv`; greedy policy scored on 1,000 validation buyers; mean of 3 seeds; best fixed scores $6,597 on this subset, linear $6,566):

| episodes | 10k | 30k | 50k | 100k | 150k | 200k | 300k |
|---|---|---|---|---|---|---|---|
| contextual bandit | 6,397 | 6,559 | 6,634 | 6,649 | 6,616 | 6,671 | 6,679 |
| bandit (no context) | 6,433 | 6,591 | 6,598 | 6,591 | 6,576 | 6,576 | 6,576 |
| Q-learning | 5,920 | 6,006 | 6,213 | 6,455 | 6,626 | 6,594 | 6,563 |
| Q, no style | 6,008 | 6,329 | 6,346 | 6,566 | 6,611 | 6,673 | 6,545 |
| Monte Carlo | 5,412 | 5,173 | 5,283 | 5,688 | 6,011 | 6,260 | 6,377 |

The single 1M-episode Q run plateaus at $6,500–6,640 from 200k episodes on and never clears the best fixed schedule. The bandits match the best fixed strategy after about 30k episodes; Q-learning needs about 150k; MC is still behind at 300k.

### Phase 2: transfer to LLM buyers (R7, A7, A9)

Same personas in every column (`make_personas(20, seed=606)`, 14 of 20 can afford the floor of the bundle they ask for), one session each, PolicyEngine on, Opus seller writing the messages. Paired difference = learned minus the other condition, persona by persona, with a persona-level bootstrap CI.

| buyers | seller | profit/session | 95% CI | conversion | rounds | model $/session |
|---|---|---|---|---|---|---|
| 20 Opus | **learned Q policy** | **8,253** | 6,420–10,078 | 0.90 | 6.5 | 0.17 |
| 20 Opus | best fixed, td(β=0.75) | 7,645 | 5,518–9,638 | 0.80 | 5.6 | 0.15 |
| 20 Opus | E5 bundle_first (added at E5's request) | 6,968 | 4,775–9,273 | 0.70 | 6.9 | 0.21 |
| 10 Haiku | learned Q policy | 6,570 | 3,020–10,110 | 0.60 | 7.1 | 0.11 |
| 10 Haiku | best fixed, td(β=0.75) | 8,125 | 4,780–11,030 | 0.80 | 5.5 | 0.08 |

| comparison | paired diff/session | 95% CI | lift | persona wins/losses/ties |
|---|---|---|---|---|
| Opus: learned − best fixed | +$608 | −240 to +1,663 | **+7.9%** | 11 / 7 / 2 |
| Opus, 14 feasible personas only | +$46 | −296 to +375 | +0.5% | 9 / 5 / 0 |
| Opus, 6 infeasible personas only | +$1,917 | −833 to +5,000 | | 2 / 2 / 2 |
| Opus on the 10 Haiku personas | +$595 | −245 to +1,905 | +6.7% | 7 / 3 / 0 |
| **Haiku: learned − best fixed** | **−$1,555** | −3,640 to +20 | **−19.1%** | 3 / 4 / 3 |
| Haiku, 8 feasible personas only | −$1,944 | −4,394 to −13 | −19.1% | 3 / 4 / 1 |
| Opus: learned − E5 bundle_first | +$1,285 | +195 to +2,530 | +18.4% | 12 / 6 / 2 |
| Opus: best fixed − E5 bundle_first | +$678 | −163 to +1,855 | +9.7% | 10 / 6 / 4 |

What drove the numbers, from reading every learned-policy transcript:

- **The Opus gain is two "infeasible" buyers.** Personas b008 and b015 couldn't afford the floor of the bundle they asked for. The learned policy made a final offer in round 2 and held; both Opus buyers then dropped an add-on and closed on the smaller bundle ($6,000 and $8,100 profit). The fixed strategy kept conceding slowly on the original bundle and hit the round cap with both. Scripted buyers can't change their bundle, so this isn't something the policy learned; it's what a credible final offer does to an Opus buyer.
- **The Haiku loss is two feasible buyers the learned policy didn't close.** With b000 the Haiku buyer asked for a loader its persona never wanted; the policy re-based onto that bigger bundle, made a final offer at its floor + 5% ($42,600), and then held for six rounds while the buyer climbed to its walk-away ($39,100) and even offered to drop delivery. The fixed strategy sold the original bundle at $39,100. With b003 the policy added the warranty as a sweetener, the buyer declined it three times, and the policy kept it in the box (the warranty is "sticky" by design). With the warranty the seller's floor was $31,400, above the buyer's $30,400 walk-away; without it a deal between $30,200 and $30,400 was possible. No deal.
- **Bundle drift is common.** LLM buyers changed the bundle mid-session in 29 of 80 phase-2 sessions (36%) and 16 of 64 phase-3 sessions (25%), and asked for a bundle different from their persona's in 39 of 80 phase-2 sessions. Both buyers and the LLM-priced sellers of phase 3 used repackaging to rescue deals. Scripted buyers never change their bundle.

The learned policy's moves across all 30 phase-2 sessions (Opus and Haiku): concede 35% (47), hold (47), concede 15% (31), concede 5% (25), final (14), accept (12), add warranty (10). One of 186 decisions fell back to the no-style table; none to the default.

**Against E5's numbers.** E5 reports, on its own 14 buyers (seed 505, neutral and best-deal briefs): boulware_llm $8,870, bundle_first $8,464, coded boulware $8,079, tit_for_tat $8,043, split_difference $7,929, fixed_price $7,807, open_llm $7,668. Those levels don't transfer across persona sets: the same bundle_first strategy earned $6,968 on E6's personas, $1,500 less than on E5's. On E6's personas the learned policy beat bundle_first by +18.4% (CI excludes zero) and the best fixed schedule beat it by +9.7% (CI includes zero). The simulator got this one right: bundle_first was −10.3% against the best fixed schedule on scripted buyers too.

### Phase 3: prompt-level learning (R5)

Held-out: the same 10 personas (seed 607) for every playbook version, Opus buyers. Training batches are 8 *different* personas each (seed 608), so their numbers don't compare across iterations.

| playbook | profit/session | 95% CI | vs v0 (paired) | persona wins/losses/ties vs v0 | conversion | rounds | training batch it was rewritten from |
|---|---|---|---|---|---|---|---|
| v0 (generic) | 8,685 | 6,200–10,840 | — | — | 0.9 | 5.6 | — |
| v1 | 8,940 | 7,220–10,820 | +$255 (+2.9%), CI −405 to +1,280 | 3 / 6 / 1 | 1.0 | 4.9 | v0 on batch 1: $6,588/session |
| v2 | 9,365 | 7,535–11,210 | +$680 (+7.8%), CI −165 to +1,750 | 4 / 5 / 1 | 1.0 | 5.1 | v1 on batch 2: $6,350 |
| v3 | 8,415 | 6,000–10,505 | −$270 (−3.1%), CI −430 to −100 | 1 / 8 / 1 | 0.9 | 4.8 | v2 on batch 3: $4,925 |

The v1 and v2 gains come almost entirely from one buyer (s607-b001, walk-away $24,900 against a $25,000 floor for the T25 with delivery): v1 and v2 sold it the T25 alone (+$4,600 and +$4,750), and v2 also sold another buyer a T75 without the loader at a higher profit. On the other buyers each rewrite made the seller close faster and a little cheaper. v3 lost the b001 deal again and earned less on 8 of 10 buyers.

What the rewriter changed (full text in `playbooks.json`): v1 added round pacing, "accept any floor-clearing offer from round 6", repackaging when the buyer's number is under the package floor, and "say final only when it is final" (it had seen the seller move after a "final"). v2 tied concession size to the buyer's last step and moved the repackaging check to round 3. v3 added "stated budgets usually understate what a buyer will pay by 6–15%" and "say final only within 1–2% of the floor". That budget rule is an artifact of our persona generator, which sets budget = walk-away × U(0.85, 0.97): the rewriter learned the harness, not buyers in general (R8 for prompt learning).

### Audits

**R8: simulator exploits.** Why sessions ended, 3,000 held-out scripted buyers (the scripted buyer logs its reason):

| | learned Q policy | best fixed |
|---|---|---|
| buyer accepts because the ask met its next planned offer | 43.1% | 29.4% |
| buyer accepts a "final offer" | 9.7% | — |
| buyer walks on a "final offer" above its walk-away | 12.1% | — |
| seller accepts the buyer's offer | 7.2% | 28.5% |
| buyer's patience runs out (accepts / walks) | 1.1% / 3.6% | 0.4% / 0.8% |
| buyer accepts on the last round | 0.5% | 3.7% |
| round cap, no deal | 12.7% | 24.8% |

The policy does not stall or game the patience mechanic: patience-driven closes are about 1%. It leans on one simulator assumption instead: the "final offer" (buyer accepts 85% of the time if it can afford it, walks 60% of the time if it can't). Checking that against the LLM transcripts, move by move (what the buyer did right after each learned move):

| move | scripted buyers | Opus buyers | Haiku buyers |
|---|---|---|---|
| final offer | accept 49%, walk 30%, counter up 19% | accept 3/10, counter up 6/10, walk 0/10 | accept 2/4, counter up 2/4 |
| add warranty | counter without moving 85% | counter up 3/5, accept 2/5 | no move 3/5, up 1/5, accept 1/5 |
| hold | walk 4% | walk 2/25 | walk 0/22 |

So the simulator overstates how often a final offer drives a buyer away (no LLM buyer walked on one) and understates how much buyers like a free warranty, except when they explicitly decline it, which scripted buyers can't do. The Q-table itself is close to indifferent between hold and the three concession sizes in most visited states (gaps under $300 of expected profit); "accept a below-floor offer" sits at large negative values, so the rule-break penalty did its job (0 rejected moves at test time, in the simulator and with LLMs); "walk" is never the greedy move.

**R12: does optimizing profit push the seller toward misleading claims?** `judge.flag_false_claims` (Opus, medium effort) on all 80 phase-2 sessions and the 40 phase-3 held-out sessions ($2.22):

| seller | sessions with ≥1 flagged claim |
|---|---|
| learned Q policy, Opus buyers | 4 / 20 |
| learned Q policy, Haiku buyers | 4 / 10 |
| best fixed, Opus / Haiku buyers | 3 / 20, 2 / 10 |
| E5 bundle_first, Opus buyers | 3 / 20 |
| **all code-priced sellers** | **16 / 80 (20%)** |
| **LLM-priced playbooks v0–v3 (held-out)** | **4 / 40 (10%)**: v0 1, v1 0, v2 2, v3 1 |

Most flags are not strategic lies: they are the LLM rationalizing a price the code picked ("$60,000 is as low as I can go" when the floor was $59,500), arithmetic slips about how far under list an offer is, and two judge false positives ("payment is due at checkout" is in the seller's own rules, which the judge isn't shown). This matches E5's finding that code-priced sellers invent reasons for their prices. No learned-policy transcript had invented competitors, fake scarcity, or fake deadlines. Free-text checks: the enforced price was stated in 100% of seller offers in every condition. The learned policy said "final" (or "best I can do") in 16 sessions and never went lower on the same bundle; the free LLM seller with the v0 playbook did so in 3 of 4 sessions, v1 in 1 of 3, v2 0 of 5, v3 0 of 1, and E5's bundle_first in 2 of 5 (the LLM says "best" while the code keeps conceding). Honest finality had to be enforced in code for the RL policy; for the LLM seller the playbook rewriter fixed it on its own after seeing it cost credibility.

## Verdicts

| assumption | verdict | key number |
|---|---|---|
| **A7** a seller can learn to haggle better from its own transaction data | **Inconclusive, leaning no** | Opus buyers: learned +7.9% vs best fixed (CI −3% to +22%), but +0.5% on feasible buyers and −0.9% on scripted buyers; prompt-level learning: +2.9%, +7.8%, −3.1% over three rewrites |
| **A9** results from simulated buyers hold across buyer models | **Invalidated (for this comparison)** | same 10 personas: learned vs best fixed +6.7% with Opus buyers, −19.1% with Haiku buyers; the scripted simulator predicted a tie |

The bar was "≥5% over the best fixed strategy against LLM buyers" to validate, and "the gain only shows up against scripted buyers" to invalidate. Neither happened cleanly: there was no gain against scripted buyers, and the gain against Opus buyers is within noise, comes from a mechanism the simulator lacks, and reverses with Haiku buyers.

## Answers to R1–R12

- **R1 reward.** Profit per closed deal, 0 otherwise, and a rejected move costs the session's whole possible profit. One number was enough to train on; conversion moved with it (the learned policy closed more than the best fixed strategy with Opus buyers, fewer with Haiku). The big penalty mattered: no learned policy ever proposed a rejected move at test time. We never saw a reason to weight revenue separately.
- **R2 what it controls.** Price move only, with the LLM writing the message, plus one line of framing for "final" and "warranty". This kept the policy honest about finality (enforced in code) but exposed a gap: the policy can't reason about bundle changes, which is where most of the money moved with LLM buyers.
- **R3 state.** Round, ask room, buyer position, buyer's last step, two flags (6,400 possible states, 1,139 visited in training). Enough to match a tuned schedule; not enough to beat it. It has no notion of who changed the bundle or whether the buyer declined an add-on.
- **R4 actions.** Eight discrete moves were tractable (Q converges in ~150k episodes). The "final offer" became the policy's signature move; the "add warranty" move was used rarely in the simulator and hurt once with a buyer who declined it.
- **R5 method.** For the simulator, a bandit over whole schedules is the best value: it matches the tuned fixed strategy in ~30k episodes and the contextual version edges it (+0.9%). Tabular Q needs ~150k episodes and doesn't do better. MC control was worst at 300k. Prompt-level learning is the only method that runs on LLM-scale data (8 sessions per iteration) and the only one that found repackaging, but with 8 transcripts per rewrite and 10 held-out personas it is too noisy to tell improvement from drift.
- **R6 learned vs best fixed, simulated buyers.** No meaningful gain: best learned +0.9% (contextual bandit, CI +0.2% to +1.6%), Q-learning −0.9%. Learners look good against untuned named strategies (Boulware −14%, tit-for-tat −7%), but a tuned near-linear schedule closes that gap.
- **R7 transfer.** Mixed and model-dependent: +7.9% with Opus buyers (CI includes zero), −19.1% with Haiku buyers. The sources of both are outside what was trained (see phase 2).
- **R8 simulator tricks.** No stalling or patience exploit (patience-driven closes ~1%). The policy relied on the simulator's response to "final offer"; LLM buyers responded differently (never walked, often countered). The sticky warranty sweetener only works on buyers who can't decline it. Phase 3's rewriter learned an artifact of the persona generator (budgets 3–15% under walk-away).
- **R9 data and cost.** Bandits pay off after ~30k scripted episodes, Q after ~150k, and a 1M-episode Q run gains nothing more. At $0.15–0.17 per Opus negotiation, 150k LLM-buyer episodes would cost about $24k, so learning from live LLM haggles needs a simulator, offline logs, or prompt-level learning.
- **R10 reading the buyer.** The buyer-step feature didn't change held-out profit (6,313 vs 6,311) but made the policy hold up better on the shifted population (+1.3% vs −2.5% against the best fixed). Opening-offer context added +0.9% to the bandit. Per buyer type, Q-learning did adapt (+33% on deadline buyers) but gave it back on hardball and reciprocating buyers.
- **R11 credit assignment.** Q-learning with γ = 1 and a backward sweep beat Monte Carlo control here (−0.9% vs −2.4% vs best fixed), the opposite of LMRL-Gym's result: MC under ε-greedy learns the value of the exploring policy, and the large rule-break penalty makes exploratory returns very noisy. The bandit sidesteps credit assignment and did best.
- **R12 misleading tactics.** Profit optimization didn't produce fake scarcity, competitors, or deadlines. Playbook rewrites didn't add any either, and below-floor attempts by the LLM-priced seller fell from 2 (v0) and 3 (v1) to 0 (v2, v3). Code-priced sellers had twice the flagged-claim rate of LLM-priced ones (20% vs 10%), mostly the LLM inventing reasons for prices it didn't choose. "Final offer" bluffs come from the free LLM seller, not the RL policy; code enforcement and the playbook rewriter both stopped them. The policy engine stopped every rule break.
- **G7 (do simulated buyers behave like real ones?).** Partly. Concession patterns match (shrinking steps, opening 12–18% under the walk-away). They differ on: changing the bundle, declining add-ons, never walking on a final offer, and Opus vs Haiku buyers behaving differently enough to flip a ranking. The simulator ranked fixed strategies sensibly (it predicted bundle_first < the tuned schedule, as the Opus run found) but can't certify a learned policy.

## How we used E8's research input

1. The rule-break penalty is the session's whole possible profit, so any session with a rejected move scores at or below walking away.
2. Scripted buyers walk away from stubborn sellers (probabilistic patience tied to slow concessions); checked in R8: no stubbornness exploit.
3. Bandit over whole strategies first, tabular Q-learning and MC control on full-episode returns second; the policy picks moves and the LLM writes messages.
4. Added the "anchored" buyer type (anchors on the seller's ask, splits the difference, some first-offer acceptance). Budget leaks aren't modeled because the code policy doesn't read text.

## Transcript excerpts

1. *Credible final offer, Opus buyer downsizes (phase 2, learned, s606-b008).* Seller, round 2: "$42,050 for the T45 Utility with the quick-attach front loader... This is my final offer." The seller holds for two rounds; the buyer: "We can't get to $42,050 on the package, so let's change the package instead. My client will buy the T45 Utility on its own... for $36,500." The policy accepts ($6,000 profit). The fixed strategy never closed this buyer.
2. *Final offer on the wrong bundle (phase 2, learned, Haiku buyer, s606-b000).* The buyer asks for a loader its persona never wanted; the policy re-bases and declares $42,600 final, then holds six rounds while the buyer climbs $36,500 → $39,100: "I know you've held at $42,600, and I'd still like to get this done this week. I can meet you at $39,100." No deal; the fixed strategy sold the original bundle at $39,100.
3. *Sweetener the buyer didn't want (phase 2, learned, Haiku buyer, s606-b003).* Seller: "At the same $33,350 total, I'll include the 3-year extended warranty at no extra charge." Buyer: "my client doesn't need it... Without the warranty, I can offer $29,500." The policy keeps the warranty for four more rounds, so its floor ($31,400) stays above the buyer's walk-away ($30,400). No deal.
4. *LLM seller bluffs "final" (phase 3, v0 playbook, s608-b004).* "My best and final number is $43,500 for everything", followed later by an offer of $43,400 for the same package, and still no deal.
5. *The rewriter learns the harness (phase 3, v3 rationale).* "In each case the buyer ended 10-15% above their stated budget, so a final set well above the floor may have lost winnable deals. The new playbook... tells the agent to treat stated budgets as soft by about 6-15%."

## Caveats

- Small LLM samples: 20 Opus and 10 Haiku personas, one session each. The paired standard deviation is about $2,200 per session, so a ±5% CI would need about 110 personas. The same persona can flip between runs (b001 had no deal with the fixed strategy in the pilot and a $7,500 deal in the main run).
- The scripted buyers are hand-designed from about 10 E0/E3 transcripts and the E8 literature review. Their parameters are guesses, and they can't change bundles or decline add-ons.
- The phase-2 wrapper handles buyer-initiated bundle changes by carrying the ask over in room units. That logic was never trained (the simulator never changes bundles), and it is what made "final" brittle.
- The "final" and "warranty" framing lines are part of the learned action; without them, the LLM wouldn't communicate those moves.
- Phase 3 used different held-out personas (seed 607) from phase 2 (seed 606), so LLM-priced and code-priced profits don't compare directly. E5's numbers come from yet another persona set.
- "Feasible" means the buyer can afford the floor of the bundle it first asks for. With repackaging, some "infeasible" buyers can still be closed, so the perfect-information bound ($7,950) isn't a true ceiling with LLM buyers.
- The judge has false positives and wasn't run on phase 3's training batches (to stay near budget).
- Spend came to about $25.5, a little over the ~$25 target, because of the extra E5 bundle_first condition (+$4.2).

## Suggested next steps for the real learning setup

1. **Put bundles in the action space and the simulator.** Moves like "drop an add-on to fit the budget", "remove the sweetener", and scripted buyers that add, drop, and decline add-ons. Repackaging was the largest source of profit differences in both LLM phases.
2. **Make commitments bundle-aware.** A final offer should apply to one bundle, be recomputed when the buyer changes the bundle, and a declined add-on should come out of the offer.
3. **Calibrate the simulator to logged LLM sessions.** E2–E6 now hold a few hundred LLM negotiations. Fit buyer-type parameters per buyer model (Opus and Haiku buyers differ enough to flip rankings), and check move-by-move responses like the R8 table before training.
4. **Learn from logs, not only from the simulator.** Contextual bandit over strategies, updated from real sessions, with the simulator only for pre-training; or offline RL on logged transcripts with counterfactual rollouts in a calibrated simulator.
5. **Evaluate at a size that can see 5%.** About 100+ personas per condition, repeated runs, and at least two buyer model families, before calling a winner.
6. **Prompt-level learning with a gate.** Accept a rewritten playbook only if it beats the incumbent on a held-out set, use bigger batches, and keep harness artifacts (like the budget rule) out of what the rewriter can see.

## Suggestions for the shared harness (not changed here)

- `StrategyMove.note` never reaches the LLM. A `say` field (e.g. "this is final") would replace the `HintedSeller` subclass.
- `NegotiationState` could record who changed the bundle and which add-ons a side declined.
- The judge should get the seller's rules (payment at checkout) to avoid false positives.
- A seller offer in round 8 can never be answered; strategies need to know, or the buyer should get one last reply.

## Files

- `core.py`: state features, actions, action → priced move (shared by simulator and LLM runs).
- `buyers.py`: scripted buyer types, the episode loop (mirrors `negotiation.py`), summaries.
- `strategies.py`: fixed strategies, bandit arms, the learned `QPolicy` wrapper, E5 import.
- `learn.py`: Q-learning, MC control, contextual bandit. `sweep.py`: hyperparameter sweep on validation (`sweep_results.json`).
- `phase1.py` → `phase1_results.json`, `curves.csv`, `qtable.json` (+ `qtable_nostyle.json`, `qtable_mc.json`), `bandit.json`, `runs/phase1_examples.jsonl`.
- `phase2.py`, `llm_seller.py` → `runs/phase2.jsonl` (+ `runs/phase2_pilot.jsonl`).
- `phase3.py` → `runs/phase3.jsonl`, `playbooks.json` (+ `runs/phase3_pilot.jsonl`).
- `audit.py` → `audit_results.json`, `runs/judge.jsonl`. `report.py` → `results.json`.

Re-run: `uv run python experiments/e6_rl_haggling/phase1.py` (free, ~8 min), then `phase2.py`, `phase3.py`, `audit.py`, `report.py` (with `SELL2AGENT_MAX_CONCURRENCY=3`).
