/**
 * S2-owned. Hosted approve page for buyer agents that can't show our MCP App deal card (text-only agents like
 * Instinct, or any client without MCP Apps). accept_deal returns `approve_url`; the agent sends that link to its
 * person; the person opens it, sees the same DealCardView, and taps Approve & Pay.
 *
 *   GET  /deal/:deal_id?t=<token>       → the deal card as a self-contained HTML page (no external loads)
 *   POST /deal/:deal_id/pay?t=<token>   → PayResult JSON; the amount always comes from the stored deal
 *
 * The token is an HMAC over (deal_id, buyer_id) with EXCHANGE_HMAC_SECRET, and carries the buyer_id, so paying
 * through the link passes E1's buyer check exactly like pay_deal does. A link only ever opens its own deal.
 *
 * Gateway wiring (S1, 3 lines): in deal-tools.ts `export const deal = …`, then in index.ts
 *   registerApprovePage(server, deal, { origin: new URL(MCP_URL).origin });
 * and in accept_deal's response: `approve_url: approveUrl(origin, deal.deal_id, buyer_id)`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { DealCardView, type PayState } from "../../views/deal-card/DealCardView";
import type { DealCard, PayResult } from "./types";

type DealModule = {
  reviewDeal(deal_id: string): Promise<DealCard>;
  payApprovedDeal(deal_id: string, credential?: undefined, ctx?: { buyer?: { buyer_id: string; run_id?: string; buyer_model?: string }; run_id?: string }): Promise<PayResult>;
};

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const secret = () => {
  const s = process.env.EXCHANGE_HMAC_SECRET;
  if (!s) throw new Error("EXCHANGE_HMAC_SECRET is required for approve links");
  return s;
};
const mac = (deal_id: string, buyer_id: string, key: string) =>
  createHmac("sha256", key).update(`approve\u0000${deal_id}\u0000${buyer_id}`).digest().subarray(0, 18);

/** `<base64url buyer_id>.<base64url mac>`: opens one deal, for the buyer who accepted it. */
export function approveToken(deal_id: string, buyer_id: string, key = secret()): string {
  return `${b64u(buyer_id)}.${b64u(mac(deal_id, buyer_id, key))}`;
}

/** The buyer_id inside a valid token for this deal, or null (tampered, wrong deal, malformed). */
export function verifyApproveToken(deal_id: string, token: string | undefined | null, key = secret()): string | null {
  if (!token) return null;
  const [who, sig] = token.split(".");
  if (!who || !sig) return null;
  let buyer_id: string;
  try { buyer_id = Buffer.from(who, "base64url").toString("utf8"); } catch { return null; }
  if (!buyer_id) return null;
  const want = mac(deal_id, buyer_id, key), got = Buffer.from(sig, "base64url");
  return got.length === want.length && timingSafeEqual(got, want) ? buyer_id : null;
}

export function approveUrl(origin: string, deal_id: string, buyer_id: string, key = secret()): string {
  return `${origin.replace(/\/$/, "")}/deal/${encodeURIComponent(deal_id)}?t=${approveToken(deal_id, buyer_id, key)}`;
}

export interface HttpOut { status: number; headers: Record<string, string>; body: string }
const html = (status: number, body: string): HttpOut => ({ status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" }, body });
const json = (status: number, body: unknown): HttpOut => ({ status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });
/** JSON for an inline <script>: escapes <, >, & and U+2028/U+2029 so a value can never close the tag or break the line. */
export const scriptJson = (v: unknown) =>
  JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** What the page shows after a pay attempt redirected back (?r=<status>&m=<message>). */
function payStateFrom(card: DealCard, r?: string | null, m?: string | null): PayState {
  if (card.status === "paid" || r === "succeeded") return { kind: "succeeded" };
  if (r === "processing") return { kind: "processing" };
  if (r === "declined") return { kind: "declined", message: m ?? undefined };
  if (r === "refused") return { kind: "refused", reasons: m ? [m] : [] };
  if (r === "error") return { kind: "error", message: m ?? undefined };
  return { kind: "idle" };
}

const page = (title: string, inner: string, script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}html,body{margin:0}body{min-height:100vh;display:grid;place-items:start center;padding:24px 16px;box-sizing:border-box;font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f4f2;color:#141414}
@media (prefers-color-scheme:dark){body{background:#121212;color:#eee}}.wrap{width:100%;max-width:440px}.note{font-size:12.5px;opacity:.65;margin:14px 2px 0}</style>
</head><body><main class="wrap">${inner}<p class="note">Secure approval link for this one deal. Payments run in Stripe test mode.</p></main>${script}</body></html>`;

// Tiny progressive enhancement: the card's button posts to /pay, then reloads with the outcome. No framework.
const SCRIPT = (payPath: string) => `<script>
(function(){var b=document.querySelector(".dc-btn");if(!b)return;b.addEventListener("click",function(){
if(b.disabled)return;b.disabled=true;b.setAttribute("aria-busy","true");var t=b.textContent;b.textContent="Paying…";
// Always send a JSON body: the gateway's body parser 400s ("Invalid JSON") on an empty body with a JSON content-type.
fetch(${scriptJson(payPath)},{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(function(r){return r.text().then(function(x){
var j;try{j=JSON.parse(x)}catch(e){j={status:"error",message:"The payment server replied "+r.status+(x?": "+x.slice(0,120):"")+". Nothing was charged."}}return j;})}).then(function(j){
var u=new URL(location.href);u.searchParams.set("r",j.status==="refused"&&j.already_paid?"succeeded":(j.status||"error"));
var m=(j.reasons&&j.reasons[0])||j.message||"";if(m)u.searchParams.set("m",m);else u.searchParams.delete("m");location.replace(u.toString());
}).catch(function(){b.disabled=false;b.removeAttribute("aria-busy");b.textContent="Couldn't reach the payment server: nothing was charged. Tap to try again.";});});})();
</script>`;

/** GET /deal/:deal_id?t= */
export async function approvePage(mod: DealModule, deal_id: string, q: { t?: string | null; r?: string | null; m?: string | null }, key?: string): Promise<HttpOut> {
  const buyer = verifyApproveToken(deal_id, q.t, key);
  if (!buyer) return html(403, page("Link not valid", `<h1>This approval link isn't valid.</h1><p>Ask your assistant for a fresh link to this deal.</p>`));
  let card: DealCard;
  try { card = await mod.reviewDeal(deal_id); }
  catch { return html(404, page("Deal not found", `<h1>We couldn't find this deal.</h1><p>It may have expired. Ask your assistant to make a new offer.</p>`)); }
  const pay = payStateFrom(card, q.r, q.m);
  const theme = "light" as const; // the page CSS follows the OS theme; the card's own palette handles light
  const markup = renderToStaticMarkup(<DealCardView card={card} pay={pay} theme={theme} onApprove={() => {}} />);
  const payPath = `/deal/${encodeURIComponent(deal_id)}/pay?t=${encodeURIComponent(q.t!)}`;
  return html(200, page(`Approve: ${card.product.title}`, markup, card.status === "ready" && pay.kind === "idle" ? SCRIPT(payPath) : ""));
}

/** POST /deal/:deal_id/pay?t= */
export async function approvePay(mod: DealModule, deal_id: string, t: string | null | undefined, key?: string): Promise<HttpOut> {
  const buyer_id = verifyApproveToken(deal_id, t, key);
  if (!buyer_id) return json(403, { status: "refused", reasons: ["This approval link isn't valid for this deal."] });
  try {
    const r = await mod.payApprovedDeal(deal_id, undefined, { buyer: { buyer_id } });
    return json(200, r);
  } catch (e) {
    return json(500, { status: "error", message: (e as Error).message });
  }
}

/** Mount both routes on the mcp-use (Hono-style) server. `deal` returns the gateway's own deal module instance. */
// biome-ignore lint: server type comes from mcp-use
export function registerApprovePage(server: any, deal: () => Promise<DealModule> | DealModule, opts: { key?: string } = {}) {
  const send = (c: any, o: HttpOut) => new Response(o.body, { status: o.status, headers: o.headers });
  server.get("/deal/:deal_id", async (c: any) => {
    const u = new URL(c.req.url);
    return send(c, await approvePage(await deal(), c.req.param("deal_id"), { t: u.searchParams.get("t"), r: u.searchParams.get("r"), m: u.searchParams.get("m") }, opts.key));
  });
  server.post("/deal/:deal_id/pay", async (c: any) => {
    const u = new URL(c.req.url);
    return send(c, await approvePay(await deal(), c.req.param("deal_id"), u.searchParams.get("t"), opts.key));
  });
}
