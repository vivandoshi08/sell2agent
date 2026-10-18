/**
 * Merchant console page (/console). The store owner sets what each product's seller agent may offer:
 * lever menu (on/off + what it costs them), floor, policy, objective weights. "Test with one buyer" runs a
 * scripted buyer through E1's real exchange with the saved settings, to show the next negotiation uses them.
 * Owned by the S2 data session; uses the shared tokens and classes plus console.css.
 */
import { useEffect, useMemo, useState } from "react";
import type { ConsolePolicy, Objective, Problem } from "./policy";
import { CONSOLE_POLICIES, validate } from "./policy";
import type { TryResult } from "./api";
import { LearningCurve } from "../panels/LearningCurve";
import "./console.css";

const usd = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const toCents = (s: string) => Math.round(Number(s) * 100);
const OBJECTIVES: { key: keyof Objective; label: string }[] = [
  { key: "margin", label: "Margin" }, { key: "conversion", label: "Conversion" }, { key: "clear_stock", label: "Clear stock" },
  { key: "repeat_customers", label: "Repeat customers" }, { key: "premium_image", label: "Premium image" },
];
const POLICY_HELP: Record<string, string> = {
  static: "List price only. The baseline.",
  negotiating: "Concedes gradually toward the floor over the rounds.",
  balanced: "Concedes less, holds margin longer.",
};

export function Console() {
  const [policies, setPolicies] = useState<ConsolePolicy[] | null>(null);
  const [store, setStore] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sel, setSel] = useState<string>("");
  const [draft, setDraft] = useState<ConsolePolicy | null>(null);
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "saved" | "error"; msg?: string; problems?: Problem[] }>({ kind: "idle" });
  const [trial, setTrial] = useState<TryResult | null>(null);
  const [trying, setTrying] = useState(false);

  useEffect(() => {
    fetch("/api/console/policies").then((r) => r.json()).then((d) => {
      setPolicies(d.policies); setStore(d.store); setNotice(d.notice ?? null);
      const first = new URLSearchParams(location.search).get("product") ?? d.policies[0]?.product_id ?? "";
      setSel(first);
    }).catch((e) => setStatus({ kind: "error", msg: `Couldn't load policies: ${e.message}. The console needs the dashboard dev server (pnpm --filter @sa/dashboard dev).` }));
  }, []);

  const saved = useMemo(() => policies?.find((p) => p.product_id === sel) ?? null, [policies, sel]);
  // Reset the editor when the merchant picks another product (not when a save updates this one).
  useEffect(() => { if (saved) { setDraft(structuredClone(saved)); setTrial(null); setStatus({ kind: "idle" }); } }, [sel, policies === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const problems = useMemo(() => (draft ? validate(draft) : []), [draft]);
  const dirty = !!draft && !!saved && JSON.stringify({ ...draft, updated_at: 0 }) !== JSON.stringify({ ...saved, updated_at: 0 });
  const edit = (f: (d: ConsolePolicy) => ConsolePolicy) => setDraft((d) => (d ? f(structuredClone(d)) : d));

  const save = async () => {
    if (!draft) return;
    setStatus({ kind: "saving" });
    const r = await fetch(`/api/console/policies/${encodeURIComponent(draft.product_id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
    if (r.ok) { setPolicies((ps) => ps!.map((p) => (p.product_id === r.policy.product_id ? r.policy : p))); setDraft(structuredClone(r.policy)); setStatus({ kind: "saved" }); setTrial(null); }
    else setStatus({ kind: "error", msg: r.error ?? "Not saved.", problems: r.problems });
  };
  const test = async () => {
    if (!draft) return;
    setTrying(true);
    const r = await fetch(`/api/console/try/${encodeURIComponent(draft.product_id)}`, { method: "POST" }).then((x) => x.json()).catch(() => null);
    setTrial(r); setTrying(false);
  };

  return (
    <main className="app console">
      <header className="top">
        <div>
          <span className="eyebrow">Seller agents · merchant console</span>
          <h1>What your seller agent may offer</h1>
        </div>
        <div className="badges">
          {store && <span className={`badge ${store === "supabase" ? "live" : "sample"}`}>{store === "supabase" ? "Saved to Supabase" : "Not saved to a database (dev memory)"}</span>}
          <a className="badge" href="./">Proof dashboard →</a>
        </div>
      </header>

      {notice && <p className="cx-notice">{notice}</p>}
      {status.kind === "error" && <p className="err">{status.msg}</p>}
      {!policies ? <p className="empty">Loading products…</p> : (
        <div className="cx-layout">
          <nav className="panel cx-products" aria-label="Products">
            <span className="eyebrow">Products</span>
            <ul>
              {policies.map((p) => (
                <li key={p.product_id}>
                  <button type="button" aria-current={p.product_id === sel} onClick={() => setSel(p.product_id)}>
                    <b>{p.title}</b>
                    <span className="num">{usd(p.list_price_cents)} list · floor {usd(p.floor_price_cents)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {draft && (
            <section className="cx-editor">
              <div className="panel">
                <div className="panel-head"><h2>Price limits</h2><span className="eyebrow">enforced in code</span></div>
                <div className="cx-facts num">
                  <div><span>List price</span><b>{usd(draft.list_price_cents)}</b></div>
                  <div><span>Unit cost</span><b>{usd(draft.unit_cost_cents)}</b></div>
                  <label><span>Floor (never sells below)</span>
                    <input type="number" step="1" min={draft.unit_cost_cents / 100} max={draft.list_price_cents / 100} value={draft.floor_price_cents / 100}
                      onChange={(e) => edit((d) => ({ ...d, floor_price_cents: toCents(e.target.value) }))} aria-invalid={problems.some((p) => p.field === "floor_price_cents")} />
                  </label>
                </div>
                <FloorBar p={draft} />
              </div>

              <div className="panel">
                <div className="panel-head"><h2>Lever menu</h2><span className="eyebrow">extras the agent may add instead of cutting price</span></div>
                <div className="scroll"><table className="pgrid cx-levers">
                  <thead><tr><th>Offer it</th><th>Lever</th><th>Serves buyers who value</th><th>Costs you</th><th>Lowest price with it</th></tr></thead>
                  <tbody>
                    {draft.levers.map((l, i) => {
                      const bad = problems.find((p) => p.field === `lever:${l.id}`);
                      return (
                        <tr key={l.id} className={l.enabled ? "" : "off"}>
                          <td><input id={`lv-${l.id}`} type="checkbox" checked={l.enabled} onChange={(e) => edit((d) => { d.levers[i].enabled = e.target.checked; return d; })} /></td>
                          <td><label htmlFor={`lv-${l.id}`}>{l.label}</label></td>
                          <td>{l.lever}</td>
                          <td><span className="cx-money"><span>$</span><input type="number" min={0} step="1" value={l.cost_cents / 100} aria-label={`${l.label} cost`} aria-invalid={!!bad}
                            onChange={(e) => edit((d) => { d.levers[i].cost_cents = toCents(e.target.value); return d; })} /></span></td>
                          <td className="num">{l.enabled ? usd(draft.floor_price_cents + l.cost_cents) : "—"}{bad && <div className="cx-bad">{bad.message}</div>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table></div>
                <p className="cx-note">The exchange refuses any lever that's off, and never prices a package below floor + the cost of its extras.</p>
              </div>

              <div className="cx-two">
                <div className="panel">
                  <div className="panel-head"><h2>Policy</h2></div>
                  <div className="cx-radios">
                    {CONSOLE_POLICIES.map((p) => (
                      <label key={p}><input type="radio" name="policy" checked={draft.policy === p} onChange={() => edit((d) => ({ ...d, policy: p }))} />
                        <span><b>{p}</b><small>{POLICY_HELP[p]}</small></span></label>
                    ))}
                  </div>
                </div>
                <div className="panel">
                  <div className="panel-head"><h2>Objective</h2><span className="eyebrow">weights 0–1</span></div>
                  {OBJECTIVES.map((o) => (
                    <label key={o.key} className="cx-slider"><span>{o.label}</span>
                      <input type="range" min={0} max={1} step={0.05} value={draft.objective[o.key] ?? 0} onChange={(e) => edit((d) => ({ ...d, objective: { ...d.objective, [o.key]: Number(e.target.value) } }))} />
                      <b className="num">{(draft.objective[o.key] ?? 0).toFixed(2)}</b></label>
                  ))}
                  <p className="cx-note">Saved to the contract's objective field. Today's policies don't read it yet; E2's learned policy will.</p>
                </div>
              </div>

              <div className="cx-actions">
                <button type="button" className="cx-primary" disabled={!dirty || problems.length > 0 || status.kind === "saving"} onClick={save}>
                  {status.kind === "saving" ? "Saving…" : "Save"}</button>
                <button type="button" disabled={!dirty} onClick={() => saved && setDraft(structuredClone(saved))}>Discard changes</button>
                <button type="button" disabled={dirty || trying} onClick={test} title={dirty ? "Save first: the test uses saved settings" : ""}>{trying ? "Testing…" : "Test with one buyer"}</button>
                <span className="cx-status" role="status">
                  {problems.length > 0 ? `${problems.length} thing${problems.length > 1 ? "s" : ""} to fix before saving` : status.kind === "saved" ? "Saved. The next negotiation uses it." : dirty ? "Unsaved changes" : ""}
                </span>
              </div>
              {problems.filter((p) => !p.field.startsWith("lever:")).map((p) => <p key={p.field + p.message} className="err">{p.message}</p>)}

              {trial && <TrialResult r={trial} />}
            </section>
          )}
        </div>
      )}
      <LearningCurve />
    </main>
  );
}

/** Where the floor sits between unit cost and list: the room the agent can negotiate in. */
function FloorBar({ p }: { p: ConsolePolicy }) {
  const x = (c: number) => `${Math.max(0, Math.min(100, (c / p.list_price_cents) * 100))}%`;
  return (
    <div className="cx-floorbar" aria-hidden="true">
      <i className="cost" style={{ width: x(p.unit_cost_cents) }} />
      <i className="room" style={{ left: x(p.floor_price_cents), width: `calc(100% - ${x(p.floor_price_cents)})` }} />
      <span style={{ left: x(p.floor_price_cents) }} className="num">floor</span>
      <small>cost · margin you protect · <b>room to negotiate</b></small>
    </div>
  );
}

function TrialResult({ r }: { r: TryResult }) {
  return (
    <div className="panel cx-trial">
      <div className="panel-head"><h2>Test buyer, against the real exchange</h2><span className="eyebrow">scripted · nothing logged</span></div>
      <ul>
        {r.levers.map((l) => (
          <li key={l.id}><span className={`pill ${l.offered ? "neg" : l.enabled ? "bad" : ""}`}>{l.offered ? "offered" : "refused"}</span>
            <b>{l.label}</b> <small>{l.reason}</small></li>
        ))}
      </ul>
      <p className="num">Opening offer {r.opening_offer_cents == null ? "—" : usd(r.opening_offer_cents)} · best after a hard low-ball {r.best_offer_cents == null ? "—" : usd(r.best_offer_cents)} · floor {usd(r.floor_price_cents)}</p>
    </div>
  );
}
