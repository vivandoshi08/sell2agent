# S2 runbook: the steps that need keys (run on a laptop)

Claude's cloud workspace can only reach the Anthropic API, not Supabase, Stripe, OpenAI or the deployed gateway. These are the S2 steps that need those, in order. Each takes a minute or two.

## 0. One-time setup
```bash
git pull && pnpm install
# repo-root .env (git-ignored; keys from the group chat; never commit it):
#   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
#   STRIPE_SECRET_KEY=sk_test_...   STRIPE_PAYMENT_MODE=test_card
#   ANTHROPIC_API_KEY (optional, for Claude buyers)
```
Supabase, if not done yet: in the SQL editor run `supabase/migrations/0001_init.sql`, then any newer migrations in order, then `supabase/seed.sql`.

## 1. Bridge 1 payment check (Stripe test mode)
```bash
pnpm --filter @sa/dashboard pay-smoke
```
**Pass:** `Pay: succeeded pi_...`, then `Second click: succeeded (already paid, not charged again)`, then `Exchange now says: paid`. The `pi_...` shows up in the Stripe test dashboard for exactly $129.00. This locks a real deal in E1's exchange and pays through S2's handler, so it proves the payment path without the deployed gateway.

## 2. Events reach Supabase
```bash
pnpm --filter @sa/dashboard seed:fake        # inserts labelled sample events (run_id s2-fake-*)
pnpm dev:dashboard                           # http://localhost:3000: the badge reads "Live · Supabase"
pnpm --filter @sa/dashboard seed:fake:clean  # removes only s2-fake-* rows
```

## 3. Bridge 2 eval on the real database
```bash
pnpm --filter @sa/dashboard eval --n 50 --models claude --seller-voice   # add ,gpt with OPENAI_API_KEY
```
Events stream to Supabase while it runs, and the live dashboard updates. At the end it writes `runs.result` for each policy and saves the run for `?local`. Through the deployed gateway instead: add `--gateway https://<deployed>/mcp`.

## 4. Re-score a run later
```bash
pnpm --filter @sa/dashboard run-result <run_id> --write   # judge + private costs → runs.result
```
