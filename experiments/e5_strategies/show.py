"""Print E5 transcripts: show.py [runs file] [--condition C] [--persona P] [--deals]"""

from __future__ import annotations

import argparse
from pathlib import Path

from sales_agent.agents import Turn, render_transcript
from sales_agent.policy import Offer
from sales_agent.runlog import load

HERE = Path(__file__).resolve().parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("runs", nargs="?", default=str(HERE / "runs/main.jsonl"))
    ap.add_argument("--condition", nargs="*")
    ap.add_argument("--persona", nargs="*")
    ap.add_argument("--deals", action="store_true")
    ap.add_argument("--out", default=None, help="write here instead of stdout")
    args = ap.parse_args()
    chunks = []
    for r in load(args.runs):
        if args.condition and r["meta"]["condition"] not in args.condition:
            continue
        if args.persona and r["persona_id"] not in args.persona:
            continue
        if args.deals and not r["deal"]:
            continue
        p = r["meta"]["persona"]
        turns = [Turn(t["role"], t["message"], t["action"], Offer(**t["offer"]) if t["offer"] else None, t["note"]) for t in r["transcript"]]
        body = render_transcript(turns, viewer="none")
        notes = [f"  ({t['role']} r{i // 2 + 1}: {t['note']})" for i, t in enumerate(r["transcript"]) if t["note"]]
        chunks.append(
            f"=== {r['meta']['condition']} | {r['persona_id']} {p['brief']} {p['target_product']}+{p['wants_addons']} "
            f"floor {p['floor']} list {p['list']} walk {p['walk_away']} | {r['ended_by']} price={r['price']} "
            f"profit={r['profit']} addons={r['addons']} rounds={r['rounds']} claims={r.get('false_claims')}\n"
            + body + ("\n" + "\n".join(notes) if notes else "")
        )
    text = "\n\n".join(chunks)
    if args.out:
        Path(args.out).write_text(text)
    else:
        print(text)


if __name__ == "__main__":
    main()
