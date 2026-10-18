/**
 * "What it learned" (#learned): the seller's learning loop on its own page, in depth.
 *  - findings in plain words, computed from the policy files (never typed in by hand)
 *  - how one negotiation flows: buyer LLM ↔ MCP tools ↔ bandit (code) ↔ price (code) ↔ words (LLM) ↔ reward ↔ retrain
 *  - one real logged negotiation, annotated
 *  - the perk lesson from 2,000 scripted buyers whose perk values are known (docs/results/b4-levers)
 *  - how the policy changed its mind (v1 → v5) and the full learned panel (picks, curve, gate, training table)
 */
import type { NegotiationEvent } from "@sa/shared";
import scripted from "../../../../docs/results/b4-levers/scripted_policy.json";
import example from "../data/learned-example.json";
import { LIVE, LP, LearningCurve, PerkGrid, Training, armName, ctxName, mean, relative, signed, usd, type Learned } from "./LearningCurve";
import { orderContexts } from "../metrics/learned";

const S = scripted as unknown as Learned;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Balanced minus Negotiating per buyer type, from the LLM-trained policy's own stats. */
function concedeFinding(d: Learned) {
  const rows = orderContexts(Object.keys(d.stats)).filter((c) => c !== "unknown").map((c) => {
    const b = mean(d.stats[c]?.balanced), n = mean(d.stats[c]?.negotiating);
    return { c, diff: b != null && n != null ? b - n : null, tries: (d.stats[c]?.balanced?.n ?? 0) + (d.stats[c]?.negotiating?.n ?? 0) };
  }).filter((r) => r.diff != null) as { c: string; diff: number; tries: number }[];
  return { rows, all: rows.every((r) => r.diff > 0), tries: rows.reduce((s, r) => s + r.tries, 0) };
}

/** What leading with each perk did vs Balanced on the same listing, all scripted buyers pooled. */
function perkFinding(d: Learned) {
  const st = d.stats.unknown ?? {};
  const bal = mean(st.balanced);
  return ["pkg:free_shipping", "pkg:extended_warranty", "pkg:bundle_discount"]
    .map((a) => ({ arm: a, v: mean(st[a]), n: st[a]?.n ?? 0 }))
    .filter((x) => x.v != null && bal != null)
    .map((x) => ({ ...x, diff: x.v! - bal! }));
}

// Versions and what moved them: docs/results/b3-learned/README.md (v1–v4) and docs/results/b4-levers/README.md (v5).
const HISTORY = [
  { v: "v1", data: "1,200 scripted sessions", chose: "Balanced for price, delivery, quality; Negotiating for trust", result: "sims only" },
  { v: "v2", data: "795 logged LLM sessions", chose: "Perks first for quality and trust buyers (20 and 10 tries)", result: "Held-out: −$5.11/buyer vs Balanced. The bet on perks lost: quality $30 vs $47, trust $13 vs $25" },
  { v: "v3", data: "2,216 logged LLM sessions", chose: "Balanced for every buyer type (reversed v2's bet)", result: "Held-out: +$6.21/buyer vs Negotiating [$3.55, $8.87]" },
  { v: "v4", data: "v3 + buyers with no stated preference", chose: "Balanced everywhere, including unknown buyers", result: "Gate passed: +$6.25/buyer vs Negotiating; live on production" },
  { v: "v5", data: "4,446 simulated + 24 real negotiations, goal reward, same-listing baseline", chose: "Balanced everywhere; perks re-explored once deployed", result: "Candidate: held-out gate pending" },
];

export function LearnedPage({ events }: { events?: NegotiationEvent[] }) {
  const c = concedeFinding(LP);
  const perks = perkFinding(S);
  const worst = perks.length ? perks.reduce((a, b) => (a.diff < b.diff ? a : b)) : null;
  const contexts = orderContexts(Object.keys(S.choice));
  return (
    <main className="page lpage" id="learned">
      <section className="head">
        <p className="meta">Seller learning loop · policy v{LP.version}{LP !== LIVE ? ` (candidate) · live seller runs v${LIVE.version}` : ""}</p>
        <h1>What your seller learned from {((LP.trained_on?.sessions ?? 0) + (S.trained_on?.sessions ?? 0)).toLocaleString()} negotiations.</h1>
        <p className="lede">Every negotiation is a trial. The seller logs which playbook it used and how it went, scores it with your goal, and keeps what works for each type of buyer. Prices are always set in code and guarded; AI only writes the words.</p>
      </section>

      <section className="lfind" aria-label="Findings">
        <article className="lcard">
          <span className="eyebrow">Lesson 1 · from AI buyers</span>
          <h2>Concede steadily, don't hold out.</h2>
          <p>Balanced (steady steps toward your soft floor) beat Negotiating (hold list, concede late) for {c.all ? "every" : "most"} buyer type, over {c.tries.toLocaleString()} tries.</p>
          <ul className="lrows">{c.rows.map((r) => <li key={r.c}><span>{ctxName(r.c)}</span><b className={`num ${r.diff >= 0 ? "up" : "down"}`}>{signed(Math.round(r.diff))}</b></li>)}</ul>
          <small>{relative(LP) ? "goal value per negotiation, same listing" : "goal value per negotiation"}</small>
        </article>
        <article className="lcard">
          <span className="eyebrow">Lesson 2 · from buyers with known perk values</span>
          <h2>Don't lead with a perk.</h2>
          <p>Free shipping or a warranty in place of a price cut cost more than it won back, even with buyers who value it: the perk raises your floor by its cost, and a buyer's budget doesn't stretch.</p>
          <ul className="lrows">{perks.map((p) => <li key={p.arm}><span>{armName(p.arm)}</span><b className={`num ${p.diff >= 0 ? "up" : "down"}`}>{signed(Math.round(p.diff))}</b></li>)}</ul>
          <small>vs Balanced on the same listing · {S.trained_on?.sessions.toLocaleString()} scripted buyers{worst ? ` · worst: ${armName(worst.arm).toLowerCase()}` : ""}</small>
        </article>
        <article className="lcard">
          <span className="eyebrow">Lesson 3 · it changes its mind</span>
          <h2>A bad bet gets reversed by data.</h2>
          <p>v2 bet on perks for quality- and trust-first buyers after only 20 and 10 tries. Fresh buyers punished it (−$5.11/buyer vs Balanced), and the next retrain switched back on its own.</p>
          <small>Since then an option needs at least {LP.min_sessions ?? 10} tries before it can win a buyer type.</small>
        </article>
      </section>

      <Training data={LP} />

      <HowItWorks />
      <Example />

      <section className="panel lp" aria-label="Perk lesson">
        <PerkGrid data={S} contexts={contexts} title="Perk lesson, buyer by buyer" sub="2,000 scripted buyers through the real exchange; each perk's worth to a buyer = its value × how much they weigh it · vs the listing's average" />
        <p className="sub">Scripted buyers value free shipping at $15 × their delivery weight, the extended warranty at $20 × their warranty weight, and the bundle discount at $15 × their price weight. Free shipping costs you $8 and the warranty $12. With known values the right answer is knowable: here no perk pays for itself, because budgets are hard caps. Source: <code>docs/results/b4-levers</code> (run <code>b4S</code>).</p>
      </section>

      <section className="panel" aria-label="Version history">
        <div className="panel-head"><h2>How the policy changed its mind</h2><span className="eyebrow">every version, what trained it, what happened next</span></div>
        <div className="scroll">
          <table className="pgrid">
            <thead><tr><th>Version</th><th>Trained on</th><th>What it chose</th><th>What happened</th></tr></thead>
            <tbody>{HISTORY.map((h) => <tr key={h.v}><td className="persona">{h.v}</td><td>{h.data}</td><td>{h.chose}</td><td>{h.result}</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <LearningCurve data={LP} events={events} perks={false} heading={false} />

      <section className="panel lcaveat" aria-label="Limits">
        <div className="panel-head"><h2>What this doesn't show yet</h2></div>
        <ul>
          <li>v{LP.version} hasn't passed its held-out test on fresh AI buyers yet (API credits ran out), so the live seller still runs v{LIVE.version}.</li>
          <li>Real traffic is small: {LP.trained_on?.by_source?.real ?? 0} live negotiations, most from before buyers' preferences reached the seller.</li>
          <li>The perk lesson comes from scripted buyers with values we set. Perks may still win where buyers compare sellers (a perk can win the sale from a rival), which these runs don't model.</li>
          <li>This is a contextual bandit: one choice per negotiation (which playbook), learned from outcomes. It is not fine-tuning a model.</li>
        </ul>
      </section>
    </main>
  );
}

function HowItWorks() {
  const steps = [
    { who: "Buyer AI", llm: true, t: "Searches and makes an offer", d: "An AI shopper (ChatGPT, Claude, or a simulated Claude buyer) calls search_products with what it values, then make_offer with a price and a message." },
    { who: "Learner · code", t: "Picks a playbook for this buyer type", d: "The exchange reads the buyer's type (what they weigh most) and draws a playbook from the policy file: the best known 90% of the time, a random one 10%. It logs the playbook and its odds." },
    { who: "Rules · code", t: "Sets the price", d: "decide() turns the playbook into a counter or an accept. Guards clamp it: never below your floor plus perk costs, never a jump past the step cap, never back up." },
    { who: "Seller voice · AI", llm: true, t: "Writes the words", d: "Claude phrases the move it was given. It can't change the price, and an output guard rewrites any message that names your floor or cost." },
    { who: "Buyer AI", llm: true, t: "Counters, accepts or walks", d: "Rounds repeat until a deal locks or the buyer leaves. Its budget is a hard cap enforced in code." },
    { who: "Score · code", t: "Scores the outcome with your goal", d: "Reward = your console weights on profit and revenue for that deal (0 if no sale), minus the average on the same listing." },
    { who: "Retrain · code", t: "Updates what works", d: "pnpm e2:retrain --live pools simulated runs and real marketplace negotiations, weights each by 1 ÷ its logged odds (so explored choices count fairly), and keeps the best playbook per buyer type." },
    { who: "Gate · AI buyers", llm: true, t: "Tested before it goes live", d: "A new version faces fresh AI buyers it never trained on. It ships only if it beats Negotiating with a 95% interval above zero and no deal below floor." },
  ];
  return (
    <section className="panel" aria-label="How it learns">
      <div className="panel-head"><h2>How one negotiation teaches the seller</h2><span className="eyebrow">AI on both sides; the learner and the price are code</span></div>
      <ol className="lflow">
        {steps.map((s, i) => (
          <li key={i} className={s.llm ? "llm" : "code"}>
            <span className="lstep num">{i + 1}</span>
            <div><span className="lwho">{s.who}</span><b>{s.t}</b><p>{s.d}</p></div>
          </li>
        ))}
      </ol>
      <p className="sub">Steps marked AI call a language model; the rest are deterministic code. The learner never asks an AI what price to set. The AIs are the buyers it learns from and the voice it speaks with.</p>
    </section>
  );
}

const REASON: Record<string, string> = {
  pacing: "pacing: concede one step on the curve",
  buyer_met_ask: "accept: the bid meets today's ask",
};

function Example() {
  const ex = example;
  const reward = Math.round((ex.deal.profit_cents + ex.deal.revenue_cents) / 2);
  const probs = Object.entries(ex.arm_probs).sort((a, b) => b[1] - a[1]);
  return (
    <section className="panel" aria-label="One logged negotiation">
      <div className="panel-head"><h2>One logged negotiation, step by step</h2><span className="eyebrow num">{ex.run_id} · {ex.buyer_model}</span></div>
      <div className="lex-head">
        <div><span className="eyebrow">Buyer</span><b>{ctxName(ex.context)} AI shopper</b><small>values delivery 1.0, price 0.5 · {ex.buyer_model}</small></div>
        <div><span className="eyebrow">Learner drew</span><b>{armName(ex.arm)}</b><small>{probs.map(([a, p]) => `${armName(a)} ${pct(p)}`).join(" · ")} (policy v{ex.policy_version})</small></div>
        <div><span className="eyebrow">Outcome</span><b className="num">Sold at {usd(ex.deal.price_cents)}</b><small className="num">list {usd(ex.product.list_price_cents)} · profit {usd(ex.deal.profit_cents)} · goal score {usd(reward)}</small></div>
      </div>
      <ol className="lex">
        {ex.steps.map((s, i) => (
          <li key={i} className={s.by}>
            <span className="lex-who">{s.by === "buyer" ? "Buyer AI" : "Seller"}</span>
            <b className="num">{usd(s.price_cents)}</b>
            <p>{s.message || "(no message)"}</p>
            {s.by === "seller" && s.reason_code && <small>code: {REASON[s.reason_code] ?? s.reason_code}</small>}
          </li>
        ))}
      </ol>
      <p className="sub">This deal went into training as one row: buyer type {ctxName(ex.context).toLowerCase()}, playbook {armName(ex.arm)}, drawn with odds {pct(ex.propensity)}, goal score {usd(reward)} (50% profit + 50% revenue). In this run the seller's words came from templates; in production Claude writes them under the same output guard. Source: <code>{ex.source}</code>.</p>
    </section>
  );
}

