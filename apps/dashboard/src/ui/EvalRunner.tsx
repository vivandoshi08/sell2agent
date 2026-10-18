/** The command to run a new eval, plus the latest saved run's manifest (public/runs/latest.json), or else the eval the
 *  dashboard is comparing from Supabase. No launch button. */
import { useEffect, useState } from "react";

const CMD = "pnpm --filter @sa/dashboard eval --n 100 --models claude --seller-voice";
interface Manifest { eval_id?: string; buyers?: number; models?: string[]; policies?: string[] }

export function EvalRunner({ current = null }: { current?: Manifest | null }) {
  const [saved, setSaved] = useState<Manifest | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const embedded = (globalThis as { __SA_EVAL__?: { eval_id: string } }).__SA_EVAL__;
    fetch("./runs/latest.json").then((r) => (r.ok ? r.json() : Promise.reject())).then(setSaved)
      .catch(() => setSaved(embedded ? { eval_id: embedded.eval_id } : {}));
  }, []);
  // No saved run on this machine: describe the eval the page is showing (live mode), if it's one eval.
  const m = saved && !saved.eval_id && current?.eval_id ? current : saved;
  const copy = () => { navigator.clipboard?.writeText(CMD).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); };
  return (
    <section className="card eval-runner">
      <div className="card-h"><h2>Eval runner</h2><span>same buyers per policy, judged, 95% intervals</span></div>
      <div className="cmd"><code>{CMD}</code><button type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button></div>
      {m === null ? <p className="empty">Looking for the latest saved run…</p> : m.eval_id ? (
        <dl className="eval-meta">
          <div><dt>{m === current ? "Comparing" : "Latest run"}</dt><dd className="num">{m.eval_id}</dd></div>
          {m.buyers != null && <div><dt>Buyers</dt><dd className="num">{m.buyers}</dd></div>}
          {m.models?.length ? <div><dt>Models</dt><dd>{m.models.join(", ")}</dd></div> : null}
          {m.policies?.length ? <div><dt>Policies</dt><dd>{m.policies.join(", ")}</dd></div> : null}
        </dl>
      ) : <p className="empty">No saved run yet. Run the command, then open the dashboard with <code>?local</code>.</p>}
    </section>
  );
}
