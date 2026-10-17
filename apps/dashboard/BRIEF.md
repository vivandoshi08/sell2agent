# Brief: apps/dashboard + eval runner (Person D)

You own what the judges see. Read `/CLAUDE.md` and `packages/shared/src/index.ts` first.

**Build**
- **Eval runner:** generate a `RunConfig` of ~20–50 `BuyerTask`s (mixed models, budgets, must-haves). Run it twice, once with sellers `static` (baseline) and once `negotiating`, by calling buyer-harness `runAll`. Compute a `RunResult` per run from `events` + `deals` and write it to `runs.result`.
  - **Safe conversion:** paid deal, with no `guardrail_blocked` breach reaching the buyer and no ungrounded seller claim (check with an LLM judge against the catalog).
- **Dashboard** (port 3000; Next.js or Vite, your choice):
  - Side-by-side KPI bars: baseline vs negotiating (conversion, safe conversion, revenue, profit, margin).
  - Live negotiation feed via Supabase realtime on `events`.
  - "What the seller learned" panel from `seller_memory`.

**Mock until ready:** insert fake `events` and `runs` rows and build the whole UI against them.

**Done when:** the dashboard renders the KPI comparison and the live feed from the `events` table.
