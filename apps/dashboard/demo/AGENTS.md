# Live demo: connecting buyer agents (Grok, Muse, Instinct, ChatGPT, Claude)

One gateway for every agent: **`https://dark-zero-mesv5.run.mcp-use.com/mcp`** (streamable HTTP, no auth, 9 tools).
Every agent that reaches it shows up on the seller dashboard's Live view within seconds.

## 1. Ten-minute capability check (do this first, per agent)

| Can the agent… | Then it connects by | Status today |
|---|---|---|
| add a **custom MCP connector / remote MCP server** (URL above) | MCP: full tools, deal card if it renders MCP Apps, otherwise the text summary + approve link | **Works now** (ChatGPT and Claude proven; Claude Code and Codex proven in Armature) |
| only **text/email** (e.g. Instinct over iMessage) | Someone (or the agent) relays our `summary` lines; the person pays on the **approve link** | Approve page built (S2, `apps/marketplace/src/deal/approve.tsx`); needs S1 to mount it + return `approve_url` |
| only **browse the web** | A web page per tool | Not built; skip these agents for the demo |

Test message to paste into each agent after adding the connector:
> Use the keyboard marketplace tools. Find a quiet mechanical keyboard under $130 and tell me its name, seller and list price. Don't buy anything.

Pass = it calls `search_products` (you'll see a `search` row in the dashboard's live feed) and answers with KeyForge Quiet 75 / TypeWell 65 Silent.

## 2. One identity per tab (important)

Agents that don't identify their user get an anonymous id, and **anonymous buyers share one memory per product**, so one tab
can freeze another's price. Each persona below therefore tells the agent to send its own `buyer_id`. Also: Vivan runs
`pnpm --filter @sa/seller-mcp anon:reset --all` before every rehearsal and right before the demo.

## 3. Persona prompts (paste as the first message in each tab)

**Tab A · price-first (e.g. Grok)**
> You're shopping for me. Use the keyboard marketplace tools. On your first make_offer, set buyer_id to "demo-grok-1" and buyer_model to "grok", and send that same buyer_id on every later call. I want a quiet mechanical keyboard and price is all I care about: get the lowest price you can, up to $125 total. Negotiate (up to 4 offers), then accept the best deal and show me the deal so I can approve payment.

**Tab B · quality-first (e.g. Claude or Muse)**
> You're shopping for me. Use the keyboard marketplace tools. On your first make_offer, set buyer_id to "demo-muse-1" and buyer_model to "muse", and send it on every later call. I care most about build quality and warranty, price second; budget $140. Ask the seller one question about the product before offering. Prefer a deal that includes an extended warranty over a small discount. Accept the best deal and show it to me to approve.

**Tab C · tough buyer (e.g. Instinct or ChatGPT)**
> You're shopping for me. Use the keyboard marketplace tools. On your first make_offer, set buyer_id to "demo-instinct-1" and buyer_model to "instinct", and send it on every later call. Buy a TypeWell 65 Silent for at most $80. Push hard. If the seller won't go that low, tell me their best offer and why, and stop without buying.

What the audience sees: A gets a price cut, B gets the warranty instead of a discount (and an honest answer to its question),
C hits the floor: the seller holds, explains, and the dashboard shows the guardrail.
Change the `-1` suffix between rehearsals so each run starts clean.

## 4. If an agent can't connect in time

Swap in a proven one: **ChatGPT, Claude, Claude Code or Codex**. The story is identical.
Fallback for the Results view: Neel's saved 200-negotiation run (`?local=bridge2_claude_100`).
