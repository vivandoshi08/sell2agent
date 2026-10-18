/**
 * My store (/store?seller=<id>): one human seller's view of what their agent sold, and the controls only they hold.
 * Connect payouts (Stripe-hosted onboarding), see each sale's split (total → our fee → their share), and confirm a
 * local pickup with the buyer's code, which is when the held card is actually charged. Floors and extras stay on /console.
 */
import { useCallback, useEffect, useState } from "react";
import type { SellerPayment } from "@sa/payments";
import type { StoreView } from "./api";
import { TopBar } from "../ui/TopBar";
import "../console/console.css";
import "./store.css";

const usd = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const sellerId = () => new URLSearchParams(location.search).get("seller") ?? "s_potrero";
const STATE_LABEL: Record<SellerPayment["state"], string> = { held: "held · awaiting pickup", paid: "paid", released: "released", other: "pending" };

async function post(path: string, data: unknown = {}) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, ...j } as { ok: boolean; url?: string; reason?: string; error?: string; seller_cents?: number };
}

export function Store() {
  const id = sellerId();
  const api = `/api/store/${encodeURIComponent(id)}`;
  const [view, setView] = useState<StoreView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch(api);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setView(j); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, [api]);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  async function go(action: "connect" | "payouts") {
    setBusy(action);
    const r = await post(`${api}/${action}`);
    if (r.url) location.assign(r.url);
    else { setBusy(null); setErr(r.error ?? r.reason ?? "Stripe didn't return a link."); }
  }

  async function settle(p: SellerPayment, action: "capture" | "release") {
    setBusy(p.payment_intent_id);
    const r = await post(`${api}/${action}`, { payment_intent_id: p.payment_intent_id, code: codes[p.payment_intent_id] ?? "" });
    setMsg((m) => ({ ...m, [p.payment_intent_id]: r.ok ? (action === "capture" ? `Charged. ${usd(r.seller_cents ?? 0)} is on its way to you.` : "Hold released. The buyer wasn't charged.") : r.reason ?? r.error ?? "Didn't work." }));
    setBusy(null);
    load();
  }

  const acct = view?.account;
  const fee = view ? view.fee_bps / 100 : 5;
  const held = view?.payments.filter((p) => p.state === "held") ?? [];
  const title = (p: SellerPayment) => {
    const pid = (p.description ?? "").split(" × ")[0];
    return view?.listings.find((l) => l.id === pid)?.title ?? (pid || p.deal_id || p.payment_intent_id);
  };
  const earned = view?.payments.filter((p) => p.state === "paid").reduce((s, p) => s + p.seller_cents, 0) ?? 0;

  return (
    <div className="shell">
      <TopBar tab="store" />
      <main className="app console store">
        <div className="panel-head st-title">
          <div><span className="eyebrow">My store</span><h1>{view?.seller.name ?? id}</h1></div>
          <p className="cx-note">Your seller agent negotiates with buyers' agents inside the floor you set. Money only moves through Stripe.</p>
        </div>
        {err && <p className="err" role="alert">{err}</p>}
        {view?.stripe_error && <p className="err">Stripe: {view.stripe_error}</p>}

        <div className="cx-two">
          <section className="panel">
            <div className="panel-head"><h2>Payouts</h2><span className="eyebrow">Stripe Connect · test mode</span></div>
            {!view ? <p className="cx-note">Loading…</p>
              : !acct ? (<>
                  <p>Connect a Stripe account so buyers' payments reach you. Stripe checks your identity; we never see your bank details.</p>
                  <button type="button" className="cx-primary" disabled={busy === "connect"} onClick={() => go("connect")}>{busy === "connect" ? "Opening Stripe…" : "Connect payouts with Stripe"}</button>
                </>)
              : !acct.ready ? (<>
                  <p><span className="pill bad">setup unfinished</span> Stripe still needs: {acct.currently_due.length ? acct.currently_due.map((f) => f.replace(/_/g, " ")).join(", ") : "a moment to verify"}.</p>
                  <button type="button" className="cx-primary" disabled={busy === "connect"} onClick={() => go("connect")}>{busy === "connect" ? "Opening Stripe…" : "Finish Stripe setup"}</button>
                </>)
              : (<>
                  <p><span className="pill neg">payouts on</span> Each sale is split by Stripe: you get the total minus our {fee}% fee.</p>
                  <div className="st-stats">
                    <div><span>Earned</span><b className="num">{usd(earned)}</b></div>
                    <div><span>Awaiting pickup</span><b className="num">{held.length}</b></div>
                  </div>
                  <button type="button" disabled={busy === "payouts"} onClick={() => go("payouts")}>{busy === "payouts" ? "Opening…" : "Open Stripe payouts"}</button>
                  <small className="cx-note st-acct">{acct.id}</small>
                </>)}
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Listings</h2><a href={`console${location.search}`}>Edit floor & extras →</a></div>
            {view && view.listings.length === 0 && <p className="cx-note">No listings yet.</p>}
            <ul className="st-list">
              {view?.listings.map((l) => (
                <li key={l.id}><b>{l.title}</b>
                  <span className="num">list {usd(l.list_price_cents)} · your floor {l.floor_price_cents == null ? "—" : usd(l.floor_price_cents)}</span></li>
              ))}
            </ul>
            <p className="cx-note">Buyers' agents never see your floor. The agent can't sell below it: that's enforced in code, not in a prompt.</p>
          </section>
        </div>

        <section className="panel">
          <div className="panel-head"><h2>Sales</h2><span className="eyebrow">newest first</span></div>
          {view && view.payments.length === 0 && <p className="cx-note">No sales yet. When a buyer's agent closes a deal, it shows up here.</p>}
          {view && view.payments.length > 0 && (
            <div className="table-wrap"><table className="st-sales">
              <thead><tr><th>Item</th><th className="num">Total</th><th className="num">Our fee</th><th className="num">You get</th><th>Status</th><th>Pickup</th></tr></thead>
              <tbody>
                {view.payments.map((p) => (
                  <tr key={p.payment_intent_id}>
                    <td>{title(p)}<small>{new Date(p.created * 1000).toLocaleString()}</small></td>
                    <td className="num">{usd(p.amount_cents)}</td>
                    <td className="num">{usd(p.fee_cents)}</td>
                    <td className="num"><b>{usd(p.seller_cents)}</b></td>
                    <td><span className={`pill ${p.state === "paid" ? "neg" : p.state === "held" ? "" : "bad"}`}>{STATE_LABEL[p.state]}</span></td>
                    <td>
                      {p.state === "held" ? (
                        <form className="st-pickup" onSubmit={(e) => { e.preventDefault(); settle(p, "capture"); }}>
                          <input inputMode="numeric" maxLength={6} placeholder="buyer's code" aria-label="Buyer's pickup code"
                            value={codes[p.payment_intent_id] ?? ""} onChange={(e) => setCodes((c) => ({ ...c, [p.payment_intent_id]: e.target.value }))} />
                          <button type="submit" className="cx-primary" disabled={busy === p.payment_intent_id || (codes[p.payment_intent_id] ?? "").length < 6}>Confirm pickup</button>
                          <button type="button" disabled={busy === p.payment_intent_id} onClick={() => settle(p, "release")}>No-show</button>
                        </form>
                      ) : <span className="cx-note">—</span>}
                      {msg[p.payment_intent_id] && <div className="cx-note" role="status">{msg[p.payment_intent_id]}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          <p className="cx-note">Card holds last up to 4 days. The buyer's card is charged only when you confirm pickup with their 6-digit code.</p>
        </section>
      </main>
    </div>
  );
}
