"""E6 phase 1 hyperparameter sweep for the tabular learners, scored on the validation buyers only.

    uv run python experiments/e6_rl_haggling/sweep.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from buyers import evaluate, population, summarize  # noqa: E402
from learn import train_q  # noqa: E402
from strategies import QPolicy, named_fixed  # noqa: E402


def main():
    val = population(2000, seed=3003)
    out = {"fixed": {n: summarize(evaluate(f, val, seed=7), boot=0)["profit_per_session"] for n, f in named_fixed().items()}}
    print(out["fixed"], flush=True)
    rows = []
    for episodes in (100_000, 300_000):
        train = population(episodes, seed=1001)
        for method in ("q", "mc"):
            for alpha_pow in (0.6, 1.0):
                for eps_end in (0.05,):
                    t = time.time()
                    table, _ = train_q(train, val[:200], method=method, alpha_pow=alpha_pow, eps_end=eps_end,
                                       eval_every=episodes, log=lambda *_: None)
                    s = summarize(evaluate(lambda: QPolicy(table), val, seed=7), boot=0)
                    row = dict(episodes=episodes, method=method, alpha_pow=alpha_pow, eps_end=eps_end,
                               val_pps=s["profit_per_session"], val_conv=s["conversion"], secs=round(time.time() - t))
                    rows.append(row)
                    print(row, flush=True)
    out["runs"] = rows
    json.dump(out, open(HERE / "sweep_results.json", "w"), indent=1)


if __name__ == "__main__":
    main()
