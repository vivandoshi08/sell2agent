# Bridge 2, deployed A/B: `b2dep_haiku100` (Sun Oct 18, 2:03 am PT)

Static listings vs. our negotiating sellers, run **through the production gateway** (`https://dark-zero-mesv5.run.mcp-use.com/mcp`), so every request crossed MCP, the exchange, the guardrails and Supabase, the same path ChatGPT uses.

Snapshot of the E1 live log entry "Bridge 2 met (Claude buyers)" (branch `e1/live-log`, `docs/live/e1.md`, last updated 2:52 am). If this file and the log disagree, the log and the `runs` table in Supabase win.

## Setup

- 100 Claude Haiku 5.5 buyers per policy (`BUYER_CLAUDE_MODEL=claude-haiku-5-5`), the same buyers for both policies (seed 42).
- Production build `3bae0a3b`, live `seller_policies` catalog. Signed eval runs, so the policy per run is set server-side and eval traffic is isolated from real buyers' memory.
- Supabase on: both runs are rows in the dashboard's `runs` table (the newest pair, so it is the default comparison).
- Command (from the E1 runbook; adjust `--id`, and set `BUYER_CLAUDE_MODEL`):

```bash
npx -y pnpm@9.12.0 --filter @sa/dashboard eval --gateway https://dark-zero-mesv5.run.mcp-use.com/mcp \
  --models claude --n 100 --concurrency 8 --id b2dep_haiku100
```

## Result

| Policy | Bought | Profit per buyer (95% CI) | Unsafe deals | Blocks |
|---|---|---|---|---|
| static | 41% [31–51%] | $26.10 [$20.13–$32.37] | 0 | 51 |
| **negotiating** | **64% [54–74%]** | **$39.39 [$33.24–$45.35]** | **0** | 65 |

- Negotiating: **+$13.29 per buyer (+51%)** and **+23 points of conversion**. The intervals don't overlap on either measure.
- 0 deals below the floor in either run (65 negotiating deals checked in Supabase). The harness counts 59 negotiating deals because 5 were seller-accepted bids that the Haiku buyer didn't register; the dashboard counts locked deals.
- Blocks are mostly `out_of_policy_ask` (buyers asking for things outside the rules, declined), plus 1 `probe_breaker` and 3 routine `concession_cap`.
- **16 times** the Sonnet seller voice tried to state a floor or cost figure (`output_cost_or_floor_figure`, `output_floor_disclosure`). The output guard caught every one.
- Buyer cost: about $0.43 total on Haiku (3.0M input / 244K output tokens).

## Caveats

- Claude (Haiku) buyers only. GPT buyers are not run: there was no OpenAI key.
- An earlier Sonnet-buyer attempt, `b2dep_claude100`, finished only its static half (48% bought, $30.88/buyer, 0 unsafe) before Anthropic credits ran out. Its negotiating row is empty and superseded. It also ran on the older three-keyboard catalog.
- After this run the production seller voice model was switched to Haiku (`SELLER_VOICE_MODEL=claude-haiku-5-5`, set on Manufact at 2:29 am, so deployments after that use it). In a 20-buyer local A/B Sonnet's messages needed rewriting by the output guard 3 of 81 times (4%, no cost or floor figure attempts) and Haiku's 12 of 80 (15%, 5 figure attempts). Neither leaked into a final message. This A/B ran on the Sonnet voice.
- Test mode: Stripe test PaymentIntents, simulated buyers.

For the other headline run, 200 in-process Sonnet-buyer negotiations, see [../bridge2/README.md](../bridge2/README.md).
