/**
 * S2 data panels for the proof dashboard: run picker, buyer fit, which levers win.
 * Owned by the S2 data session; the design session places them in App.tsx and may restyle them.
 * They use only class names and tokens that exist in both the current and the redesigned styles.css.
 */
import type { PolicyKpis } from "../metrics/kpis";
import { leverWinsByPersona, type LiveTraffic } from "../metrics/kpis";
import type { RunInfo } from "../data/runs";
import { BarCompare } from "../ui/BarCompare";
import { clock, leverLabel, personaLabel, policyLabel } from "../ui/labels";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const muted = { opacity: 0.65 } as const;

/** Pick which runs to compare. Default = the latest complete eval (both policies), see defaultSelection. */
export function RunPicker({ runs, selected, onChange, isDefault }: { runs: RunInfo[]; selected: string[]; onChange: (ids: string[] | null) => void; isDefault: boolean }) {
  if (runs.length <= 1) return null;
  const evalIds = [...new Set(runs.filter((r) => selected.includes(r.run_id)).map((r) => r.eval_id))];
  const which = evalIds.length === 1 && evalIds[0] ? `eval ${evalIds[0]}` : "latest per policy";
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <details className="panel run-picker">
      <summary>
        <span className="eyebrow">Comparing {selected.length} run{selected.length === 1 ? "" : "s"}{isDefault ? ` · ${which}` : ""}</span>
        <span className="rp-change">Change<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
      </summary>
      <div className="scroll">
        <table className="pgrid">
          <thead><tr><th></th><th>Run</th><th>Policy</th><th>Buyers</th><th>Started</th></tr></thead>
          <tbody>
            {runs.slice(0, 30).map((r) => (
              <tr key={r.run_id}>
                <td><input id={`run-${r.run_id}`} type="checkbox" checked={selected.includes(r.run_id)} onChange={() => toggle(r.run_id)} aria-label={`Compare ${r.run_id}`} /></td>
                <td><label htmlFor={`run-${r.run_id}`} className="num">{r.run_id}</label></td>
                <td>{policyLabel(r.policy)}</td>
                <td className="num">{r.buyers}{r.planned != null && r.planned !== r.buyers ? <span style={muted}> / {r.planned}</span> : null}</td>
                <td className="num" style={muted}>{clock(r.started)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!isDefault && <button type="button" className="rp-reset" onClick={() => onChange(null)}>Back to the default</button>}
    </details>
  );
}

/** Filter every panel to one buyer model (Claude vs GPT vs ChatGPT users). Hidden when there's only one. */
export function ModelFilter({ models, model, onChange }: { models: string[]; model: string | null; onChange: (m: string | null) => void }) {
  if (models.length <= 1) return null;
  return (
    <label className="badge" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <span>Buyer model</span>
      <select value={model ?? ""} onChange={(e) => onChange(e.target.value || null)} style={{ font: "inherit", background: "transparent", color: "inherit", border: 0 }}>
        <option value="">all</option>
        {models.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    </label>
  );
}

/** Buyer fit per policy, with intervals: shows negotiation serves buyers, not just squeezes them. */
export function BuyerFit({ kpis }: { kpis: PolicyKpis[] }) {
  const any = kpis.some((k) => k.avg_buyer_fit != null);
  return (
    <div className="panel kpi">
      <div className="card-h"><h2>Buyer fit</h2><span>how much of what each buyer values the deal delivered</span></div>
      {any ? (
        <BarCompare compact format={pct} max={1} bars={kpis.map((k) => ({ policy: k.policy, value: k.avg_buyer_fit, ci: k.ci.buyer_fit }))} />
      ) : (
        <p className="empty">Needs buyers with a lever profile. Simulated buyers send one; live ChatGPT traffic may not.</p>
      )}
    </div>
  );
}

/** Which lever packages closed deals, by buyer type and policy. */
export function LeverWins({ kpis }: { kpis: PolicyKpis[] }) {
  const wins = leverWinsByPersona(kpis);
  const personas = [...new Set(wins.map((w) => w.persona))].sort();
  const allPriceOnly = wins.length > 0 && wins.every((w) => w.package === "price only");
  return (
    <div className="panel">
      <div className="panel-head"><h2>Which levers win, by buyer type</h2><span className="eyebrow">closed deals</span></div>
      {!wins.length ? <p className="empty">No closed deals in the selected runs yet.</p> : (
        <div className="scroll">
          <table className="pgrid">
            <thead><tr><th>Buyer type</th>{kpis.map((k) => <th key={k.policy}>{policyLabel(k.policy)}</th>)}</tr></thead>
            <tbody>
              {personas.map((p) => (
                <tr key={p}>
                  <td>{personaLabel(p)}</td>
                  {kpis.map((k) => {
                    const cell = wins.filter((w) => w.persona === p && w.policy === k.policy);
                    return <td key={k.policy}>{cell.length ? cell.map((w) => <div key={w.package} className="lw num">{leverLabel(w.package)} <span style={muted}>{pct(w.share)} · {w.deals}</span></div>) : <span style={muted}>no deals</span>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {allPriceOnly && <p className="empty">Every deal so far is price only: the lever policy is still gated off (E2). This fills in once sellers offer warranty, shipping or bundles.</p>}
    </div>
  );
}

const usd = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const RULES: Record<string, string> = {
  concession_cap: "cut too big for one round", price_freeze: "price frozen (probing detected)", buyer_memory_resume: "returning buyer resumed at last offer",
  final_not_final: "\"final\" offer wasn't final", floor: "below floor", out_of_policy_ask: "buyer asked for something not offered",
  input_injection: "prompt injection in a buyer message",
};
// Public titles of the seed catalog (supabase/seed.sql); unknown ids fall back to a readable id.
const TITLES: Record<string, string> = {
  kb_keyforge_quiet75: "KeyForge Quiet 75", kb_clackco_tkl: "ClackCo TKL Pro", kb_typewell_65: "TypeWell 65 Silent",
  hp_keyforge_anc: "KeyForge ANC Over-Ear", hp_clackco_studio: "ClackCo Studio Wired", hp_typewell_buds: "TypeWell ANC Buds",
};
const titleOf = (id: string | null) => TITLES[id ?? ""] ?? (id ?? "").replace(/^(kb|hp)_/, "").split("_").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ");

/** Real buyers on the deployed gateway (e.g. ChatGPT users): what they actually paid, with no eval policy split. */
export function LiveTrafficPanel({ live }: { live: LiveTraffic }) {
  if (!live.negotiations && !live.deals) return null;
  return (
    <div className="panel">
      <div className="panel-head"><h2>Real buyers on the live gateway</h2><span className="eyebrow">{live.models.filter((m) => m !== "unknown").join(", ") || "buyer agents"} · Stripe test mode</span></div>
      <div className="lt-stats num" style={{ display: "flex", gap: 28, flexWrap: "wrap", margin: "8px 0 14px" }}>
        <Stat label="Negotiations" value={String(live.negotiations)} />
        <Stat label="Deals" value={String(live.deals)} />
        <Stat label="Paid" value={`${live.paid}${live.payment_failures ? ` · ${live.payment_failures} failed` : ""}`} />
        <Stat label="Revenue (test)" value={usd(live.revenue_cents)} />
        <Stat label="Avg discount off list" value={live.avg_discount == null ? "—" : pct(live.avg_discount)} />
        <Stat label="Below floor" value={String(live.below_floor)} bad={live.below_floor > 0} />
      </div>
      {live.recent_deals.length > 0 && (
        <div className="scroll">
          <table className="pgrid">
            <thead><tr><th>Time</th><th>Product</th><th>Deal</th><th>List</th><th>Paid</th></tr></thead>
            <tbody>{live.recent_deals.map((d, i) => (
              <tr key={i}>
                <td className="num" style={muted}>{d.ts ? new Date(d.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : ""}</td>
                <td>{d.product_title ?? titleOf(d.product_id)}</td>
                <td className="num">{usd(d.price_cents)}</td>
                <td className="num" style={muted}>{d.list_price_cents == null ? "—" : usd(d.list_price_cents)}</td>
                <td>{d.paid ? <span className="pill neg">paid</span> : <span style={muted}>not yet</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {live.below_floor > 0 && <p className="err">{live.below_floor} deal{live.below_floor > 1 ? "s were" : " was"} flagged below floor by the exchange. Check the deal_accepted events (below_floor: true).</p>}
      {live.blocks.length > 0 && <p className="empty">Guardrails stepped in {live.blocks.reduce((s, b) => s + b.n, 0)} times: {live.blocks.map((b) => `${RULES[b.rule] ?? b.rule} (${b.n})`).join(", ")}.</p>}
    </div>
  );
}

function Stat({ label, value, bad = false }: { label: string; value: string; bad?: boolean }) {
  return <div style={{ display: "grid", gap: 2 }}><span className="eyebrow">{label}</span><b style={{ fontSize: "1.35rem", color: bad ? "var(--bad)" : undefined }}>{value}</b></div>;
}
