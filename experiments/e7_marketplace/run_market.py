"""Run E7 market sessions or the one-to-one baseline.

    SELL2AGENT_MAX_CONCURRENCY=3 uv run python experiments/e7_marketplace/run_market.py --mode direct --n 2 --tag pilot
    SELL2AGENT_MAX_CONCURRENCY=3 uv run python experiments/e7_marketplace/run_market.py --mode both --n 20 --tag full
    SELL2AGENT_MAX_CONCURRENCY=3 uv run python experiments/e7_marketplace/run_market.py --baseline --n 20 --tag full
    uv run python experiments/e7_marketplace/run_market.py --registry   # write registry.json only

Re-running the same command skips personas already in the output file, so a crashed run resumes.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from market import HERE, registry, render_session, run_market_session  # noqa: E402

from sell2agent.agents import BuyerAgent, SellerAgent  # noqa: E402
from sell2agent.negotiation import run_negotiation  # noqa: E402
from sell2agent.personas import make_personas  # noqa: E402
from sell2agent.policy import PolicyEngine  # noqa: E402
from sell2agent.runlog import RunLog, load, run_many  # noqa: E402

SEED = 707
RUNS = HERE / "runs"


def write_registry() -> None:
    (HERE / "registry.json").write_text(json.dumps(registry(), indent=2) + "\n")
    print("wrote", HERE / "registry.json")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["direct", "broker", "both"], default="both")
    ap.add_argument("--baseline", action="store_true", help="one-to-one: each persona vs the negotiating seller alone")
    ap.add_argument("--registry", action="store_true")
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--start", type=int, default=0, help="first persona index")
    ap.add_argument("--tag", default="full")
    ap.add_argument("--concurrency", type=int, default=3)
    ap.add_argument("--max-turns", type=int, default=12)
    ap.add_argument("--show", action="store_true", help="print each session's log")
    args = ap.parse_args()

    write_registry()
    if args.registry:
        return
    personas = make_personas(20, seed=SEED)
    idx = list(range(args.start, min(20, args.start + args.n)))

    if args.baseline:
        log = RunLog(RUNS / f"{args.tag}_baseline_one_to_one.jsonl")
        done = {r["persona_id"] for r in log.load() if r.get("ended_by") != "error"}
        todo = [i for i in idx if personas[i].id not in done]
        print(f"baseline: {len(todo)} to run ({len(done)} already done)")

        def one(i: int):
            p = personas[i]
            return run_negotiation(
                BuyerAgent(p), SellerAgent(), policy=PolicyEngine(), max_rounds=args.max_turns,
                session_id=f"{args.tag}-o2o-{p.id}", meta={"experiment": "e7_marketplace", "mode": "one_to_one", "persona_index": i},
            )

        run_many(one, todo, concurrency=args.concurrency, log=log, label="baseline")
        return

    modes = ["direct", "broker"] if args.mode == "both" else [args.mode]
    for mode in modes:
        log = RunLog(RUNS / f"{args.tag}_{mode}.jsonl")
        done = {r["persona"]["id"] for r in log.load() if r.get("ended_by") != "error"}
        todo = [i for i in idx if personas[i].id not in done]
        print(f"{mode}: {len(todo)} to run ({len(done)} already done)")

        def one(i: int, mode=mode):
            p = personas[i]
            rec = run_market_session(p, mode, persona_index=i, max_turns=args.max_turns, session_id=f"{args.tag}-{mode}-{p.id}")
            if args.show:
                print(render_session(rec), flush=True)
            print(
                f"  {mode} {p.id}: deal={rec['deal']} winner={rec.get('winner')} price={rec.get('price')} "
                f"walk={p.walk_away} turns={rec['buyer_turns']} cost=${rec['usage']['total']['cost_usd']:.3f} err={rec['error'][:80]!r}",
                file=sys.stderr, flush=True,
            )
            return rec

        run_many(one, todo, concurrency=args.concurrency, log=log, label=mode)
        recs = load(log.path)
        cost = sum(r["usage"]["total"]["cost_usd"] for r in recs)
        print(f"{mode}: {len(recs)} sessions in file, model cost ${cost:.2f}")


if __name__ == "__main__":
    main()
