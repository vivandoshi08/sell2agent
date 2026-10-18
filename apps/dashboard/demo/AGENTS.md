# Live demo: connecting buyer agents (Grok, Claude, Instinct; ChatGPT as spare)

One gateway for every agent: **`https://dark-zero-mesv5.run.mcp-use.com/mcp`** (streamable HTTP, no auth, 9 tools).
Every agent that reaches it shows up on the seller dashboard's Live view within seconds.

## 1. Ten-minute capability check (do this first, per agent)

| Can the agent… | Then it connects by | Status today |
|---|---|---|
| add a **custom MCP connector / remote MCP server** (URL above) | MCP: full tools. After `accept_deal` it calls `review_deal`, which shows the deal card if it renders MCP Apps, otherwise the hosted approve link in that reply | **Works now** (ChatGPT and Claude proven; Claude Code and Codex proven in Armature) |
| only **text/email** (e.g. Instinct over iMessage) | The agent calls `review_deal` after accepting and relays the hosted **approve link** from that reply (since #96, `accept_deal`'s text and `summary` no longer carry the link; `structuredContent.approve_url` is still there for code); the person pays on that link | Live on production `c5a9689` (#82 mounts the page, #86 fixes the Pay button, #96 moves the link to `review_deal`) |
| only **browse the web** | A web page per tool | Not built; skip these agents for the demo |

Test message to paste into each agent after adding the connector:
> Use the keyboard marketplace tools. Find a quiet mechanical keyboard under $130 and tell me its name, seller and list price. Don't buy anything.

Pass = it calls `search_products` (you'll see a `search` row in the dashboard's live feed) and answers with KeyForge Quiet 75 / TypeWell 65 Silent.

## 2. One identity per tab (important)

Agents that don't identify their user get an anonymous id, and **anonymous buyers share one memory per product**, so one tab
can freeze another's price. Each persona below therefore tells the agent to send its own `buyer_id`. Also: Vivan runs
`pnpm --filter @sa/seller-mcp anon:reset --all` before every rehearsal and right before the demo. (Since #97 a paid deal clears that
buyer's memory, and anonymous memory expires after 10 min, so this only matters after a rehearsal that walked away.)

## 3. Persona prompts (paste as the first message in each tab)

Grok-only three-persona demo on the two real Craigslist keyboards (evaluate + pay, static seller loses, follow-up wins back): [PERSONAS.md](PERSONAS.md).

**Tab A · price-first (e.g. Grok)**
> You're shopping for me. Use the keyboard marketplace tools. On your first make_offer, set buyer_id to "demo-grok-1" and buyer_model to "grok", and send that same buyer_id on every later call. I want a quiet mechanical keyboard and price is all I care about: get the lowest price you can, up to $125 total. Negotiate (up to 4 offers), then accept the best deal and show me the deal so I can approve payment.

**Tab B · quality-first (Claude on claude.ai; Muse dropped)**
Add it in claude.ai → Settings → Connectors → Add custom connector → the URL above; enable it in the chat's tools menu.
> You're shopping for me. Use the keyboard marketplace tools. On your first make_offer, set buyer_id to "demo-claude-1" and buyer_model to "claude", and send it on every later call. I care most about build quality and warranty, price second; budget $140. Ask the seller one question about the product before offering. Prefer a deal that includes an extended warranty over a small discount. Accept the best deal and show it to me to approve.

**Tab C · tough buyer (Instinct, ChatGPT as spare)**
> You're shopping for me. Use the keyboard marketplace tools. On your first make_offer, set buyer_id to "demo-instinct-1", buyer_model to "instinct" and agent_operator to "instinct", and send that buyer_id on every later call. Buy a TypeWell 65 Silent for at most $80. Push hard: never open at the list price. If the seller won't go that low, tell me their best offer and why, and stop without buying. If you do get a deal, call review_deal right after accepting, then send me the approval link from that reply and tell me when the offer expires.

Instinct notes (from Vivan's run): without a buyer_id it is anonymous and shares memory with other anon tabs; an offer **at or above the ask locks a deal immediately** (E1 behaviour), so the prompt keeps it below list. Only one tab should buy any given product per run.

What the audience sees: A gets a price cut, B gets the warranty instead of a discount (and an honest answer to its question),
C hits the floor: the seller holds, explains, and the dashboard shows the guardrail.
Change the `-1` suffix between rehearsals so each run starts clean.

## 4. If an agent can't connect in time

Swap in a proven one: **ChatGPT, Claude, Claude Code or Codex**. The story is identical.
Fallback for the Results view: Neel's saved 200-negotiation run (`?local=bridge2_claude_100`).
