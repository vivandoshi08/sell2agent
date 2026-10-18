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

## Run (corrected 6:20 am)

1. Exploration `b4X`: 300 simulated Claude Sonnet 5.5 buyers, seed 515, `learned` at ε = 1, through the real exchange in-process.
   77% bought, $51.99 profit/buyer, 0 below floor. **Its package-arm sessions don't count:** a `pkg:*` arm only offered its
   extra when that round's cut exceeded the extra's cost, so only 17 of 76 free-shipping and 6 of 27 warranty sessions ever
   offered the perk. Fixed: package arms now lead with their perk at the first concession (`pickLever` lead mode). Learned
   events carry `arm_rev: 2`, and retraining drops older package sessions. b4X's base-arm sessions are still used.
2. **Like-for-like baseline.** A package arm can only be drawn on listings that offer its extra, so raw rewards compared arms
   across listings with different prices (warranty "won" for price-first buyers who give warranty zero weight). Retraining now
   subtracts each listing's average (`--baseline listing`, the default), so every number is "vs the listing's average".
3. **Perk lesson, `b4S`:** 2,000 scripted buyers through the real exchange, ε = 1, no model calls. Scripted buyers now value
   perks by their preferences (free shipping $15 × delivery weight, warranty $20 × warranty weight, bundle $15 × price weight)
   and pick among affordable listings. Perks fired in 468/468 and 63/63 package sessions. Result (`scripted_policy.json`,
   vs listing average): **no perk pays for itself for any buyer type.**

| Buyer type | Balanced (no perk) | Lead with free shipping | Lead with warranty |
| --- | --- | --- | --- |
| Price | +$6.28 (214) | −$9.30 (185) | +$2.54 (29) |
| Quality | +$9.09 (99) | −$5.17 (89) | −$33.33 (16) |
| Delivery | +$6.50 (108) | −$5.29 (89) | −$6.60 (7, too few) |
| Trust | +$8.03 (88) | −$4.12 (105) | +$2.17 (11) |

   Why: the perk raises the seller's floor by its cost and buyers' budgets are hard caps, so it can't buy a higher price. This
   matches E11 (levers-first lost $730/session) and the extras A/B (~−$11/buyer). Not modeled: buyers comparing sellers, where
   a perk can win the sale from a rival.
4. **v5 candidate** (`apps/seller-mcp/learned_policy.candidate.json`): `b3-learned` runs + `b4X` (base arms) + 24 live
   negotiations = **24 real + 4,446 simulated**, reward 50% profit + 50% revenue, listing baseline. Chooses **Balanced for
   every buyer type**. Balanced vs Negotiating (same listing): price +$5.77, quality +$7.21, delivery +$9.01, trust +$7.90.

## Haiku retrain and gate (6:45 am) — v5 is live in the policy file

All on Claude Haiku 5.5 buyers (`BUYER_CLAUDE_MODEL=claude-haiku-5-5`, $0.10 / $0.50 per M tokens), template seller voice,
`SUPABASE_URL=` empty. **Total model spend: $3.63.**

| Run | What | Buyers | Cost |
| --- | --- | --- | --- |
| `b5P` | pilot, ε = 1 over playable arms | 20 | $0.05 |
| `b5X` | exploration, ε = 1, perk arms lead with their perk (arm_rev 2) | 600 | $1.43 |
| `b5G_*` | held-out gate, seed 2121: learned v5 / negotiating / balanced | 300 × 3 | $2.15 |

Perks actually offered in b5X: 211 of 254 free-shipping and 48 of 62 warranty negotiations (the rest closed before the
first concession). Bundle discount was never playable on the listings these buyers chose.

**v5** (`apps/seller-mcp/learned_policy.json`): 24 real + 5,450 simulated negotiations, reward 50% profit + 50% revenue,
same-listing baseline. Chooses Balanced for price, quality, delivery and unknown; lead with free shipping for trust (30 tries).
AI buyers now back the perk lesson for price-first shoppers: free shipping −$11.31 vs Balanced over 127 tries.

**Gate (300 fresh Haiku buyers, paired):** learned 69% bought, $39.59/buyer; negotiating 56%, $34.28; balanced 69%, $39.81.
learned − negotiating **+$5.31 [$2.70, $7.92]** → PASS. learned − balanced −$0.22 [−$2.42, $1.98] → not offered as default.
0 deals below floor in all three runs.

Per buyer type on the gate (learned − balanced): quality +$3.27 ±4.22, price +$3.12 ±3.24, delivery −$3.28 ±4.16,
**trust −$4.97 ±7.99**. The trust-first free-shipping pick did not hold up on fresh buyers; it is within noise either way.
v5's 10% exploration keeps testing it, and the next retrain (which can include the b5G runs) will decide.

## Where it shows

Dashboard tab **What it learned** (`#learned`): the three lessons, training sources and goal, how one negotiation teaches the
seller (which steps are AI and which are code), one logged LLM negotiation step by step, the perk grid, version history
v1→v5, the learning curve and the gate.

## What this does and doesn't show

- **v5 ties Balanced** on held-out buyers; Balanced stays the default. Products opt into `learned` in the console.
- **Haiku buyers only.** GPT buyers not run. Earlier LLM runs in this folder (`b4X`) used Sonnet; `b4Y` failed (no credits) and isn't used.
- **Real traffic is small:** 24 live negotiations, most with no stated preference (before the preferences fix, which isn't deployed yet).
