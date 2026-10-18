"""Render one E1 run as a readable trace: buyer reasoning, every tool call and
result, the seller's turns (including moves the policy engine rejected), and
the checkout. Used to draft trace_example.md, which is then annotated by hand.

    uv run python experiments/e1_e2e_mcp/make_trace.py <run_id> [--runs runs/buyer_runs.jsonl] > trace.md
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import RUNS, SESSIONS  # noqa: E402

from sell2agent.runlog import load  # noqa: E402


def short(obj, n=900) -> str:
    s = obj if isinstance(obj, str) else json.dumps(obj, indent=2)
    return s if len(s) <= n else s[:n] + "\n... (truncated)"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("run_id")
    ap.add_argument("--runs", default=str(RUNS / "buyer_runs.jsonl"))
    args = ap.parse_args()
    rec = next(r for r in load(args.runs) if r["run_id"] == args.run_id)
    turns = load(SESSIONS / f"{args.run_id}.turns.jsonl")
    rejected = [t for t in turns if t.get("rejected")]
    p = rec["persona"]
    print(f"# Trace: {args.run_id}\n")
    print(f"Persona {p['id']}: {p['need']}. Wants {', '.join(p['wants_addons']) or 'no add-ons'}. Budget ${p['budget']:,}, private walk-away ${p['walk_away']:,}. "
          f"Bundle floor ${p['floor']:,}, list ${p['list']:,}. Brief: {rec['brief']}. Design: {rec['design']}.\n")
    print(f"Wall time {rec['wall_s']}s, {rec['num_turns']} buyer turns, buyer cost ${rec['buyer_cost_usd']:.3f}.\n")
    texts = {t["after_tool_calls"]: t["text"] for t in rec["assistant_texts"]}
    for i, tu in enumerate(rec["tool_uses"]):
        if i in texts:
            print(f"**Buyer (thinking out loud):** {texts[i]}\n")
        print(f"### {i + 1}. `{tu['name']}`\n")
        print("```json\n" + short(tu["input"], 600) + "\n```\n")
        print("Result" + (" (ERROR)" if tu.get("is_error") else "") + ":\n")
        res = tu.get("result") or ""
        try:
            res = json.loads(res)
        except (json.JSONDecodeError, TypeError):
            pass
        print("```json\n" + short(res) + "\n```\n")
    last = len(rec["tool_uses"])
    if last in texts:
        print(f"**Buyer's final report:**\n\n{texts[last]}\n")
    if rejected:
        print("## Policy engine rejections (seller moves that never reached the buyer)\n")
        for t in rejected:
            print(f"- round {t['round']}: {t['action']} {t.get('offer')} -> {t.get('note')}")
    print("\n## Seller-side turn log\n")
    for t in turns:
        off = t.get("offer")
        o = f" [{off['product_id']} {'+'.join(off['addons'])} ${off['price']:,}]" if off else ""
        print(f"- r{t['round']} {t['role']} {t['action']}{o}{' (REJECTED)' if t.get('rejected') else ''}: {t['message'][:300]}")


if __name__ == "__main__":
    main()
