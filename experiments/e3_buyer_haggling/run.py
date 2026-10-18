"""Run E3 sessions. Each part appends to its own runs/<part>.jsonl and skips
sessions already logged without error, so a part can be stopped and resumed.

    uv run python experiments/e3_buyer_haggling/run.py grid   [--personas 0,1] [--avail ...] [--briefs ...]
    uv run python experiments/e3_buyer_haggling/run.py models [--models opus,sonnet,haiku] [--personas ...]
    uv run python experiments/e3_buyer_haggling/run.py leak   [--models opus,sonnet,haiku] [--personas ...]
    uv run python experiments/e3_buyer_haggling/run.py b8     [--personas ...]
    add --dry to list the jobs without running them
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import AVAILABILITY, BRIEF_NAMES, RUNS, done_keys, make_job, run_job  # noqa: E402

from sales_agent.personas import make_personas  # noqa: E402
from sales_agent.runlog import RunLog, run_many  # noqa: E402


def pick(xs, sel):
    if not sel:
        return xs
    idx = [int(i) for i in sel.split(",")]
    return [xs[i] for i in idx]


def jobs_for(part: str, args) -> list[dict]:
    jobs = []
    if part == "grid":
        personas = pick(make_personas(8, seed=303), args.personas)
        avails = args.avail.split(",") if args.avail else AVAILABILITY
        briefs = args.briefs.split(",") if args.briefs else BRIEF_NAMES
        for a in avails:
            for b in briefs:
                for p in personas:
                    jobs.append(make_job("grid", p, availability=a, brief=b))
    elif part == "models":
        personas = pick(make_personas(10, seed=304), args.personas)
        models = args.models.split(",") if args.models else ["opus", "sonnet", "haiku"]
        avails = args.avail.split(",") if args.avail else ["advertised", "fixed"]
        for m in models:
            for a in avails:
                for p in personas:
                    jobs.append(make_job("models", p, availability=a, brief="neutral", buyer_model=m))
    elif part == "leak":
        models = args.models.split(",") if args.models else ["opus", "sonnet", "haiku"]
        for m in models:
            n = 15 if m == "opus" else 10
            personas = pick(make_personas(n, seed=305), args.personas)
            for p in personas:
                jobs.append(make_job("leak", p, availability="available", brief="neutral", buyer_model=m, seller_ask_budget=True))
    elif part == "b8":
        personas = pick(make_personas(15, seed=305), args.personas)
        for p in personas:
            jobs.append(make_job("b8", p, availability="available", brief="neutral", buyer_model="opus",
                                 seller_ask_budget=True, budget_only=True))
    else:
        raise SystemExit(f"unknown part {part}")
    return jobs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("part", choices=["grid", "models", "leak", "b8"])
    ap.add_argument("--personas", default="", help="comma-separated persona indexes")
    ap.add_argument("--avail", default="")
    ap.add_argument("--briefs", default="")
    ap.add_argument("--models", default="")
    ap.add_argument("--concurrency", type=int, default=3)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    path = RUNS / f"{args.part}.jsonl"
    jobs = jobs_for(args.part, args)
    done = done_keys(path)
    todo = [j for j in jobs if j["key"] not in done]
    print(f"{args.part}: {len(jobs)} jobs, {len(jobs) - len(todo)} already done, {len(todo)} to run", flush=True)
    if args.dry:
        for j in todo:
            print("  ", j["key"])
        return
    results = run_many(run_job, todo, concurrency=min(args.concurrency, 3), log=RunLog(path), label=args.part)
    cost = sum(r["usage"].get("cost_usd", 0) for r in results)
    errs = [r for r in results if r["ended_by"] == "error"]
    deals = sum(1 for r in results if r["deal"])
    print(f"done: {len(results)} sessions, {deals} deals, {len(errs)} errors, ${cost:.2f}", flush=True)
    for r in errs[:5]:
        print("ERROR", r["meta"]["key"], r["error"][:300], flush=True)


if __name__ == "__main__":
    main()
