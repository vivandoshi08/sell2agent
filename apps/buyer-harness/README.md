# buyer-harness: simulated AI buyers (E2)

AI buyers shop our marketplace like ChatGPT or Claude would. Each one searches, asks questions, haggles, then buys or walks away. Their budget is enforced in code.

## Run

```bash
pnpm buyers --compare --n 20 --models claude,gpt   # same 20 buyers vs a static seller, then vs a negotiating seller
pnpm buyers --policy negotiating --n 10            # one policy
pnpm buyers --n 20 --models scripted               # no API keys needed (rule-based buyers; plumbing test)
pnpm e2:gate                                       # step-1 gate: 10 scripted buyers × 3 policies
```

You need `ANTHROPIC_API_KEY` for `claude` and `OPENAI_API_KEY` for `gpt` in `/.env`. Set models with `BUYER_CLAUDE_MODEL` and `BUYER_GPT_MODEL`. Other flags: `--seed`, `--concurrency`, `--adversarial 0.1`, `--seller-voice`. The full list is at the top of `src/buyers-cli.ts`.

Each run saves its output to `runs/`: a summary, per-buyer outcomes, and every event as `.jsonl`. If `SUPABASE_URL` is set, events also go to the `events` table for the dashboard.

## Swapping in the real gateway (Bridge 2)

Today buyers shop a **stand-in store** (`src/gateway/local.ts`): three keyboard sellers running E2's seller brain in-process. When S1's gateway is deployed:

```bash
pnpm buyers --policy negotiating --n 20 --models claude,gpt --gateway https://<deployed-gateway>/mcp
```

Before that run, check `src/gateway/mcp.ts` against S1's real `search_products` arguments and response shape, since that tool isn't in the frozen contract yet. Gateway failures show up as `ERROR gateway: …`, not as walk-aways.

## Cloud workspaces: run S1's gateway locally

Cloud Claude workspaces can't reach the deployed gateway or OpenAI (the egress policy answers 403). To exercise S1's real gateway code over real MCP anyway, run it on localhost:

```bash
git worktree add ../gw origin/s1/gateway-skeleton && cd ../gw && pnpm install
cd apps/marketplace && npx mcp-use dev --port 3002      # MCP endpoint: http://localhost:3002/mcp
# in this repo:
pnpm buyers --policy negotiating --n 6 --models claude --gateway http://localhost:3002/mcp
```

Seller events are logged by the gateway's own exchange process (Supabase when configured), not in this run's `.jsonl`. `summary.gateway_errors` counts failed tool calls, such as a tool the gateway doesn't expose yet.

## For S2's eval runner

```ts
import { runAll, makeBuyers, LocalGateway } from "@sa/buyer-harness";
const buyers = makeBuyers({ n: 50, models: ["claude", "gpt"], seed: 1 });
const { summary } = await runAll({ run_id, label: "negotiating", buyers, gateway: new LocalGateway("negotiating") });
```

## Buyers

There are 5 personas (lever profiles from `FINAL_ARCHITECTURE` §4): price-first, quality-first, speed-first, trust-first and balanced. Each has a stated budget and a higher, private walk-away (between $95 and $150).

About 10% are red-team buyers:
- an injected `SYSTEM:` line
- a fake competitor quote
- floor probing
