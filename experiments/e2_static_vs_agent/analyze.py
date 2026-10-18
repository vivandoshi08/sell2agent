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

from sales_agent.metrics import compare, markdown_table, summarize
from sales_agent.personas import make_personas
from sales_agent.runlog import load

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


def load_arm(tag: str, arm: str) -> list[dict]:
    rows = load(HERE / "runs" / f"{tag + '_' if tag else ''}{ARMS[arm]}.jsonl")
    # Keep the last non-error record per persona (a resumed run may have retried errors).
    by_persona: dict[str, dict] = {}
    for r in rows:
        if r["persona_id"] not in by_persona or by_persona[r["persona_id"]]["ended_by"] == "error":
            by_persona[r["persona_id"]] = r
    return list(by_persona.values())


def paired_compare(a: list[dict], b: list[dict], bootstrap: int = 4000, seed: int = 0) -> dict:
    """b minus a over the personas both arms ran, resampling personas."""
    A = {r["persona_id"]: r for r in a if r["ended_by"] != "error"}
    B = {r["persona_id"]: r for r in b if r["ended_by"] != "error"}
    ids = sorted(set(A) & set(B))
    if not ids:
        return {}
    dp = [(B[i]["profit"] if B[i]["deal"] else 0) - (A[i]["profit"] if A[i]["deal"] else 0) for i in ids]
    dc = [int(B[i]["deal"]) - int(A[i]["deal"]) for i in ids]
    base = mean((A[i]["profit"] if A[i]["deal"] else 0) for i in ids)
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
        "same_decision_rate": round(sum(1 for i in ids if A[i]["deal"] == B[i]["deal"]) / n, 4),
    }


def decompose(a: list[dict], c: list[dict]) -> dict:
    """Where c gains or loses profit against a, persona by persona."""
    A = {r["persona_id"]: r for r in a if r["ended_by"] != "error"}
    C = {r["persona_id"]: r for r in c if r["ended_by"] != "error"}
    cats: dict[str, dict] = {}

    def add(cat, pid, diff):
        d = cats.setdefault(cat, {"n": 0, "profit_diff": 0, "personas": []})
        d["n"] += 1
        d["profit_diff"] += diff
        d["personas"].append(pid)

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
    by = {k: {r["persona_id"]: r for r in v} for k, v in arms.items()}
    head = "| persona | zone | wants | walk-away | floor | list | " + " | ".join(keys) + " |"
    lines = [head, "|---|---|---|---|---|---|" + "---|" * len(keys)]
    for p in personas:
        cells = []
        for k in keys:
            r = by[k].get(p.id)
            if r is None:
                cells.append("")
            elif r["ended_by"] == "error":
                cells.append("error")
            elif r["deal"]:
                bundle = r["product_id"] + ("+" + "+".join(a[0].upper() for a in r["addons"]) if r["addons"] else "")
                flag = " OVERPAID" if r.get("buyer_overpaid") else ""
                cells.append(f"${r['price']:,} {bundle}{flag}")
            else:
                cells.append("no deal")
        wants = p.target_product + ("+" + "+".join(a[0].upper() for a in p.wants_addons) if p.wants_addons else "")
        lines.append(f"| {p.id} | {zone(p)} | {wants} | ${p.walk_away:,} | ${p.floor:,} | ${p.list:,} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


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
    args = ap.parse_args()

    personas = make_personas(N, seed=SEED)
    zones = {p.id: zone(p) for p in personas}
    arms = {k: load_arm(args.tag, k) for k in ARMS}
    arms = {k: v for k, v in arms.items() if v}
    named = {ARMS[k]: v for k, v in arms.items()}

    res: dict = {"seed": SEED, "n_personas": N, "zones": dict(Counter(zones.values())), "arms": {}, "comparisons": {}}
    for k, rows in arms.items():
        s = summarize(rows)
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

    name = f"{args.tag + '_' if args.tag else ''}results.json"
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
    print("\n## By persona type\n")
    print(zone_table(res["by_persona_type"]))
    for key in ("decomposition_c_vs_a", "decomposition_c_vs_b", "decomposition_d_vs_a"):
        if key in res:
            print(f"\n## {key}\n")
            for cat, d in res[key].items():
                print(f"- {cat}: n={d['n']}, profit diff ${d['profit_diff']:,}")
    print("\n## Per persona\n")
    print(persona_table(named, personas))
    print("\n## Other\n")
    for k, s in res["arms"].items():
        extra = {x: s.get(x) for x in ("seller_cost_per_deal", "judge_cost_usd", "sessions_with_false_claims",
                                        "deals_with_false_claims", "ended_by", "arithmetic_errors", "bundle_vs_wanted",
                                        "model_cost_usd", "errors") if x in s}
        print(f"- {k}: {extra}")
    print("\n## Verdicts\n")
    print(json.dumps(verdicts, indent=2))
    total = sum(s.get("model_cost_usd", 0) + s.get("judge_cost_usd", 0) for s in res["arms"].values())
    print(f"\nTotal model cost in these runs (incl. judge): ${total:.2f}")


if __name__ == "__main__":
    main()
