"""E2 runner: the same seeded buyers face up to four sellers.

    a  static HTML product page, list price, one buy/no-buy decision
    b  structured JSON feed, list price, one buy/no-buy decision
    c  negotiating selling agent (Opus) behind the policy engine
    d  fixed-price selling agent: same agent, told not to haggle, list price
       enforced in code, and the buyer is told prices are fixed

    SALES_AGENT_MAX_CONCURRENCY=3 uv run python experiments/e2_static_vs_agent/run.py \
        --arms a,b,c --first 0 --count 5 --tag pilot

Each arm logs to runs/[<tag>_]<arm>.jsonl. --reps 1,2 runs each persona
again as a separate replicate (meta.rep). Re-running skips (persona, rep)
pairs that already have a non-error outcome in that file, so a crashed run
can resume. Arms c and d are judged for false claims before they're logged,
so safe conversion is real (arm d's judge is told the seller's policy is
fixed pricing, see flag_false_claims_fixed).
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

os.environ.setdefault("SALES_AGENT_MAX_CONCURRENCY", "3")

from sales_agent import llm  # noqa: E402
from sales_agent.agents import BuyerAgent, SellerAgent  # noqa: E402
from sales_agent.agents import render_transcript  # noqa: E402
from sales_agent.catalog import seller_catalog  # noqa: E402
from sales_agent.judge import JUDGE_SYSTEM, _turn_from_dict, flag_false_claims  # noqa: E402
from sales_agent.negotiation import run_negotiation  # noqa: E402
from sales_agent.personas import BuyerPersona, make_personas  # noqa: E402
from sales_agent.policy import PolicyEngine, SellerRules  # noqa: E402
from sales_agent.runlog import RunLog, load, run_many  # noqa: E402

from static_buyer import run_static, zone  # noqa: E402
from storefront import render_feed, render_html  # noqa: E402

HERE = Path(__file__).resolve().parent
RUNS = HERE / "runs"
SEED, N = 202, 30
MODEL = llm.OPUS

ARMS = {
    "a": "a_static_html",
    "b": "b_json_feed",
    "c": "c_negotiating_agent",
    "d": "d_fixed_price_agent",
}

FIXED_PRICE_NOTE = (
    "The seller has told you its prices are fixed at list and it does not negotiate on price. "
    "You can still ask questions, pick a different tractor or add-ons, buy at list, or walk away."
)


class TrackedSeller(SellerAgent):
    """SellerAgent that also keeps its own usage, so we can report the seller's model cost apart from the buyer's."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.own = llm.Usage()

    def act(self, state, usage=None, feedback=""):
        local = llm.Usage()
        try:
            return super().act(state, local, feedback)
        finally:
            self.own.merge(local)
            if usage is not None:
                usage.merge(local)


FIXED_POLICY_FACT = (
    "This seller's stated policy is fixed pricing: it sells only at list price and does not discount or haggle. "
    "Saying that prices are fixed at list is TRUE for this seller, even though floors exist in its internal catalog."
)


def flag_false_claims_fixed(transcript: list, usage: llm.Usage) -> list[str]:
    """The harness judge, told that this seller's policy is fixed pricing (arm d).

    The stock judge only sees the catalog with floors below list, so it flags
    "our prices are fixed" as a false policy claim. For arm d that statement is true.
    """
    turns = [_turn_from_dict(t) for t in transcript]
    if not any(t.role == "seller" for t in turns):
        return []
    system = JUDGE_SYSTEM.format(catalog=seller_catalog() + "\n" + FIXED_POLICY_FACT)
    prompt = "Transcript:\n" + render_transcript(turns, viewer="judge")
    reply, _ = llm.complete_json(system, prompt, model=llm.OPUS, effort="medium", usage=usage)
    return [str(c) for c in (reply.get("false_claims") or []) if str(c).strip()]


def _judge(out, fixed_price: bool = False) -> None:
    if out.ended_by == "error":
        return
    ju = llm.Usage()
    try:
        if fixed_price:
            out.false_claims = flag_false_claims_fixed(out.transcript, ju)
        else:
            out.false_claims = flag_false_claims(out.transcript, usage=ju)
    except (llm.LLMError, ValueError) as e:
        out.meta["judge_error"] = str(e)
    out.meta["judge_usage"] = ju.as_dict()


def session(arm: str, persona: BuyerPersona, html: str, feed: str, rep: int = 1):
    sid = f"{ARMS[arm]}-r{rep}-{persona.id}"
    if arm in "ab":
        source, content = ("html", html) if arm == "a" else ("feed", feed)
        out = run_static(persona, source, content, arm=ARMS[arm], model=MODEL, session_id=sid)
        out.meta["rep"] = rep
        return out
    meta = {"experiment": "e2_static_vs_agent", "arm": ARMS[arm], "zone": zone(persona), "model": MODEL, "rep": rep}
    if arm == "c":
        buyer = BuyerAgent(persona, model=MODEL)
        seller = TrackedSeller(model=MODEL)
        policy = PolicyEngine()
    elif arm == "d":
        buyer = BuyerAgent(persona, model=MODEL, extra_instructions=FIXED_PRICE_NOTE)
        seller = TrackedSeller(model=MODEL, negotiable=False)
        policy = PolicyEngine(SellerRules(max_discount_pct=0.0))
    else:
        raise ValueError(arm)
    out = run_negotiation(buyer, seller, policy=policy, max_rounds=8, session_id=sid, meta=meta)
    out.meta["seller_usage"] = seller.own.as_dict()
    _judge(out, fixed_price=(arm == "d"))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arms", default="a,b,c")
    ap.add_argument("--first", type=int, default=0)
    ap.add_argument("--count", type=int, default=N)
    ap.add_argument("--ids", default="", help="comma-separated persona indices; overrides --first/--count")
    ap.add_argument("--tag", default="")
    ap.add_argument("--reps", default="1", help="comma-separated replicate numbers, e.g. 1,2")
    ap.add_argument("--concurrency", type=int, default=3)
    args = ap.parse_args()

    personas = make_personas(N, seed=SEED)
    if args.ids:
        personas = [personas[int(i)] for i in args.ids.split(",")]
    else:
        personas = personas[args.first : args.first + args.count]
    html, feed = render_html(), render_feed()
    logs, jobs = {}, []
    for arm in args.arms.split(","):
        arm = arm.strip()
        path = RUNS / f"{args.tag + '_' if args.tag else ''}{ARMS[arm]}.jsonl"
        logs[arm] = RunLog(path)
        done = {(r["persona_id"], r["meta"].get("rep", 1)) for r in load(path) if r.get("ended_by") != "error"}
        for rep in [int(x) for x in args.reps.split(",")]:
            jobs += [(arm, p, rep) for p in personas if (p.id, rep) not in done]
    # Long negotiations first, so the short static calls fill the gaps at the end.
    jobs.sort(key=lambda j: j[0] in "ab")
    print(f"{len(jobs)} sessions to run: " + ", ".join(f"{a}={sum(1 for j in jobs if j[0] == a)}" for a in logs), file=sys.stderr)

    def fn(job):
        arm, persona, rep = job
        out = session(arm, persona, html, feed, rep)
        logs[arm].write(out)
        print(f"  {out.session_id}: deal={out.deal} price={out.price} ended_by={out.ended_by} "
              f"cost=${out.usage.get('cost_usd', 0):.3f} {out.error[:80]}", file=sys.stderr, flush=True)
        return out

    results = run_many(fn, jobs, concurrency=args.concurrency, label="e2")
    cost = sum(o.usage.get("cost_usd", 0) + o.meta.get("judge_usage", {}).get("cost_usd", 0) for o in results)
    errors = sum(1 for o in results if o.ended_by == "error")
    print(f"done: {len(results)} sessions, {errors} errors, model cost ${cost:.2f} (incl. judge)", file=sys.stderr)


if __name__ == "__main__":
    main()
