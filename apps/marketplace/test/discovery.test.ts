import { test } from "node:test";
import assert from "node:assert/strict";
import { namespaceFor, openRpc, serverCard, ucpProfile } from "../src/discovery";

const URL = "https://dark-zero-mesv5.run.mcp-use.com/mcp";
const tools = [{ name: "search_products", title: "Search products", description: "d", inputSchema: { type: "object" } }];

test("namespace is the deployed host, reversed", () => {
  assert.equal(namespaceFor(URL), "com.mcp-use.run.dark-zero-mesv5");
});

test("UCP profile has the required registries and an mcp transport at the gateway", () => {
  const p = ucpProfile(URL);
  assert.match(p.ucp.version, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(p.ucp.payment_handlers, {}); // required even when empty
  const [svc] = Object.values(p.ucp.services);
  assert.equal(svc[0].transport, "mcp");
  assert.equal(svc[0].endpoint, URL);
  assert.ok(!svc[0].endpoint.endsWith("/"));
  assert.match(svc[0].schema, /^https:\/\/.*\/openrpc\.json$/);
  const [neg] = Object.values(p.ucp.capabilities);
  assert.equal(neg[0].config.negotiable, true);
});

test("server card lists the remote and the tools", () => {
  const c = serverCard(URL, tools);
  assert.deepEqual(c.remotes, [{ type: "streamable-http", url: URL }]);
  assert.deepEqual(c.capabilities.tools.map((t) => t.name), ["search_products"]);
});

test("OpenRPC has one method per tool", () => {
  const o = openRpc(URL, tools);
  assert.equal(o.methods[0].name, "search_products");
  assert.deepEqual(o.methods[0].params[0].schema, { type: "object" });
});

test("no private fields in any discovery file", () => {
  const json = JSON.stringify([ucpProfile(URL), serverCard(URL, tools), openRpc(URL, tools)]);
  for (const k of ["floor_price_cents", "unit_cost_cents", "cost_cents", "objective"]) assert.ok(!json.includes(k), k);
});
