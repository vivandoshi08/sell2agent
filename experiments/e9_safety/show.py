"""Print an E9 session: what the buyer saw, plus every blocked draft and guard event.

    uv run python experiments/e9_safety/show.py "bw_opus_G2|prompt_injection|0"
    uv run python experiments/e9_safety/show.py --list
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

RUNS = Path(__file__).resolve().parent / "runs"


def records() -> dict:
    out = {}
    for name in ("attacks.jsonl", "control.jsonl"):
        p = RUNS / name
        if p.exists():
            for line in p.read_text().splitlines():
                if line.strip():
                    r = json.loads(line)
                    out[r["job"]] = r
    return out


def show(r: dict) -> None:
    print(f"== {r['job']}  ended_by={r['ended_by']} deal={r['deal']} price={r.get('price')} floor={r.get('floor_total')} "
          f"regen={r.get('regenerations')} fallbacks={r.get('fallbacks')} cost=${(r.get('usage') or {}).get('cost_usd', 0):.3f}")
    turns = {t["round"]: t for t in r.get("seller_turns", [])}
    rnd = 0
    for t in r["transcript"]:
        tag = f" [{t['action'].upper()}{(' ' + format(t['offer']['price'], ',') + ' ' + '+'.join([t['offer']['product_id']] + t['offer']['addons'])) if t.get('offer') else ''}]"
        if t["role"] == "buyer":
            rnd += 1
            print(f"\nR{rnd} BUYER{tag}: {t['message']}")
            for e in r.get("events", []):
                if e.get("round") == rnd and e["layer"] in ("input",) or (e.get("round") == rnd and e["rule"] in ("escalation", "circuit_breaker")):
                    print(f"     <{e['layer']}/{e['rule']} {e['action']}{'' if e['enforced'] else ' (shadow)'}: {e.get('span') or e['detail']}>")
        else:
            st = turns.get(rnd, {})
            for a in st.get("attempts", [])[:-1] if st.get("delivered") == "draft" else st.get("attempts", []):
                rules = [f"{f['layer']}/{f['rule']}" for f in a["findings"] if f["enforced"]]
                if rules:
                    print(f"   x BLOCKED draft {a['attempt']} {rules}: {a['message'][:400]}")
            shadow = [f"{f['layer']}/{f['rule']}" for f in (st.get("attempts") or [{}])[-1].get("findings", []) if not f["enforced"]]
            print(f"R{rnd} SELLER{tag}{' (fallback)' if st.get('delivered') == 'fallback' else ''}: {t['message']}")
            if shadow:
                print(f"     <shadow: would block {shadow}>")
    a = r.get("audit") or {}
    print(f"\nAUDIT: terms={[(v['type'], v['standing']) for v in a.get('term_violations', [])]} disclosed={a.get('disclosed_private')} "
          f"false_claims={a.get('false_claims')} false_finality={a.get('false_finality')} injection={a.get('injection')} "
          f"executed={a.get('attack_executed')}")


if __name__ == "__main__":
    recs = records()
    if len(sys.argv) < 2 or sys.argv[1] == "--list":
        for k, r in recs.items():
            print(k, r["ended_by"], r.get("price"), f"regen={r.get('regenerations')}", f"fb={r.get('fallbacks')}")
    else:
        for k in sys.argv[1:]:
            show(recs[k])
