"""E2 analysis: KPIs per arm, comparisons with CIs, and the by-persona-type breakdown.

    uv run python experiments/e2_static_vs_agent/analyze.py [--tag pilot]

Writes results.json (or <tag>_results.json) and prints the markdown tables
used in the README.

Besides the harness's metrics.compare (an unpaired bootstrap), this adds a
paired bootstrap: the same persona faces every arm, so we resample personas
and take the per-persona difference. That's the tighter, correct interval
for this design.
"""

from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from pathlib import Path
from statistics import mean

from sell2agent.metrics import compare, markdown_table, summarize
from sell2agent.personas import make_personas
from sell2agent.runlog import load

from static_buyer import zone

HERE = Path(__file__).resolve().parent
SEED, N = 202, 30
ARMS = {
    "a": "a_static_html",
    "b": "b_json_feed",
    "c": "c_negotiating_agent",
    "d": "d_fixed_price_agent",
}
ZONES = ["below_floor", "haggle_zone", "above_list"]
TABLE_KEYS = [
    "sessions", "conversion", "feasible_conversion", "safe_conversion", "revenue", "profit",
    "margin", "profit_per_session", "avg_price", "avg_discount_from_list", "surplus_capture",
    "avg_rounds", "buyer_overpaid", "violations_closed", "model_cost_per_deal",
]


def rep(r: dict) -> int:
    return r["meta"].get("rep", 1)


def load_arm(tag: str, arm: str, reps: set[int] | None = None) -> list[dict]:
    rows = load(HERE / "runs" / f"{tag + '_' if tag else ''}{ARMS[arm]}.jsonl")
    # One record per (persona, rep): a non-error one if any (a resumed run may have retried errors).
    keyed: dict[tuple, dict] = {}
    for r in rows:
        if reps and rep(r) not in reps:
            continue
        k = (r["persona_id"], rep(r))
        if k not in keyed or keyed[k]["ended_by"] == "error":
            keyed[k] = r
    return list(keyed.values())


def _profit(r: dict) -> int:
    return r["profit"] if r["deal"] else 0


def _per_persona(rows: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for r in rows:
        if r["ended_by"] != "error":
            out.setdefault(r["persona_id"], []).append(r)
    return out


def paired_compare(a: list[dict], b: list[dict], bootstrap: int = 4000, seed: int = 0) -> dict:
    """b minus a, resampling personas. With replicates, each persona's value is its mean over reps."""
    A, B = _per_persona(a), _per_persona(b)
    ids = sorted(set(A) & set(B))
    if not ids:
        return {}
    pa = {i: mean(_profit(r) for r in A[i]) for i in ids}
    pb = {i: mean(_profit(r) for r in B[i]) for i in ids}
    ca = {i: mean(int(r["deal"]) for r in A[i]) for i in ids}
    cb = {i: mean(int(r["deal"]) for r in B[i]) for i in ids}
    dp = [pb[i] - pa[i] for i in ids]
    dc = [cb[i] - ca[i] for i in ids]
    base = mean(pa.values())
    rng = random.Random(seed)
    n = len(ids)
    bp, bc = [], []
    for _ in range(bootstrap):
        idx = [rng.randrange(n) for _ in range(n)]
        bp.append(mean(dp[k] for k in idx))
        bc.append(mean(dc[k] for k in idx))
    bp.sort()
    bc.sort()
    lo, hi = int(0.025 * bootstrap), int(0.975 * bootstrap) - 1
    return {
        "n_paired": n,
        "profit_per_session_diff": round(mean(dp), 2),
        "profit_per_session_diff_ci95": [round(bp[lo], 2), round(bp[hi], 2)],
        "profit_per_session_lift_pct": round(mean(dp) / base * 100, 1) if base else None,
        "conversion_diff": round(mean(dc), 4),
        "conversion_diff_ci95": [round(bc[lo], 4), round(bc[hi], 4)],
        # Share of (persona, rep) pairs where both arms made the same buy/no-buy call.
        "same_decision_rate": _same_decision(a, b),
    }


def _same_decision(a: list[dict], b: list[dict]) -> float | None:
    A = {(r["persona_id"], rep(r)): r for r in a if r["ended_by"] != "error"}
    B = {(r["persona_id"], rep(r)): r for r in b if r["ended_by"] != "error"}
    keys = set(A) & set(B)
    return round(sum(1 for k in keys if A[k]["deal"] == B[k]["deal"]) / len(keys), 4) if keys else None


def decompose(a: list[dict], c: list[dict]) -> dict:
    """Where c gains or loses profit against a, matching (persona, rep) pairs."""
    A = {(r["persona_id"], rep(r)): r for r in a if r["ended_by"] != "error"}
    C = {(r["persona_id"], rep(r)): r for r in c if r["ended_by"] != "error"}
    cats: dict[str, dict] = {}

    def add(cat, pid, diff):
        d = cats.setdefault(cat, {"n": 0, "profit_diff": 0, "personas": []})
        d["n"] += 1
        d["profit_diff"] += diff
        d["personas"].append(f"{pid[0]}/r{pid[1]}")

    for pid in sorted(set(A) & set(C)):
        ra, rc = A[pid], C[pid]
        pa = ra["profit"] if ra["deal"] else 0
        pc = rc["profit"] if rc["deal"] else 0
        if not ra["deal"] and not rc["deal"]:
            add("neither_closed", pid, 0)
        elif rc["deal"] and not ra["deal"]:
            add("agent_closed_page_lost", pid, pc - pa)
        elif ra["deal"] and not rc["deal"]:
            add("page_closed_agent_lost", pid, pc - pa)
        elif pc > pa:
            add("both_closed_agent_more", pid, pc - pa)
        elif pc < pa:
            add("both_closed_agent_less", pid, pc - pa)
        else:
            add("both_closed_same", pid, 0)
    return cats


def zone_breakdown(arms: dict[str, list[dict]], zones: dict[str, str]) -> dict:
    out = {}
    for z in ZONES:
        out[z] = {}
        for arm, rows in arms.items():
            xs = [r for r in rows if zones.get(r["persona_id"]) == z and r["ended_by"] != "error"]
            if not xs:
                continue
            deals = [r for r in xs if r["deal"]]
            out[z][arm] = {
                "sessions": len(xs),
                "deals": len(deals),
                "conversion": round(len(deals) / len(xs), 3),
                "profit_per_session": round(sum(r["profit"] for r in deals) / len(xs), 0),
                "avg_price": round(mean(r["price"] for r in deals), 0) if deals else None,
                "avg_discount_from_list": round(mean(1 - r["price"] / r["list_total"] for r in deals), 4) if deals else None,
                "buyer_overpaid": sum(1 for r in deals if r.get("buyer_overpaid")),
            }
    return out


def zone_table(zb: dict) -> str:
    lines = ["| persona type | arm | n | deals | conversion | profit/session | avg price | avg discount | overpaid |",
             "|---|---|---|---|---|---|---|---|---|"]
    for z, arms in zb.items():
        for arm, s in arms.items():
            disc = "" if s["avg_discount_from_list"] is None else f"{s['avg_discount_from_list']:.1%}"
            price = "" if s["avg_price"] is None else f"${s['avg_price']:,.0f}"
            lines.append(f"| {z} | {arm} | {s['sessions']} | {s['deals']} | {s['conversion']:.0%} | "
                         f"${s['profit_per_session']:,.0f} | {price} | {disc} | {s['buyer_overpaid']} |")
    return "\n".join(lines)


def persona_table(arms: dict[str, list[dict]], personas) -> str:
    keys = list(arms)
    by = {k: _per_persona(v) for k, v in arms.items()}
    ran = {k: {r["persona_id"] for r in v} for k, v in arms.items()}
    head = "| persona | zone | wants | walk-away | floor | list | " + " | ".join(keys) + " |"
    lines = [head, "|---|---|---|---|---|---|" + "---|" * len(keys)]
    for p in personas:
        cells = []
        for k in keys:
            if p.id not in ran[k]:
                cells.append("")
                continue
            rs = sorted(by[k].get(p.id, []), key=rep)
            parts = []
            for r in rs:
                if r["deal"]:
                    bundle = r["product_id"] + ("+" + "+".join(a[0].upper() for a in r["addons"]) if r["addons"] else "")
                    flag = " OVERPAID" if r.get("buyer_overpaid") else ""
                    parts.append(f"${r['price']:,} {bundle}{flag}")
                else:
                    parts.append("no deal")
            cells.append(" / ".join(parts) or "error")
        wants = p.target_product + ("+" + "+".join(a[0].upper() for a in p.wants_addons) if p.wants_addons else "")
        lines.append(f"| {p.id} | {zone(p)} | {wants} | ${p.walk_away:,} | ${p.floor:,} | ${p.list:,} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def oracle(personas) -> dict:
    """Profit ceilings with no model in the loop, per zone and overall.

    static: the buyer buys the most profitable bundle of its target tractor plus a subset of its wanted
            add-ons whose LIST total fits its walk-away.
    negotiate: same, but any bundle whose FLOOR fits, sold at min(walk-away, list) (perfect price discrimination).
    """
    from itertools import combinations

    from sell2agent.catalog import cost_total, floor_total, list_total

    rows = []
    for p in personas:
        subsets = [list(c) for k in range(len(p.wants_addons) + 1) for c in combinations(p.wants_addons, k)]
        st = [list_total(p.target_product, s) - cost_total(p.target_product, s) for s in subsets
              if list_total(p.target_product, s) <= p.walk_away]
        ng = [min(p.walk_away, list_total(p.target_product, s)) - cost_total(p.target_product, s) for s in subsets
              if floor_total(p.target_product, s) <= p.walk_away]
        rows.append((zone(p), max(st, default=0), max(ng, default=0)))
    out = {"all": {"static_pps": round(mean(r[1] for r in rows)), "negotiate_pps": round(mean(r[2] for r in rows)),
                   "static_conv": round(mean(r[1] > 0 for r in rows), 3), "negotiate_conv": round(mean(r[2] > 0 for r in rows), 3)}}
    for z in ZONES:
        zs = [r for r in rows if r[0] == z]
        if zs:
            out[z] = {"n": len(zs), "static_pps": round(mean(r[1] for r in zs)), "negotiate_pps": round(mean(r[2] for r in zs)),
                      "static_conv": round(mean(r[1] > 0 for r in zs), 3), "negotiate_conv": round(mean(r[2] > 0 for r in zs), 3)}
    return out


def _last_offer_ok(r: dict) -> bool:
    offers = [t["offer"] for t in r["transcript"] if t["role"] == "seller" and t["action"] == "offer" and t.get("offer")]
    return bool(offers) and offers[-1]["price"] <= r["walk_away"]


def extras(rows: list[dict]) -> dict:
    """Sensitivity and behavior checks that the harness summary doesn't cover."""
    ok = [r for r in rows if r["ended_by"] != "error"]
    deals = [r for r in ok if r["deal"]]
    clean_profit = sum(r["profit"] for r in deals if not r.get("buyer_overpaid"))
    seller_turns = [t for r in ok for t in r["transcript"] if t["role"] == "seller"]
    return {
        # Count deals where the buyer paid above its walk-away as no deal (they're buyer errors).
        "profit_per_session_excl_overpaid": round(clean_profit / len(ok), 2) if ok else None,
        "deals_at_floor": sum(1 for r in deals if r["price"] == r["floor_total"]),
        "deals_within_2pct_of_floor": sum(1 for r in deals if r["price"] <= r["floor_total"] * 1.02),
        "deals_at_list": sum(1 for r in deals if r["price"] >= r["list_total"]),
        "seller_turns_saying_floor": sum(1 for t in seller_turns if "floor" in t["message"].lower()),
        # Round cap hit right after the seller made an offer the buyer could have accepted (<= walk-away).
        # The harness ends on the seller's last turn, so the buyer never gets to say yes.
        "round_cap_with_acceptable_last_offer": sum(1 for r in ok if r["ended_by"] == "round_cap" and _last_offer_ok(r)),
        "sessions_where_seller_said_floor": sum(
            1 for r in ok if any(t["role"] == "seller" and "floor" in t["message"].lower() for t in r["transcript"])),
    }


def seller_cost(rows: list[dict]) -> dict:
    ok = [r for r in rows if r["ended_by"] != "error"]
    deals = [r for r in ok if r["deal"]]
    s = sum(r["meta"].get("seller_usage", {}).get("cost_usd", 0) for r in ok)
    j = sum(r["meta"].get("judge_usage", {}).get("cost_usd", 0) for r in ok)
    return {
        "seller_cost_usd": round(s, 4),
        "seller_cost_per_session": round(s / len(ok), 4) if ok else None,
        "seller_cost_per_deal": round(s / len(deals), 4) if deals else None,
        "judge_cost_usd": round(j, 4),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="")
    ap.add_argument("--reps", default="", help="only use these replicates, e.g. 1 (default: all)")
    ap.add_argument("--out", default="", help="results file name (default: [<tag>_]results.json)")
    args = ap.parse_args()
    reps = {int(x) for x in args.reps.split(",")} if args.reps else None

    personas = make_personas(N, seed=SEED)
    zones = {p.id: zone(p) for p in personas}
    arms = {k: load_arm(args.tag, k, reps) for k in ARMS}
    arms = {k: v for k, v in arms.items() if v}
    named = {ARMS[k]: v for k, v in arms.items()}

    res: dict = {"seed": SEED, "n_personas": N, "zones": dict(Counter(zones.values())), "arms": {}, "comparisons": {}}
    for k, rows in arms.items():
        s = summarize(rows)
        s.update(extras(rows))
        if k in "cd":
            s.update(seller_cost(rows))
            s["sessions_with_false_claims"] = sum(1 for r in rows if r.get("false_claims"))
            s["deals_with_false_claims"] = sum(1 for r in rows if r.get("false_claims") and r["deal"])
            s["ended_by"] = dict(Counter(r["ended_by"] for r in rows))
        else:
            deals = [r for r in rows if r["deal"]]
            s["seller_cost_per_deal"] = 0.0
            s["arithmetic_errors"] = sum(1 for r in deals if r["meta"].get("arithmetic_error"))
            s["bundle_vs_wanted"] = dict(Counter(r["meta"].get("bundle_vs_wanted") for r in deals))
        res["arms"][ARMS[k]] = s
        per_rep = {}
        for rp in sorted({rep(r) for r in rows}):
            sr = summarize([r for r in rows if rep(r) == rp], bootstrap=0)
            per_rep[rp] = {x: sr[x] for x in ("sessions", "conversion", "profit_per_session", "avg_price")}
        res.setdefault("per_rep", {})[ARMS[k]] = per_rep

    pairs = [("a", "c"), ("b", "c"), ("a", "b"), ("a", "d"), ("d", "c"), ("b", "d")]
    for x, y in pairs:
        if x in arms and y in arms:
            res["comparisons"][f"{x}_vs_{y}"] = {
                "unpaired_harness": compare(arms[x], arms[y]),
                "paired": paired_compare(arms[x], arms[y]),
            }
    if "a" in arms and "c" in arms:
        res["decomposition_c_vs_a"] = decompose(arms["a"], arms["c"])
    if "b" in arms and "c" in arms:
        res["decomposition_c_vs_b"] = decompose(arms["b"], arms["c"])
    if "a" in arms and "d" in arms:
        res["decomposition_d_vs_a"] = decompose(arms["a"], arms["d"])
    res["by_persona_type"] = zone_breakdown(named, zones)
    res["oracle_ceilings"] = oracle(personas)
    # Seed 202 drew only 2/30 above-list buyers; the generator's nominal mix is ~30/50/20.
    # Reweight per-zone profit/session to that mix as a sensitivity check.
    mix = {"below_floor": 0.3, "haggle_zone": 0.5, "above_list": 0.2}
    res["reweighted_to_nominal_mix"] = {
        arm: round(sum(mix[z] * res["by_persona_type"][z][arm]["profit_per_session"] for z in ZONES), 0)
        for arm in named if all(arm in res["by_persona_type"][z] for z in ZONES)
    }

    # Verdicts against the bar in EXPERIMENTS.md.
    verdicts = {}
    if "a" in arms and "c" in arms:
        sa, sc = res["arms"][ARMS["a"]], res["arms"][ARMS["c"]]
        sb = res["arms"].get(ARMS["b"])
        lift = res["comparisons"]["a_vs_c"]["paired"]["profit_per_session_lift_pct"]
        beaten = sa["profit_per_session"] >= sc["profit_per_session"] or (sb and sb["profit_per_session"] >= sc["profit_per_session"])
        if beaten:
            v = "invalidated"
        elif lift is not None and lift >= 10 and sc["conversion"] >= sa["conversion"]:
            v = "validated"
        else:
            v = "inconclusive"
        verdicts["A3"] = {"verdict": v, "lift_pct_vs_a": lift, "conversion_a": sa["conversion"], "conversion_c": sc["conversion"]}
    if "a" in arms and "b" in arms:
        pc = res["comparisons"]["a_vs_b"]["paired"]
        ci = pc["conversion_diff_ci95"]
        verdicts["B1"] = {"conversion_diff_b_minus_a": pc["conversion_diff"], "ci95": ci,
                          "same_decision_rate": pc["same_decision_rate"],
                          "answer": "format changed the buy rate" if (ci[0] > 0 or ci[1] < 0) else "no detectable format effect"}
    res["verdicts"] = verdicts

    name = args.out or f"{args.tag + '_' if args.tag else ''}results.json"
    (HERE / name).write_text(json.dumps(res, indent=2, default=str) + "\n")

    print("## KPI table\n")
    print(markdown_table(named, TABLE_KEYS))
    print("\n## CIs (harness summarize)\n")
    for k, s in res["arms"].items():
        print(f"- {k}: conversion {s['conversion']} {s.get('conversion_ci95')}, profit/session {s['profit_per_session']} {s.get('profit_per_session_ci95')}")
    print("\n## Comparisons (second minus first)\n")
    for key, c in res["comparisons"].items():
        u, p = c["unpaired_harness"], c["paired"]
        print(f"- {key}: profit/session diff {p['profit_per_session_diff']} paired CI {p['profit_per_session_diff_ci95']} "
              f"(unpaired CI {u['profit_per_session_diff_ci95']}), lift {p['profit_per_session_lift_pct']}%; "
              f"conversion diff {p['conversion_diff']} paired CI {p['conversion_diff_ci95']} (unpaired {u['conversion_diff_ci95']}); "
              f"same decision {p['same_decision_rate']}")
    print("\n## Per replicate\n")
    for k, pr in res["per_rep"].items():
        print(f"- {k}: " + "; ".join(f"r{rp}: n={v['sessions']} conv={v['conversion']} pps={v['profit_per_session']}" for rp, v in pr.items()))
    print("\n## By persona type\n")
    print(zone_table(res["by_persona_type"]))
    for key in ("decomposition_c_vs_a", "decomposition_c_vs_b", "decomposition_d_vs_a"):
        if key in res:
            print(f"\n## {key}\n")
            for cat, d in res[key].items():
                print(f"- {cat}: n={d['n']}, profit diff ${d['profit_diff']:,}")
    print("\n## Profit/session reweighted to the nominal 30/50/20 zone mix\n")
    print(res["reweighted_to_nominal_mix"])
    print("\n## Oracle ceilings (no model)\n")
    for z, o in res["oracle_ceilings"].items():
        print(f"- {z}: {o}")
    print("\n## Per persona\n")
    print(persona_table(named, personas))
    print("\n## Other\n")
    for k, s in res["arms"].items():
        extra = {x: s.get(x) for x in ("profit_per_session_excl_overpaid", "deals_at_floor", "deals_within_2pct_of_floor",
                                        "deals_at_list", "round_cap_with_acceptable_last_offer", "sessions_where_seller_said_floor", "seller_cost_per_deal", "judge_cost_usd", "sessions_with_false_claims",
                                        "deals_with_false_claims", "ended_by", "arithmetic_errors", "bundle_vs_wanted",
                                        "model_cost_usd", "errors") if x in s}
        print(f"- {k}: {extra}")
    print("\n## Verdicts\n")
    print(json.dumps(verdicts, indent=2))
    total = sum(s.get("model_cost_usd", 0) + s.get("judge_cost_usd", 0) for s in res["arms"].values())
    print(f"\nTotal model cost in these runs (incl. judge): ${total:.2f}")


if __name__ == "__main__":
    main()
