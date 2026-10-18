"""Re-grade every recorded seller draft with the current OutputGuard (no model calls).

    uv run python experiments/e9_safety/regrade.py

The runs used guard v1 (Opus attack cells) and v2 (everything else). After the runs,
v3 fixed false positives found while hand-labelling blocked drafts. This script asks:
on exactly the drafts the sellers wrote, which blocks would the current rules keep
or release, and would they flag anything new on delivered text? Each draft is
checked against the context rebuilt from the transcript (bundle, standing offer,
earlier seller offers, buyer figures). Finality context is taken from the original
run (a draft the original guard flagged as "final_not_final" was not a final move),
so only the wording rules change. Compares against runs/fp_labels.json.
Writes runs/regrade.json.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
sys.path.insert(0, str(HERE))

from guardrails import CONDITIONS, GUARD_VERSION, OutputGuard, SessionPolicy, SessionState, TurnContext, money_figures  # noqa: E402
from sell2agent.policy import PolicyEngine  # noqa: E402
from sell2agent.policy import Offer  # noqa: E402
from sell2agent.runlog import load  # noqa: E402

RUNS = HERE / "runs"


def _o(d):
    return Offer(d["product_id"], int(d["price"]), list(d.get("addons") or [])) if d else None


def main() -> None:
    og = OutputGuard()
    labels = json.loads((RUNS / "fp_labels.json").read_text()) if (RUNS / "fp_labels.json").exists() else {}
    released, kept, new_flags = [], [], []
    stats = Counter()
    for r in load(RUNS / "attacks.jsonl") + load(RUNS / "control.jsonl"):
        if r.get("ended_by") == "error":
            continue
        arm = r["meta"]["arm"]
        output_on = r["meta"]["condition"] in ("G2", "G3", "G4")
        turns = {t["round"]: t for t in r.get("seller_turns") or []}
        cfg = CONDITIONS[r["meta"]["condition"]]
        sp = SessionPolicy(PolicyEngine(), cfg, SessionState())
        freeze_round = min((e["round"] for e in r.get("events") or [] if e.get("rule") == "circuit_breaker" and e.get("enforced")), default=None)
        max_rounds = r.get("max_rounds") or 8
        persona_bundle = None
        tr = r["transcript"]
        rnd = 0
        for i, t in enumerate(tr):
            if t["role"] == "buyer":
                rnd += 1
                continue
            before = tr[:i]
            buyer_offers = [_o(x["offer"]) for x in before if x["role"] == "buyer" and x["action"] == "offer" and x.get("offer")]
            seller_offers = [_o(x["offer"]) for x in before if x["role"] == "seller" and x["action"] == "offer" and x.get("offer")]
            figs = set()
            for x in before:
                if x["role"] == "buyer":
                    figs |= {v for v, _ in money_figures(x["message"])}
                    if x.get("offer"):
                        figs.add(int(x["offer"]["price"]))
            last_offer = next((x["offer"] for x in reversed(before) if x.get("offer")), None)
            bundle = (last_offer["product_id"], list(last_offer["addons"])) if last_offer else (persona_bundle or ("T45", []))
            for a in (turns.get(rnd) or {}).get("attempts", []):
                target = _o(a["offer"]) if a["action"] == "offer" else (buyer_offers[-1] if a["action"] == "accept" and buyer_offers else None)
                orig = [f for f in a["findings"] if f["layer"] == "output"]
                o = _o(a["offer"]) if a["action"] == "offer" else None
                final_allowed = bool(o and (rnd >= max_rounds or o.price <= sp.offer_low(o.product_id, o.addons)
                                            or (freeze_round is not None and rnd >= freeze_round)))
                ctx = TurnContext(action=a["action"], offer=target, bundle=bundle, standing=seller_offers[-1] if seller_offers else None,
                                  seller_offers=seller_offers, buyer_figures=figs, final_allowed=final_allowed, lock_mode=arm == "open")
                found = og.check(a["message"], ctx)
                now = {f.rule for f in found}
                spans = {f.rule: f.span for f in found}
                before_rules = {f["rule"] for f in orig}
                stats["drafts"] += 1
                if output_on:
                    for rule in sorted(before_rules):
                        key = f"{r['job']}|{rnd}|{a['attempt']}|{rule}"
                        rec = {"key": key, "rule": rule, "label": labels.get(key), "message": a["message"][:300]}
                        (kept if rule in now else released).append(rec)
                for rule in sorted(now - before_rules):
                    new_flags.append({"job": r["job"], "round": rnd, "attempt": a["attempt"], "rule": rule, "span": spans.get(rule, ""),
                                      "delivered": (turns.get(rnd) or {}).get("delivered") == "draft" and a is (turns.get(rnd) or {}).get("attempts", [None])[-1]})
    def lab(xs, v):
        return sum(1 for x in xs if x["label"] == v)
    res = {
        "guard_version_now": GUARD_VERSION,
        "drafts_checked": stats["drafts"],
        "original_blocks": len(kept) + len(released),
        "blocks_kept": len(kept), "blocks_released": len(released),
        "kept_labelled_violation": lab(kept, "violation"), "kept_labelled_ok": lab(kept, "ok"),
        "released_labelled_violation": lab(released, "violation"), "released_labelled_ok": lab(released, "ok"),
        "unlabelled": sum(1 for x in kept + released if x["label"] is None),
        "new_flags": len(new_flags), "new_flags_by_rule": dict(Counter(x["rule"] for x in new_flags)),
        "released": released, "kept_ok": [x for x in kept if x["label"] == "ok"], "new": new_flags,
    }
    (RUNS / "regrade.json").write_text(json.dumps(res, indent=1))
    print(json.dumps({k: v for k, v in res.items() if k not in ("released", "kept_ok", "new")}, indent=1))
    for x in res["kept_ok"]:
        print("  still blocked, labelled ok:", x["key"], "|", x["message"][:160])
    for x in res["released"]:
        if x["label"] == "violation":
            print("  RELEASED a labelled violation:", x["key"], "|", x["message"][:160])
    for x in new_flags:
        print("  new flag:", x["job"], x["round"], x["rule"], "delivered" if x["delivered"] else "draft", "|", x["span"][:150])


if __name__ == "__main__":
    main()
