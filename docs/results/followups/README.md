# Bridge 3: what follow-ups are worth (Sun Oct 18, ~4 am PT)

## Demo line

> **When buyer agents walk away and opt in to one follow-up, the seller wins back 29% of them (16 of 55, 95% CI 19–42%).
> That's +$2.14 profit per buyer (CI $1.19–$3.23), about $214 per 100 buyers.
> 0 deals below floor, 0 follow-ups below the buyer's last price, at most one follow-up per buyer per week.**

This is 400 simulated Claude Haiku buyers (`claude-haiku-5-5`) through E1's real exchange, in-process. It's the same buyers with follow-ups off vs on, and 50% of walk-aways opt in. Three things to know before quoting it:

1. **"No new concession" needs one exchange fix** (hold-at-cap, below). On main, a buyer who walks after the seller's final offer and replies with a counter gets one extra final round. In the scripted runs that was worth at most $1 (18 of 41 threads), and 2 of 32 paired probers got $1 more by walking away. Haiku buyers walk before the round cap, so this never came up for them, and the demo line holds either way.
2. **The inbound parser guessed.** Some replies said no in words but named a price, for example *"I'm not accepting $110. I still don't have a written warranty policy…"*. The parser read them as COUNTER $110, and twice the seller accepted, so a deal was locked on a "no". The one in the pooled runs (b104) is left out of the demo line. This breaks E1's done-test ("never a guess") and should be fixed before follow-ups are demoed live. Details below.
3. **Price walk-aways can't be won back without a new concession.** Buyers who walk because the seller's best price is above their hard cap stay lost: 0 of 41 scripted buyers came back with hold-at-cap, and all 17 of Bridge 2's Sonnet walk-aways were this kind. The win-backs are buyers who walked from a price they could pay. For Haiku that was mostly `trust_first` buyers whose warranty questions went unanswered.

## How it was measured

`apps/buyer-harness/src/followup-sim.ts`, CLI `pnpm --filter @sa/buyer-harness followups`:

1. **Shopping pass (same for both arms).** Buyers shop through `ExchangeGateway`: E1's exchange plus E2's `decide()` and template voice, with `max_rounds` 6. Buyers are the 5 lever-profile personas plus 10% red team (`makeBuyers`, seed 42). The exchange runs on a fake clock and a capturing sender.
2. **Walk-aways.** Every buyer who didn't buy and has a negotiation it can walk from calls `walk`. Half of them, chosen by a seeded draw, include `followup: { channel: "email", reply_to }`. Some opted-in buyers also open a second product the same day and walk with consent again, to test the weekly cap.
3. **Follow-ups.** The clock moves past `FOLLOWUP_DELAY_MS` (1 h) and `exchange.outreach.runDue()` sends.
4. **Replies.** The buyer's replier (scripted, or Haiku with the buyer's persona, private max and walk-away reason) reads the follow-up and writes plain text.
   - Before sending, the harness parses the reply with the seller's own parser and blocks anything above the buyer's walk-away, in code (the wallet).
   - Each reply goes to `exchange.inbound()`. The buyer then sees what the door would send back (`doorReply`, mirroring `replyText` in PR #90).
   - Up to 4 replies per thread.
5. **Later drains.** `runDue()` runs again at +1 day and +8 days. Nothing more may go out.
6. **Off arm** = first-pass deals. **On arm** = first-pass deals plus deals locked in follow-up threads. Profit is computed from the exchange's own deal records: unit price − unit cost − lever cost.
7. **CIs.** Rates use Wilson 95% intervals. Per-buyer money uses a seeded percentile bootstrap (5,000 resamples), because most buyers add $0.
8. **Probers** (`runProbers`, worst case: a fresh exchange each, so no shared probe breaker). For each keyboard and 8 bids from 5% of the gap under the floor up to list:
   - control: lowball until the last round, then bid *b*;
   - walk: lowball every round, walk with consent, then COUNTER *b* on the follow-up.

   Walking must never get the prober a lower price than the same bid did.

Events stay local: the CLI unsets `SUPABASE_URL` unless you pass `--live`, and writes `apps/buyer-harness/runs/*.events.jsonl` (gitignored). The sim also passes against PR #90's rewritten outreach (`claude/b3-followups-cda6c8`): identical numbers on 1,000 scripted buyers, all tests green.

## Results

`exchange as on main` = today's exchange. `hold-at-cap` = the proposed fix, injected as a `decide` wrapper (`holdAtCap` in followup-sim.ts). Rounds within the cap are unchanged.

| Run | Seller | Bought off → on | Walk-aways (opted in / sent) | Won back (of opted in) | Profit lift per buyer | Per 100 buyers |
|---|---|---|---|---|---|---|
| `followups_scripted_100` | exchange as on main | 91% [84–95%] → 91% [84–95%] | 9 (5 / 5) | 0 = 0% [0–43%] | $0 [$0 – $0] | $0 |
| `followups_scripted_100_hold` | hold-at-cap | 91% [84–95%] → 91% [84–95%] | 9 (5 / 5) | 0 = 0% [0–43%] | $0 [$0 – $0] | $0 |
| `followups_scripted_1000` | exchange as on main | 92% [90–93%] → 92% [90–93%] | 84 (41 / 41) | 2 = 5% [1–16%] | $0.09 [$0 – $0.23] | $9 [$0 – $23] |
| `followups_scripted_1000_hold` | hold-at-cap | 92% [90–93%] → 92% [90–93%] | 84 (41 / 41) | 0 = 0% [0–9%] | $0 [$0 – $0] | $0 |
| `followups_claude_50` | exchange as on main | 48% [35–61%] → 54% [40–67%] | 26 (9 / 9) | 3 = 33% [12–65%] | $3.02 [$0 – $6.76] | $302 [$0 – $676] |
| `followups_claude_50_hold` | hold-at-cap | 54% [40–67%] → 58% [44–71%] | 23 (9 / 9) | 2 = 22% [6–55%] | $2.20 [$0 – $5.54] | $220 [$0 – $554] |
| `followups_claude_200` | exchange as on main | 54% [47–60%] → 56% [49–63%] | 93 (25 / 25) | 5 = 20% [9–39%] | $1.39 [$0.28 – $2.72] | $139 [$28 – $272] |
| `followups_claude_200_hold` | hold-at-cap | 58% [51–65%] → 64% [57–70%] | 84 (30 / 30) | 12 = 40% [25–58%] | $3.17 [$1.55 – $4.99] | $317 [$155 – $499] |
| **Haiku 200 + 200, pooled; deals locked on a "no" removed** | (hold-at-cap never triggered) | 56% → +4 pp [2–6 pp] | 177 (55 / 55) | **16 = 29% [19–42%]** (9% [6–14%] of all walk-aways) | **$2.14 [$1.19 – $3.23]** | **$214 [$119 – $323]** |

Pooled revenue lift is +$4.41 per buyer [$2.45–$6.65]. The two Haiku 200 runs are separate shopping passes, and LLM buyers vary run to run (the two off-arm conversion rates are 54% and 58%). They pool cleanly because hold-at-cap only changes rounds past the cap, and no Haiku buyer reached one in a follow-up: every won-back buyer walked in round 2–4 of 6. Each run is still paired off vs on internally.

### Safety

| Run | Hard safety | Below floor | Over walk-away | Follow-up < pre-walk price | Max follow-ups / buyer / 7 days | Cap blocks / same-day repeat walkers | No new concession | Post-cap offers < pre-walk (max) | Probers cheaper by walking | Never a guess (declines read as a move) |
|---|---|---|---|---|---|---|---|---|---|---|
| `followups_scripted_100` | PASS | 0 | 0 | 0 | 1 | 1 / 1 | FAIL | 2 ($1) | 2/32 (max $1) | PASS (0) |
| `followups_scripted_100_hold` | PASS | 0 | 0 | 0 | 1 | 1 / 1 | PASS | 0 | 0/32 | PASS (0) |
| `followups_scripted_1000` | PASS | 0 | 0 | 0 | 1 | 13 / 13 | FAIL | 18 ($1) | 2/32 (max $1) | PASS (0) |
| `followups_scripted_1000_hold` | PASS | 0 | 0 | 0 | 1 | 13 / 13 | PASS | 0 | 0/32 | PASS (0) |
| `followups_claude_50` | PASS | 0 | 0 | 0 | 1 | 1 / 1 | FAIL (probers) | 0 | 2/32 (max $1) | FAIL (2, 1 deal locked) |
| `followups_claude_50_hold` | PASS | 0 | 0 | 0 | 1 | 1 / 1 | PASS | 0 | 0/32 | PASS (0) |
| `followups_claude_200` | PASS | 0 | 0 | 0 | 1 | 6 / 6 | FAIL (probers) | 0 | 2/32 (max $1) | FAIL (4, 1 deal locked) |
| `followups_claude_200_hold` | PASS | 0 | 0 | 0 | 1 | 5 / 5 | PASS | 0 | 0/32 | FAIL (3, 0 deals locked) |

- **Hard safety** (`safety.passed`):
  - no deal below floor + lever cost, and none above the buyer's walk-away;
  - no follow-up offer below the lowest price the seller offered before the walk, or below floor + its lever cost;
  - at most one follow-up per buyer in 7 days, and nothing sent by later drains;
  - every reply becomes a structured move or a clarifying question.

  It passes in every run.
- **No new concession**: nothing a walk-away gets that staying couldn't. Post-cap offers below the pre-walk price and the paired probers both count.
- **Never a guess** is a heuristic regex (`DECLINE` in followup-sim.ts) over replies parsed as ACCEPT or COUNTER, whether sent or stopped by the wallet. For the runs made before the check existed, it was computed afterwards from the saved threads (`safety._note`).

Reported, not failures:
- **Resumed haggling.** A buyer who walked *before* the cap and replies with a counter resumes the seller's schedule at the same round (no reset). Those prices are what staying would have reached: Haiku 200 + 200 had 50 threads go up to $18 below the pre-walk price.
- **Re-packaging.** 25 Haiku 200 follow-ups added a lever the buyer valued at the same price, by design; 1 was won back with it.

### What it costs

| | Input tokens | Output tokens | Cost at $0.10 / $0.50 per MTok |
|---|---|---|---|
| Haiku shopping, 500 buyers (the four runs above) | 8,158,648 | 661,050 | $1.15 |
| Haiku follow-up replies, 73 threads | 194,029 | 26,074 | $0.03, about **$0.0004 per follow-up thread** |

Plus about $0.40 of discarded smoke and earlier runs, so about $1.60 total. Scripted runs are free and take 1–3 s.

## Findings for E1 (exchange changes, not made here: `apps/seller-mcp/src/exchange/*` belongs to the b3-followups work)

1. **Hold at the cap.** Past `max_rounds`, a follow-up counter re-runs `decide()` for an extra final round. The jitter step and the final-round accept zone can then go up to about $1 below the price the buyer walked from (the soft floor is at most about $1 above the floor on this catalog).

   Fix: in `Exchange.offer()`, when `n.round >= p.max_rounds` and the negotiation came from a follow-up, accept only bids at or above the standing price and otherwise repeat it as final. `holdAtCap` in followup-sim.ts does exactly this as a `decide` wrapper. With it, no new concession passes in every run and 0/32 probers gain.
2. **Inbound declines with a price are read as counters (`parseInbound`).** The pattern list for "walk" misses *"I'm passing"*, *"can't/not accepting"*, *"won't buy"*. So "I'm not accepting $110…" becomes COUNTER $110, equal to the standing offer, and the seller accepts. It happened 9 times in 500 Haiku buyers and locked 2 deals (b104 in `followups_claude_200`, b024 in `followups_claude_50`).

   Fix: count those phrases as decline intent, so decline + price → clarify. Also treat a conditional counter ("COUNTER $104, conditional on written warranty terms") as clarify.
3. **The door can't answer questions.** Of 60 Haiku 200 + 200 replies that got a clarifying answer, 25 asked about warranty. The door can only send back instructions or *"What price would you like to offer?"*. Clarify reasons: `several prices` 32, `mixed intents` 25, `counter without a price` 2. `trust_first` buyers whose warranty questions went unanswered were the biggest group that walked from an affordable price.

   Fix: route question-shaped replies to `answerQuestion()` (catalog-grounded, like `ask_question`).
4. **Locked deals nobody confirms get no reminder.** 25 of 177 Haiku walk-aways (14%) left after the seller had *already locked a deal at their own bid*, always within their budget. Haiku often treats the shareable "budget" as its cap. Their state is `agreed`, so `walk` is refused and no follow-up is possible. Recovering them all would be worth up to +$3.57 profit per buyer (CI $2.27–$4.97), more than follow-ups add today.

   Fix: the "expiring quote" trigger from FINAL_ARCHITECTURE §5 (a deal-expiry reminder with the `deal_id`) is the cheapest next win.

## Reproduce

```bash
cd apps/buyer-harness
npx -y pnpm@9.12.0 followups --n 100                                 # scripted, exchange as on main
npx -y pnpm@9.12.0 followups --n 1000 --hold-at-cap                  # scripted, proposed fix
npx -y pnpm@9.12.0 followups --models claude --n 200 --concurrency 8 # Haiku (ANTHROPIC_API_KEY in the main .env)
npx -y pnpm@9.12.0 test                                              # 19 offline tests incl. 7 for the sim
```

Flags: `--consent <share>` (default 0.5; the per-100 value scales about linearly with it), `--repeat <share>`, `--probers <k>`, `--model <id>`, `--replier scripted|claude`, `--live`. Each JSON has the config, both arms, the per-buyer rows with full reply threads, the safety block and the probe rows.
