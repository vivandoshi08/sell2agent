# Bridge 4: the seller learns which perk to offer, for the seller's goal, from real and simulated traffic (Sun Oct 18, 6 am PT)

Four changes, so the learning loop does what the seller-side UI claims:

| Gap (found 5:50 am) | Fix | Where |
| --- | --- | --- |
| The bandit only picked a concession curve (negotiating / balanced / lever_policy). Which extra to offer was a fixed rule, not learned | New arms `pkg:free_shipping`, `pkg:extended_warranty`, `pkg:bundle_discount`: balanced pricing that offers that one extra instead of a price cut. A package arm is only drawn on listings that offer its extra, and the logged propensity counts only the arms that listing can play | `apps/seller-mcp/src/sellers/bandit.ts`, `exchange/exchange.ts` |
| The console's goal weights (margin, conversion, …) were saved and read by nothing | `seller_policies.objective` now reaches `ProductConfig.objective`, is logged on every negotiation event, and is the reward: `objectiveReward` = margin weight × profit + (conversion + clear stock) weight × revenue. Default 0.5 / 0.5 = half profit, half revenue | `sellers/bandit.ts`, `exchange/supabase-catalog.ts`, `buyer-harness/src/learned-logs.ts` |
| Live `make_offer` never carried the buyer's preferences, so every real shopper was context "unknown" | `search_products` remembers each buyer_id's preferences for 30 min; `make_offer` takes optional `preferences` and otherwise reuses them, passing `buyer_profile` to the exchange | `apps/marketplace/src/preferences.ts`, `negotiate.ts`, `index.ts` |
| Retraining read simulated runs only | `pnpm e2:retrain --live` also pulls every live marketplace negotiation (`run_id = "live"`) from Supabase. Each session is tagged real or sim; the policy file records the counts and the reward formula | `buyer-harness/src/e2-retrain.ts` |

The dashboard's "What the seller learned" panel shows all four: real vs simulated training counts, the goal being optimized,
a "which perk works for which buyer" grid, and the gate status. The console's Objective box says what the learned seller optimizes.

## Run

1. Exploration `b4X`: 300 simulated Claude Sonnet 5.5 buyers (5 personas + 10% red team), seed 515, `learned` at ε = 1 (uniform over
   the arms each listing can play), through the real exchange in-process, `SUPABASE_URL=` empty. 77% bought [71–83%],
   $51.99 profit/buyer, 0 below floor. ~3.8M input tokens.
2. Retrain → **v5 candidate** (`apps/seller-mcp/learned_policy.candidate.json`): `b3-learned` runs + `b4X`
   + live marketplace traffic (23). **23 real + 4,549 simulated** sessions, reward **50% profit + 50% revenue** (no product has
   saved console goals yet, so every session uses the default).

| Buyer type | v4 chose | v5 chooses | Why (IPS goal value per negotiation, tries) |
| --- | --- | --- | --- |
| Price | balanced | balanced | balanced $40.63 (1,263) beats free shipping $33.09 (33) |
| Quality | balanced | **lead with free shipping** | free shipping $39.06 (16) vs balanced $36.25 (484) |
| Delivery | balanced | balanced | warranty $68.13 but only 8 tries (below the 10-try minimum); balanced $41.78 (639) |
| Trust | balanced | **lead with free shipping** | free shipping $51.31 (18) vs balanced $37.28 (269) |
| No stated preference | balanced | balanced | balanced $39.77 (2,655) |

No arm tried bundle discount: no simulated buyer landed on a listing that offers it.

## What this does and doesn't show

- **Shows:** the loop now learns perks per buyer type, scores sessions with the seller's goal, and takes in real traffic, end to end,
  with 0 deals below floor. The two new picks rest on 16 and 18 tries each, just above the minimum.
- **Not yet:** v5 has **no held-out gate**. It is a candidate; the live `learned_policy.json` stays v4 (gate passed). The gate needs
  ~900 more simulated buyers (`pnpm e2:learned --id b4G --n 300 --seed 2121 --policy-file ../seller-mcp/learned_policy.candidate.json --gate`,
  with `BUYER_CLAUDE_MODEL=claude-haiku-5-5` to keep it cheap). It was blocked at 6:05 am: the Anthropic API key is out of credits.
  A second exploration (`b4Y`, 600 buyers) failed for the same reason and is not used.
- **Real traffic is small:** 23 live negotiations, 19 with no stated preference (they predate the preferences fix, which isn't deployed yet).
  Live products run fixed policies, so real sessions teach the base arms only, not the perks.
- **Buyers:** the exploration used Sonnet buyers (the harness default), not the Haiku buyers of `b3-learned`.
