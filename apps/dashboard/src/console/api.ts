/**
 * Merchant console HTTP API, mounted on the dashboard's Vite dev server (vite.config.ts). SERVER-SIDE ONLY.
 *
 *   GET  /api/console/policies            → { store, policies: ConsolePolicy[] }
 *   PUT  /api/console/policies/:id        → { ok, policy } | { ok: false, problems }
 *   POST /api/console/try/:id             → one scripted buyer asks for every lever against E1's real exchange,
 *                                           built on the console's catalog: shows the next negotiation uses the edit.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Exchange, MemorySink } from "@sa/seller-mcp/exchange";
import { LEVER_CATALOG, type ConsolePolicy } from "./policy";
import { consoleCatalog, type PolicyStore } from "./store";

export interface TryResult {
  product_id: string;
  levers: { id: string; label: string; enabled: boolean; offered: boolean; reason: string }[];
  opening_offer_cents: number | null;
  best_offer_cents: number | null;
  floor_price_cents: number;
}

/** Run one scripted negotiation per lever, plus a plain one, on a fresh in-process exchange. No events leave it. */
export async function tryPolicy(store: PolicyStore, product_id: string): Promise<TryResult | null> {
  const policy = await store.get(product_id);
  if (!policy) return null;
  const ex = new Exchange({ catalog: consoleCatalog(store), llm: null, sink: new MemorySink().sink });
  const ctx = (i: number) => ({ run_id: "s2-console-try", buyer_id: `b_console_${product_id}_${i}`, buyer_model: "scripted" });
  const ask = Math.round(policy.list_price_cents * 0.9);

  const levers: TryResult["levers"] = [];
  for (const [i, l] of LEVER_CATALOG.entries()) {
    const r: any = await ex.handle({ kind: "offer", ctx: ctx(i), product_id, offer_price_cents: ask, levers: [l.id] } as any);
    const got: string[] = r.standing_offer?.levers ?? [];
    const enabled = policy.levers.find((x) => x.id === l.id)?.enabled ?? false;
    levers.push({ id: l.id, label: l.label, enabled, offered: !!r.ok && got.includes(l.id), reason: r.ok ? (got.includes(l.id) ? "Seller included it in the offer." : "Seller answered with price only.")
        : r.error?.code === "bad_lever" && !enabled ? "Off in your menu, so the exchange refused it." : r.error?.message ?? r.message });
  }

  // A plain negotiation, low-balling every round, to show the opening and the best price the seller reaches.
  const c = ctx(99);
  let r: any = await ex.handle({ kind: "offer", ctx: c, product_id, offer_price_cents: Math.round(policy.list_price_cents * 0.5) } as any);
  const opening = r.standing_offer?.price_cents ?? null;
  let best = opening;
  for (let round = 0; round < 8 && r.ok && r.negotiation_id && !r.standing_offer?.final; round++) {
    r = await ex.handle({ kind: "offer", ctx: c, product_id, negotiation_id: r.negotiation_id, offer_price_cents: Math.round(policy.list_price_cents * 0.5) } as any);
    if (r.standing_offer?.price_cents != null) best = Math.min(best ?? Infinity, r.standing_offer.price_cents);
  }
  return { product_id, levers, opening_offer_cents: opening, best_offer_cents: best, floor_price_cents: policy.floor_price_cents };
}

const MAX_BODY = 64 * 1024;
async function body(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) throw new Error("body too large"); }
  return raw ? JSON.parse(raw) : null;
}
function send(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
}

/** Connect-style middleware. Calls next() for anything outside /api/console. */
export function consoleApi(store: PolicyStore) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/api/console/")) return next();
    try {
      const [, , , what, id] = url.pathname.split("/"); // "", api, console, what, id
      if (req.method === "GET" && what === "policies" && !id) return send(res, 200, { store: store.kind, policies: await store.list() });
      if (req.method === "PUT" && what === "policies" && id) {
        const edit = (await body(req)) as ConsolePolicy | null;
        if (!edit || edit.product_id !== decodeURIComponent(id)) return send(res, 400, { ok: false, problems: [{ field: "product_id", message: "Body product_id must match the URL." }] });
        const r = await store.save(edit);
        return send(res, r.ok ? 200 : 422, r);
      }
      if (req.method === "POST" && what === "try" && id) {
        const r = await tryPolicy(store, decodeURIComponent(id));
        return r ? send(res, 200, r) : send(res, 404, { error: `Unknown product ${id}` });
      }
      return send(res, 404, { error: "Not found" });
    } catch (e) {
      return send(res, 500, { error: (e as Error).message });
    }
  };
}
