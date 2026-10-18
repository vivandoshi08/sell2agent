// Discovery files (FINAL_ARCHITECTURE §1 "Signposts"): how an agent finds this gateway from its domain.
//   /.well-known/ucp                    UCP business profile listing the MCP transport (+ a "negotiable" capability)
//   /.well-known/mcp/server-card.json   MCP server card (SEP-2127; path still in flux, so also at /mcp/server-card)
//   /openrpc.json                       OpenRPC description of the tools (UCP requires a schema for an mcp transport)
// Tool lists are read from the server's own tools/list, so these files can't drift from what's deployed.
// No A2A agent card yet: it needs a real A2A endpoint, which arrives with the Inkbox door (Bridge 3).

const UCP_VERSION = "2026-01-11";
const SPEC_URL = "https://ucp.dev/latest/specification/overview/";
const CACHE = { "Cache-Control": "public, max-age=300" }; // UCP: public, max-age ≥ 60, no redirects

type ToolInfo = { name: string; title?: string; description?: string; inputSchema?: unknown; outputSchema?: unknown };

/** Reverse-DNS namespace from the deployed host, e.g. dark-zero-mesv5.run.mcp-use.com → com.mcp-use.run.dark-zero-mesv5 */
export function namespaceFor(mcpUrl: string): string {
  return new URL(mcpUrl).hostname.split(".").reverse().join(".");
}

export function ucpProfile(mcpUrl: string) {
  const origin = new URL(mcpUrl).origin;
  const ns = namespaceFor(mcpUrl);
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        [`${ns}.marketplace`]: [
          { version: UCP_VERSION, spec: SPEC_URL, transport: "mcp", endpoint: mcpUrl.replace(/\/$/, ""), schema: `${origin}/openrpc.json` },
        ],
      },
      capabilities: {
        // No standard field says "this seller negotiates" (docs/research/discovery.md); this is our proposal.
        [`${ns}.negotiation`]: [
          {
            version: UCP_VERSION,
            spec: SPEC_URL,
            schema: `${origin}/openrpc.json`,
            config: {
              negotiable: true,
              tools: { search: "search_products", offer: "make_offer", accept: "accept_deal", review: "review_deal", pay: "pay_deal" },
              payment: "stripe_test_mode",
            },
          },
        ],
      },
      payment_handlers: {}, // payment runs inside the MCP flow (pay_deal), not through a UCP handler
    },
  };
}

export function serverCard(mcpUrl: string, tools: ToolInfo[]) {
  return {
    name: `${namespaceFor(mcpUrl)}/marketplace`,
    title: "sell2agent",
    description: "Compare products from competing sellers and negotiate price and extras with each seller's agent.",
    version: "0.0.1",
    remotes: [{ type: "streamable-http", url: mcpUrl }],
    capabilities: { tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description })) },
  };
}

export function openRpc(mcpUrl: string, tools: ToolInfo[]) {
  return {
    openrpc: "1.3.2",
    info: { title: "sell2agent (MCP tools)", version: "0.0.1" },
    servers: [{ name: "mcp", url: mcpUrl }],
    methods: tools.map((t) => ({
      name: t.name,
      summary: t.title ?? t.name,
      description: t.description,
      paramStructure: "by-name",
      params: [{ name: "arguments", required: true, schema: t.inputSchema ?? { type: "object" } }],
      result: { name: "structuredContent", schema: t.outputSchema ?? { type: "object" } },
    })),
  };
}

/**
 * The server's own tools/list, via its in-process fetch (no network hop). Sent to the host the caller used, so
 * mcp-use's Host validation (on when bound to localhost) accepts it. Throws rather than publishing an empty list.
 */
export async function listTools(server: { fetch: (r: Request) => Promise<Response> }, requestUrl: string): Promise<ToolInfo[]> {
  const res = await server.fetch(
    new Request(new URL("/mcp", requestUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  const body = await res.text();
  const line = body.split("\n").find((l) => l.startsWith("data: "));
  const tools = res.ok ? JSON.parse(line ? line.slice(6) : body).result?.tools : undefined;
  if (!Array.isArray(tools) || !tools.length) throw new Error(`tools/list failed (HTTP ${res.status})`);
  return tools;
}

// biome-ignore lint: server type comes from mcp-use
export function registerDiscovery(server: any, mcpUrl: string) {
  const json = (c: any, body: unknown) => c.json(body, 200, CACHE);
  server.get("/.well-known/ucp", (c: any) => json(c, ucpProfile(mcpUrl)));
  const withTools = (build: (tools: ToolInfo[]) => unknown) => async (c: any) => {
    try {
      return json(c, build(await listTools(server, c.req.url)));
    } catch (e) {
      console.error("[discovery]", e);
      return c.json({ error: "tool list unavailable" }, 503);
    }
  };
  const card = withTools((tools) => serverCard(mcpUrl, tools));
  server.get("/.well-known/mcp/server-card.json", card);
  server.get("/mcp/server-card", card);
  server.get("/openrpc.json", withTools((tools) => openRpc(mcpUrl, tools)));
}
