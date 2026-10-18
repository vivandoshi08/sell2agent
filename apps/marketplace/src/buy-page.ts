// The web door to the seller's agent: a plain HTML page per listing, for buyers (people or AI agents) who can browse but
// can't add an MCP connector. Same exchange behind it as the MCP tools (E2's decide() + voice(), E1's guardrails, the
// same floor), same events, same approve page. No scripts, no install steps: every action is a GET form, so an agent
// that can only fetch URLs can still ask, offer and accept. Nothing is charged here; payment is at the approve link or at pickup.
//
//   GET /buy/:product_id                          listing + forms
//   GET /buy/:product_id?do=ask&q=…               answer from catalog facts only (E2 answerQuestion)
//   GET /buy/:product_id?do=offer&price=32&note=… seller's reply (counter or accept)
//   GET /buy/:product_id?do=accept&o=<offer_id>   locks the deal for 30 min, shows the approve link
//   GET /k2                                       short alias (BUY_ALIASES="k2=kb_keychron_k2_real,…")
// The buyer id (b) and negotiation id (n) ride in the links, so fetch-only agents without cookies keep their negotiation.
import { randomUUID } from "node:crypto";
import type { ExchangeResponse } from "@sa/seller-mcp/exchange";
import { answerQuestion, defaultLlm, usd } from "@sa/seller-mcp/sellers";
import { getListing } from "./search.js";
import { catalog } from "./catalog-source.js";
import { exchange, approveLink, expiryText } from "./negotiate.js";
import { log } from "./log.js";

type Q = Record<string, string | undefined>;
type Out = { status: number; headers: Record<string, string>; body: string };
type Listing = NonNullable<ReturnType<typeof getListing>>;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const BUYER_RE = /^anon_[0-9a-f-]{36}$/; // web buyers only get gateway-minted ids; never accept someone else's oai_/run ids
const ID_RE = /^[\w-]{1,80}$/;

export function aliases(env = process.env.BUY_ALIASES ?? "k2=kb_keychron_k2_real"): Record<string, string> {
  return Object.fromEntries(env.split(",").map((p) => p.split("=").map((s) => s.trim())).filter(([a, b]) => a && b && ID_RE.test(a) && ID_RE.test(b)));
}

/** Dollars typed by a person or agent ("32", "$32.50") → integer cents, or null. */
export function toCents(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.replace(/[$,\s]/g, "").match(/^(\d{1,6})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const c = Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, "0")) : 0);
  return c > 0 ? c : null;
}

function specLine(l: Listing): string {
  return Object.entries(l.specs ?? {}).filter(([k]) => !["make", "model", "pickup"].includes(k))
    .map(([k, v]) => (typeof v === "boolean" ? (v ? k.replace(/_/g, " ") : `no ${k.replace(/_/g, " ")}`) : `${k.replace(/_/g, " ")}: ${v}`)).join(" · ");
}

function page(l: Listing, state: { b: string; n?: string; reply?: string; answer?: string; error?: string; accept?: { offer_id: string; price: number }; deal?: { summary: string; approve?: string; expires?: string } }): string {
  const self = `/buy/${encodeURIComponent(l.id)}`;
  const hidden = `<input type="hidden" name="b" value="${esc(state.b)}">${state.n ? `<input type="hidden" name="n" value="${esc(state.n)}">` : ""}`;
  const pickup = typeof l.specs?.pickup === "string" ? ` · Pickup: ${esc(l.specs.pickup)}` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(l.title)} · ${esc(usd(l.list_price_cents))}, negotiable</title>
<meta name="description" content="${esc(l.title)}. ${esc(usd(l.list_price_cents))}, price negotiable. Ask a question or make an offer on this page.">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;color:#1b1f1d;background:#fff}
h1{font-size:22px;margin:0 0 4px}.muted{color:#5b6460}.box{border:1px solid #d6dbd8;border-radius:8px;padding:12px 14px;margin:14px 0}
.reply{background:#eef6f1;border-color:#9ccfb3}.err{background:#fbefe9;border-color:#e2b29a}label{display:block;margin:6px 0 2px;font-weight:600}
input[type=text]{width:100%;box-sizing:border-box;padding:7px;font:inherit}button,a.btn{display:inline-block;margin-top:8px;padding:7px 14px;font:inherit;border:1px solid #1b6b47;background:#1b6b47;color:#fff;border-radius:6px;text-decoration:none;cursor:pointer}</style>
</head><body>
<h1>${esc(l.title)}</h1>
<p><strong>${esc(usd(l.list_price_cents))}</strong>, price negotiable · ${l.in_stock ? "in stock" : "sold"}${pickup}</p>
<p class="muted">${esc(specLine(l))}</p>
<p>${esc(l.description)}</p>
<p class="muted">How this page works: ask a question or type an offer in US dollars. The seller's assistant replies right here. You can accept its price with one click. Accepting holds the price for 30 minutes and charges nothing; you pay at pickup, or at the card link shown after you accept.</p>
${state.error ? `<div class="box err" role="alert">${esc(state.error)}</div>` : ""}
${state.answer ? `<div class="box reply" role="status"><strong>Answer:</strong> ${esc(state.answer)}</div>` : ""}
${state.reply ? `<div class="box reply" role="status"><strong>Seller:</strong> ${esc(state.reply)}${state.accept ? `<br><a class="btn" href="${self}?do=accept&amp;b=${encodeURIComponent(state.b)}&amp;n=${encodeURIComponent(state.n ?? "")}&amp;o=${encodeURIComponent(state.accept.offer_id)}">Accept ${esc(usd(state.accept.price))}</a>` : ""}</div>` : ""}
${state.deal ? `<div class="box reply" role="status"><strong>${esc(state.deal.summary)}</strong>${state.deal.expires ? `<br>Held until ${esc(state.deal.expires)}.` : ""}<br>Pay at pickup (cash or card)${state.deal.approve ? `, or approve and pay by card now: <a href="${esc(state.deal.approve)}">${esc(state.deal.approve)}</a>` : "."}</div>` : ""}
${state.deal || !l.in_stock ? "" : `<form class="box" method="get" action="${self}"><input type="hidden" name="do" value="offer">${hidden}
<label for="price">${state.n ? "Counter-offer" : "Make an offer"} (US dollars)</label><input type="text" id="price" name="price" inputmode="decimal" placeholder="e.g. 32">
<label for="note">Note to the seller (optional)</label><input type="text" id="note" name="note" maxlength="500">
<button type="submit">Send offer</button></form>`}
<form class="box" method="get" action="${self}"><input type="hidden" name="do" value="ask">${hidden}
<label for="q">Ask a question about this item</label><input type="text" id="q" name="q" maxlength="500" placeholder="e.g. Does it work with a Mac?">
<button type="submit">Ask</button></form>
<p class="muted">AI assistants that use MCP can reach the same seller at /mcp (product id: ${esc(l.id)}).</p>
</body></html>`;
}

const html = (status: number, body: string): Out => ({ status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" }, body });

/** Handles one page view or action. Exported for tests (pass a fake exchange / listing lookup). */
export async function buyPage(product_id: string, q: Q, deps: {
  listing?: (id: string) => Promise<Listing | null>;
  ex?: () => Promise<{ handle: (m: any) => Promise<ExchangeResponse> }>;
  ask?: (l: Listing, question: string) => Promise<{ answer: string; grounded: boolean }>;
  approve?: (deal_id: string, buyer_id: string) => string | undefined;
  now?: () => number;
  mcpUrl?: string;
} = {}): Promise<Out> {
  const find = deps.listing ?? (async (id: string) => getListing(id, deps.mcpUrl ?? "http://localhost/mcp", await catalog()));
  const l = ID_RE.test(product_id) ? await find(product_id) : null;
  if (!l) return html(404, `<!doctype html><title>Not found</title><p>No listing ${esc(product_id)}.</p>`);
  const b = q.b && BUYER_RE.test(q.b) ? q.b : `anon_${randomUUID()}`;
  const n = q.n && ID_RE.test(q.n) ? q.n : undefined;
  const ctx = { run_id: "live", buyer_id: b, buyer_model: "web", channel: "web" as const };
  const ex = deps.ex ?? exchange;

  if (q.do === "ask" && q.q?.trim()) {
    const question = q.q.trim().slice(0, 500);
    const base = { run_id: "live", buyer_id: b, buyer_model: "web", seller_id: l.seller_id, product_id: l.id, negotiation_id: n ?? null, price_cents: null };
    await log({ ...base, actor: "buyer", type: "question_asked", payload: { question, channel: "web" } });
    const r = deps.ask ? await deps.ask(l, question) : await answerQuestion({ product_id: l.id, title: l.title, description: l.description,
      specs: l.specs, list_price_cents: l.list_price_cents, shipping_days: l.shipping_days }, question, defaultLlm());
    await log({ ...base, actor: "seller", type: "question_answered", payload: { question, grounded: r.grounded, channel: "web" } });
    return html(200, page(l, { b, n, answer: r.answer }));
  }

  if (q.do === "offer") {
    const cents = toCents(q.price);
    if (!cents) return html(400, page(l, { b, n, error: "Type your offer as a dollar amount, for example 32." }));
    const r = await (await ex()).handle({ kind: "offer", ctx, product_id: l.id, negotiation_id: n, offer_price_cents: cents, message: q.note?.slice(0, 500) || undefined });
    if (!r.ok && !r.negotiation_id) return html(400, page(l, { b, n, error: r.error?.message ?? r.message ?? "The seller couldn't take that offer." }));
    const nid = r.negotiation_id ?? n;
    if (r.deal) return html(200, page(l, { b, n: nid, reply: r.message, deal: dealView(r, b, deps) }));
    const o = r.standing_offer;
    const canAccept = !!o && r.allowed_actions.includes("accept");
    return html(200, page(l, { b, n: nid, reply: [r.message, r.summary].filter(Boolean).join(" "), accept: canAccept ? { offer_id: o!.offer_id, price: o!.price_cents } : undefined }));
  }

  if (q.do === "accept" && n && q.o && ID_RE.test(q.o)) {
    const r = await (await ex()).handle({ kind: "accept", ctx, negotiation_id: n, offer_id: q.o });
    if (!r.deal) return html(400, page(l, { b, n, error: r.error?.message ?? r.message ?? "That offer can't be accepted any more. Make a new offer." }));
    return html(200, page(l, { b, n, deal: dealView(r, b, deps) }));
  }

  return html(200, page(l, { b, n }));
}

function dealView(r: ExchangeResponse, b: string, deps: { approve?: (d: string, b: string) => string | undefined; now?: () => number }) {
  const d = r.deal!;
  return { summary: r.summary ?? `Deal locked: ${d.title}, ${usd(d.total_cents)}.`, approve: (deps.approve ?? approveLink)(d.deal_id, b),
    expires: d.expires_at ? expiryText(d.expires_at, deps.now?.()) : undefined };
}

// biome-ignore lint: server type comes from mcp-use
export function registerBuyPage(server: any, mcpUrl: string) {
  const send = (o: Out) => new Response(o.body, { status: o.status, headers: o.headers });
  const query = (url: string): Q => Object.fromEntries(new URL(url).searchParams.entries());
  const serve = async (id: string, url: string) => {
    try {
      return send(await buyPage(id, query(url), { mcpUrl }));
    } catch (e) {
      console.error("[buy page]", (e as Error).message);
      return send(html(500, `<!doctype html><title>Try again</title><p>Something went wrong on our side. Please try again in a moment.</p>`));
    }
  };
  server.get("/buy/:product_id", (c: any) => serve(c.req.param("product_id"), c.req.url));
  for (const [alias, id] of Object.entries(aliases())) server.get(`/${alias}`, (c: any) => serve(id, c.req.url));
}
