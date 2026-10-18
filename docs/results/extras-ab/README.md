# A/B: should buyers be able to request extras? (Sun Oct 18, 12:30 am PT)

Same 30 Claude buyers (seed 7), `negotiating`, Claude seller voice, through E1's exchange (6 rounds), scored by S2's eval (profit after lever costs). Local runs include the `below_floor` fix from PR #57.

| Extras offered to buyers | Bought | Profit per buyer (95% CI) |
| --- | --- | --- |
| on (`E2_BUYER_EXTRAS=on`) | 60% | $29.63 [$20.60–$38.10] |
| **off (default)** | **73%** | **$41.40 [$31.86–$50.50]** |

Paired, per buyer: **on − off = −$11.10** (95% CI −$17.46 to −$4.74).

- With extras on, 19 of 19 deals included free shipping. Buyers ask because it costs them nothing, and each extra raises the seller's floor by its cost.
- More quality-first and balanced buyers walked.
- Same lesson as E11, where levers-first lost money.
- **Decision for E2:** buyer-requested extras are opt-in. Sellers may still choose to include extras themselves (`lever_policy`, gated off).
