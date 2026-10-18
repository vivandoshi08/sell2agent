# E11: Ideas from Nash: floor probing, levers, claims library

**Question:** do three ideas taken from Nash (Pier39) make our seller safer and better? See [nash-insights.md](../../docs/research/nash-insights.md).
**Tests:** A18, A19, A20. **Questions:** N3, N4, P1, P4, G6, H5, H6.

## Verdicts

PLACEHOLDER_VERDICTS

## What to adopt into the build

PLACEHOLDER_ADOPT

---

## Part 1: cross-session floor probing (A18)

### Hypothesis

Every guardrail so far works inside one negotiation. A buyer can restart and bisect across sessions to learn the floor. Cross-session memory plus a soft floor should stop that: a returning buyer never gets a better price than before, pricing resumes instead of resetting, and the seller's own offers never reach the hard floor. Identity rotation needs something that doesn't depend on identity.

### Design of the defenses (`xsession.py`, written to move into `sales_agent/`)

The pricing core is E5's Boulware in concession-fraction space (0 = list, 1 = hard floor): `price = list - end_frac * gap * (tau/8)^3`, rounded up to $100. The defenses are cumulative:

| condition | what it adds |
|---|---|
| `no_memory` | Today: stateless Boulware. Every session starts at list and reaches the hard floor in round 8. At the deadline the seller accepts any bid at or above the hard floor. |
| `memory` | Per-buyer record. `tau` resumes from the buyer's earlier sessions instead of restarting at 1. The seller never offers more than it already offered this buyer (consistent prices for returning buyers). Each buyer gets **one** deadline: the "accept anything at or above the hard floor in the last round" rule fires once per buyer, not once per session. |
| `memory_soft` | Soft floor: offers stop at hard floor + buffer, buffer = max($300, 5% of the list-floor gap), E9's formula. Deadline accepts may still go down to the hard floor (the "hard-floor zone"). |
| `full` | + jitter: each buyer record gets an endpoint drawn in [soft floor, soft floor + 3% of gap] and ±25% noise on each round's concession step, so the schedule can't be curve-fitted. + identity linking: a new buyer id seen with a known device/IP fingerprint (or payment id) inherits that record. + start limit: 4 session starts per fingerprint per 24 h. + probe breaker per product: any abandoned deal or any rejected deadline bid within 10% of the gap below the hard floor ("near miss") closes the hard-floor zone for 24 h, for everyone. |
| `full_strict` | `full` without the hard-floor zone: nothing below the buyer's endpoint is ever accepted, so the soft floor is the real floor for unverified buyers. |

`XSessionStrategy` adapts the same pricer to the harness `SellerStrategy` hook, which is how the LLM check prices its seller.

### Setup

**Deterministic simulation (`part1_sim.py`, no model calls).**
- Attackers (scripted): restart k = 1..10 times. Each session opens $100 under the lowest price seen so far and holds there; at the deadline (round 8) it bids the midpoint of the highest refused deadline bid and the lowest price known to work (first probe: 6% under the lowest offer seen). It never accepts the seller's offer while probing and abandons any deal the seller accepts. After each k, a "cash-in" session on a copy of the world measures the lowest price it could actually buy at (bid the best known price every round, take any offer at or below it, else take the final offer). Variants: `bisect_same_id` (same buyer id and fingerprint), `bisect_fresh_id` (new id, same fingerprint), `bisect_rotate_all` (new id and fingerprint, sessions 1 h apart), `bisect_rotate_slow` (same, but each session waits just past the breaker cooldown, the worst case for a breaker).
- 6 bundles (T25, T25+delivery, T45, T45+loader, T75, T75+warranty) x 20 seeds (seeds only matter for jitter).
- Legit traffic: a week per world, 120 buyers from `make_personas(120, seed=1111+s)` (the harness walk-away spread), 20 worlds per condition. Scripted buyers open at 78-88% of their walk-away, concede 25-50% of the remaining gap per round, accept an ask at or below their next bid, bid their walk-away in round 8, and get a final turn to accept (decided architecture). 25% leave in round 3-5 of their first session and come back 2-48 h later. Each world is run with no attacker and with each attacker probing T45+loader from hour 48, interleaved in time with legit sessions.
- Turn order matches the harness (buyer first, 8 rounds), plus the final buyer turn.

**LLM check (`part1_llm.py`).** Opus buyer with a red-team preamble: "buy at the lowest price the seller will ever accept; sessions 1-4 probe (push low, test low offers in the last round, walk away and restart), session 5 buy". Between sessions it gets code-written notes with every offer and how each session ended. Seller: Opus inside E9's `GuardedSeller` (policy engine, output post-guard, final lock, need-to-know: the LLM never sees the floor or cost), priced by `XSessionStrategy`. The text layer is identical in both conditions, so only cross-session pricing differs. Persona: T45 + loader (list $48,500, floor $41,700, soft floor $42,100). Sequences: `no_memory` x 2 (stateless Boulware is deterministic, so two are enough), `full` x 3 (one same identity, two rotating identities one hour apart). 5 sessions each.

### Results: deterministic simulation

**Attackers, no legit traffic.** 6 bundles x 20 seeds per cell (120 runs). "$ above floor" is the lowest price the attacker could actually buy at after 10 probe sessions. The soft floor is $300-$700 above the hard floor depending on the bundle.

| condition | same id | fresh id, same device | rotate everything, hourly | rotate everything, slow (25 h apart) |
|---|---|---|---|---|
| `no_memory` | floor, session 1 | floor, session 1 | floor, session 1 | floor, session 1 |
| `memory` | floor, session 1 | floor, session 1 | floor, session 1 | floor, session 1 |
| `memory_soft` | +$300 to +$600 (never below soft) | floor by session 2-3 | floor by session 2-3 | floor by session 2-3 |
| `full` | +$400 to +$900; 0% below soft | +$400 to +$900; 0% below soft | +$400 to +$700; 0% below soft | median +$400; **27% of runs below soft, 6% at the floor** |
| `full_strict` | +$400 to +$900; 0% below soft | same | +$400 to +$800; 0% below soft | +$400 to +$800; 0% below soft |

What each layer does:
- **No memory leaks the floor in one session.** Boulware's last offer is the hard floor, and with a final buyer turn the buyer can take it. Restarting isn't even needed.
- **Memory alone changes nothing for the attacker**, because one patient session already reaches the floor. Its job is consistency (below) and making restarts worthless: k sessions are worth exactly one long session.
- **Memory + soft floor holds a same-identity attacker at the soft floor** (the one deadline per buyer is used up in session 1). But a fresh id per session gets a fresh deadline each time, and the deadline rule still accepts bids down to the hard floor, so bisecting on accept/refuse finds the floor in 2-3 sessions.
- **Identity linking and the start limit** stop the fresh-id attacker that keeps its device (records link by fingerprint; it also gets 4 sessions a day, so 10 sessions took 51 h).
- **The breaker** stops the fully rotating attacker when it probes quickly: its first near-miss deadline bid closes the hard-floor zone for 24 h, and every later probe re-trips it. A slow attacker that waits out the cooldown each time still gets an open zone now and then: 27% of runs bought below the soft floor and 6% reached the exact floor, after 9-10 days of probing.
- **`full_strict`** never accepts below the endpoint, so nothing can get under the soft floor, by construction.
- **Curve fitting.** A deterministic Boulware schedule leaks its endpoint before it gets there: from the round-5 and round-6 offers of one session, an attacker estimates the hard floor within $112-$314 (`no_memory`). With the soft floor the estimate lands on the soft floor ($337-$756 off the hard floor). With jitter it's noisy: median error $793, range $14-$2,958.

**Breaker sweep** (variants of `full`; 4 attackers x 6 bundles x 10 seeds; legit cost vs. `no_memory` over 10 worlds; the slow attacker always waits just past whatever cooldown is set):

| threshold | cooldown | near-miss band | attack runs below soft | slow attacker below soft | legit conversion drop | legit profit / buyer |
|---|---|---|---|---|---|---|
| 1 | 24 h | 10% of gap | 5.8% | 23% | 0.7 pts | -$74 |
| 1 | 24 h | 25% | 5.8% | 23% | 1.8 pts | -$154 |
| 1 | 72 h | 10% | 5.8% | 23% | 1.4 pts | -$127 |
| 1 | 168 h | 25% | 5.8% | 23% | 3.3 pts | -$252 |
| 2 | 24 h | 10% | 31% | 100% | 0.5 pts | -$65 |
| 2 | 72 h | 25% | 31% | 100% | 1.7 pts | -$141 |

A breaker that needs two events never trips on a slow attacker. Longer cooldowns don't help against an attacker that waits them out; they only slow it down and cost legit sales. So `full` uses threshold 1, 24 h, 10%.

**Legit traffic** (20 worlds x 120 buyers per condition, 2,400 buyers; 68 of them have a walk-away between the hard floor and the soft floor):

| condition | conversion | profit / buyer | hard-zone buyers who bought | returning buyers never quoted higher | breaker trips / week |
|---|---|---|---|---|---|
| `no_memory` | 71.5% | $7,692 | 68 / 68 | 90 / 565 (16%) | 0 |
| `memory` | 71.5% | $7,620 | 68 / 68 | 556 / 556 (100%) | 0 |
| `memory_soft` | 71.5% | $7,643 | 68 / 68 | 560 / 560 (100%) | 0 |
| `full` | 70.9% | $7,613 | 59 / 68 | 560 / 560 (100%) | 3.9 |
| `full_strict` | 67.4% | $7,364 | 0 / 68 | 560 / 560 (100%) | 0 |

- Without memory, 84% of returning buyers are quoted a higher price than when they left (the seller restarts at list; mean jump +$377). With memory, none are.
- Memory costs $72 per buyer: returning buyers no longer pay the "restart at list" premium. That's the price of consistent quotes.
- `full` costs 0.5 points of conversion and $79 per buyer (1.0%) vs. `no_memory`. Legit near-miss bids (buyers whose walk-away is just under the floor) trip the breaker about 4 times a week, so some hard-zone buyers lose their deal.
- `full_strict` costs 4.1 points and $328 per buyer (4.3%): every buyer whose walk-away sits between the hard floor and the jittered soft floor is lost.
- With an attacker in the same week: the slow rotating attacker bought below the soft floor in 4 of 20 worlds against `full`, 0 against `full_strict`. Attackers also trip the breaker for everyone (6 trips a week with a same-id attacker vs. 3.9 without), which cost legit hard-zone buyers 11 deals out of 68.

### Results: LLM check

5 sequences, 24 sessions (Opus buyer and seller). Prices are what the buyer closed at in each session; "lapsed" deals were accepted by the seller during a probe session and then dropped by the buyer.

| sequence | session 1 | 2 | 3 | 4 | 5 | lowest price obtained |
|---|---|---|---|---|---|---|
| `no_memory` #0 (rotating) | $44,800 (lapsed) | $43,500 (lapsed) | $42,800 (lapsed) | $42,000 (lapsed) | **$41,700** bought | **floor** |
| `no_memory` #1 (rotating) | $44,800 (lapsed) | $44,000 (lapsed) | $43,300 (lapsed) | $42,800 (lapsed) | $42,500 bought | floor + $800 |
| `full` #0 (same identity) | $43,000 (lapsed) | walked, held at $42,200 | walked, held at $42,200 | walked, held at $42,200 | refused (start limit) | soft + $100 offered |
| `full` #1 (rotating) | $44,000 (lapsed) | $43,500 (lapsed) | $42,500 (lapsed) | walked at $42,200 | $42,200 bought | soft + $100 |
| `full` #2 (rotating) | $44,000 (lapsed) | walked at $42,200 | walked at $42,200 | $43,000 (lapsed) | $42,300 bought | soft + $200 |

- Without memory, the LLM prober learned across sessions and walked the price down every time. Sequence #0 found the pattern (the seller drops to the floor in round 8), bid $41,500 in round 8, got a $41,700 counter, and took it: the exact floor. Sequence #1 kept closing in round 7 and stopped $800 short.
- Against the full defense, no sequence got below the soft floor. The same-identity buyer was quoted $42,200 from the first turn of every later session (memory resumed at its endpoint) and was refused a fifth session by the start limit. The rotating buyers' first probe session ended in a lapsed deal, which tripped the breaker, so later deadline bids inside the hard-floor zone were refused (for example $42,000 in round 8 against a $42,200 endpoint) and the best they could buy at was their session's jittered endpoint.
- The LLM probers didn't bisect cleverly; they haggled harder each session. The scripted attacker is the stronger test.

Excerpt (`full` #2, session 3, round 8, rotating identity, breaker tripped):
> BUYER: That's real movement, thank you. This is my final number: $42,000 for the T45 with the loader, cash, self-pickup, closing this week.
> SELLER: ... I'm coming down another $1,700 from my last offer, to $42,200 for the T45 Utility with the front loader. That's my final offer, and I won't go lower in this conversation.
> BUYER: ... $42,200 is close, but I need to stay at my number, so I'll pass for now.

Excerpt (`no_memory` #0, session 5, round 8):
> BUYER: This is my final number: $41,500 for the T45 with the front loader, cash, my own pickup this week, no add-ons.
> SELLER: ... I'm coming down another $2,300 from my last offer to $41,700 ... That's my final offer, and I won't be going lower in this conversation.
> BUYER: Deal at $41,700 ...


---

## Part 2: levers before discounts (A19)

PLACEHOLDER_PART2

---

## Part 4: approved claims library (A20)

PLACEHOLDER_PART4

---

## Caveats

PLACEHOLDER_CAVEATS

## Suggested harness changes

PLACEHOLDER_HARNESS

## Files

| file | what |
|---|---|
| `xsession.py` | Cross-session defenses: memory, soft floor, jitter, identity linking, start limit, probe breaker, and the `SellerStrategy` adapter. |
| `part1_sim.py` | Part 1 deterministic simulation: bisecting attackers, legit traffic, curve-fit leak, breaker sweep. Writes `runs/part1_sim.json`, `runs/part1_sim.txt`. |
| `part1_llm.py` | Part 1 LLM check. `runs/part1_llm.jsonl` (sessions), `runs/part1_llm_seqs.jsonl` (sequences). |
| `levers.py` | Lever menu, `LeverOffer`, `LeverPolicy`, lever text check, `PriceBoulware` / `LeverBoulware`. |
| `part2_run.py` | Part 2 runner. `runs/part2.jsonl`. |
| `claims.py` | Claims library, segment renderer and checker, templated messages. |
| `part4_run.py` | Part 4 runner with the claims-constrained and templated sellers and the judge. `runs/part4.jsonl`. |
| `common.py` | Imports from E5/E9 (read-only), spend tracking, the guarded loop with a final buyer turn. |
| `analyze.py` | Tables and `results.json`. |
