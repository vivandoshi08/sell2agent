/**
 * SPIKE: A2A (Google Agent2Agent / Linux Foundation) JSON-RPC endpoint for the seller.
 *   GET  /.well-known/agent-card.json   agent card (also /.well-known/agent.json, legacy path)
 *   POST /                              JSON-RPC 2.0: "message/send" (A2A v0.3) or "SendMessage" (A2A v1.0)
 * A message may carry a DataPart {skill, args} (structured) and/or TextPart (free text). Reply = one agent Message
 * with a TextPart (readable) + DataPart (the raw ExchangeResponse). No SDK: node:http only.
 * No auth (spike). The buyer is identified by contextId only (A2A has no buyer identity of its own).
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { SellerAgent, toText, type SkillCall } from "./agent";
import type { ExchangeResponse } from "@sa/seller-mcp/exchange";

const SKILLS: { id: SkillCall["skill"]; description: string }[] = [
  { id: "search_products", description: "args {query}. Public listings." },
  { id: "get_listing", description: "args {product_id}. Price, specs, negotiable." },
  { id: "make_offer", description: "args {product_id, offer_price_cents, message?}. Seller counters, accepts or rejects. Integer cents." },
  { id: "accept_deal", description: "args {} (or {offer_id}). Accept the seller's standing offer; locks a deal." },
  { id: "walk_away", description: "args {reason?}." },
  { id: "check_offers", description: "args {}. Current state of this conversation's negotiation." },
];

export function agentCard(url: string) {
  return {
    protocolVersion: "0.3.0",
    name: "Sales Agent seller",
    description: "Seller agent. Ask about a listing, make an offer in cents, accept a deal. Send a DataPart {skill, args} or plain text like 'kb_clackco_tkl, can you do $90?'.",
    url,
    preferredTransport: "JSONRPC",
    supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    version: "0.0.1-spike",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: SKILLS.map((s) => ({ id: s.id, name: s.id, description: s.description, tags: ["commerce", "negotiation"] })),
  };
}

type Part = { kind?: string; text?: string; data?: unknown };
interface A2AMessage { messageId?: string; contextId?: string; role?: string; parts?: Part[] }

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function startA2AServer(agent: SellerAgent, port = 0): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const host = `http://${req.headers.host}`;
      const send = (code: number, j: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      if (req.method === "GET" && (req.url === "/.well-known/agent-card.json" || req.url === "/.well-known/agent.json")) return send(200, agentCard(`${host}/`));
      if (req.method !== "POST") return send(404, { error: "not found" });
      let rpc: { id?: unknown; method?: string; params?: { message?: A2AMessage } };
      try { rpc = JSON.parse(await body(req)); } catch { return send(200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
      const v1 = rpc.method === "SendMessage";
      if (rpc.method !== "message/send" && !v1) return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `method not found: ${rpc.method}` } });
      const m = rpc.params?.message;
      if (!m?.parts?.length) return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "params.message.parts required" } });
      const contextId = m.contextId ?? randomUUID();
      const data = m.parts.find((p) => p.data && typeof p.data === "object")?.data as SkillCall | undefined;
      const text = m.parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("\n");
      let reply: string, out: unknown;
      try {
        if (data?.skill) { out = await agent.call(contextId, data); reply = (out as ExchangeResponse).message !== undefined && "ok" in (out as object) ? toText(out as ExchangeResponse) : JSON.stringify(out); }
        else ({ reply, data: out } = await agent.text(contextId, text));
      } catch (e) {
        return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message: String(e) } });
      }
      const parts = v1 ? [{ text: reply }, ...(out ? [{ data: out }] : [])] : [{ kind: "text", text: reply }, ...(out ? [{ kind: "data", data: out }] : [])];
      const msg = { ...(v1 ? {} : { kind: "message" }), messageId: randomUUID(), contextId, role: v1 ? "ROLE_AGENT" : "agent", parts };
      send(200, { jsonrpc: "2.0", id: rpc.id, result: v1 ? { message: msg } : msg });
    });
    server.listen(port, () => {
      const a = server.address();
      resolve({ server, url: `http://localhost:${typeof a === "object" && a ? a.port : port}/` });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startA2AServer(new SellerAgent(), Number(process.env.PORT ?? 3005)).then(({ url }) => console.log(`A2A seller on ${url}  card: ${url}.well-known/agent-card.json`));
}
