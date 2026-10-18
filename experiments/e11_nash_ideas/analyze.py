"""E11 analysis: reads runs/*, prints tables, writes results.json.

    uv run python experiments/e11_nash_ideas/analyze.py
"""

from __future__ import annotations

import json
import random
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))

from sell2agent.metrics import summarize  # noqa: E402
from sell2agent.runlog import load  # noqa: E402

RUNS = HERE / "runs"


def paired(a: dict, b: dict, key, n: int = 4000, seed: int = 0) -> dict:
    """Paired bootstrap of mean(b - a) over shared ids. key(record) -> number."""
    ids = sorted(set(a) & set(b))
    if not ids:
        return {}
    diffs = [key(b[i]) - key(a[i]) for i in ids]
    rng = random.Random(seed)
    boots = sorted(statistics.mean(diffs[rng.randrange(len(diffs))] for _ in diffs) for _ in range(n))
    return {"n": len(ids), "mean_diff": round(statistics.mean(diffs), 2),
            "ci95": [round(boots[int(0.025 * n)], 2), round(boots[int(0.975 * n) - 1], 2)]}


def cost_of(records, keys=("usage",)) -> float:
    return round(sum((r.get(k) or {}).get("cost_usd", 0) for r in records for k in keys), 4)


# ============================================================== Part 1


def part1() -> dict:
    out = {}
    sim = RUNS / "part1_sim.json"
    if sim.exists():
        d = json.loads(sim.read_text())
        out["sim"] = {"summary": d["summary"], "breaker_sweep": d.get("breaker_sweep", []), "conditions": d["conditions"]}
    seqs = load(RUNS / "part1_llm_seqs.jsonl")
    sess = load(RUNS / "part1_llm.jsonl")
    if seqs:
        rows = []
        for s in sorted(seqs, key=lambda r: r["job"]):
            mine = sorted([x for x in sess if x["job"].startswith(s["job"] + "|")], key=lambda x: x["meta"]["session"])
            traj = []
            for x in mine:
                offers = [t["offer"]["price"] for t in x["transcript"] if t["role"] == "seller" and t["offer"]]
                bids = [t["offer"]["price"] for t in x["transcript"] if t["role"] == "buyer" and t["offer"]]
                traj.append({"session": x["meta"]["session"], "ended_by": x["ended_by"], "price": x.get("price"),
                             "min_offer": min(offers) if offers else None, "max_bid": max(bids) if bids else None,
                             "rounds": x["rounds"], "end_price": x["xsession"]["end_price"], "tau0": x["xsession"]["tau0"],
                             "hard_zone_open": x["xsession"]["hard_zone_open_at_start"], "abandoned": x["xsession"]["abandoned"]})
            rows.append({"job": s["job"], "condition": s["condition"], "identity": s["identity"], "min_offer_seen": s["min_offer_seen"],
                         "lowest_deal": s["lowest_deal"], "final_deal": s["final_deal"], "floor": s["floor"], "soft_floor": s["soft_floor"],
                         "trajectory": traj})
        out["llm"] = {"sequences": rows, "cost_usd": cost_of(sess), "sessions": len(sess)}
        print("\nPart 1 LLM probe: per sequence (floor $41,700, soft floor $42,100)")
        for r in rows:
            t = " | ".join(f"s{x['session']}:{'deal ' + format(x['price'], ',') if x['price'] else x['ended_by']} min{x['min_offer']}" for x in r["trajectory"])
            print(f"  {r['job']:22s} min_offer={r['min_offer_seen']} lowest_deal={r['lowest_deal']} final={r['final_deal']}  {t}")
    return out


# ============================================================== Part 2


def part2() -> dict:
    recs = [r for r in load(RUNS / "part2.jsonl") if r.get("ended_by") not in ("skipped",)]
    if not recs:
        return {}
    by = defaultdict(list)
    for r in recs:
        by[r["meta"]["condition"]].append(r)
    res = {"conditions": {}, "paired": {}, "cost_usd": cost_of(recs)}
    print("\nPart 2: levers before discounts")
    hdr = f"{'condition':13s} {'n':>3s} {'conv':>5s} {'profit/sess':>11s} {'margin':>7s} {'avg price':>9s} {'lever $/deal':>12s} {'levers/deal':>11s} " \
          f"{'surplus':>8s} {'surplus+lv':>10s} {'rounds':>6s} {'blocks':>6s} {'fb':>3s} {'$/sess':>6s}"
    print(hdr)
    for c in ("price_only", "levers_first", "llm_levers"):
        rs = by.get(c, [])
        if not rs:
            continue
        ok = [r for r in rs if r["ended_by"] != "error"]
        s = summarize(ok, bootstrap=2000)
        deals = [r for r in ok if r["deal"]]
        lv = Counter(x for r in deals for x in r.get("levers", []))
        offered = Counter(x for r in ok for x in r.get("levers_offered", []))
        row = {
            **{k: s.get(k) for k in ("sessions", "errors", "deals", "conversion", "conversion_ci95", "profit_per_session", "profit_per_session_ci95",
                                     "margin", "avg_price", "avg_rounds", "model_cost_per_session")},
            "lever_cost_per_deal": round(statistics.mean(r.get("lever_cost", 0) for r in deals), 1) if deals else None,
            "levers_per_deal": round(statistics.mean(len(r.get("levers", [])) for r in deals), 2) if deals else None,
            "lever_value_per_deal": round(statistics.mean(r.get("lever_value", 0) for r in deals), 1) if deals else None,
            "levers_in_deals": dict(lv), "levers_offered_sessions": dict(offered),
            "buyer_price_surplus_per_deal": round(statistics.mean(r["price_surplus"] for r in deals), 1) if deals else None,
            "buyer_surplus_with_levers_per_deal": round(statistics.mean(r["surplus_with_levers"] for r in deals), 1) if deals else None,
            "policy_blocks": sum(r["violations_attempted"] for r in ok), "text_blocks": sum(r["text_blocks"] for r in ok),
            "fallbacks": sum(r["fallbacks"] for r in ok),
            "by_type": {},
        }
        for t in ("price_first", "quality_first"):
            tr = [r for r in ok if r["buyer_type"] == t]
            if tr:
                td = [r for r in tr if r["deal"]]
                row["by_type"][t] = {"sessions": len(tr), "conversion": round(len(td) / len(tr), 3),
                                     "profit_per_session": round(sum(r["profit"] for r in td) / len(tr), 1),
                                     "levers_per_deal": round(statistics.mean(len(r.get("levers", [])) for r in td), 2) if td else None}
        res["conditions"][c] = row
        print(f"{c:13s} {len(ok):>3d} {s['conversion']:>5} {s['profit_per_session']:>11} {s.get('margin')!s:>7} {s.get('avg_price')!s:>9} "
              f"{row['lever_cost_per_deal']!s:>12} {row['levers_per_deal']!s:>11} {row['buyer_price_surplus_per_deal']!s:>8} "
              f"{row['buyer_surplus_with_levers_per_deal']!s:>10} {s['avg_rounds']:>6} {row['policy_blocks']}/{row['text_blocks']:<3} {row['fallbacks']:>3} {s['model_cost_per_session']:>6}")
    ids = {c: {f"{r['persona_id']}-{r['buyer_type']}": r for r in by.get(c, []) if r["ended_by"] != "error"} for c in by}
    for b in ("levers_first", "llm_levers"):
        if b in ids and "price_only" in ids:
            res["paired"][f"{b}_vs_price_only"] = {
                "profit_per_session": paired(ids["price_only"], ids[b], lambda r: r["profit"] if r["deal"] else 0),
                "conversion": paired(ids["price_only"], ids[b], lambda r: 1 if r["deal"] else 0),
            }
            print(f"  paired {b} - price_only: profit/session {res['paired'][f'{b}_vs_price_only']['profit_per_session']}, "
                  f"conversion {res['paired'][f'{b}_vs_price_only']['conversion']}")
    for c, row in res["conditions"].items():
        print(f"  {c}: by type {row['by_type']} levers in deals {row['levers_in_deals']}")
    return res


# ============================================================== Part 4


def part4() -> dict:
    recs = [r for f in sorted(RUNS.glob("part4*.jsonl")) if "pilot" not in f.name for r in load(f) if r.get("ended_by") not in ("skipped",)]
    if not recs:
        return {}
    by = defaultdict(list)
    for r in recs:
        by[r["meta"]["condition"]].append(r)
    res = {"conditions": {}, "paired": {}, "cost_usd": round(cost_of(recs) + cost_of(recs, ("judge_usage",)), 4)}
    print("\nPart 4: claims library")
    print(f"{'condition':11s} {'n':>3s} {'fc rate':>7s} {'fc rate norm/probe':>18s} {'claims/sess':>11s} {'conv':>5s} {'profit/sess':>11s} {'rounds':>6s} "
          f"{'regen':>5s} {'fb':>3s} {'$/sess':>6s}")
    for c in ("free_noguard", "free_guard", "claims", "templated"):
        rs = [r for r in by.get(c, []) if r["ended_by"] != "error"]
        if not rs:
            continue
        s = summarize([{**r, "false_claims": r.get("false_claims", [])} for r in rs], bootstrap=2000)
        flagged = [r for r in rs if r.get("false_claims")]
        types = Counter(c_["type"] for r in rs for c_ in r.get("false_claims", []))
        rules = Counter(e["rule"] for r in rs for e in r["events"] if e.get("enforced") and e.get("action") in ("regenerate", "fallback"))
        shadow = Counter(e["rule"] for r in rs for e in r["events"] if not e.get("enforced") and e.get("layer") == "output")
        kinds = {}
        for k in ("normal", "probing"):
            kr = [r for r in rs if r["meta"]["buyer_kind"] == k]
            if kr:
                kinds[k] = {"sessions": len(kr), "false_claim_rate": round(sum(1 for r in kr if r.get("false_claims")) / len(kr), 3),
                            "conversion": round(sum(1 for r in kr if r["deal"]) / len(kr), 3)}
        row = {
            **{k: s.get(k) for k in ("sessions", "errors", "deals", "conversion", "conversion_ci95", "profit_per_session", "profit_per_session_ci95",
                                     "margin", "avg_price", "avg_rounds", "safe_conversion", "model_cost_per_session")},
            "false_claim_rate": round(len(flagged) / len(rs), 3),
            "false_claims_per_session": round(sum(len(r.get("false_claims", [])) for r in rs) / len(rs), 3),
            "false_claim_types": dict(types), "guard_blocks_by_rule": dict(rules), "shadow_output_findings": dict(shadow),
            "regenerations": sum(r["regenerations"] for r in rs), "fallbacks": sum(r["fallbacks"] for r in rs),
            "by_buyer": kinds,
            "judge_cost_usd": cost_of(rs, ("judge_usage",)),
        }
        res["conditions"][c] = row
        nk = kinds.get("normal", {}).get("false_claim_rate")
        pk = kinds.get("probing", {}).get("false_claim_rate")
        print(f"{c:11s} {len(rs):>3d} {row['false_claim_rate']:>7} {str(nk) + ' / ' + str(pk):>18s} {row['false_claims_per_session']:>11} {s['conversion']:>5} "
              f"{s['profit_per_session']:>11} {s['avg_rounds']:>6} {row['regenerations']:>5} {row['fallbacks']:>3} {s['model_cost_per_session']:>6}")
    ids = {c: {f"{r['persona_id']}-{r['meta']['buyer_kind']}": r for r in by.get(c, []) if r["ended_by"] != "error"} for c in by}
    for b in ("claims", "templated", "free_noguard"):
        if b in ids and "free_guard" in ids:
            res["paired"][f"{b}_vs_free_guard"] = {
                "false_claim_session": paired(ids["free_guard"], ids[b], lambda r: 1 if r.get("false_claims") else 0),
                "conversion": paired(ids["free_guard"], ids[b], lambda r: 1 if r["deal"] else 0),
                "profit_per_session": paired(ids["free_guard"], ids[b], lambda r: r["profit"] if r["deal"] else 0),
            }
            print(f"  paired {b} - free_guard: {res['paired'][f'{b}_vs_free_guard']}")
    for c, row in res["conditions"].items():
        print(f"  {c}: claim types {row['false_claim_types']}; guard blocks {row['guard_blocks_by_rule']}; by buyer {row['by_buyer']}")
    return res


def main() -> None:
    results = {"experiment": "E11", "part1": part1(), "part2": part2(), "part4": part4()}
    # Pilots that aren't part of the main logs: the Part 1 LLM pilot, and the three Part 2 pilot sessions discarded after
    # the text-check fix. (The other pilot sessions count toward the main runs and are in their logs.)
    pilots = sum(cost_of(load(RUNS / f)) + cost_of(load(RUNS / f), ("judge_usage",)) for f in ("part1_llm_pilot.jsonl", "part2_pilot_discarded.jsonl"))
    results["cost_usd"] = {
        "part1_llm": results["part1"].get("llm", {}).get("cost_usd", 0),
        "part2": results["part2"].get("cost_usd", 0),
        "part4": results["part4"].get("cost_usd", 0),
        "pilots_outside_main_logs": round(pilots, 4),
        # Three Part 1 sessions were in flight when the first main run was stopped to add resume; their spend was never
        # logged. Estimated at about half a session each (~$0.12).
        "unlogged_estimate": 0.35,
    }
    results["cost_usd"]["total"] = round(sum(results["cost_usd"].values()), 2)
    print("\nModel cost:", results["cost_usd"])
    (HERE / "results.json").write_text(json.dumps(results, indent=1, default=str))


if __name__ == "__main__":
    main()
