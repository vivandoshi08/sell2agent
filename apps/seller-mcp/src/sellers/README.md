# sellers/: E2's seller decision module

The "Seller decision" seam from [docs/BUILD_PLAN.md](../../../../docs/BUILD_PLAN.md). E1's exchange calls this; E2 owns it.

```ts
import { decide, voice, answerQuestion, defaultLlm } from "@sa/seller-mcp/sellers";

const move = decide(state, { name: "negotiating" });  // code: action, price, final flag, TRUE reason
// E1 guardrails check `move` here
const { message } = await voice(move, ctx, defaultLlm()); // Claude words it; checked; template fallback
const answer = await answerQuestion(publicProduct, question, defaultLlm()); // grounded or "I don't know"
```

| Policy | What it does | Source |
|---|---|---|
| `static` | List price, fixed. The baseline. | |
| `negotiating` (default) | Hold list in round 1, concede on t⁴, never more than 75% of the list→floor gap | E10 "profit" tactic |
| `balanced` | Boulware t³ down to the soft floor by the last round | E5/E10 |

Every policy uses a soft floor (3% of the gap above the hard floor), never raises a price it already offered, and only calls an offer final on the last round.

**Gate:** `pnpm e2:gate` runs 10 scripted buyers against all three policies. Add `--llm` to have Claude write the messages (needs `ANTHROPIC_API_KEY`).

**Tests:** `pnpm test:sellers`.

## `learned`: the bandit's policy, live in the exchange

Set a product's strategy to `learned` (console, `seller_policies.policy`, or a signed eval run's `strategy`). Per negotiation the
exchange calls `chooseArm(policy, buyer_profile)` once (`exchange/learned.ts`): context = the buyer's strongest lever, arm =
`negotiating` | `balanced` | `lever_policy`, ε-greedy. The arm is kept for every turn and goes through the same decision guard,
jitter and output guard as a fixed strategy. `lever_policy` gets the listing's extras as its menu; an extra it adds joins the package
and the floor rises by its cost before the guard.

- Seller events carry `arm`, `propensity`, `bandit_context`, `policy_version` (and `learned_fallback` when it fell back).
- No file, a bad file, or a file whose `gate.passed` isn't true → `negotiating`.
- The file is a static JSON import, so the gateway bundle (rolldown) inlines it. Run `pnpm --filter @sa/marketplace build && pnpm --filter @sa/marketplace check:learned-bundle`
  after retraining. `LEARNED_POLICY_PATH` reads a file from disk instead.
- Buyers who send no lever profile (all live `make_offer` calls today: the gateway passes `preferences` only to search) get
  context `unknown`, learned from all sessions pooled.
- `pnpm e2:retrain --runs <run ids>` rebuilds the policy from logged negotiations (jsonl or `--from-db`), IPS-weighted on the
  logged propensity, as a new version with a learning curve. Its gate starts not passed.
- `pnpm e2:learned --id <id> --seed <held-out seed> --policy-file <file> --gate` scores it against the fixed policies on the same
  buyers (paired 95% CIs) and writes the gate. `beats_best_fixed` is the bar for offering `learned` as a default; nothing flips one automatically.
