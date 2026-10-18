# Bridge 3: the learned policy, trained on real-model negotiations (Sun Oct 18, 3–5 am PT)

The `learned` strategy now runs in E1's exchange. For each negotiation it draws one arm from `learned_policy.json` by
buyer type: `negotiating`, `balanced` or `lever_policy`. It logs the arm and its probability on every seller event.
`pnpm e2:retrain` rebuilds the policy from those logs.

All runs used Claude Haiku buyers (`claude-haiku-5-5`): 5 personas plus 10% red team. They went through E1's real exchange
in-process (`ExchangeGateway`) with `SUPABASE_URL=` empty, so nothing reached the live dashboard. Seller messages used
templates, behind the same output guard. Each policy in a phase faced the same buyers, so the comparisons are paired.

Scoring matches the dashboard. A buyer counts as converted once a deal locks. Profit is (price − unit cost) × quantity,
minus the cost of any extras.

## Result

| Held-out test (fresh buyers) | learned | negotiating | balanced | learned − negotiating (95% CI) | learned − balanced (95% CI) | below floor |
| --- | --- | --- | --- | --- | --- | --- |
| **v3**, 300 buyers, seed 777 | 68%, **$39.87** | 55%, $33.66 | 71%, $40.93 | **+$6.21 [$3.55, $8.87]** | −$1.06 [−$3.35, $1.22] | 0 |
| v2, 300 buyers, seed 4242 | 65%, $38.08 | 61%, $37.62 | 75%, $43.19 | +$0.46 [−$2.41, $3.33] | **−$5.11 [−$7.99, −$2.23]** | 0 |

Cells show the share who bought, then profit per buyer.

- **Gate passes (v3):** `learned` beats `negotiating` (the fallback and current default) with a CI above 0 and 0 deals below
  floor. `gate.passed = true`, so a product set to `learned` now uses v3 instead of falling back.
- **Not offered as a default:** `learned` doesn't beat the best fixed policy, `balanced` (−$1.06, CI spans 0).
  `gate.beats_best_fixed = false`. No default was changed.
- **What it learned:** with real LLM buyers, `balanced` wins every buyer type. v3 picks it for all four contexts. Its only
  difference from fixed `balanced` is the 10% exploration, which costs about $1/buyer here. That exploration is what lets
  it notice if another arm starts winning.
- **Recommendation (not applied):** the fixed-policy evidence now favors `balanced` over `negotiating` as the default.
  Paired on the same buyers, it leads by +$5.57/buyer [95% CI $2.71, $8.43] on seed 4242 and +$7.27 [$4.49, $10.05] on
  seed 777. Changing the default is Vivan's call.

## How it got there (the loop, run three times)

| Version | Trained on | Choice per buyer type (price · delivery · quality · trust) | Held-out |
| --- | --- | --- | --- |
| v1 | 1,200 scripted sessions (UCB) | balanced · balanced · balanced · negotiating | sims only |
| v2 | 795 logged sessions: phase A (100 buyers × negotiating, balanced, learned v1 at ε=0.3) + an exploration batch (200 buyers, uniform arms) | balanced · balanced · **lever_policy** · **lever_policy** | seed 4242: −$5.11 vs balanced |
| v3 | 2,216 logged sessions: v2's data + seed 4242's three runs (logged with propensities) | balanced · balanced · balanced · balanced | seed 777: +$6.21 vs negotiating |

v2 bet on `lever_policy` for quality and trust buyers, based on 20 and 10 training sessions. Held-out buyers punished
that bet. On the same seed-4242 buyers, profit per buyer was:

| Context | learned v2 | balanced | Arm v2 chose |
| --- | --- | --- | --- |
| quality | $30.33 | $46.52 | `lever_policy` |
| trust | $13.20 | $24.87 | `lever_policy` |
| price | $49.32 | $48.01 | `balanced` |
| delivery | $48.22 | $48.53 | `balanced` |

Retraining on those logged outcomes (113 and 67 lever sessions) reversed the choice. The curve in `learned_policy.json`
replays this in logged order: it matches always-`balanced` by epoch 3, dips at epochs 14–18 (the lever bet), and ends
level with it.

### Estimator fix found along the way

The first retrain used plain IPS weights (1/logged propensity). It let 2–5 explored `lever_policy` sessions (weight 10)
take three contexts. It also let 5 explored `negotiating` sessions outweigh 76 fixed-run ones. Retraining now uses:

- **Multiple-logger IPS:** weight = 1 / the arm's average logging probability in that context across all runs.
  `--weighting logged` keeps plain IPS.
- **A minimum of 10 sessions per arm** before the greedy choice trusts it.

The exchange logs `arm_probs`, so mixture propensities are exact going forward.

## Cost

2,302 Haiku buyer sessions: 39.0M input and 3.1M output tokens. At $0.10 / $0.50 per MTok that is **≈ $5.46**. The seller
side cost nothing because it used template voice. Each 300-buyer run took about 6 minutes at concurrency 8.

## Reproduce

```bash
cd apps/buyer-harness
# retrain v3 from the committed logs (gunzipped on the fly); identical stats, choice and curve
npx -y pnpm@9.12.0 e2:retrain --runs ../../docs/results/b3-learned/runs/b3A_learned.events.jsonl.gz,../../docs/results/b3-learned/runs/run_202610181012_negotiating.events.jsonl.gz,../../docs/results/b3-learned/runs/run_202610181013_balanced.events.jsonl.gz,../../docs/results/b3-learned/runs/b3X_learned.events.jsonl.gz,../../docs/results/b3-learned/runs/b3B_learned.events.jsonl.gz,../../docs/results/b3-learned/runs/b3B_negotiating.events.jsonl.gz,../../docs/results/b3-learned/runs/b3B_balanced.events.jsonl.gz --out /tmp/v3.json
# a new held-out run (real model calls)
SUPABASE_URL= BUYER_CLAUDE_MODEL=claude-haiku-5-5 npx -y pnpm@9.12.0 e2:learned --id b3D --n 300 --seed 9001 --policy-file ../seller-mcp/learned_policy.json --gate
```

Files: `runs/*.events.jsonl.gz` holds every run's event log (A, exploration X, held-out B and C). `learned_policy.v2.json`
is v2 with its failed gate. The live file is `apps/seller-mcp/learned_policy.json` (v3).
