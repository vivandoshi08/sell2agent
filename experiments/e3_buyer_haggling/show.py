"""Print E3 transcripts.

    uv run python experiments/e3_buyer_haggling/show.py <part> [key substring ...]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import RUNS, session_behavior  # noqa: E402

from sell2agent.runlog import load  # noqa: E402


def show(r: dict) -> None:
    p = r["meta"]["persona"]
    print("=" * 100)
    print(r["meta"]["key"], f"| floor {p['floor']:,} list {p['list']:,} walk-away {p['walk_away']:,} budget {p['budget']:,}")
    print(f"deal={r['deal']} price={r['price']} ended_by={r['ended_by']} rounds={r['rounds']} cost=${r['usage'].get('cost_usd', 0):.3f}")
    b = session_behavior(r)
    print({k: b[k] for k in ("counter", "haggled", "first_buyer_offer_pct_list", "discount_pct", "seller_discounted")})
    for t in r["transcript"]:
        off = t.get("offer")
        tag = f" [OFFER ${off['price']:,} {off['product_id']} {off['addons']}]" if t["action"] == "offer" and off else f" [{t['action'].upper()}]"
        note = f" ({t['note']})" if t.get("note") else ""
        print(f"  {t['role'].upper()}:{tag}{note} {t['message']}")


def main() -> None:
    part, subs = sys.argv[1], sys.argv[2:]
    for r in load(RUNS / f"{part}.jsonl"):
        if all(s in r["meta"]["key"] for s in subs):
            show(r)


if __name__ == "__main__":
    main()
