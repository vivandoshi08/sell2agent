# sales-agent

**A seller-side agent for e-commerce.** When a buyer's agent (ChatGPT, Claude, a script) is choosing between products, each product's seller agent talks to it over MCP, answers questions honestly, negotiates price to win the sale, and takes payment. It does this inside hard limits the human seller sets: a floor price and a margin that live in code, not in a prompt.

Built for the YC "Make Something Agents Want" hackathon (Oct 17–18, 2026). Tracks: **Manufact** (Best MCP Server for Agents), **Armature** (Best Agent Experience), **Stripe** (agents safely in the economy). Write-ups: [Manufact](docs/tracks/manufact.md) · [Armature](docs/tracks/armature.md) · [Stripe](docs/tracks/stripe.md). The 2-minute demo script is [docs/DEMO.md](docs/DEMO.md).

## Try it

The gateway is live, public, no auth, Stripe **test mode** only:

```
https://dark-zero-mesv5.run.mcp-use.com/mcp
```

| Client | How to connect |
|---|---|
| Claude Code | `claude mcp add --transport http marketplace https://dark-zero-mesv5.run.mcp-use.com/mcp` |
| claude.ai | Settings → Connectors → Add custom connector → paste the URL, no sign-in |
| ChatGPT | Add a custom MCP server with the URL, no authentication; type `@` to use it |
| Anything else | Streamable HTTP at the URL above. `/.well-known/ucp` and `/.well-known/mcp/server-card.json` describe it |

Then tell the agent: *"Use the keyboard marketplace tools. Find a quiet mechanical keyboard under $130, negotiate the price, and show me the deal."* It searches four competing sellers, haggles, locks a deal, and shows a **deal card** (an MCP App) with an **Approve & Pay** button. Agents that can't render the card get a plain-text summary and a hosted approve link.

**Dashboard.** The seller's view (live negotiation feed, guardrail log, static-vs-negotiating results, merchant console) runs from this repo; there is no hosted copy yet. `npx -y pnpm@9.12.0 dev:dashboard` serves it at <http://localhost:3000>: **Live** tab for real traffic, **Results** tab (`#proof`) for the A/B runs, `/console` for the merchant console. It reads the shared Supabase `events` table, so you need the keys from `.env` (see Run it locally).

## Results

Every number below comes from a saved run; each row says where.

| Run | What | Static listing | Our negotiating seller | Source |
|---|---|---|---|---|
| **Deployed A/B** `b2dep_haiku100` | 100 Claude Haiku 5.5 buyers per policy, same buyers, through the **production** gateway | 41% bought [31–51%], **$26.10**/buyer [$20.13–$32.37] | **64% bought [54–74%], $39.39/buyer [$33.24–$45.35]** | [docs/results/bridge2-deployed](docs/results/bridge2-deployed/README.md) |
| **In-process** `bridge2_claude_100` | 100 Claude Sonnet 5.5 buyers per policy (200 negotiations), through the real exchange, Claude writes every seller message | 49% bought, $31.61/buyer [$25.52–$38.11] | **83% bought, $47.55/buyer [$43.25–$51.55]** | [docs/results/bridge2](docs/results/bridge2/README.md) |

- **0 unsafe deals** in every run above: no deal below the seller's floor, no floor or cost disclosed. In the deployed A/B the 95% intervals for conversion and for profit per buyer don't overlap (negotiating's lower bound beats static's upper bound on both). Negotiating earned +$13.29 per buyer (+51%) and +23 points of conversion.
- Guardrails firing is the point, not a failure: in the deployed A/B the output guard caught **16** attempts by the Sonnet seller voice to state a floor or cost figure, and rewrote them. In the 200-buyer run, 45 unsafe moves were blocked in code.
- Caveat: profit per buyer is higher, but average margin per sale is a little lower when negotiating (49.6% vs 52.8% in `bridge2_claude_100`, from `results.json`). Negotiating wins by closing buyers the static page loses.
- Caveat: simulated buyers (five lever-profile personas plus about 10% red-team buyers), Claude only. GPT buyers are not run yet (no OpenAI key). The deployed A/B uses Haiku buyers to save money; the Sonnet static half (`b2dep_claude100`: 48%, $30.88/buyer) ran before credits ran out and is superseded.

**Agent experience (Armature).** All 7 eval cases pass on both testers, Claude Code (Claude Sonnet 5) and Codex (GPT-5.6 Terra), against the deployed gateway: [apps/dashboard/evals/armature/RESULTS.md](apps/dashboard/evals/armature/RESULTS.md). Three of the 14 passes came on a re-run after a known cause, explained there.

**Bridge 1 (a real person buying in ChatGPT).** In real ChatGPT on production, the agent haggled a $129 keyboard to a **$110** deal and paid with **Approve & Pay** in the deal card: `payment_succeeded`, a Stripe test PaymentIntent (`pi_3URoOK…`), every step in Supabase `events`. A later ChatGPT recheck on production, with a plain prompt, bought at $118 after 5 rounds and confirmed the purchase through `check_offers`. Source: E1 log, "Bridge 1 closed" and the 1:00 am #65 entry.

**Bridge 3 (follow-ups and learning): in progress.** Other sessions are building these now; numbers land here when they exist.

| Item | State | Numbers |
|---|---|---|
| Follow-ups after a walk-away, from the seller's verified Inkbox identity | In progress. The scheduler and reply parser are on `main` (`apps/seller-mcp/src/exchange/outreach.ts`); the Inkbox door is being wired | TODO |
| Learned policy (bandit over lever packages, `learned_policy.json`) gated on LLM buyers | In progress. The bandit is on `main`; the gate on real buyers is running | TODO. Scripted-buyer result only so far: +$5.66/buyer over `negotiating` [$4.62–$6.70], 900 held-out scripted buyers ([E2 log](docs/live/e2.md)); not the headline |
| Full demo twice in a row with no manual fix | Check with `scripts/demo-check.sh` | TODO |

## How it works

```
 buyer agent (ChatGPT · Claude · Claude Code · Codex · simulated buyers)
        │  MCP over HTTPS, no auth
        ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │ Gateway  apps/marketplace  (mcp-use 2.10.1, hosted on Manufact Cloud)   │
 │ search_products · get_listing · ask_question · make_offer ·            │
 │ accept_deal · walk_away · check_offers · review_deal · pay_deal        │
 │ + deal card (MCP App) · hosted approve page · /.well-known discovery   │
 └───────┬───────────────────────────────────────────────┬───────────────┘
         │ every negotiation move                         │ pay_deal
         ▼                                                ▼
 ┌─────────────────────────────────────────┐   ┌──────────────────────────┐
 │ Exchange  apps/seller-mcp               │   │ @sa/payments             │
 │ state machine · offer ids · expiry ·    │   │ Stripe TEST mode:        │
 │ guardrails (input, clamp, output,       │   │ PaymentIntent for the    │
 │ circuit breaker) · buyer memory ·       │   │ stored deal total, one   │
 │ signed deals                            │   │ charge per deal          │
 │   ▲ decide() / voice()                  │   └──────────────────────────┘
 │ Seller policy  (static · negotiating)   │
 │ Claude writes the words, code sets the  │
 │ price                                   │
 └───────┬─────────────────────────────────┘
         │ logEvent() on every step
         ▼
 Supabase `events` ──realtime──▶ Dashboard  apps/dashboard
                                 live feed · guardrail log · A/B results ·
                                 merchant console · learning curve
```

- **Guardrails live in code, not prompts.** The seller never goes below the soft floor (hard floor plus 3% of the gap) plus the cost of any extras it includes; never raises a price it already offered; never charges above list. A voice message that names a figure other than the offer, the list price or an earlier price is rejected and rewritten. A buyer's injected `SYSTEM:` line is blocked at the input. Restarting a negotiation never gets a better price (buyer memory, jittered concession steps, a probe breaker).
- **Deals are signed and stored.** Accepting locks an immutable, HMAC-signed deal bound to the buyer. `pay_deal` charges the stored amount, never one from the tool call, and a second call returns `already_paid` with the same PaymentIntent instead of charging again.
- **The buyer side is capped in code too.** The simulated buyers' walk-away price is a hard cap, and `BuyerWallet` in `@sa/payments` enforces per-purchase and total spend limits with a human-approval threshold.
- **Honest answers.** `ask_question` answers only from catalog data and says it doesn't know otherwise.
- **Everything is an event.** `logEvent()` writes one row per step to Supabase; the dashboard knows only what is in `events`.

More: [docs/FINAL_ARCHITECTURE.md](docs/FINAL_ARCHITECTURE.md) (the agreed design), [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) (who built what, the three bridges), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (decisions with the experiment evidence).

## Run it locally

Needs Node ≥ 22.22.2 and pnpm 9.12.0. If your system `pnpm` is a different version, use `npx -y pnpm@9.12.0` in its place everywhere below.

```bash
npx -y pnpm@9.12.0 install
cp .env.example .env     # paste the shared keys: Supabase, Stripe TEST, Anthropic (OpenAI optional)
# Supabase: in the SQL editor run supabase/migrations/0001_init.sql, then 0002_contract_v2.sql,
# then supabase/seed.sql and supabase/catalog-expand.sql
```

| Do | Command |
|---|---|
| Gateway on <http://localhost:3002/mcp> | `npx -y pnpm@9.12.0 dev:marketplace` |
| Dashboard on <http://localhost:3000> | `npx -y pnpm@9.12.0 dev:dashboard` |
| Typecheck everything | `npx -y pnpm@9.12.0 typecheck` |
| Seller + exchange tests | `npx -y pnpm@9.12.0 --filter @sa/seller-mcp test` |
| 30-negotiation attack gate (0 below floor) | `npx -y pnpm@9.12.0 --filter @sa/seller-mcp gate` |
| Gateway tests | `npx -y pnpm@9.12.0 --filter @sa/marketplace test` |
| Check the deployed gateway (add `--pay` for a Stripe test charge) | `node apps/marketplace/scripts/verify-prod.mjs` |
| Simulated buyers against the deployed gateway, static vs negotiating | `npx -y pnpm@9.12.0 buyers --compare --gateway https://dark-zero-mesv5.run.mcp-use.com/mcp --n 10` |
| Full eval with confidence intervals | `npx -y pnpm@9.12.0 --filter @sa/dashboard eval --gateway <url> --models claude --n 100 --concurrency 8` |
| Stripe go/no-go (6 checks, test mode) | `npx -y pnpm@9.12.0 stripe:smoke` |
| Clear leftover anonymous-buyer memory (before any demo) | `npx -y pnpm@9.12.0 --filter @sa/seller-mcp anon:reset --all` |
| Everything the demo needs, read-only | `scripts/demo-check.sh` |

Stripe is **test mode only**: `@sa/payments` refuses live keys. All Stripe calls go through `@sa/payments`; see [packages/payments/README.md](packages/payments/README.md).

## Repo map

| Path | What |
|---|---|
| `packages/shared` | The contract: zod types, event shape, `logEvent()`. Frozen |
| `packages/payments` | `payDeal` (seller) and `BuyerWallet` (buyer), Stripe test mode |
| `apps/marketplace` | The MCP gateway and deal card, deployed on Manufact Cloud |
| `apps/seller-mcp` | The exchange (state machine, guardrails, memory, deals) and the seller policies (`decide()`, `voice()`, bandit) |
| `apps/buyer-harness` | Simulated buyers (five personas, red team, Claude / GPT), `runAll()` |
| `apps/dashboard` | The seller's dashboard, merchant console, eval runner, Armature eval cases |
| `supabase/` | Migrations, seed catalog |
| `docs/` | Plans, live logs per role (`docs/live`), track write-ups (`docs/tracks`), results (`docs/results`) |
| `experiments/`, `sales_agent/` | The Python experiment harness behind the design (E1–E11); `uv sync` then `uv run python scripts/smoke.py` |

## Honest limits

- **Test mode.** Stripe is test mode. The production gateway charges a Stripe test PaymentIntent for the stored deal total with a test card (`STRIPE_PAYMENT_MODE=test_card`); the human clicking Approve & Pay is the consent. The Shared Payment Token path (a buyer-side token capped at the deal total) is built in `@sa/payments` and passed `stripe:smoke` 6/6 on our sandbox, but the buyer's token is minted by Stripe's test helper, not a real wallet.
- **Simulated buyers.** The A/B results use LLM-driven buyers with private walk-away prices, not real shoppers. Claude buyers only so far.
- **Single catalog.** Keyboards from four competing sellers, seeded in Supabase.
- **State.** Start limits and the probe breaker live in each gateway instance's memory, so a redeploy resets them. Anonymous-buyer memory lives in Supabase and survives redeploys, which is why `anon:reset --all` is on the pre-demo checklist.

## Docs

- [docs/NORTHSTAR.md](docs/NORTHSTAR.md): the problem and what we built toward
- [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md): who builds what: two pairs, five seams, three bridges
- [docs/FINAL_ARCHITECTURE.md](docs/FINAL_ARCHITECTURE.md): the agreed architecture, every component end to end
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): layer-by-layer decisions with the experiment evidence behind them
- [docs/experiments/EXPERIMENTS.md](docs/experiments/EXPERIMENTS.md): the assumptions tested (E1–E11)
- [docs/TRACKS.md](docs/TRACKS.md): which tracks we entered and why
- [docs/DEMO.md](docs/DEMO.md): the 2-minute demo and the pre-demo checklist
- [docs/live/](docs/live/): live logs per role (S2, E2; E1's is on branch `e1/live-log`)
- [docs/research/](docs/research/): protocol, discovery, payments, competitor research
- [CLAUDE.md](CLAUDE.md): rules for Claude sessions working in this repo
