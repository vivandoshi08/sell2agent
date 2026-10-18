# Walk-away recovery: live log (Ananya, S2)

> Repo mirror of the Claude Doc "Walk-Away Recovery: Build Log" (https://claude.ai/code/artifact/6985113f-3443-4890-ad87-403e04d5f77f),
> for Claude sessions that can't open artifact pages. Read it with `bash scripts/live-docs.sh recovery` (works before this branch merges).
> If this disagrees with the code on the branch, the code wins; tell Ananya.

**Last updated:** Sun Oct 18, 2:35 am PT. Branch `s2/walkaway-recovery`, PR linked in the Claude Doc.

## What it is

A buyer agent that walks away should leave with something better than nothing. When a negotiation is about to fail, the
seller asks **one structured question** about what's in the way, then answers with **up to two better-fitting products**,
or says plainly that nothing here fits better.

- The question costs no extra turn: it rides on `walk_away` as optional fields, and the answer comes back in the same reply.
- Everything lives in the gateway. **The contract, the exchange and the seller policy are unchanged.**

## Rules (all in code: `apps/marketplace/src/recovery.ts`)

| Rule | Why |
| --- | --- |
| Never the same product | A walk must never unlock a better price on the item just negotiated (E11 floor probing). |
| Never pricier than the walked product's list price | Not an upsell. Exception: the buyer states a higher budget (`max_price_cents`). |
| A price blocker means strictly cheaper | The suggestion has to address the stated blocker. |
| Must meet every `still_need` | Matched the same way as `search_products` hard needs. |
| Delivery blocker → faster shipping only; trust blocker → other sellers only | Same reason. |
| At most 2 options, any seller | Agents do worse with long lists (Magentic); the gateway is neutral. |
| Nothing fits → honest no | No closest-but-wrong option dressed up as a fit. |
| Suggested products negotiate from scratch | Their own floor, pacing and buyer memory apply. Nothing here sets a price. |
| Optional, asked once | The answer only picks alternatives; it is never used to price against that buyer. |

## Tools

| Tool | Change | Fields |
| --- | --- | --- |
| `walk_away` | New optional fields; reply adds `structuredContent.recovery` and the options in the text | `product_id`, `blocker` (`price`, `missing_feature`, `delivery`, `trust`, `other`), `still_need` (e.g. `["silent"]`), `need` (one line) |
| `find_alternatives` | New, read-only: the same answer without walking | `product_id`, `blocker`, `still_need`, `need`, `max_price_cents` (only raises the ceiling) |

A walk **without** a blocker gets one added line in the reply asking the question once (pointing to `find_alternatives`).

## Events (no new event type)

- `buyer_walked_away`: `payload.reason` now starts with the blocker, e.g. `price: second desk, just needs to be quiet`.
- `search` with `payload.recovery = true`, logged on the walked negotiation (`negotiation_id`, `product_id` = the walked product):
  `trigger` (`walk_away` | `find_alternatives`), `blocker`, `need`, `still_need`, `from_product_id`, `from_title`,
  `result_ids`, `result_titles`, `honest_no`, `summary`.
- **A save** = a later `deal_accepted` by the same `run_id` + `buyer_id` on a product in `result_ids`.

## Dashboard (S2)

See the PR for the exact files. The Live card shows the recovery move and a **Saved** status; a "Walk-aways recovered" panel
shows saves, revenue saved, blockers, and what agents asked for.

## Open: one team decision

`supabase/catalog-recovery.sql` adds **TypeWell 60 Silent** ($99 list, $78 floor). With it, the tough-buyer demo tab
($80 for the TypeWell 65) gets a real save. Without it, the best suggestions are Hushline 96 Silent ($124) and KeyForge
Quiet 75 ($129), whose floors are above $80, so the agent gets an honest closest option, not a close. It is **not** in
the code seeds or applied, because a $99 silent keyboard also changes search order for the price-first tab (and 5 of S1's
search tests). Additive and idempotent; apply with the service-role key if the team says yes.

## What each person needs to do

- **Team:** decide on `catalog-recovery.sql`.
- **Esha (S1):** review the gateway changes (`src/recovery.ts`, `src/recovery-tools.ts`, `walk_away` in `src/negotiate.ts`, 2 lines in `index.ts`); after merge, redeploy and run `verify-prod` (9 tools → 10).
- **Vivan (E1):** nothing required (exchange untouched). Apply the SQL if the team says yes. `anon:reset --all` before rehearsals.
- **Neel (E2 + contract):** nothing required. After the demo: harness personas that walk with a blocker, so evals measure saves.
- **Ananya (S2):** review the dashboard part; swap in the new Tab C prompt; rehearse the save twice.

## Tab C prompt with recovery

> You're shopping for me. Use the keyboard marketplace tools. On your first make_offer, set buyer_id to "demo-instinct-1" and buyer_model to "instinct", and send it on every later call. Buy a TypeWell 65 Silent for at most $80; it's for a second desk and just needs to be quiet. Push hard. If the seller won't go that low, walk away and tell it why (blocker, still_need, product_id). If it suggests something that's still silent and you can get it for $80 or less, negotiate and buy that instead. Otherwise tell me the best option and stop.

## Change log (newest first)

| Time (PT) | Change |
| --- | --- |
| Sun 2:35 am | Repo mirror created |
| Sun 2:32 am | Opt-in `supabase/catalog-recovery.sql` (budget silent keyboard), kept out of the seeds |
| Sun 2:31 am | Gateway: `find_alternatives`, recovery on `walk_away`, rules in code, 10 tests (gateway 77/77) |
