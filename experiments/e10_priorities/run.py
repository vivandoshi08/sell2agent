"""E10 runner: 4 seller priorities x 24 buyers (8 needs x 3 buyer types).

    SALES_AGENT_MAX_CONCURRENCY=3 uv run python experiments/e10_priorities/run.py --phase pilot
    SALES_AGENT_MAX_CONCURRENCY=3 uv run python experiments/e10_priorities/run.py --phase main --reuse experiments/e10_priorities/runs/pilot.jsonl

Writes one Outcome per line to runs/<phase>.jsonl and progress to runs/<phase>.log.
Re-running skips (priority, buyer) pairs already finished without an error, so a
killed job resumes. --reuse copies finished pairs from another run file only if
they were produced by the same code (same sha of catalog_ext/buyers/sellers).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import threading
import time
from pathlib import Path

from sales_agent import llm
from sales_agent.negotiation import run_negotiation
from sales_agent.runlog import RunLog, load, run_many

import catalog_ext as cx
from buyers import E10Buyer, make_buyers
from sellers import PRIORITIES, E10Seller

HERE = Path(__file__).resolve().parent
RUNS = HERE / "runs"
MAX_ROUNDS = 8
CODE_SHA = hashlib.sha1(b"".join((HERE / f).read_bytes() for f in ["catalog_ext.py", "buyers.py", "sellers.py"])).hexdigest()[:10]
PILOT = {"price_first": "n3", "quality_first": "n2", "balanced": "n4"}  # one need per buyer type


class Logger:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()

    def __call__(self, msg: str) -> None:
        line = f"{time.strftime('%H:%M:%S')} {msg}"
        with self.lock:
            print(line, flush=True)
            with self.path.open("a") as f:
                f.write(line + "\n")


def seller_notes(transcript: list[dict]) -> list[dict]:
    out = []
    for t in transcript:
        if t["role"] == "seller" and str(t.get("note", "")).startswith("e10 "):
            try:
                out.append(json.loads(t["note"][4:]))
            except json.JSONDecodeError:
                pass
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", default="pilot")
    ap.add_argument("--priorities", nargs="*", default=list(PRIORITIES))
    ap.add_argument("--needs", nargs="*", default=None, help="need ids (default: all 8; pilot: one per type)")
    ap.add_argument("--budget", type=float, default=20.0, help="stop starting sessions past this spend (USD)")
    ap.add_argument("--concurrency", type=int, default=3)
    ap.add_argument("--reuse", nargs="*", default=[])
    args = ap.parse_args()

    RUNS.mkdir(exist_ok=True)
    out_path = RUNS / f"{args.phase}.jsonl"
    log = Logger(RUNS / f"{args.phase}.log")
    runlog = RunLog(out_path)

    buyers = make_buyers()
    if args.phase == "pilot" and args.needs is None:
        buyers = [b for b in buyers if PILOT[b.buyer_type] == b.need_id]
    elif args.needs:
        buyers = [b for b in buyers if b.need_id in args.needs]

    have = {(r["meta"]["priority"], r["persona_id"]) for r in load(out_path) if r.get("ended_by") != "error"}
    for path in args.reuse:
        for r in load(path):
            key = (r["meta"]["priority"], r["persona_id"])
            if r.get("ended_by") == "error" or key in have:
                continue
            if r["meta"].get("code_sha") == CODE_SHA:
                r["meta"]["reused_from"] = Path(path).name
                runlog.write(r)
                have.add(key)
                log(f"reused {key} from {path}")
            else:
                log(f"not reusable (code changed): {key} from {path}")

    # Buyer-major order, so a run stopped early is balanced across priorities.
    todo = [(p, b) for b in buyers for p in args.priorities if (p, b.id) not in have]
    log(f"phase={args.phase} buyers={len(buyers)} priorities={len(args.priorities)} todo={len(todo)} sha={CODE_SHA} "
        f"model={llm.DEFAULT_MODEL} effort={llm.DEFAULT_EFFORT} max_conc={llm.MAX_CONCURRENCY}")

    spent = [0.0]
    lock = threading.Lock()

    def one(item):
        prio, persona = item
        with lock:
            if spent[0] >= args.budget:
                return None
        seller = E10Seller(prio)
        out = run_negotiation(
            E10Buyer(persona),
            seller,
            policy=cx.E10Policy(),
            max_rounds=MAX_ROUNDS,
            meta={
                "experiment": "e10_priorities",
                "phase": args.phase,
                "priority": prio,
                "buyer_type": persona.buyer_type,
                "need_id": persona.need_id,
                "code_sha": CODE_SHA,
                "model": llm.DEFAULT_MODEL,
                "effort": llm.DEFAULT_EFFORT,
                "persona": persona.to_dict(),
            },
        )
        out.meta["seller_usage"] = seller.own.as_dict()
        out.meta["classifier_usage"] = seller.classifier.as_dict()
        runlog.write(out)
        with lock:
            spent[0] += out.usage.get("cost_usd", 0)
            total = spent[0]
        notes = seller_notes(out.transcript)
        reads = ",".join(n.get("inferred_type", "")[:2] for n in notes if "inferred_type" in n)
        overrides = sum(1 for n in notes if "llm_price" in n)
        bundle = cx.describe(out.product_id, out.addons) if out.deal else "-"
        log(f"{prio:10s} {persona.id:7s} {out.ended_by:13s} deal={out.deal!s:5s} {bundle:45s} price={out.price} profit={out.profit} "
            f"walk={persona.walk_away} rounds={out.rounds} overrides={overrides}{' reads=' + reads if reads else ''} "
            f"cost=${out.usage.get('cost_usd', 0):.3f} wall={out.wall_s:.0f}s total=${total:.2f}"
            f"{' ERR ' + out.error[:120] if out.error else ''}")
        return out

    run_many(one, todo, concurrency=args.concurrency, label=f"e10-{args.phase}")
    log(f"finished phase={args.phase} spent=${spent[0]:.2f}")


if __name__ == "__main__":
    sys.exit(main())
