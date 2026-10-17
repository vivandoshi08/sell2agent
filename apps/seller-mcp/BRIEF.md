# Brief: apps/seller-mcp (Person A)

You build the product: the seller agent, exposed as an MCP server. Read `/CLAUDE.md` and `packages/shared/src/index.ts` first.

**Build**
- One multi-tenant MCP server (Streamable HTTP) on port 3001; each seller at `/mcp/:seller_id`.
- Tools exactly as named in `TOOL_NAMES`, with the `*Input` / `*Output` zod schemas from `@sa/shared`:
  - `get_listing`: public product info only. Never return `seller_policies`.
  - `ask_question`: answer only from catalog data; if unknown, `grounded: false` and say so.
  - `make_offer`: an LLM proposes accept, counter or reject plus a pitch message. Then **code enforces**: price ≥ `floor_price_cents`, round ≤ `max_rounds`, concessions ⊆ `allowed_concessions`. If the LLM's proposal breaks a rule, clamp it and log `guardrail_blocked`.
  - `accept_deal`: create a Stripe TEST PaymentIntent at the agreed price, insert into `deals`, and log `deal_accepted`.
- Sellers with `strategy = 'static'` (baseline): always respond with list price, never counter.
- Memory (stretch): after each closed or lost negotiation, write one insight to `seller_memory`; inject recent insights for that `buyer_model` into the negotiation prompt.

**Mock until ready:** read the catalog from Supabase seed (already committed). Test with a script calling tools directly, or with MCP Inspector.

**Done when:** MCP Inspector can run get_listing → make_offer ×3 → accept_deal, and it never goes below floor.
