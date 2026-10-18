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

PLACEHOLDER_PART1_RESULTS

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
