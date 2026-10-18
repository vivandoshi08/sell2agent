"""E6 phase 2: does the policy learned on scripted buyers transfer to LLM buyers?

    uv run python experiments/e6_rl_haggling/phase2.py --pilot      # 2 personas x 2 conditions, Opus buyers
    uv run python experiments/e6_rl_haggling/phase2.py              # the full run

Conditions (same personas, PolicyEngine on, Opus seller at low effort writing the messages):
    learned     greedy Q policy from phase 1 (qtable.json, back-off qtable_nostyle.json)
    best_fixed  the best fixed strategy on phase-1 validation buyers (phase1_results.json)
Buyers: 20 Opus buyers (make_personas(20, seed=606)), then Haiku buyers on the first 10 personas.
Runs append to runs/phase2.jsonl; already-finished (condition, buyer model, persona) jobs are skipped.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from llm_seller import HintedSeller, safe_run  # noqa: E402  (sets SALES_AGENT_MAX_CONCURRENCY first)
from learn import load_qdict  # noqa: E402
from sales_agent import llm  # noqa: E402
from sales_agent.metrics import summarize  # noqa: E402
from sales_agent.personas import make_personas  # noqa: E402
from sales_agent.runlog import RunLog, load, run_many  # noqa: E402
from strategies import QPolicy, e5_condition, fixed_by_name  # noqa: E402

RUNS = HERE / "runs"


def strategy_for(cond: str, log: list):
    if cond == "learned":
        return QPolicy(load_qdict(HERE / "qtable.json"), q_backoff=load_qdict(HERE / "qtable_nostyle.json"), log=log)
    best = json.load(open(HERE / "phase1_results.json"))["best_fixed"]
    return fixed_by_name(best)()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pilot", action="store_true")
    ap.add_argument("--concurrency", type=int, default=3)
    args = ap.parse_args()

    personas = make_personas(20, seed=606)
    best = json.load(open(HERE / "phase1_results.json"))["best_fixed"]
    jobs = []
    if args.pilot:
        jobs = [(p, c, "opus") for p in personas[:2] for c in ("learned", "best_fixed")]
        path = RUNS / "phase2_pilot.jsonl"
    else:
        jobs = [(p, c, "opus") for p in personas for c in ("learned", "best_fixed")]
        jobs += [(p, c, "haiku") for p in personas[:10] for c in ("learned", "best_fixed")]
        path = RUNS / "phase2.jsonl"
    log = RunLog(path)
    done = {(o["meta"]["condition"], o["meta"]["buyer"], o["persona_id"]) for o in load(path) if o["ended_by"] != "error"}
    jobs = [j for j in jobs if (j[1], j[2], j[0].id) not in done]
    print(f"{len(jobs)} sessions to run (best fixed = {best})", flush=True)

    models = {"opus": llm.OPUS, "haiku": llm.HAIKU}

    def run(job):
        p, cond, buyer = job
        slog: list = []
        extra = e5_condition(best).instructions if (cond == "best_fixed" and best.startswith("e5:")) else ""
        seller = HintedSeller(strategy=strategy_for(cond, slog), extra_instructions=extra)
        meta = {"experiment": "e6_phase2", "condition": cond, "strategy": "q_learned" if cond == "learned" else best,
                "buyer": buyer, "buyer_model": models[buyer], "seller_model": llm.DEFAULT_MODEL}
        out = safe_run(p, seller, buyer_model=models[buyer], meta=meta)
        out.meta["strategy_log"] = slog
        return out

    # Opus buyers first, then Haiku, so a partial run still gives the main comparison.
    jobs.sort(key=lambda j: (j[2] != "opus", j[0].id, j[1]))
    run_many(run, jobs, concurrency=args.concurrency, log=log, label="phase2")

    rows = load(path)
    for buyer in ("opus", "haiku"):
        for cond in ("learned", "best_fixed"):
            xs = [o for o in rows if o["meta"]["buyer"] == buyer and o["meta"]["condition"] == cond]
            if xs:
                s = summarize(xs)
                print(buyer, cond, {k: s.get(k) for k in ("sessions", "errors", "conversion", "profit_per_session", "profit_per_session_ci95", "avg_rounds", "model_cost_usd")})


if __name__ == "__main__":
    main()
