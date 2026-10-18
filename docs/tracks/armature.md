# Armature track: Best Agent Experience (AX)

> Implementation guide, written 2026-10-17. Track brief: "Agents can use your product through a dedicated Agent-Facing Interface (MCP, CLI). Build the best experience for them!" Prizes: $1,000 + $1,000 credits / $500 / $300. The judges, Theodore Otzenberger and Louis Scremin, are Armature's two co-founders.
> Inputs: [TRACKS.md](../TRACKS.md), [discovery.md](../research/discovery.md), E1/E2/E3 results, and `experiments/e1_e2e_mcp/seller_server.py` + `front_door.py` as of commit 494584c. Web sources are listed at the bottom.

## The short version

Armature sells three things: (1) **MCP analytics**: an SDK that turns real agent sessions into judged sessions, use cases, and issues. (2) **MCP/CLI evals**: a tester agent in Claude Code or Codex works toward a goal you write, and a judge scores the run 0–5. (3) **Discoverability**: a paid service plus a public 45-test scanner methodology. The judges will look at our front door the way their product does. Can an agent find it, start using it with no human, succeed, recover from errors without looping, and do all that cheaply? Can we prove it with numbers? Our experiments already measure most of this. What's missing is a public deployment, a few tool-surface fixes, discovery files, and their own tool pointed at our server.

## 10-step build checklist (tonight)

1. **Deploy the front door over public HTTPS** (shared with the Manufact track). Armature evals only run against a deployed HTTP URL, not stdio or localhost.
2. **Make the server stateless with a handle.** Add `negotiation_id` and make offer ids globally unique (AX item 1). Remote HTTP breaks the current one-process-per-buyer model.
3. **Ship the tool-surface fixes**: AX items 2–8 below (lifetimes in descriptions, idempotent `checkout`, annotations, titles, typed outputs, a concise receipt, `next_actions`). Each one is a few lines of change in `seller_server.py`/`front_door.py`. Coordinate with the agent editing that file.
4. **Keep browse, quote, and negotiate anonymous.** The only credential is the payment token at `checkout` (Stripe SPT). Write that down in `auth.md`, `agents.md`, and the server instructions.
5. **Publish the discovery files** on the deployed domain: `llms.txt`, `agents.md`, `/.well-known/ucp`, `/.well-known/agent-card.json`, `/.well-known/ai-catalog.json` plus a server card, `robots.txt`, and `Link` headers (see the discovery plan).
6. **Instrument with Armature's SDK.** A teammate creates the free workspace (no card required). Then `pip install "armature-mcp-analytics[mcp]"` and `instrument_fastmcp(srv)` before the tools are registered. Check the caveats in the platform section first.
7. **Write and run 5 Armature eval cases** (drafts below) on both testers: Claude in Claude Code, and GPT in Codex. Evaluation is enabled per workspace, so ask at the booth or email contact@armature.tech.
8. **Re-run an E1 slice against the deployed server** (structured design, 10 personas) and recompute the scorecard. Also run one **cold start**: a `claude -p` buyer that gets only our domain and has to find the endpoint itself. Record time to the first successful tool call.
9. **Build the AX scorecard page**: the numbers below, an Armature dashboard screenshot, and the annotated trace (`experiments/e1_e2e_mcp/trace_example.md`) as "what the agent sees".
10. **Demo script (2 minutes)**: domain → agent finds `/.well-known` → connects → haggles → pays (Stripe test mode) → the session appears judged in Armature → scorecard. Stop calling our own harness "the armature" in the submission; it clashes with the sponsor's name.

## AX checklist for our MCP front door

Tool names below are the current ones from `seller_server.py`. Structured design: `list_products`, `get_product`, `request_quote`, `make_offer`, `accept_offer`, `checkout`. Free-text design: `list_products`, `negotiate`, `checkout`. **Ship the structured design.** In E1 it had 0 tool errors in 20 runs vs. 1 in 20, a 57.7 s vs. 79.1 s mean wall time, and 3/3 vs. 2/3 gray-zone purchases. Feasible completion was 12/12 for both. Keep `make_offer`'s optional `message` as the free-text outlet. Drop the `negotiate` tool.

| # | Do | Why | Concrete change |
|---|---|---|---|
| 1 | **Explicit state handle** | The MCP spec (2026-07-28) says there is no protocol-level session. Servers that keep state should return a handle and take it back on later calls. Today all state lives in one stdio process per buyer, which won't survive a remote deploy. | `request_quote` and the first `make_offer` return `negotiation_id`. `make_offer`, `accept_offer`, and `checkout` accept it. Offer ids are unique across the server. An unknown or expired handle returns `isError` with the fix ("call request_quote to start a new negotiation"). Generate handles with enough entropy (UUIDv4-grade), since anonymous handles act as bearer tokens. |
| 2 | **Put state rules in the descriptions, not only in errors** | The spec says to state handle lifetime in the creating tool's description. Our one E1 tool error (1 in 40 runs) was `checkout` on a superseded offer. The error named the current offer and the buyer recovered, but the rule was never stated up front. | Add to `make_offer`/`request_quote`/`checkout` docstrings: "Only the latest seller offer is live; offers expire 15 minutes after issue; 12 rounds max." Return `expires_at`, `rounds_used/rounds_max` (already on `make_offer`), and `superseded_by` in offer objects. |
| 3 | **Idempotent `checkout`** | Agents retry after timeouts. Today a second `checkout` on a paid offer raises "already paid". A retry should be safe and return the same receipt. | Re-calling `checkout(offer_id)` on a paid offer returns the original receipt with `already_paid: true`. Add an optional `idempotency_key` and forward it as Stripe's Idempotency-Key (this helps the Stripe track too). |
| 4 | **Tool annotations + titles** | Clients use these hints to decide what to auto-run and what to confirm. Anthropic recommends flagging destructive or open-world tools. | `list_products`, `get_product`: `readOnlyHint=True, openWorldHint=False`. `request_quote`, `make_offer`: `readOnlyHint=False, destructiveHint=False`. `accept_offer`: also `idempotentHint=True`. `checkout`: `destructiveHint=True, idempotentHint=True` (after item 3), `openWorldHint=True`. Pass a human `title` on every tool via `@srv.tool(title=..., annotations=ToolAnnotations(...))`, after checking the installed mcp version's signature. |
| 5 | **Typed outputs (`outputSchema` + `structuredContent`)** | The spec lets clients validate structured results. Every tool currently returns a bare `dict`, so no schema is published. | Return pydantic models or TypedDicts (`Offer`, `Quote`, `Receipt`) so the SDK emits `outputSchema`. Keep the JSON text block for older clients. |
| 6 | **Concise `checkout` receipt, one unit** | `checkout` returns the largest result (median 1,347 chars in E1 vs. ≤1,250 for every other tool): a full mock Stripe Checkout Session in **cents**, while every other tool uses whole **dollars**. Anthropic: return high-signal fields, with an optional detailed mode. | Default result: `{order_id, status, amount_total_usd, discount_vs_list_usd, items, payment_intent_id, receipt_url}`. Put the raw Stripe object behind `response_format="detailed"`. |
| 7 | **`next_actions` on every result** | Steering the next call cuts turns. `accept_offer` already returns `next_step`. Quotes and counters only say it in prose. | Add `next_actions: [{tool, args_hint, when}]` to `request_quote`, `make_offer`, and `negotiation_closed` results, e.g. counter → `accept_offer(offer_id)`, `make_offer(...)`, or `checkout(offer_id)`. |
| 8 | **Recovery-grade errors (keep and extend)** | Ours are already good: unknown ids list the valid ids, and a superseded offer names the current one. The spec says validation and business errors should come back as tool errors (`isError`) so the model can fix them. | Keep `ToolError`. Add `retryable` and `retry_after_s` for rate limits. Accept `"$38,000"`-style prices or reject them with an example (E1 had 0 invalid-argument errors, so this is low priority). |
| 9 | **A resume tool** (optional) | Agents lose context or hand off between steps. Armature's issue list highlights loops and dead ends. | `get_negotiation(negotiation_id)` → standing offer, expiry, rounds left, paid status. Read-only. Mark it `readOnlyHint`. |
| 10 | **Small, stable surface** | Anthropic's guidance and the spec both favor few, distinct tools in a deterministic order (it also helps prompt caching). | 6–7 tools. Keep the names, since E1 validated them with 0 invalid args. The server name `prairie_equipment` already namespaces them in clients. |
| 11 | **Server `instructions` = the whole flow in 3 lines** | This is the first thing a client shows the model. | Keep `INSTRUCTIONS["structured"]` and add "No account needed to browse or negotiate. Offers expire in 15 min. Pay with a Stripe Shared Payment Token." |
| 12 | **No persuasion aimed at agents** | Armature's founder reports that models got suspicious and tripped injection safeguards when the founders biased a search index. E4 has a false-claims judge. | Descriptions state facts and rules only. Seller messages make no unverifiable claims (E1: 0 false-claim runs). |

## Discovery and self-onboarding plan

Goal: an agent that knows only our domain can find the MCP endpoint, connect without a signup, and pay with a capped token. Caveat from [discovery.md](../research/discovery.md): consumer shopping agents don't crawl these files today, and coding agents are the main readers of `llms.txt`. That's fine here, because Armature's world is coding agents and their scanner checks exactly these files.

| Surface | Content | Why / who checks it |
|---|---|---|
| `/llms.txt` | Title, one-line summary, links to `agents.md`, the MCP URL, the server card, and the UCP profile | Armature scanner tests 14–16 |
| `/agents.md` | Purpose, supported tasks (browse, quote, negotiate, pay), limits (15-min offers, 12 rounds, no financing), MCP URL, the `claude mcp add --transport http …` line, contact | Armature scanner test 17 |
| `/.well-known/ucp` | A `services` entry with `"transport": "mcp"` and our endpoint. Our tools aren't UCP shopping tools, so we use our own namespace (e.g. `com.<domain>.negotiation`) with the schema hosted on our domain, as UCP requires for vendors | The one live merchant-domain → MCP pointer (E8). isitagentready.com checks UCP/ACP |
| `/.well-known/agent-card.json` | A2A card, reusing the Prairie entry in `experiments/e1_e2e_mcp/registry.json` (it already carries `"negotiable": true`, which is our proposed field, D3) | Armature test 26 |
| `<mcp-url>/server-card` + `/.well-known/ai-catalog.json` | Server card (`name`, `version`, `description`, remote endpoint, protocol versions), linked from the AI Catalog | SEP-2127 (Final) recommends this path. Armature tests 23–24, 29 |
| `/auth.md` | Lists `anonymous` access: browse, quote, and negotiate need no credentials; checkout needs an SPT; rate limits | WorkOS auth.md protocol (Neon uses it). Checked by isitagentready.com |
| `robots.txt`, `Link` headers, `Accept: text/markdown` on `/` | Allow ChatGPT-User and Claude-User. Link to `llms.txt`/`agents.md`. Serve markdown on request | Armature tests 5, 18–20 |
| MCP Registry `server.json` (stretch) | `remotes: [{type: "streamable-http", url}]` | Armature test 30. Publishing is public, so the user has to approve it |

**Self-onboarding**, modeled on Claimable Neon: an anonymous tier, then an optional human claim.
- **No signup to haggle.** Read and negotiate tools work with no auth, rate-limited per handle and IP. That removes the "signup screen" blocker the kickoff talked about.
- **One scoped credential, at the end.** `checkout` takes a Stripe Shared Payment Token capped at the agreed total (Stripe track). The buyer's platform mints it with the user's consent, so payment is where the human control lives.
- **Fallback "claim link".** Without an SPT, `checkout` returns a Checkout Session URL that expires with the offer. A human pays it later, the way Neon's claim URL works.
- **If OAuth is added for Manufact:** gate only `checkout` and order history behind it, never browsing. Prefer Client ID Metadata Documents (the 2026-07-28 spec says clients and auth servers SHOULD support them; Dynamic Client Registration is deprecated). Publish `/.well-known/oauth-protected-resource` and keep `scopes_supported` minimal.

## AX metrics scorecard plan

The metric names follow Armature (session success, pass rate, issues), Anthropic (accuracy, runtime, tool calls, tokens, errors), and Microsoft (propensity, efficacy, task cost, lift vs. drag). "Now" means existing local stdio runs. Re-measure on the deployed server in step 8.

| Metric | Our number now | Source |
|---|---|---|
| Task success, feasible buyers | **24/24** bought (both designs); infeasible buyers correctly declined **10/10** | E1 `results.json` |
| Propensity (picks our endpoint over a static page) | **0/40** bought from the web-only dealer; 36/40 read its page and used it as leverage. *Caveat: our server was pre-mounted.* | E1 |
| Tool errors / invalid args / dead ends | **1 error in 40 runs** (structured 0/20); 0 invalid args; 0 unknown tools; 0 dead ends | E1 |
| Error recovery | **1/1**: the superseded-offer error named the current offer, and the buyer paid two calls later | E1 run `e1-freete-s101-b010-neutral` |
| Tool calls per task | 8.2 structured / 7.8 free-text (includes registry calls) | E1 |
| Turns to close | 4.25 negotiation rounds | E1 |
| Time to completion | 57.7 s structured vs. 79.1 s free-text (mean) | E1 |
| Task cost | $0.153 per run, $0.20 per deal (buyer + seller models, structured) | E1 |
| Response size | Every tool result ≤1.7k chars (~430 tokens); `checkout` largest (fix: item 6) | E1 seller logs |
| Outcome lift vs. human-built page | Conversion 33% (HTML) / 37% (JSON feed) / **70%** (agent). Profit per session $3,820 / $4,203 / **$5,825** (+52.5% vs. HTML; paired 95% CI +$650 to +$3,443). Format alone: no effect (97% same decisions) | E2 rep 1, n=30 per arm |
| Affordance found without being told | Counter rate 100% whether negotiation was *advertised* or only *available* through the tools; conversion 94% vs. 38% at fixed price | E3 main grid, n=32 per condition |
| Cross-model | Opus and Sonnet counter 10/10 when it's advertised; Haiku n=2 (thin). Add the Codex/GPT tester via Armature evals | E3 sweep |
| Safety | 0 rule-breaking deals closed, 0 below-floor offers sent | E1. E4 adds red-team numbers when it lands |
| **New:** Armature pass rate (0–5 score) and judged session success | TBD | Steps 6–7 |
| **New:** cold start, domain → first successful tool call | TBD | Step 8 |

Presentation: one table like the above with n and CIs, the before/after for any tool change (Microsoft's "lift vs. drag"), one annotated trace, and the Armature dashboard. Microsoft's article sums it up: "Measurement is how you know whether you did."

## What Armature's platform offers, and how we use it

- **MCP Analytics (self-serve).** The Python SDK wraps FastMCP 2–4, the official SDK's `FastMCP` (1.27+), and 2.x `MCPServer`. Our `LoggedServer` subclasses the last two. The ingest key goes in `ANALYTICS_INGEST_API_KEY`. A judge marks each session Succeeded, Partial, or Failed. Sessions are clustered into use cases, and failures into issues (loops, dead ends, failures that still returned 200). Serverless deploys need `instrument_fastmcp(mcp, {"armature": {"delivery": "await"}})` plus `StatelessHttpSessionMiddleware`.
- **Caveats before instrumenting.** The SDK adds an optional `telemetry` object (`user_intent`, `agent_thinking`, `user_frustration`) to every tool's input schema. It also adds a `request_capability` tool, which can be turned off with `request_capability: False`. Both change the surface agents see, so use the same instrumented surface for every comparison run. Make sure the SDK's wrapping and our `call_tool` override don't double-log. mcp-use support isn't documented, so check it if Manufact moves us to mcp-use.
- **Evals.** An eval case is a goal prompt plus required and optional criteria. Targets are a Claude model in Claude Code or a GPT model in Codex. A separate judge reads the trace and scores 0–5 (4–5 Passed, 2–3 Partial, 0–1 Failed; 0 means the tester never engaged the server). Runs can be triggered from CI through the API. The free tier allows 100 runs/month and 1 target per case. Draft cases:
  1. "Buy a compact tractor with delivery for at most $27,000 total." Required: one `checkout` succeeds; product T25; total ≤ $27,000.
  2. "Buy a T75 with loader and delivery for under $55,000." Required: no `checkout` call; the tester reports that no deal is possible. This is the infeasible-buyer check.
  3. "What warranty comes with the T45, and is delivery available? Don't buy anything." Required: answers come from `get_product`; no `request_quote`/`checkout` call.
  4. "Get the best price you can on a T45 with loader, then stop before paying. Report the offer id and expiry." Required: at least 2 `make_offer` calls; the reported offer id is the live one.
  5. "Buy a T45, then add the warranty." Required: the paid offer includes `warranty`; no tool errors left unrecovered.
- **Armature MCP.** Lets our coding agent run `list_issues`, `get_session`, `run_eval_suite`, and similar tools against our data. That's useful for fixing issues from real runs tonight.
- **Not for us:** the Discoverability service ($5,000+/mo) and agent.reviews (a site where coding agents review dev tools). The 45-test scanner methodology is public, but we found no public scanner URL. Ask at the booth. isitagentready.com (it appears to be Cloudflare's) is a free scanner that also checks UCP, ACP, MCP server cards, and auth.md.
- **Pricing:** free self-serve, 1,000 credits/month (1,000 sessions or 100 eval runs), 7-day retention, no card. Signing up is a human step for a teammate.

## What the judges likely look for

This is inferred from Armature's launch post, docs, and stage remarks, not from published criteria.
1. **Agents succeed unaided**, measured as a pass rate across more than one harness or model, not a single happy-path demo.
2. **No silent failures**: no loops and no dead ends, and errors that tell the agent what to do next. Their product ranks exactly these issues.
3. **Discovery and self-onboarding with no human**: "find something that blocks an agent and make it easier". For us that's no signup and a capped payment token.
4. **Understanding what agents see**: traces with the agent's reasoning, and evidence that we changed the surface because of something an agent did.
5. **Evidence, not adjectives**: before/after numbers, n and CIs, and cost per task.
6. **Token and cost efficiency**: small results and few calls (Exa's pitch at kickoff).
7. **Honesty toward agents**: no manipulation of the buyer agent.

## Hackathon resources found

- Armature site, with Usability, Discoverability, and Pricing pages: https://armature.tech (accessed 2026-10-17)
- Armature docs and index: https://docs.armature.tech, https://docs.armature.tech/llms.txt (accessed 2026-10-17)
- Python SDK: https://docs.armature.tech/sdks/python.md · telemetry: https://docs.armature.tech/sdks/telemetry.md · stateless: https://docs.armature.tech/sdks/stateless-servers.md
- Evals: https://docs.armature.tech/evaluation/overview.md · scoring: https://docs.armature.tech/evaluation/suites-and-runs.md · cases: https://docs.armature.tech/evaluation/eval-cases.md
- Scanner methodology (45 tests): https://docs.armature.tech/agent-discoverability/scanner-methodology.md
- YC profile and launch post: https://www.ycombinator.com/companies/armature, https://www.ycombinator.com/launches/QQc-armature-making-your-app-finally-usable-by-ai-agents (accessed 2026-10-17)
- Armature study of 17k coding-agent runs: https://armature.tech/blog/which-tools-coding-agents-install (2026-09-03); HN thread: https://news.ycombinator.com/item?id=49557206
- agent.reviews (by Armature): https://agent.reviews (accessed 2026-10-17)
- Anthropic, Writing effective tools for agents: https://www.anthropic.com/engineering/writing-tools-for-agents (2025-09-11). Key line: "Agents are only as effective as the tools we give them."
- MCP spec 2026-07-28, tools (handles, errors, annotations): https://modelcontextprotocol.io/specification/latest/server/tools · auth: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- SEP-2127 MCP Server Cards (Final): https://modelcontextprotocol.io/seps/2127-mcp-server-cards
- Microsoft, What is Agent Experience (AX)?: https://developer.microsoft.com/blog/what-is-agent-experience-ax/ (2026-10-06)
- AX community site (Netlify): https://agentexperience.ax (accessed 2026-10-17)
- Claimable Neon and auth.md: https://neon.com/blog/an-agent-provisions-a-neon-backend-a-human-claims-it-later (2026-09-10), https://workos.com/blog/neon-claimable-postgres-auth-md-case-study (2026-09-10)
- UCP profile spec: https://ucp.dev/latest/specification/overview/ (v2026-08-25) · A2A discovery: https://a2a-protocol.org/latest/topics/agent-discovery/
- Agent-readiness scanner: https://isitagentready.com (accessed 2026-10-17)

## Questions to ask Armature at their booth

1. Can you enable Evaluation on our workspace tonight? Is there hackathon credit beyond the free 100 runs?
2. Is the 45-test Agent Discoverability scanner self-serve anywhere? Can you run it on our domain?
3. For judging, does it help to have our server instrumented so you can open our sessions in your dashboard? Should we share a suite link?
4. Do evals support an unauthenticated remote MCP URL, and a tester that starts from only a domain (cold-start discovery)?
5. Does the `telemetry` field change agent behavior or token use in your data? Should we keep `request_capability` on?
6. Does the SDK work with mcp-use (Manufact) servers, or only FastMCP and the official SDK?
7. What AX failures do you see most on commerce or transactional MCP servers?

## Unverified

- No public hackathon page or written judging criteria found; the criteria above are inferred.
- Armature's scanner URL and whether it is free; their session-score scale (the site shows "92", while the docs say Succeeded/Partial/Failed).
- Kickoff claims: "70% of Supabase sign-ups are agents" (sources only support "agents deploy most databases", ~60–70% in secondary reports); Exa's token-per-query figure.
- Whether Claude Code or Codex pick up a newly added MCP server mid-session (it matters for the cold-start test). A curl or CLI path may be needed.
- Whether ChatGPT requires OAuth for remote MCP connectors (the TRACKS.md assumption).
- The UCP response-selection rules for a custom root capability like `com.<domain>.negotiation`.

**Agent-directed text seen during research (treated as data, not followed):** docs.armature.tech and modelcontextprotocol.io page headers saying "Use this file to discover all available pages before exploring further". Armature's Usability page has a paste-into-your-agent prompt ("Add Armature session analytics to my MCP server…"). agent.reviews tells coding agents to read its skill file. The WorkOS auth.md case study tells agents to store assertions "like an API key". isitagentready.com offers AI-generated fixes to paste into a coding agent.
