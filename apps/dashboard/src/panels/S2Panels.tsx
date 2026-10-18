/**
 * S2 data panels for the proof dashboard: run picker, buyer fit, which levers win.
 * Owned by the S2 data session; the design session places them in App.tsx and may restyle them.
 * They use only class names and tokens that exist in both the current and the redesigned styles.css.
 */
import type { PolicyKpis } from "../metrics/kpis";
import { leverWinsByPersona } from "../metrics/kpis";
import type { RunInfo } from "../data/runs";
import { BarCompare } from "../ui/BarCompare";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const muted = { opacity: 0.65 } as const;

/** Pick which runs to compare. Default = latest run of each policy. */
export function RunPicker({ runs, selected, onChange, isDefault }: { runs: RunInfo[]; selected: string[]; onChange: (ids: string[] | null) => void; isDefault: boolean }) {
  if (runs.length <= 1) return null;
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <details className="panel">
      <summary className="panel-head" style={{ cursor: "pointer" }}>
        <span className="eyebrow">Comparing {selected.length} run{selected.length === 1 ? "" : "s"}{isDefault ? " · latest per policy" : ""}</span>
      </summary>
      <div className="scroll">
        <table className="pgrid">
          <thead><tr><th></th><th>Run</th><th>Policy</th><th>Buyers</th><th>Started</th></tr></thead>
          <tbody>
            {runs.slice(0, 30).map((r) => (
              <tr key={r.run_id}>
                <td><input id={`run-${r.run_id}`} type="checkbox" checked={selected.includes(r.run_id)} onChange={() => toggle(r.run_id)} aria-label={`Compare ${r.run_id}`} /></td>
                <td><label htmlFor={`run-${r.run_id}`} className="num">{r.run_id}</label></td>
                <td>{r.policy}</td>
                <td className="num">{r.buyers}</td>
                <td className="num" style={muted}>{r.started ? new Date(r.started).toLocaleTimeString("en-US", { hour12: false }) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!isDefault && <button type="button" onClick={() => onChange(null)} style={{ marginTop: 8, font: "inherit", cursor: "pointer" }}>Back to latest per policy</button>}
    </details>
  );
}

/** Buyer fit per policy, with intervals: shows negotiation serves buyers, not just squeezes them. */
export function BuyerFit({ kpis }: { kpis: PolicyKpis[] }) {
  const any = kpis.some((k) => k.avg_buyer_fit != null);
  return (
    <div className="panel kpi">
      <h3>Buyer fit</h3>
      <p className="sub" style={muted}>How much of what each buyer values the deal delivered</p>
      {any ? (
        <BarCompare compact height={26} format={pct} max={1} bars={kpis.map((k) => ({ policy: k.policy, value: k.avg_buyer_fit, ci: k.ci.buyer_fit }))} />
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
            <thead><tr><th>Buyer type</th>{kpis.map((k) => <th key={k.policy}>{k.policy}</th>)}</tr></thead>
            <tbody>
              {personas.map((p) => (
                <tr key={p}>
                  <td>{p.replace(/_/g, " ")}</td>
                  {kpis.map((k) => {
                    const cell = wins.filter((w) => w.persona === p && w.policy === k.policy);
                    return <td key={k.policy}>{cell.length ? cell.map((w) => <div key={w.package} className="num">{w.package} <span style={muted}>{pct(w.share)} · {w.deals}</span></div>) : <span style={muted}>no deals</span>}</td>;
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
