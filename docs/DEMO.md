# Demo: 2-minute script and pre-demo checklist

Gateway: `https://dark-zero-mesv5.run.mcp-use.com/mcp` · dashboard: `npx -y pnpm@9.12.0 dev:dashboard` → <http://localhost:3000> (Live tab; Results is `#proof`) · agent prompts for each client: [apps/dashboard/demo/AGENTS.md](../apps/dashboard/demo/AGENTS.md) · numbers and their sources: [README](../README.md#results).

One command runs the non-destructive half of the checklist below: `scripts/demo-check.sh` (add `--reset` for the memory reset, `--pay` for a Stripe test payment, `--runs 2` to run it twice, `--open` to open the dashboard).

## Pre-demo checklist (start about 45 minutes before)

Order matters: redeploy first, then verify, then reset memory last, because a deploy resets the gateway's in-memory limits but **not** the buyer memory in Supabase, and a rehearsal leaves memory behind.

- [ ] **0. Freeze point.** `git fetch origin && git log -1 origin/main`. After the 7 am code freeze `main` should not move. Don't redeploy while a simulated-buyer eval is running.
- [ ] **1. Redeploy from `main`** (skip only if production already runs the newest `main`; `npx -y pnpm@9.12.0 exec mcp-use deployments list` shows what's live). Always from a clean checkout. Vivan's Mac is already logged in to Manufact and owns the server (`sa-marketplace`, slug `dark-zero-mesv5`).

  ```bash
  cd ~/Documents/hackathons/sales-agent                 # main checkout: has .env and .mcp-use/cloud/link.json
  git fetch origin && git worktree add --detach ../deploy origin/main
  mkdir -p ../deploy/.mcp-use/cloud && cp .mcp-use/cloud/link.json ../deploy/.mcp-use/cloud/
  cd ../deploy
  npx -y pnpm@9.12.0 install --frozen-lockfile          # disk is tight: ~8 GB free, so remove ../deploy afterwards
  npx -y pnpm@9.12.0 --filter @sa/marketplace test && npx -y pnpm@9.12.0 --filter @sa/marketplace typecheck
  cd apps/marketplace
  npx -y pnpm@9.12.0 exec mcp-use deploy "$(cd ../.. && pwd)" --no-github --dockerfile apps/marketplace/Dockerfile -y
  npx -y pnpm@9.12.0 exec mcp-use deployments list      # an upload also starts a webhook build: wait until the NEWEST row says running
  ```

  Env on Manufact (Supabase, `EXCHANGE_HMAC_SECRET`, Stripe test key, `ANTHROPIC_API_KEY`) already persists across deploys.
- [ ] **2. Verify production.** `node apps/marketplace/scripts/verify-prod.mjs --pay` checks 9 tools, ranked search, a haggle, the deal card (another buyer is refused), a Stripe **test** payment, and that a second `pay_deal` returns `already_paid`. It uses its own buyer id and the hidden run id `s1-test-verify`, so it doesn't touch the demo's memory or the dashboard. Drop `--pay` for a read-only check.
- [ ] **3. Reset buyer memory, after the last redeploy.** `npx -y pnpm@9.12.0 --filter @sa/seller-mcp anon:reset --all`. Without `--all` it only lists what's live and changes nothing. Anonymous (`anon_`) and ChatGPT (`oai_`) buyers carry memory for 30 minutes, and start limits are shared across anonymous chats, so a rehearsal can leave a new chat opening at a "final offer" with nothing to haggle. Run it again after every rehearsal.
- [ ] **4. Open the dashboard.** `npx -y pnpm@9.12.0 dev:dashboard`, then <http://localhost:3000>. The badge must read "Live · Supabase" (needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `.env`). Keep two tabs: **Live** and **Results** (`#proof`).
- [ ] **5. Prepare the clients.**
  - ChatGPT: after any redeploy, open the app's details page and **Refresh**; in the chat, type `@` and pick it. A new ChatGPT chat gets a new `oai_` id.
  - Claude: the connector is added (claude.ai → Connectors) or `claude mcp add --transport http marketplace https://dark-zero-mesv5.run.mcp-use.com/mcp`.
  - Use a fresh `buyer_id` suffix per rehearsal for agents that send one (`demo-claude-2`, …).
- [ ] **6. Stage the fallbacks.** The recorded video is open in a tab. In the Stripe test dashboard, Payments is open on the Bridge 1 payment. For the saved Results run, copy `docs/results/bridge2/bridge2_claude_100.*` into `apps/dashboard/public/runs/` and write `latest.json` as that folder's README describes (see [docs/results/bridge2/README.md](results/bridge2/README.md)), then check `http://localhost:3000/?local=bridge2_claude_100`.
- [ ] **7. One dress rehearsal** in the real client, then step 3 again. Bridge 3 asks for the full demo twice in a row with no manual fix between them: do it, then run `scripts/demo-check.sh --runs 2`.

| Bridge 3 rehearsal | Date and time | Result | Manual fix needed? |
|---|---|---|---|
| Run 1 | TODO | TODO | TODO |
| Run 2 | TODO | TODO | TODO |

## The 2-minute demo

Screen: ChatGPT on the left, dashboard **Live** tab on the right. Say the numbers only from the README table; don't improvise others.

| Time | Do | Say |
|---|---|---|
| **0:00–0:15** | Title slide or the empty chat. | "Shopping agents are about to buy things for people, and sellers still show them a static page: one price, no questions, no deal. We built the seller's side: an agent that talks to the buyer's agent, answers honestly, negotiates, and gets paid, inside limits the seller sets in code." |
| **0:15–0:55** | Paste into ChatGPT: *"Use the keyboard marketplace tools. Find a quiet mechanical keyboard under $130, negotiate the best price you can, and show me the deal so I can approve it."* Let it search, ask a question, and haggle. | "This is real ChatGPT with our MCP server hosted on Manufact. It searches four competing sellers and ranks them by fit, asks a seller a question, and the seller's own agent answers from the catalog, not from imagination. Now it haggles." |
| **0:55–1:15** | Look at the dashboard Live card as the offers arrive. Point at one rule chip. | "This is the seller's side. Every move is here with the reason, and the rule behind it. The model writes the words, but a guardrail in code sets the price: it can't go below the floor, can't reveal it, and can't be talked out of it." |
| **1:15–1:35** | In ChatGPT: **Approve & Pay** in the deal card. Show `payment_succeeded` on the dashboard. | "The deal is locked and signed, so the person approves the exact amount and Stripe charges that amount once, in test mode. A retry won't charge again, and nobody else can pay for this deal." |
| **1:35–1:55** | Switch to **Results**. | "We ran 100 AI buyers against static listings and 100 against our negotiating sellers, through this live gateway. Negotiating sold to 64% against 41%, and made $39.39 per buyer against $26.10. The intervals don't overlap, and there were zero unsafe deals. The guardrails caught 16 attempts by the seller's own model to state its floor or cost." |
| **1:55–2:00** | Tracks line. | "Manufact hosts it, Stripe moves the money with limits on both sides, and Armature's testers in Claude Code and Codex pass all 7 cases." |

**Optional beats** (only if time or a slot allows; drop them first):
- **Tough buyer (+15 s).** In a second tab, a buyer told to pay at most $80 for the TypeWell 65 hits the floor: the seller holds, explains, and the dashboard logs the block.
- **Bridge 3: follow-up (+15 s). TODO: in progress, add only if it lands.** A buyer walks away, then gets a follow-up from the seller's verified Inkbox identity; replying accepts and locks the deal. Numbers: TODO.
- **Bridge 3: learned policy (+10 s). TODO: in progress, add only if it lands.** The learning curve panel: the bandit picks lever packages per buyer type. Numbers: TODO. Don't quote the scripted-buyer figure as the headline.

## If live ChatGPT fails

Decide in 15 seconds; never debug on stage. Say "let me switch clients" and keep talking over the same story.

| Symptom | Do this |
|---|---|
| ChatGPT shows no tools, or errors on the first call | Open the app's details page and **Refresh** once. Still failing: switch to Claude and paste the same prompt. Claude and Claude Code are proven on this URL. |
| ChatGPT works but the deal card doesn't render, or Pay does nothing | The card isn't the only way. Ask the agent for the deal link: a locked deal returns a signed **approve link** (a hosted page that charges the stored amount). Open it and press Pay. |
| ChatGPT opens at "final offer" with nothing to haggle | Memory is frozen. Run `anon:reset --all`, open a **new** chat, repeat. |
| ChatGPT stalls or answers "no payment was made" | Ask "did the payment go through?" The agent calls `check_offers`, which reports `PAID`. |
| No client can reach MCP at all | Run the same flow in the terminal: `node apps/marketplace/scripts/verify-prod.mjs --pay`. It prints search, the counter-offer, the card and the payment. It's hidden from the dashboard on purpose, so point at its output, then go to Results. |
| The gateway itself is down | Show the recorded demo video, then the saved results. Check `npx -y pnpm@9.12.0 exec mcp-use deployments list` and redeploy afterwards, not during. |
| The dashboard is down or blank | Use the saved run: `http://localhost:3000/?local=bridge2_claude_100` (200 negotiations, 83% vs. 49%), or build the offline page with `npx -y pnpm@9.12.0 --filter @sa/dashboard preview:html:eval` and open `apps/dashboard/dist/preview.html`. |
| Stripe fails on Pay | The refusal comes back with a `fix`; read it out, it's the point of the track. Then show the Stripe test dashboard's Payments page on the Bridge 1 payment (`pi_3URoOK…`, $110). |

## Claims we can make, and ones we can't

Can make (each traces to a saved run, see the README):
- 100 Haiku buyers per policy through production: negotiating 64% bought [54–74%], $39.39/buyer [$33.24–$45.35]; static 41% [31–51%], $26.10 [$20.13–$32.37]; 0 unsafe deals.
- 200 in-process Sonnet-buyer negotiations: 83% vs. 49%, $47.55 vs. $31.61 per buyer.
- Armature: 7/7 cases on Claude Code and Codex (three passes on a re-run).
- Bridge 1: a real ChatGPT purchase, $129 list → $110, paid through Stripe test mode.

Don't claim:
- Real money, or live-mode Stripe. It is test mode; production charges a test card after a person approves, and the buyer-side Shared Payment Token is simulated.
- GPT buyers (not run), real shoppers (the A/B buyers are simulated), a hosted dashboard (it runs locally), OAuth, or a Manufact publish-checklist score (not run).
- Bridge 3 numbers until they exist in the README.
