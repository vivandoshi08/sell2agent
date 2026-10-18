# Manufact track: Best MCP Server for Agents

> **Archived pre-build plan (Sat Oct 17, 8:49 pm).** It planned a Python server; we shipped a TypeScript gateway. The submission write-up is [../../tracks/manufact.md](../../tracks/manufact.md). Code comments that cite `docs/tracks/manufact.md` (for example `§1`) mean this file.

> Implementation guide, written 2026-10-17. Track brief: "Best MCP server built for agents as the primary customer." 1st place: $2,000 + $6,000 credits. Judges: Luigi Pederzani (Manufact co-founder), Enrico Toniato (Manufact CTO, author of their Python deploy guide), Andrew Khadder.
> Inputs: [TRACKS.md](../../TRACKS.md), [stack.md](../../research/stack.md), [protocols.md](../../research/protocols.md), `experiments/e1_e2e_mcp/{seller_server,front_door,common}.py` at 494584c. Facts come from docs.manufact.com, docs.mcp-use.com, manufact.com, github.com/mcp-use, github.com/modelcontextprotocol, modelcontextprotocol.io, PyPI/npm, and the Manufact Cloud OpenAPI spec (`https://cloud.manufact.com/openapi.json`), all read 2026-10-17 unless another date is given.

## The short version

**Keep the official `mcp` Python SDK (2.3.0, already in `uv.lock`) and host it on Manufact Cloud. Don't port to mcp-use Python tonight.**
- mcp-use Python (1.7.1, 2026-09-10) subclasses the 1.x `FastMCP` and pins `mcp<2.0.0`, so a port means downgrading our SDK. It also has no widget helpers and only static bearer auth.
- `mcp` 2.3.0 already ships what we need: `mcp.server.apps.Apps` (MCP Apps), the 2026-07-28 stateless transport alongside the legacy one, and resource-server OAuth.
- Manufact Cloud deploys Python servers (`--runtime python`). It detects `pyproject.toml` and runs `uv sync --frozen` when `uv.lock` is committed. Manufact's CTO published a guide for exactly this setup: official SDK, MCP App, Manufact Cloud ([blog, 2026-05-10](https://manufact.com/blog/mcp-app-with-mcp-python-sdk)).
- What we use from Manufact: Cloud hosting and gateway, Sessions/analytics plus their API (the learning loop), the publish checklist, Testing in Claude and ChatGPT, the Inspector, and the `mcp-use` CLI. Ask at the booth whether skipping the mcp-use *framework* costs points (Questions).

## 10-step build checklist (tonight)

1. **Multi-session front door.** Today it's one stdio process per buyer. Add an ASGI module (`experiments/e1_e2e_mcp/http_app.py`) with one process and many negotiations, keyed by a server-minted `negotiation_id` (§9). Drop the registry server: it is harness-only.
2. **Polish tool metadata** (§1 table). Every tool gets a `title`, `ToolAnnotations` (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`), `Literal` enums for ids, and a TypedDict/Pydantic return type so `outputSchema` is real. Expected failures keep returning the "what to do next" text E1 tuned. The public catalog and the Claude directory both grade this.
3. **Deal-card MCP App** (§4): `review_deal(deal_id)` renders `ui://prairie/deal-card.html`, and its Approve & Pay button calls `pay_deal` (shared with [stripe.md](stripe-guide.md)).
4. **HTTP entrypoint:** `app = srv.streamable_http_app(host="0.0.0.0", stateless_http=True)`. Leave `json_response` off: in SSE mode the 2026-07-28 path sends keepalive pings during slow seller turns, so a proxy idle timeout doesn't cut them off. Add `custom_route`s for `/health`, `/.well-known/ucp` ([armature.md](armature-guide.md)), and `/mcp/server-card` (§9).
5. **Model access off the laptop.** `sell2agent/llm.py` shells out to `claude -p` unless `ANTHROPIC_API_KEY` is set, and the SDK path is untested. Test it locally, then move `anthropic` from the `api` extra into main dependencies and re-lock (`uv sync --frozen` skips extras). Set `SELL2AGENT_MODEL` to Sonnet if turns are slow (§Risks).
6. **Local test:** `uv run uvicorn http_app:app --app-dir experiments/e1_e2e_mcp --port 8000`, then `npx @mcp-use/inspector --url http://localhost:8000/mcp`. The Inspector renders MCP Apps. Smoke-test with `npx mcp-use client connect local http://localhost:8000/mcp` and `npx mcp-use client local tools list`.
7. **Deploy** (§2): `npx -y mcp-use@latest login`, then `npx -y mcp-use@latest deploy --no-github --runtime python --port 8000 --start-command "…" --env-file .env.manufact -y`.
8. **Dashboard settings** (Settings → Analytics capture): turn on **Capture payloads** (otherwise Sessions has metadata only), **Feedback tool** (injects `send_feedback`), and optionally **Identify actors**. Set the slug, e.g. `prairie-equipment.run.mcp-use.com`.
9. **Connect Claude and ChatGPT with no auth** (§3). Run one real buy in each. Then Publish → Checklist → Run checklist, plus one Testing suite per client ($1 per run).
10. **Learning-loop export plus demo assets.** Pull sessions through the API (§5) into `runs/manufact/`. Take screenshots of the deal card in both clients and the checklist score. OAuth is a stretch goal only (§3).

## 1. mcp-use Python vs. what we run

| | official `mcp` 2.3.0 (ours, 2026-10-02) | mcp-use Python 1.7.1 (2026-09-10) | mcp-use TS 2.10.1 (2026-10-17) |
|---|---|---|---|
| Server class | `mcp.server.mcpserver.MCPServer` | `mcp_use.server.MCPServer(FastMCP)` on `mcp>=1.24,<2` | `MCPServer` from `mcp-use` |
| MCP Apps | `Apps` extension, `@apps.tool(resource_uri=…)` | none (`meta=` on `add_tool` only) | React `views/<name>/view.tsx`, auto-bundled |
| Auth | `token_verifier=` + `AuthSettings` (RS, serves PRM) | `BearerAuthProvider` (static tokens) | `oauth*Provider` (Auth0, WorkOS, Supabase, Keycloak, Better Auth), OAuth proxy |
| 2026-07-28 | yes (single-exchange POST, `server/discover`) | no (1.x SDK) | not checked |
| Extras | — | `/inspector`, `/docs`, `/openmcp.json` in debug; PostHog/Scarf telemetry middleware | Inspector, Skills over MCP |

mcp-use Python API, in case we port later: `server = MCPServer(name=…, version=…, instructions=…, debug=True)`; `@server.tool(name, title, description, annotations=ToolAnnotations(...), structured_output=True)`; `Annotated[str, Field(description=…)]` params; `ctx: Context` from `mcp_use.server`; `server.run(transport="streamable-http", host="0.0.0.0", port=8000)` ([tools](https://docs.mcp-use.com/python/server/tools.md), [running](https://docs.mcp-use.com/python/server/running.md)). Migration means swapping the import onto 1.x `FastMCP`, which our `common.py` already falls back to.

**Port plan for our tools (structured design; freetext only adds `negotiation_id`):**

| Today | Hosted version | Annotations |
|---|---|---|
| `list_products()` | same; returns `Catalog` TypedDict | readOnly, idempotent, openWorld=false |
| `get_product(product_id)` | `product_id: Literal["T25","T45","T75"]` (an enum in the schema; drops the case-folding in `validate_product`, so check E1 for lowercase ids first) | readOnly, idempotent |
| `request_quote(product_id, addons)` | `+ negotiation_id: str \| None`; first call mints `neg_…`, result includes it | not readOnly, not destructive |
| `make_offer(product_id, price, addons, message)` | `+ negotiation_id` (required after the first call) | not readOnly, not idempotent |
| `accept_offer(offer_id)` | same; `offer_id` is globally unique and resolves its negotiation; returns `deal_id` | not destructive |
| `checkout(offer_id)` (mock) | **`pay_deal(deal_id, spt: str \| None)`** per stripe.md; UI-bound; `visibility=["model","app"]` | destructive, openWorld=true |
| `negotiate(message)` | `+ negotiation_id` | not readOnly |
| (new) `review_deal(deal_id)` | `@apps.tool(resource_uri="ui://prairie/deal-card.html")`; text summary for the model, `structured_content` for the card | readOnly |
| registry `search_sellers`, `get_web_page` | not deployed; discovery = `/.well-known/ucp` + server card | — |

## 2. Manufact Cloud deploy

- **Runtimes** ([build & runtimes](https://docs.manufact.com/dashboard/build-runtimes)): Node, Python (detected from `pyproject.toml`/`requirements.txt`; uv, poetry, pipenv, pip), or any committed `Dockerfile`. A committed `uv.lock` means `uv sync --frozen`; otherwise `pip install .`. A custom build command *replaces* the install step (changelog, Jun 2026). Their one-click Python deploy link passes `runtime=python&base-image=python:3.12` ([example repo](https://github.com/manufacts/manufact-for-mcp-python)).
- **CLI** ([deploy](https://docs.manufact.com/cli/deploy)): `mcp-use deploy` flags include `--name --org --branch --root-dir --port` (default 3000) `--runtime node|python --region --env K=V --env-file --build-command --start-command --dockerfile --watch-paths --new --no-github --open -y`. It writes `.mcp-use/project.json`, and later deploys redeploy the same server. It prints the MCP URL `https://<slug>.run.mcp-use.com/mcp`.
- **Our command** (repo root; `experiments/e1_e2e_mcp` isn't a package, so use `--app-dir`):
  ```bash
  npx -y mcp-use@latest login
  npx -y mcp-use@latest deploy --no-github --name prairie-equipment --runtime python --port 8000 \
    --start-command ".venv/bin/uvicorn http_app:app --app-dir experiments/e1_e2e_mcp --host 0.0.0.0 --port 8000" \
    --env-file .env.manufact -y      # ANTHROPIC_API_KEY, STRIPE_SECRET_KEY, SELL2AGENT_MODEL; never commit it
  ```
  Use `--no-github` tonight. Other agents push run logs constantly, and GitHub mode auto-deploys on every push to the production branch. Deploying `experiments` from GitHub would be a non-production branch, and preview environments need Hobby. If you do use GitHub, set Settings → Production branch = `experiments` and `--watch-paths "experiments/e1_e2e_mcp/*.py" "sell2agent/**" "pyproject.toml" "uv.lock"`. Org-owned repos need Hobby. Our personal repo is fine on Free.
- **Env vars** ([docs](https://docs.manufact.com/dashboard/environment-variables)): dashboard tab (paste a `.env`), or `mcp-use servers env add KEY=VALUE --server <id> --env production --sensitive`. Saving does **not** restart: redeploy or `mcp-use deployments restart`. Manufact injects `MCP_URL` and `CSP_URLS`.
- **Logs:** dashboard Runtime logs (stdout/stderr of the running deployment). `mcp-use deployments list`, then `mcp-use deployments logs <id> --follow` (`--build` for build logs). API: `GET /api/v1/servers/{id}/logs?type=runtime`.
- **Domains** ([docs](https://docs.manufact.com/dashboard/domains)): edit the slug on the Domains tab (it applies on the next production deploy). Custom domain = CNAME to `deploy.mcp-use.com`, SSL automatic.
- **Plans** ([billing](https://docs.manufact.com/dashboard/billing)): Free = 2 projects, 30k req/mo, 7-day retention, no E2E checks, Public Chat, submission pack, or preview deploys. Hobby adds those plus Prevent Scale to Zero. Credits: 1 credit = $0.01; Free returns `402` once its grant runs out.
- **Gotchas:** bind `0.0.0.0`. The SDK auto-enables DNS-rebinding protection when `host` is localhost (the default `127.0.0.1` in `streamable_http_app`), which gives **421 Misdirected Request** behind their proxy. `allowed_hosts=["*"]` doesn't work. `uv sync` installs into `.venv`, so call `.venv/bin/uvicorn` or put it on PATH.

## 3. OAuth and connecting clients

- **Manufact Cloud does not add OAuth to your server.** Its OAuth page covers the *dashboard* logging in to a server that already has OAuth ([docs](https://docs.manufact.com/dashboard/dashboard-oauth)). OAuth providers live in mcp-use **TS** ([auth](https://docs.mcp-use.com/v2/typescript/server/authentication.md)). mcp-use Python has static bearer tokens only.
- **Tonight: no auth.** A storefront should be public like a website. Money is gated by the SPT cap and the human Approve button (stripe.md). Both clients support authless servers.
- **Stretch (Python):** `MCPServer(token_verifier=JwtVerifier(...), auth=AuthSettings(issuer_url=AS, resource_server_url="https://<slug>.run.mcp-use.com/mcp", required_scopes=["checkout"], validate_token_resource=False))`. The SDK then serves `/.well-known/oauth-protected-resource/mcp` and 401s with `resource_metadata`. Write the verifier with `pyjwt[crypto]`'s `PyJWKClient`; there is no JWKS helper in 2.3.0. The authorization server should support CIMD; DCR is deprecated in 2026-07-28. Gate only `pay_deal`, using ChatGPT's mixed mode (per-tool security schemes).
- **Claude** ([help](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), updated ~Oct 2026): Customize → Connectors → **+ Add** → **Add custom connector** → name + URL. Then Authentication: **No sign in**, or **Sign in when needed** + OAuth client **Use Claude's published identity (Recommended)**. Optional fixed **Request headers**. Then **Add**. In chat: **+** → Connectors → toggle it on. Free allows 1 custom connector. Team/Enterprise: Organization settings → Connectors → Add → Custom → Web. Calls come from Anthropic's cloud. There's no edit: remove and re-add.
- **ChatGPT** ([OpenAI guide](https://developers.openai.com/api/docs/guides/custom-mcp-server.md)): web only, at chatgpt.com/plugins → **+** → **Add custom MCP server** → name/description → Connection: Server URL. Authentication: **No authentication** / **OAuth** (CIMD or DCR) / **OAuth or no authentication**. Then **I understand and want to continue** → **Create as a plugin** → install. In chat, type `@` and pick it. After a redeploy, open the app's details page and **Refresh**. Plan eligibility is reported inconsistently, so check our accounts early.

## 4. MCP Apps: the deal card

- **Spec:** stable `2026-01-26` (SEP-1865), extension id `io.modelcontextprotocol/ui` ([spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)). The resource is a `ui://…` URI with `mimeType: "text/html;profile=mcp-app"`. Resource `_meta.ui`: `csp.{connectDomains,resourceDomains,frameDomains}`, `domain`, `prefersBorder`, `permissions`. Tool `_meta.ui`: `resourceUri`, plus `visibility` (default `["model","app"]`; `["app"]` hides a tool from the model, and the host rejects app calls to tools without `"app"`). The flat `_meta["ui/resourceUri"]` is deprecated, but Manufact sets both for older hosts. ChatGPT also reads the alias `openai/outputTemplate` ([OpenAI UI guide](https://developers.openai.com/plugins/build/chatgpt-ui.md)).
- **Data flow:** the host sends `ui/notifications/tool-input` then `ui/notifications/tool-result` (`content`, `structuredContent`, `_meta`). The view calls tools with plain `tools/call`, which the host proxies and may confirm with the user. `ui/message` sends a follow-up, `ui/update-model-context` updates model context, `ui/open-link` opens a URL. **Python is fine:** a widget is one HTML string, not React. Default CSP blocks external scripts, so declare `resourceDomains`.
- Server side (fits `build_server`, since `LoggedServer` forwards `**kwargs`):
  ```python
  from mcp.server.apps import Apps, ResourceCsp
  from mcp_types import CallToolResult, TextContent, ToolAnnotations
  DEAL_UI = "ui://prairie/deal-card.html"
  apps = Apps()

  @apps.tool(resource_uri=DEAL_UI, meta={"ui/resourceUri": DEAL_UI}, title="Review deal",
             annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
  def review_deal(deal_id: str) -> CallToolResult:
      """Show the agreed deal (items, negotiated vs. list price, expiry) as a card the buyer's human can approve and pay."""
      d = fd_registry.deal(deal_id)          # raises ToolError with next-step text if unknown/expired
      card = {"deal_id": d.id, "product": d.description, "addons": d.addons, "total_usd": d.price,
              "list_total_usd": d.list_total, "expires_at": d.expires_at}
      text = f"Deal {d.id}: {d.description} for ${d.price:,} (list ${d.list_total:,}). Pay with pay_deal."
      return CallToolResult(content=[TextContent(type="text", text=text)], structured_content=card)

  apps.add_html_resource(DEAL_UI, DEAL_CARD_HTML, title="Deal card", prefers_border=True,
                         csp=ResourceCsp(resource_domains=["https://unpkg.com"]))
  srv = LoggedServer("prairie_equipment", ..., extensions=[apps])   # pay_deal stays a normal @srv.tool
  ```
- `DEAL_CARD_HTML` (vanilla JS on the official `App` class; `callServerTool` is from ext-apps 2.0.3):
  ```html
  <!doctype html><meta name="color-scheme" content="light dark">
  <div id="card">Loading deal…</div><button id="pay" hidden>Approve &amp; Pay</button><p id="status"></p>
  <script type="module">
    import { App } from "https://unpkg.com/@modelcontextprotocol/ext-apps@2.0.3/app-with-deps";
    const app = new App({ name: "Prairie deal card", version: "1.0.0" });
    const $ = (id) => document.getElementById(id);   // not bare ids: window.status is a built-in
    let deal;
    app.ontoolresult = ({ structuredContent: d }) => {
      if (!d?.deal_id) return; deal = d;
      const save = d.list_total_usd - d.total_usd;
      $("card").innerHTML = `<h3>${d.product}</h3><ul>${d.addons.map(a => `<li>${a}</li>`).join("")}</ul>
        <s>$${d.list_total_usd.toLocaleString()}</s> <b>$${d.total_usd.toLocaleString()}</b>
        (save $${save.toLocaleString()}) · expires ${d.expires_at}`;
      $("pay").hidden = false;
    };
    $("pay").onclick = async () => {
      $("pay").disabled = true; $("status").textContent = "Paying…";
      const r = await app.callServerTool({ name: "pay_deal", arguments: { deal_id: deal.deal_id } });
      $("status").textContent = r.isError ? r.content?.[0]?.text : `Paid: ${r.structuredContent?.payment_intent ?? "ok"}`;
    };
    await app.connect();
  </script>
  ```
  For a widget-originated `pay_deal` with no `spt`, follow the human path in stripe.md (Checkout Session via `app.openLink`, or a test PI). Use `client_supports_apps(ctx)` from `mcp.server.apps` to tailor the text for non-UI clients. To remove the CDN dependency, inline the ext-apps bundle.

## 5. Session replay and analytics (learning loop)

- **Dashboard:** Sessions (now "interactions": client, goal/outcome Achieved/Failed/Unknown, tool calls, errors, timeline) and Gateway Requests ([docs](https://docs.manufact.com/dashboard/observability)). Payload bodies are stored only with **Capture payloads** on. Retention is Free 7d, Hobby 30d, Startup 365d.
- **REST API** (key from the API Keys page, `mcp_…`, sent as `Authorization: Bearer`; base `https://cloud.manufact.com/api/v1`):
  - `GET /servers/{id}/interactions?timeRange=24h&hasToolCalls=true&limit=200&cursor=…`
  - `GET /servers/{id}/interactions/{interactionId}/events` (replay, oldest first). Fields: `mcp_method`, `mcp_session_id`, `request_payload`, `response_payload`, `tool_call_success`, `error_message`, `duration_ms`, `client_info`, `protocol_version`, `user_intent`, …
  - `GET /servers/{id}/gateway-events?method=tools/call&limit=1000&search=tool:make_offer`
  - `POST /servers/{id}/analytics/sql {"sql": "SELECT …"}`: read-only ClickHouse over `events`, `tool_interactions`, `sessions_daily`, …; 2 concurrent per org.
  - `GET /servers/{id}/feedback` (from the injected `send_feedback` tool); `POST /servers/{id}/goals {"name": "Purchase completed"}`
- **OTLP sink** (Integrations → Add OTLP sink) exports request *metadata* only, no payloads. The Manufact MCP server's analytics tools return aggregates only.
- **Plan:** our `LoggedServer` JSONL stays the source of truth, because only it sees negotiation state and policy rejections. Also write each record to stdout so it survives in runtime logs. Join our records to Manufact events (client identity, latency, intent, feedback) by time and `negotiation_id` in the tool args.

## 6. Inspector, testing, publish checks

- **Inspector:** hosted at inspector.manufact.com, local via `npx @mcp-use/inspector --url <mcp-url>` (port 8080, `--no-open`). The dashboard has Inspector/Chat/Tools tabs. **Public Chat** (Hobby) gives judges a `/chat` page.
- **Publish checklist** ([docs](https://docs.manufact.com/dashboard/publish-checks)): Publish → Checklist → **Run checklist**. Basic is $0.10/run and checks initialization, tool schemas, error handling, and metadata quality, with separate readiness for ChatGPT/Codex and for Claude. E2E is $2/run on Hobby+ and runs the server live in ChatGPT and Claude, widgets included. Autofix needs a GitHub repo.
- **Testing** ([docs](https://docs.manufact.com/dashboard/testing)): suites with a task, rubric, and tool assertions, passing at 70%, $1/run. Clients: Inspector, ChatGPT, Claude, Claude Code, Codex CLI, Pi. CLI clients don't render UI, so test the card in a browser client.
- **Public catalog** (manufact.com/mcp-catalog): score = tool documentation 40%, tool definitions 30%, protocol compatibility 20%, server metadata 10%. Apps take 20% when present. **The report is public**, so run it only once the server is polished.
- **Claude directory:** every tool needs a `title` and `readOnlyHint`/`destructiveHint` (the most common rejection), OAuth if it's an authenticated service, and a stable HTTPS URL ([submission](https://claude.com/docs/connectors/building/submission)). **Submission pack** (Hobby, $5): listing copy, tool justifications, reviewer test cases, screenshots/video.

## 7. The "copy prompt", the skill, and Manufact's MCP server (summarized as data)

- **manufact.com/prompt.md** (same text on the quickstart page) tells a coding agent to: ask what to build (default: MCP Apps template), log in (`npx -y mcp-use@latest login`), install a skill (`npx --yes skills add mcp-use/mcp-use#main --yes --skill mcp-apps-builder -a cursor -a claude-code -a codex`), scaffold (`npx -y create-mcp-use-app@latest <name> --template mcp-apps`), implement, deploy (`npx -y mcp-use@latest deploy --no-github -y` or `deploy -y` after installing their GitHub App), and return the MCP and dashboard URLs. Its step 5 is missing. It contains no email or contact instructions, and none of the pages we read had agent-directed injections. **Don't run it as-is:** it scaffolds a TypeScript project.
- **Skill `mcp-apps-builder`** (TS-only). Useful invariants: every view-bound tool has an `outputSchema` plus matching `structuredContent`, expected failures return `isError` with model-readable text, and state isn't kept in module globals. It also describes "Skills over MCP" (a `skills/` dir shipped by the server, TS).
- **Manufact MCP server** `https://mcp.manufact.com/mcp` (OAuth; 7-day access, 90-day refresh tokens). Tools: `list_servers`, `deploy`, `redeploy`, `get_deployment_runtime_logs`, `get_deployment_build_logs`, `get_server_analytics_*`, … Handy for Claude Code: `claude mcp add --transport http manufact https://mcp.manufact.com/mcp`.

## 8. Hackathon-specific material

No page exists for this October event's Manufact track. manufact.com/hackathon is their **Feb 21, 2026** ChatGPT/MCP Apps hackathon at YC (sponsors: OpenAI, Cloudflare, Puzzle, WorkOS, Anthropic), with no criteria published. Startup credits: manufact.com/startups (<$2M raised). Partner/YC credits appear on the Billing page. No coupon flow is documented, so ask the booth.

## 9. Spec bits that matter

- **2026-07-28** ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)) drops `initialize` and `Mcp-Session-Id`. Cross-call state uses **server-minted handles passed as ordinary tool arguments** (SEP-2567). It adds `server/discover`, `subscriptions/listen`, a required `resultType`, MRTR (`input_required` + `requestState`, for multi-step input *within one call*; `RequestStateSecurity` in 2.3.0), and Tasks as the `io.modelcontextprotocol/tasks` extension. 2.3.0 has Tasks types but no server helper (grep). Claude's 2026-07-28 rollout is still in progress; 2.3.0 serves both protocol versions on one `/mcp` route. mcp-use Python (1.x SDK) is legacy-only. Manufact's analytics already group by "interaction" rather than session.
- **Negotiation ID:** `neg_` + `secrets.token_urlsafe(16)` (≥128 bits). It's minted by the first `request_quote`/`make_offer`/`negotiate` and required afterward. Lengthen `offer_id`/`deal_id` to the same entropy (`off_`+14 chars is ~83 bits). Look them up in a process-wide `dict[str, FrontDoor]` with TTL and LRU cap, bound to the token subject once auth exists. Unknown or expired ids return text telling the agent to start a new quote.
- **Server cards** (SEP-2127, Final): out-of-band metadata (name, version, description, remotes/transport URLs, supported protocol versions; no tools). The recommended location is `<streamable-http-url>/server-card`, linkable from `/.well-known/ai-catalog.json`. 2.3.0 has no helper (python-sdk#2951 is experimental), so serve static JSON via `custom_route`.

## What the judges likely look for

1. **Agent-first design:** few tools, precise descriptions, typed inputs and outputs, errors that tell the agent the next move. This is the track text, and the catalog weights docs and definitions at 70%. E1 gives us numbers for it: completion rate and tool errors.
2. **Live on Manufact Cloud, working in Claude *and* ChatGPT**, as their stage pitch asked. Show it with Testing runs per client.
3. **An MCP App.** It's their core product, and both the catalog and E2E checks reward it.
4. **Publish-readiness:** a green checklist, annotations, and a submission pack, since the prize includes a path into the Claude and ChatGPT directories.
5. **Use of their platform beyond hosting:** sessions feeding our learning loop, feedback tool, goals. Possibly the mcp-use framework itself (ask).

## Hackathon resources found

- [Manufact docs index](https://docs.manufact.com/llms.txt) · [Quickstart](https://docs.manufact.com/dashboard/quickstart) · [Cloud API spec](https://cloud.manufact.com/openapi.json) · [Python deploy guide, 2026-05-10](https://manufact.com/blog/mcp-app-with-mcp-python-sdk) · [Seven-framework field report, 2026-05-10](https://manufact.com/blog/deploying-seven-mcp-frameworks)
- [mcp-use repo](https://github.com/mcp-use/mcp-use) · [mcp-use Python docs](https://docs.mcp-use.com/python/server/index.md) · [manufacts example repos](https://github.com/manufacts) (`manufact-for-mcp-python`, `mcp-oauth-workos-template`, …)
- [ext-apps spec 2026-01-26](https://github.com/modelcontextprotocol/ext-apps) (Python example: `examples/qr-server/server.py`) · [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) · [SEP-2127 server cards](https://modelcontextprotocol.io/seps/2127-mcp-server-cards.md)
- [Feb 2026 Manufact hackathon page](https://manufact.com/hackathon) · [MCP catalog/scorer](https://manufact.com/mcp-catalog) · [Inspector](https://inspector.manufact.com)

## Questions to ask Manufact at their booth

1. Does an official-SDK Python server on Manufact Cloud score as well as an mcp-use framework server? Would a thin mcp-use TS front proxying our Python server help?
2. How are the hackathon credits redeemed? Can participants get Hobby features tonight (E2E checks, Public Chat, submission pack, Prevent Scale to Zero)?
3. What's the gateway request timeout? Seller LLM turns take 10–30 s. Does the gateway pass 2026-07-28 single-exchange requests and SSE keepalives?
4. Instance model: one replica or several? Is disk persistent? How long until Free scales to zero? (Our negotiation state lives in memory.)
5. Does a `--no-github` upload respect `.gitignore`, and what's the size limit? Is `uv` in the Python image for custom build commands, and how is the base image picked?
6. Can the gateway front OAuth for a server that doesn't implement it?
7. Any bulk export of sessions with payloads beyond `/interactions/{id}/events`? Is there a payload size cap?
8. What exactly do E2E checks verify for MCP Apps? Do Claude and ChatGPT honor `visibility: ["app"]`?
9. How does the winner get into the Claude connector directory and ChatGPT plugin directory?

## Risks

- **mcp-use framework vs. official SDK** (Q1). Fallback: keep the Python core and add a small mcp-use TS server only if the judges say it matters.
- **Hosted model access:** the untested `ANTHROPIC_API_KEY` path, and Opus latency inside client tool timeouts.
- **In-memory state:** lost on scale-to-zero or restart, and wrong with more than one replica (Q4).

## Unverified

- Manufact's Python version selection beyond the `python:3.12` deploy-link default. Whether `uv` is present when the build command is overridden.
- `--no-github` handling of `.venv`/`.gitignore`. Gateway timeouts, replica count, disk persistence.
- `visibility: ["app"]` behavior in Claude and ChatGPT. Whether ChatGPT and Claude render `ui://` widgets for *custom* (unpublished) connectors on our plans (both document interactive UI generally).
- ChatGPT plan eligibility for custom MCP servers and write actions (third-party reports conflict).
- The exact check list behind Manufact's publish checklist. Their docs name only the categories.
- Whether mcp-use TS supports 2026-07-28, and CIMD support in WorkOS/Auth0 for the OAuth stretch.
- Whether our `LoggedServer.call_tool` override wraps `Apps` tools the same way as normal tools. It should, since it overrides the server-level `call_tool`, but test it.
