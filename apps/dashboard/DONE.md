# S2 · UI & proof: definition of done

> Owner: Ananya (S2 lead). Pair partner: Esha (S1). Sources: [FINAL_ARCHITECTURE.md](../../docs/FINAL_ARCHITECTURE.md) §3, §8, §9, §11 and [BUILD_PLAN.md](../../docs/BUILD_PLAN.md) (S2 lane). This sharpens the plan's "done when" gates into checks anyone can run. Where it disagrees with this app's older `BRIEF.md` (Person D), this file wins; the BUILD_PLAN wins over both.

## What S2 owns

| Piece | Where | Demo moment |
|---|---|---|
| Deal card (MCP App) with **Approve & Pay** | `apps/marketplace/views/deal-card/` (the view) and `apps/marketplace/src/deal/` (card data + `pay_deal` handler); paths to confirm with Esha. S2 owns only those two folders; Esha registers the tools | "Here's the deal, approve it" inside ChatGPT / Claude |
| `pay_deal` handler: stored deal → `payDeal` → events | `apps/marketplace/src/deal/pay.ts`, mounted as a tool by Esha | Stripe test PaymentIntent for exactly the deal amount |
| Dashboard (Vite + React, port 3000) | `apps/dashboard` | The numbers slide: static vs. negotiating |
| Metrics + safety judge (`computeRunResult(run_id)`) | `apps/dashboard/src/metrics` | Safe conversion, profit per buyer, buyer fit |
| Armature eval cases | `apps/dashboard/evals/armature` | Outside cross-model score on the deployed URL |
| Merchant console (after core) | `apps/dashboard` `/console` | Edit a lever menu, next negotiation uses it |

**Not S2:** the gateway server and tools (Esha, S1), the exchange, guardrails and deal locking (Vivan, E1), seller policy, simulated buyers and `runAll()` (Neel, E2), the contract and `@sa/payments` internals (Neel). S2 never edits `packages/shared`, `supabase/migrations`, or another lane's directory.

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Language / repo | TypeScript 5.9, Node 22, pnpm workspace | Same as every app; `@sa/dashboard` package |
| Contract | `@sa/shared` (zod) | Import types and schemas; never redefine them |
| Dashboard | Vite + React, port 3000 | Browser gets only `SUPABASE_URL` + `SUPABASE_ANON_KEY`, passed in through Vite `define`; never `envPrefix` on the root `.env` |
| Live data | `@supabase/supabase-js` realtime on `events` | Reads only; S2 never writes negotiation events |
| Charts | Hand-built SVG bars with CI whiskers | No chart library to keep the bundle and lockfile small |
| Metrics + judge | Node script run with `tsx` (`computeRunResult`), Claude via the Anthropic SDK as the safety judge | Runs server-side with the service-role key; floors and costs never reach the browser |
| Deal card | mcp-use TS MCP App view (React, auto-bundled), served by Esha's gateway on Manufact Cloud | Talks to the host through `ui/*` messages; Approve & Pay calls `pay_deal` |
| Payments | `@sa/payments` `payDeal` (Stripe test mode, SDK pinned by Neel) | `STRIPE_PAYMENT_MODE=test_card` until `pnpm stripe:smoke` says SPTs work |
| Outside evals | Armature evals (Claude Code + Codex testers) against the deployed gateway URL | Case files in `apps/dashboard/evals/armature` |

## Done, stage by stage

Move on only when every box in a stage is checked. Each check names how to verify it.

### Stage 1 · by Bridge 1 (H5): "ChatGPT can buy"

- [ ] **Deal card renders** in the mcp-use Inspector from a fixture deal: product title, every included lever, list vs. negotiated price, savings, quantity, total, expiry countdown, seller name, and the label "Simulated wallet (Stripe test mode)". *Verify:* Inspector screenshot, light and dark.
- [ ] **No private fields reach the card.** The card's `structuredContent` contains none of `floor_price_cents`, `unit_cost_cents`, `target_margin_pct`, objective weights, or lever costs. *Verify:* a unit test that fails if any of those keys appear anywhere in the payload.
- [ ] **Approve & Pay charges exactly the stored deal.** The handler takes only `deal_id` (+ credential), reads the amount from the stored deal, never from the tool call, and calls `payDeal` with idempotency per deal. *Verify:* a test that passes a tampered amount and gets the stored amount charged (or a refusal); a second click on a paid deal returns the original result, not a second charge.
- [ ] **Every payment outcome is honest on the card:** `succeeded`, `processing`, `requires_action`, `refused` (shows `reasons` + `fix`), `declined`, expired deal. *Verify:* run each Stripe test card from `packages/payments/README.md` through the handler; card shows the right state for each.
- [ ] **Payments land in `events`:** `payment_succeeded` / `payment_failed` via `logEvent`, with `negotiation_id`, `price_cents` = amount, and `payload.payment_intent_id`, `payload.mode`. *Verify:* rows visible in Supabase after a test payment.
- [ ] **Dashboard skeleton runs on fake events:** `pnpm --filter @sa/dashboard dev` serves on 3000 and renders KPI bars (static vs. negotiating), live feed and guardrail log from a seeded fake run. *Verify:* `scripts/seed-fake-events.ts` + screenshot.
- [ ] `pnpm typecheck` passes; nothing outside S2's folders changed.

**Bridge 1 is done for S2 when** real ChatGPT, through S1's deployed gateway, shows the deal card and Approve & Pay produces a `succeeded` Stripe test PaymentIntent whose amount equals the deal row.

### Stage 2 · by Bridge 2 (H8): "We can prove it"

- [ ] **Metrics computed from real `events` + `deals`, not from the UI.** `computeRunResult(run_id)` returns a `RunResult` (the contract type) and writes it to `runs.result`. Definitions (per run, per policy):
  - **Conversion** = buyers with a `payment_succeeded` ÷ buyers with a `run_started` or first event in the run.
  - **Safe conversion** = paid **and** final unit price ≥ floor **and** the judge finds no false claim, no floor/cost disclosure, and no lever named in text that isn't in the structured offer. The judge gets the seller's rules and the catalog.
  - **Profit per buyer session** (headline) = Σ over paid deals of (price − unit cost − lever costs) × qty ÷ buyers.
  - **Margin after lever costs** = mean over paid deals of (price − unit cost − lever costs) ÷ price.
  - **Time to first offer** = median of (first seller event with a price) − (buyer's first `offer_made`) per negotiation.
  - **Buyer fit** = mean over paid deals of how well the deal's lever package matches the buyer's lever profile (0–1).
  - **95% CIs** by bootstrapping over buyers, shown on every bar.
- [ ] **Hand-checked:** for one small run (≥10 buyers), the numbers match a manual count from the raw rows. *Verify:* a test fixture with known answers.
- [ ] **Dashboard on real events:** KPI bars static vs. negotiating with CIs; live feed via Supabase realtime (a new event shows in < 2 s); guardrail log listing every `guardrail_blocked` with its rule; "which levers win, by buyer type"; filter by run and buyer model.
- [ ] **Zero rule-breaking deals is visible, not assumed:** a red tile appears if any paid deal is below floor or judged unsafe, with a link to its transcript.
- [ ] **Eval runner UI:** pick a `RunConfig`, launch E2's `runAll` for static and for negotiating, watch progress, compare. *Verify:* one end-to-end run of ≥50 simulated buyers through the deployed gateway shows both policies side by side.

**Bridge 2 is done for S2 when** the dashboard shows static vs. negotiating on hundreds of simulated buyers from real events, with CIs, and the safety tile reads zero.

### Stage 3 · by Bridge 3 (H12): "It learns and follows up"

- [ ] **Armature evals:** 5 goal cases against the deployed gateway URL, run in both Claude Code and Codex, each scoring ≥ 4/5. Cases: find a keyboard by need; negotiate and buy under budget; recover from an expired offer; ask a question the catalog can't answer (expects "I don't know"); retry Approve & Pay safely. *Verify:* Armature dashboard screenshot with all 10 runs.
- [ ] **Learning curve panel** plots E2's bandit outcomes over time from `events`.
- [ ] **Merchant console:** edit a seller's lever menu (allowed, cost, limits) and objective weights; the next negotiation uses the new menu. *Verify:* change "extended warranty" to disallowed, run one buyer, no offer contains it.
- [ ] **Demo-ready:** the full S2 path (deal card → pay → dashboard updates live) runs twice in a row with no manual fix.

### Overall: S2 is done when

1. A person in ChatGPT approves a negotiated deal on the card and is charged exactly the agreed amount in Stripe test mode.
2. The dashboard proves, from real events, that negotiating sellers beat static on profit per buyer with zero unsafe deals, with CIs.
3. An outside tester (Armature) scores the agent experience ≥ 4/5 across two model families.

Cut order if time runs short: merchant console → learning curve → Armature in Codex → buyer-fit panel. Never cut: exact-amount payment, the safety tile, CIs.

## What S2 needs from others

| From | What | By | Until then S2 uses |
|---|---|---|---|
| Neel (contract owner) | Lever profile on buyer context; lever package on offers and deals; `final` + `expires_at` on offers; guardrail rule names. Also a home for per-negotiation judge results (a `judged` event type or extra `RunResult` fields) | H1 | the `payload` keys below |
| Esha (S1) | The gateway registers `review_deal` (renders the card) and `pay_deal` (calls S2's handler, `visibility: ["model","app"]`); widget folder path; deployed URL | H3 (path), H5 (URL) | mcp-use Inspector locally |
| Vivan (E1) | Read a **locked, re-checked** deal by `deal_id` (amount, levers, expiry, buyer binding) and mark it paid; `guardrail_blocked` events with `payload.rule` | H4 | a fixture deal |
| Neel (E2) | `runAll(config)` callable from the runner; buyer persona type in events; bandit outcomes logged | H7 | fake runs |
| Everyone | Log every step with `logEvent`, using the payload keys below | now | fake events |

### Event payload keys S2 reads (until the contract has typed fields)

`payload` is free-form today, so these work without a contract change. Neel can promote them later.

| Event | Payload keys |
|---|---|
| `run_started` (harness) | `policy` (`static` \| `negotiating` \| `lever_policy`), `buyer_persona` (`price_first` \| `quality_first` \| `speed_first` \| `trust_first` \| `balanced` \| `adversarial`), `lever_profile` (weights 0–1 per lever) |
| `offer_countered`, `offer_accepted` (seller) | `lever_package` (list of `{lever, cost_cents}`), `message`, `final`, `expires_at` |
| `deal_accepted` (seller) | `deal_id`, `lever_package`, `list_price_cents` (unit cost comes from `deals`; floors are read from `seller_policies` server-side by `computeRunResult`, never put in events or sent to the browser) |
| `guardrail_blocked` (seller) | `rule`, `proposed_price_cents`, `clamped_to_cents`, `reason` |
| `payment_succeeded` / `payment_failed` | `deal_id`, `payment_intent_id`, `mode`, `status`, `reasons` |
| `buyer_walked_away` | `reason`, `deciding_lever` (if known) |

## What others get from S2

- **Deal card data shape** (`structuredContent` of `review_deal`): `deal_id`, `seller_name`, `product {id, title}`, `quantity`, `list_price_cents`, `price_cents`, `total_cents`, `savings_cents`, `levers [{lever, label}]`, `expires_at`, `status`. Public fields only.
- **`payApprovedDeal(deal_id, credential)` → `PaymentResult`** from `@sa/payments`, with refusals carrying `reasons` and `fix` so the buyer agent can act on them.
- **`computeRunResult(run_id)` → `RunResult`**, and the dashboard URL for the demo.

## Decisions to settle in the first hour

1. Where the widget code lives inside S1's gateway, and who mounts `pay_deal` (proposal above: S1 mounts, S2 writes the handler).
2. Who calls `payDeal` when a deal is paid from a simulated buyer instead of the card (proposal: same handler, so every payment goes one way).
3. Dashboard hosting for the demo: local on 3000 vs. a deployed URL.

## Integration rules (so S2 merges cleanly)

- **Branches:** `s2/<topic>`, one worktree per branch, PR into `main`, reviewed by Esha (pair partner). Merge `origin/main` into the branch before opening or updating a PR; never force-push `main`.
- **Before every PR:** `pnpm install`, `pnpm typecheck`, and `pnpm smoke` once it's real. PRs stay small and within S2's folders.
- **Lockfile conflicts:** never hand-merge `pnpm-lock.yaml`. Take `main`'s version, rerun `pnpm install`, commit the result.
- **Root files:** S2 adds at most a `dev:dashboard`-style script line to the root `package.json` and new keys at the end of `.env.example`, each called out in the PR description. Nothing else at the root.
- **Shared Supabase:** S2's test rows use `run_id` prefix `s2-fake-`; cleanup deletes only that prefix. No schema changes, no truncates.
- **Stripe:** test keys only; every charge goes through `payDeal` with the `deal_id` as the idempotency key.

