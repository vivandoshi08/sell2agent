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

**Not here yet (BUILD_PLAN E2 H6–H13):** LLM buyers and `runAll()`, the lever policy (gated), the bandit, and `learned_policy.json`.
