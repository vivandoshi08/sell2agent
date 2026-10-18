# Sales Agent — read this first

**What we're building (YC "Make Something Agents Want" hackathon, demo Sun 10am):**
A seller-side agent for e-commerce. When a buyer agent is choosing between products, each product's
seller agent talks to it over MCP, answers questions honestly, and negotiates price to win the sale —
within hard limits the human seller sets (floor price, margin). Customers = people who sell things.

**The demo:** run N simulated buyer agents (several models) against static listings (baseline) vs.
our negotiating sellers. Show conversion rate, safe conversion rate, revenue, profit, margin.

## Architecture

```
buyer-harness ──GET /search──▶ marketplace ──(listings w/ mcp_url)──▶ buyer-harness
buyer-harness ──MCP tools───▶ seller-mcp  (get_listing, ask_question, make_offer, accept_deal)
seller-mcp    ──Stripe TEST PaymentIntent on accept_deal
seller-mcp + buyer-harness ──logEvent()──▶ Supabase `events` table ──realtime──▶ dashboard
```

| Dir | Owner | Port |
|---|---|---|
| `packages/shared` | Neel (contract owner) | — |
| `apps/seller-mcp` | Person A | 3001 (`/mcp/:seller_id`) |
| `apps/buyer-harness` | Person B | CLI |
| `apps/marketplace` + `supabase/seed.sql` | Person C | 3002 |
| `apps/dashboard` + eval runner | Person D | 3000 |
| `packages/payments` (Stripe) | Neel | — |

## Rules for every Claude session

1. **`packages/shared/` and `supabase/migrations/` are FROZEN. Do not edit them.** If you need a new
   field or type, STOP and tell your human. Neel changes the contract; everyone pulls.
2. **Only edit files inside your own app directory** (see your `BRIEF.md`).
3. **Import all types/schemas from `@sa/shared`.** Never redefine them locally. Validate inputs with the zod schemas.
4. **Log every action** with `logEvent()` from `@sa/shared/db`, using the shared `NegotiationEvent` shape.
   The dashboard only knows what's in `events`.
5. **Money is integer cents.** Stripe is **TEST mode only**. All Stripe calls go through `@sa/payments`
   (seller: `payDeal`, buyer: `BuyerWallet`). Don't import `stripe` directly. See `packages/payments/README.md`.
6. **Guardrails live in code, not prompts.** Seller never goes below `floor_price_cents`; buyer never exceeds `budget_cents`.
7. **Build against mocks until the real piece lands** (see your BRIEF). Don't block on teammates.
8. Before merging: `pnpm typecheck` and `pnpm smoke` (once smoke is real). Merge to `main` every 1–2 hours, small commits.

## Live build logs (read before integrating)

- **E2 (seller policy + simulated buyers, Neel):** https://claude.ai/code/artifact/c650b63d-5ba1-4ace-ab58-eb2a7abc3b0a. It has the exact
  `decide()` / `voice()` / `runAll()` signatures, the mocks in place, open asks, and the plan. Updated after every E2 push.
  Read it with the Docs tools (it's a Claude Doc). If it disagrees with the code, the code wins; tell your human.

## Setup

```bash
pnpm install
cp .env.example .env   # paste the shared keys from the group chat
# Supabase: run supabase/migrations/0001_init.sql then supabase/seed.sql in the SQL editor
```

## Checkpoints
- **~8:30pm Sat:** one real buyer → search → negotiate → Stripe test payment, end to end
- **~1am:** full eval run (baseline vs negotiating) at scale
- **7am Sun:** code freeze; polish + demo rehearsal only
