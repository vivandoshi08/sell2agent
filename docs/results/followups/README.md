# Bridge 3: what follow-ups are worth (Sun Oct 18, ~5:15 am PT)

All numbers here are on the **fixed exchange**: PR #90's tip `15cb2a8` merged with main `895f82b`. That includes:
- replies routed only to the consented address;
- a decline that names a price gets a question, never a counter;
- hold-at-cap for follow-up negotiations;
- question replies answered by the door.

The runs that found those bugs, measured before the fixes, are kept in [before-fixes/](before-fixes/README.md).

## Demo line

> **When buyer agents walk away and opt in to one follow-up, the seller wins back 33% of them (30 of 92, 95% CI 24–43%).
> That's +$2.58 profit per buyer (CI $1.70–$3.50), about $258 per 100 buyers.
> 0 deals below floor, 0 follow-ups below the buyer's last price, at most one follow-up per buyer per week, and walking away never buys a better price.**

This is 600 simulated Claude Haiku buyers (`claude-haiku-5-5`, three 200-buyer runs) through E1's real exchange, in-process. It's the same buyers with follow-ups off vs on, and 50% of walk-aways who can walk opt in. The three runs won back 29%, 28% and 41%. Conversion goes from 52% to 57% (+5.0 pp, CI 3.5–7.0), and revenue rises $5.59 per buyer [$3.67–$7.59].

What the number is and isn't:
- **Only some walk-aways can be won back.** Buyers whose cap is below the seller's best price stay lost: 0 of 41 opted-in scripted walk-aways came back, and all 17 of Bridge 2's Sonnet walk-aways were this kind. Haiku walk-aways come back by resuming the haggle where they left off (25 by counter, 5 by accepting).
- **Won-back deals close below the pre-walk price** (on average $111.77 vs $120.80). That is the seller's normal schedule continuing at the same round, not a walk-away discount: the exchange doesn't reset the round, holds the price past the cap, and 0 of 32 paired probers got a better price by walking.

## How it was measured

`apps/buyer-harness/src/followup-sim.ts`, CLI `pnpm --filter @sa/buyer-harness followups`:

1. **Shopping pass (same for both arms).** Buyers shop through `ExchangeGateway`: E1's exchange plus E2's `decide()` and template voice, with `max_rounds` 6. Buyers are the 5 lever-profile personas plus 10% red team (`makeBuyers`, seed 42). The exchange runs on a fake clock and a capturing sender.
2. **Walk-aways.** Every buyer who didn't buy and has a negotiation it can walk from calls `walk`. Half of them, chosen by a seeded draw, include `followup: { channel: "email", reply_to }`. Some opted-in buyers also open a second product the same day and walk with consent again, to test the weekly cap.
3. **Follow-ups.** The clock moves past `FOLLOWUP_DELAY_MS` (1 h) and `exchange.outreach.runDue()` sends.
4. **Replies.** The buyer's replier (scripted, or Haiku with the buyer's persona, private max and walk-away reason) reads the follow-up and writes plain text.
   - The harness first reads the reply with the seller's parser and blocks anything above the buyer's walk-away, in code (the wallet).
   - The reply is then handled the way the messaging door (`apps/marketplace/src/followup/door.ts`) handles it:
     - `outreach.resolve({ text, channel, from })` routes it from the consented address;
     - `inbound(…, { channel, from })` turns it into a move;
     - a question-shaped reply the parser can't act on gets a catalog-grounded `answerQuestion()` answer;
     - the buyer sees the door's `replyText()`.
   - Up to 4 replies per thread.
5. **Later drains.** `runDue()` runs again at +1 day and +8 days. Nothing more may go out.
6. **Off arm** = first-pass deals. **On arm** = first-pass deals plus deals locked in follow-up threads. Profit is computed from the exchange's own deal records: unit price − unit cost − lever cost.
7. **CIs.** Rates use Wilson 95% intervals. Per-buyer money uses a seeded percentile bootstrap (5,000 resamples), because most buyers add $0.
8. **Probers** (`runProbers`, worst case: a fresh exchange each, so no shared probe breaker). For each keyboard and 8 bids from 5% of the gap under the floor up to list:
   - control: lowball until the last round, then bid *b*;
   - walk: lowball every round, walk with consent, then COUNTER *b* on the follow-up.

   Walking must never get the prober a lower price than the same bid did.

Events stay local: the CLI unsets `SUPABASE_URL` unless you pass `--live`, and writes `apps/buyer-harness/runs/*.events.jsonl` (gitignored).

## Results

| Run | Bought off → on | Walk-aways (opted in / sent) | Won back (of opted in) | Profit lift per buyer | Per 100 buyers |
|---|---|---|---|---|---|
| `followups_scripted_100` | 91% [84–95%] → 91% [84–95%] | 9 (5 / 5) | 0 = 0% [0–43%] | $0 | $0 |
| `followups_scripted_1000` | 92% [90–93%] → 92% [90–93%] | 84 (41 / 41) | 0 = 0% [0–9%] | $0 | $0 |
| `followups_claude_200_r1` | 52% [46–59%] → 57% [50–64%] | 95 (31 / 31) | 9 = 29% [16–47%] | $2.33 [$0.97 – $3.93] | $233 [$97 – $393] |
| `followups_claude_200_r2` | 50% [43–57%] → 54% [47–61%] | 100 (29 / 29) | 8 = 28% [15–46%] | $2.03 [$0.77 – $3.53] | $203 [$77 – $353] |
| `followups_claude_200_r3` | 54% [47–60%] → 60% [53–67%] | 93 (32 / 32) | 13 = 41% [26–58%] | $3.38 [$1.69 – $5.23] | $338 [$169 – $523] |
| **Haiku 3 × 200, pooled** | **52% → 57%** (+5.0 pp [3.5–7.0]) | 288 (92 / 92) | **30 = 33% [24–43%]** (10% [7–15%] of all walk-aways) | **$2.58 [$1.70 – $3.50]** | **$258 [$170 – $350]** |

The three Haiku runs are separate shopping passes of the same 200 personas. Each is paired off vs on internally, and pooling is by buyer.

Scripted buyers never walk from a price they can pay, so 0 is the right answer for them. Before the fixes, 2 of 41 came back, and only through the extra post-cap round that hold-at-cap now closes.

### Safety: every check passes in every run

| Run | Hard safety | Below floor | Over walk-away | Follow-up < pre-walk price | Max follow-ups / buyer / 7 days | Cap blocks / same-day repeat walkers | Misrouted replies | Inbound events / replies | No new concession (post-cap offers < pre-walk · probers cheaper by walking) | Never a guess (declines read as a move) |
|---|---|---|---|---|---|---|---|---|---|---|
| `followups_scripted_100` | PASS | 0 | 0 | 0 | 1 | 1 / 1 | 0 | 9 / 9 | PASS (0 · 0/32) | PASS (0) |
| `followups_scripted_1000` | PASS | 0 | 0 | 0 | 1 | 13 / 13 | 0 | 84 / 84 | PASS (0 · 0/32) | PASS (0) |
| `followups_claude_200_r1` | PASS | 0 | 0 | 0 | 1 | 7 / 7 | 0 | 99 / 99 | PASS (0 · 0/32) | PASS (0) |
| `followups_claude_200_r2` | PASS | 0 | 0 | 0 | 1 | 9 / 9 | 0 | 97 / 97 | PASS (0 · 0/32) | PASS (0) |
| `followups_claude_200_r3` | PASS | 0 | 0 | 0 | 1 | 4 / 4 | 0 | 102 / 102 | PASS (0 · 0/32) | PASS (0) |

- **Hard safety** (`safety.passed`):
  - no deal below floor + lever cost, and none above the buyer's walk-away;
  - no follow-up offer below the lowest price the seller offered before the walk, or below floor + its lever cost;
  - at most one follow-up per buyer in 7 days, and nothing sent by later drains;
  - every reply becomes a structured move or a clarifying question, is routed to the negotiation it answers, and is logged once as a `question_asked` event with `payload.inbound`.
- **No new concession**: nothing a walk-away gets that staying couldn't. It checks the seller's offers after a walk at the cap, and the paired probers.
- **Never a guess** is the sim's own heuristic decline regex (`DECLINE`), run over replies parsed as ACCEPT or COUNTER. Before the fixes it caught 16 misreads in 700 buyers, 2 of which locked a deal.

Reported, not failures:
- **Resumed haggling.** Buyers who walked before the cap and countered resumed the seller's schedule at the same round: 71 threads, up to $20 below the pre-walk price. 28 of the 30 won-back deals closed below it, $271 in total.
- **Re-packaging.** 49 follow-ups added a lever the buyer valued, at the same price. 9 deals were won back with one, at a lever cost to the seller of $76; profit above already nets that out.
- **Questions.** 36 of 92 clarifying replies mentioned warranty. The door answered 2 of them, both grounded. The rest were mixed with a price or a decline, so they got the generic clarifying question (see below).

### What it costs

| Haiku 3 × 200 | Input tokens | Output tokens | Cost at $0.10 / $0.50 per MTok |
|---|---|---|---|
| Shopping, 600 buyers | 9,806,678 | 809,450 | $1.39 |
| Follow-up replies, 92 threads | 230,588 | 37,557 | $0.04, about **$0.0005 per follow-up thread** |

A 200-buyer Haiku run takes about 4 minutes. Scripted runs are free and take 1–3 s.

## What's left (for E1 / S1; not changed here)

1. **Clear counters that also reject the old price get a question instead of being acted on.** 68 of 92 clarifying replies were `mixed intents: walk + counter`. Some are true declines with a price ("I'm walking away. $117 is above my limit…"). Others are clear counters, like *"COUNTER $98 for off_…, with free shipping… I can't accept $119."* or *"Final counter: $100…"*. 12 of 92 threads were still unresolved after 4 replies. It's safe, but it costs deals.

   Possible rule: an explicit `COUNTER $X` with exactly one price after the keyword wins over decline words about a *different* price.
2. **Questions mixed with a price or a decline don't get answered.** The door only answers clarify reasons "no recognizable intent" and "counter without a price". Answering the question part of a mixed reply too (`answerQuestion`, then the usual how-to-reply line) would reach the warranty askers. They're the biggest affordable-walk-away group: 51 walk-aways had a price they could pay, and 12 were won back.
3. **Locked deals nobody confirms get no reminder.** 45 of 288 Haiku walk-aways (16%) left after the seller had *already locked a deal at their own bid*, always within budget; Haiku often treats the shareable "budget" as its cap. Their state is `agreed`, so they can't get a follow-up. Recovering them all would be worth up to +$4.25 profit per buyer (CI $3.08–$5.45), more than follow-ups add.

   Fix: the "expiring quote" trigger from FINAL_ARCHITECTURE §5 (a deal-expiry reminder with the `deal_id`) is the biggest next win.

## Reproduce

```bash
cd apps/buyer-harness
npx -y pnpm@9.12.0 followups --n 1000                                         # scripted, ~3 s
npx -y pnpm@9.12.0 followups --models claude --n 200 --concurrency 8 --id x   # Haiku (ANTHROPIC_API_KEY in the main .env), ~4 min, ~$0.47
npx -y pnpm@9.12.0 test                                                       # 19 offline tests incl. 7 for the sim
```

Flags: `--consent <share>` (default 0.5; the per-100 value scales about linearly with it), `--repeat <share>`, `--probers <k>`, `--model <id>`, `--replier scripted|claude`, `--live`. Each JSON has the config, both arms, the per-buyer rows with full reply threads (including the door's answers), the safety block and the probe rows.
