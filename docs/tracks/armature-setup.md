# Armature: environment setup

Companion to the [archived Armature plan](../archive/tracks/armature-guide.md) (steps 6–7). This is the "how do I run it" half.

## One-time, per machine

```bash
pnpm install                      # Node workspace
uv sync --extra analytics         # Python harness + Armature SDK
cp .env.example .env              # then paste the shared keys
uv run --extra analytics python scripts/armature_check.py   # doctor
```

`armature_check.py` prints what's installed, which keys are set, and refuses a
live (non `sk_test_`) Stripe key.

## The key

`ANALYTICS_INGEST_API_KEY` is the Armature **ingest** key from the dashboard
(free workspace, 1,000 credits/month, no card). A human has to create the
workspace — it is step 6 in armature.md. Paste it into `.env`.
`ANALYTICS_INGEST_URL` stays blank for a US workspace; EU workspaces set it to
`https://eu.armature.tech/api/mcp-analytics/ingest`.

**With no key set, everything still runs** — both helpers below no-op and send
nothing. Nobody is blocked on the signup.

## Python servers (experiments, `sales_agent/`)

```python
from sales_agent.analytics import instrument

srv = LoggedServer("prairie_equipment")
inst = instrument(srv)             # BEFORE any @srv.tool()
```

`sales_agent/analytics.py` also carries `load_env()` (reads `/.env`, no dotenv
dependency), `is_configured()`, and `await flush(inst)` for shutdown.
Options pass straight through: `instrument(srv, delivery="await", request_capability=False)`.

## Node seller MCP (`apps/seller-mcp`)

```ts
import { buildAnalyticsServer, flushAnalytics } from "./analytics.js";

const server = buildAnalyticsServer(() => {
  const mcp = new McpServer({ name: "seller-mcp", version: "0.1.0" });
  registerTools(mcp);              // tools registered INSIDE the factory
  return mcp;
});
```

`pnpm dev:seller` now loads `/.env` via Node's `--env-file-if-exists`. The other
apps can get the same by adding `--env-file-if-exists=../../.env` to their `dev`
script.

## What instrumenting changes about the tool surface

Verified locally against `mcp` 2.3.0, SDK 0.1.42:

- every tool's input schema gains a `telemetry` property
- `request_capability` (on by default) adds one extra tool to `tools/list`

Both change what the buyer agent sees, so **use the same setting for every arm of
a comparison**. E1/E2/E3 baselines were measured uninstrumented; if we quote
before/after numbers against them, re-run the baseline instrumented, or set
`request_capability=False` / `requestCapability: false` and note it.

## Versions pinned

| Piece | Version |
|---|---|
| `armature-mcp-analytics[mcp]` (Python) | 0.1.42 |
| `@armature-tech/mcp-analytics` (Node) | 0.6.47 |
| `mcp` (Python, 2.x → `MCPServer`) | 2.3.0 |
| `@modelcontextprotocol/sdk` (Node, v1 path) | 1.32.1 |
