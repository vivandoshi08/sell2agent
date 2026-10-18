/** Connect to the remote Stripe MCP (what @stripe/mcp 0.3.3 proxies to) and dump tool names + input schemas. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { testKey } from "./env";

export async function connect(): Promise<Client> {
  const client = new Client({ name: "sa-spike", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL("https://mcp.stripe.com"), {
    requestInit: { headers: { Authorization: `Bearer ${testKey()}` } },
  });
  await client.connect(transport);
  return client;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = await connect();
  const { tools } = await c.listTools();
  for (const t of tools) console.log(`- ${t.name}: ${JSON.stringify(t.inputSchema?.properties ?? {}).slice(0, 300)}`);
  await c.close();
}
