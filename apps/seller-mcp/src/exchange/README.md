# exchange (E1 · exchange & safety)

`handle(move) → response` for every buyer move. Gateway (S1): `import { Exchange } from "@sa/seller-mcp/exchange"`.

Per seller turn: **input guard** (strip injections, log out-of-policy asks, circuit breaker) → E2 `decide()` →
**decision guard** (clamp to [soft floor, list], mask below-floor accepts, 35% concession cap, freeze, final only when final)
→ E2 `voice()` → **output guard** (E9 v3 + E11 fixes; template fallback) → offer or locked deal → `events`.

| File | What |
|---|---|
| `types.ts` | Move / ExchangeResponse / StandingOffer / LockedDeal (move to `@sa/shared` when Neel adds them) |
| `state.ts` | transition table; illegal transitions throw |
| `exchange.ts` | protocol: round cap + final buyer turn, 15-min offer expiry, accept only by live buyer-bound `offer_id`, idempotent accept |
| `deals.ts` | HMAC-signed deals; `getLockedDeal`, `validateForPayment`, `markPaid` for S2's pay handler |
| `decision-guard.ts`, `input-guard.ts`, `output-guard.ts` | E9 guardrails ported from `experiments/e9_safety/guardrails.py` |
| `store.ts`, `catalog.ts`, `events.ts` | memory store, seed catalog, event sink (Supabase `logEvent` when `SUPABASE_URL` is set) |
| `outreach.ts`, `inbound.ts` | Bridge 3 follow-ups: queue, weekly cap, routing and opt-outs in the store; `runDue()`, `resolve()`, `inbound()`. The gateway's door (`apps/marketplace/src/followup`) runs them |

Checks: `pnpm --filter @sa/seller-mcp test` and `pnpm --filter @sa/seller-mcp gate` (30 negotiations incl. E4/E9 attacks).

Next (stage 2): Supabase store once the contract has an offers table, buyer memory across sessions + jitter + probe breaker (E11), lever packages in offers.
Set `EXCHANGE_HMAC_SECRET` in deploy so deal signatures survive restarts.
