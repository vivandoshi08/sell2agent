"""Run the false-claims judge (sell2agent.judge) over E5 seller transcripts.

    SELL2AGENT_MAX_CONCURRENCY=3 uv run python experiments/e5_strategies/judge_runs.py --runs runs/main.jsonl

Writes {session_id, condition, persona_id, deal, false_claims, usage} per line to
runs/judge.jsonl and skips sessions already judged. analyze.py merges the flags
back into the outcomes, so safe conversion counts them.
"""

from __future__ import annotations

import argparse
import threading
from pathlib import Path

from sell2agent import judge, llm
from sell2agent.runlog import RunLog, load, run_many

from run import RUNS, Logger


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", nargs="*", default=[str(RUNS / "main.jsonl")])
    ap.add_argument("--conditions", nargs="*", default=None)
    ap.add_argument("--deals-only", action="store_true", help="only judge sessions that closed")
    ap.add_argument("--budget", type=float, default=5.0)
    ap.add_argument("--concurrency", type=int, default=3)
    args = ap.parse_args()

    out_path = RUNS / "judge.jsonl"
    log = Logger(RUNS / "judge.log")
    out = RunLog(out_path)
    done = {r["session_id"] for r in load(out_path) if not r.get("error")}

    sessions = []
    for path in args.runs:
        p = Path(path)
        p = p if p.is_absolute() or p.exists() else Path(__file__).resolve().parent / path
        for r in load(p):
            if r.get("ended_by") == "error" or r["session_id"] in done:
                continue
            if args.conditions and r["meta"]["condition"] not in args.conditions:
                continue
            if args.deals_only and not r["deal"]:
                continue
            sessions.append(r)
    log(f"judging {len(sessions)} sessions (already judged: {len(done)})")

    spent = [0.0]
    lock = threading.Lock()

    def one(r):
        with lock:
            if spent[0] >= args.budget:
                return None
        usage = llm.Usage()
        rec = {"session_id": r["session_id"], "condition": r["meta"]["condition"], "persona_id": r["persona_id"], "deal": r["deal"]}
        try:
            rec["false_claims"] = judge.flag_false_claims(r["transcript"], usage=usage)
        except (llm.LLMError, ValueError) as e:
            rec["false_claims"], rec["error"] = [], str(e)[:300]
        rec["usage"] = usage.as_dict()
        out.write(rec)
        with lock:
            spent[0] += usage.cost_usd
            total = spent[0]
        log(f"{rec['condition']:17s} {rec['persona_id']} deal={rec['deal']!s:5s} claims={len(rec['false_claims'])} "
            f"cost=${usage.cost_usd:.3f} total=${total:.2f}{' ERR' if rec.get('error') else ''}")
        return rec

    run_many(one, sessions, concurrency=args.concurrency, label="e5-judge")
    log(f"judge finished, spent=${spent[0]:.2f}")


if __name__ == "__main__":
    main()
