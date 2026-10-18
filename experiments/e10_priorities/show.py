"""Print E10 transcripts.

    uv run python experiments/e10_priorities/show.py runs/main.jsonl n3-pf            # every priority for one buyer
    uv run python experiments/e10_priorities/show.py runs/main.jsonl n3-pf adaptive   # one session
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from sell2agent.runlog import load

HERE = Path(__file__).resolve().parent


def show(r: dict) -> None:
    p = r["meta"]["persona"]
    print(f"=== {r['meta']['priority']} / {r['persona_id']} ({p['buyer_type']}) walk ${p['walk_away']:,} budget ${p['budget']:,} "
          f"std {p['std_product']} prem {p['prem_product']} wants {p['wants_addons']} -> {r['ended_by']} "
          f"{r.get('product_id')} {r.get('addons')} {r.get('price')} profit {r.get('profit')}")
    for t in r["transcript"]:
        off = t.get("offer")
        o = f"  [OFFER {off['product_id']} {'+'.join(off['addons'])} ${off['price']:,}]" if off else ""
        a = f"  [{t['action'].upper()}]" if t["action"] in ("accept", "walk") else ""
        note = ""
        if t["role"] == "seller" and str(t.get("note", "")).startswith("e10 "):
            n = json.loads(t["note"][4:])
            bits = [n.get("tactic", "")]
            if "inferred_type" in n:
                bits.append(f"read={n['inferred_type']}({n.get('confidence')})")
            if "llm_price" in n:
                bits.append(f"llm_price={n['llm_price']}")
            if n.get("warranty_free"):
                bits.append("warranty_free")
            note = "   {" + ", ".join(bits) + "}"
        print(f"{t['role'].upper()}: {t['message']}{o}{a}{note}")
    print()


def main() -> None:
    path = Path(sys.argv[1])
    if not path.is_absolute() and not path.exists():
        path = HERE / path
    persona = sys.argv[2] if len(sys.argv) > 2 else None
    prio = sys.argv[3] if len(sys.argv) > 3 else None
    for r in load(path):
        if persona and r["persona_id"] != persona:
            continue
        if prio and r["meta"]["priority"] != prio:
            continue
        show(r)


if __name__ == "__main__":
    main()
