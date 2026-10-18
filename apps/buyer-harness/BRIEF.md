# Brief: apps/buyer-harness (Person B)

You build the simulated buyer agents. Read `/CLAUDE.md` and `packages/shared/src/index.ts` first.

**Build**
- Input: a `RunConfig` (JSON). For each `BuyerTask`, run one buyer agent using the given `buyer_model` (support Claude plus at least one other provider).
- Loop: `GET {MARKETPLACE_URL}/search` → connect to 2–3 listings' `mcp_url` as an MCP client → `ask_question` / `make_offer` across sellers → pick the best deal → `accept_deal` → confirm the Stripe TEST payment (`pm_card_visa`) → log `payment_succeeded`. Or walk away and log `buyer_walked_away`.
- **The budget cap is enforced in code:** never call `accept_deal` above `budget_cents`.
- Log the buyer-side events (`search`, `offer_made`, `buyer_walked_away`, `payment_*`) with `logEvent`.
- Run buyers concurrently (e.g. 5 at a time). Export `runAll(config: RunConfig)` so the dashboard's eval runner can call it.

**Mock until ready:** a stub seller MCP that counters at 95% of the offer price, then accepts; a stub search that returns `supabase/seed.sql` products.

**Done when:** `pnpm run:buyers` with 1 buyer searches, negotiates, and pays end to end.
