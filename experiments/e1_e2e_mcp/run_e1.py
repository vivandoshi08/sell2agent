"""Batch runner for E1: personas x tool designs x briefs, a few buyer runs at a time.

    uv run python experiments/e1_e2e_mcp/run_e1.py --personas 0-9 --designs structured,freetext --tag e1
    uv run python experiments/e1_e2e_mcp/run_e1.py --personas 2,4,6 --briefs buy_fast,best_deal --designs structured --tag e1b

Each finished run is appended to runs/buyer_runs.jsonl. Runs whose run_id is
already in that file are skipped, so a crashed batch can be restarted.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from buyer import run_buyer  # noqa: E402
from common import RUNS  # noqa: E402

from sell2agent.personas import make_personas  # noqa: E402


def parse_indices(s: str) -> list[int]:
    out = []
    for part in s.split(","):
        if "-" in part:
            a, b = part.split("-")
            out.extend(range(int(a), int(b) + 1))
        elif part.strip():
            out.append(int(part))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=101)
    ap.add_argument("--personas", default="0-9")
    ap.add_argument("--designs", default="structured,freetext")
    ap.add_argument("--briefs", default="neutral")
    ap.add_argument("--concurrency", type=int, default=3)
    ap.add_argument("--tag", default="e1")
    ap.add_argument("--variant", default="negotiable", choices=["negotiable", "fixed"], help="fixed: Prairie sells at list only (A2 test)")
    ap.add_argument("--out", default=str(RUNS / "buyer_runs.jsonl"))
    args = ap.parse_args()

    idx = parse_indices(args.personas)
    pool = make_personas(max(idx) + 1, seed=args.seed)
    out = Path(args.out)
    done = set()
    if out.exists():
        done = {json.loads(l)["run_id"] for l in out.read_text().splitlines() if l.strip()}

    jobs = []
    for brief in args.briefs.split(","):
        for i in idx:
            for design in args.designs.split(","):  # interleave designs so both progress evenly
                p = make_personas(max(idx) + 1, seed=args.seed)[i]
                p.brief = brief
                run_id = f"{args.tag}-{design[:6]}-{p.id}-{brief}"
                if run_id not in done:
                    jobs.append((p, design, run_id))
    print(f"{len(jobs)} runs to do ({len(done)} already in {out.name}); concurrency {args.concurrency}", file=sys.stderr, flush=True)

    lock = threading.Lock()
    start = time.monotonic()
    total_cost = 0.0

    def one(job):
        p, design, run_id = job
        return run_buyer(p, design, run_id, variant=args.variant)

    with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        futs = {ex.submit(one, j): j for j in jobs}
        for n, fut in enumerate(as_completed(futs), 1):
            p, design, run_id = futs[fut]
            try:
                rec = fut.result()
            except Exception as e:  # keep the batch going
                rec = {"run_id": run_id, "design": design, "brief": p.brief, "persona": p.to_dict(), "crash": repr(e)}
            with lock, out.open("a") as f:
                f.write(json.dumps(rec, default=str) + "\n")
            total_cost += rec.get("buyer_cost_usd") or 0
            s = rec.get("summary") or {}
            print(
                f"[{n}/{len(jobs)} {time.monotonic() - start:.0f}s] {run_id}: {s.get('outcome')} {s.get('seller')} {s.get('price')} "
                f"turns={rec.get('num_turns')} wall={rec.get('wall_s')}s buyer=${rec.get('buyer_cost_usd') or 0:.2f} (batch buyer total ${total_cost:.2f})",
                file=sys.stderr,
                flush=True,
            )


if __name__ == "__main__":
    main()
