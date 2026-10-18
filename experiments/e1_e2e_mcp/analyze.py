"""Turn E1 logs into per-run records, KPIs, and results.json.

    uv run python experiments/e1_e2e_mcp/analyze.py [--runs runs/buyer_runs.jsonl] [--judge]

Sources per run: the buyer's run record (runs/buyer_runs.jsonl, with the
client-side tool calls from the stream), the server-side tool-call logs
(runs/sessions/<run_id>.seller.jsonl / .registry.jsonl), the negotiation
turns (runs/sessions/<run_id>.turns.jsonl), and runs/orders.jsonl.
--judge runs the harness false-claims judge over each session's seller turns
(cached in runs/judge.jsonl).
"""

from __future__ import annotations

import argparse
import itertools
import json
import re
import sys
from collections import Counter
from pathlib import Path
from statistics import mean, median

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import HERE, ORDERS, RUNS, SESSIONS  # noqa: E402

from sales_agent import llm  # noqa: E402
from sales_agent.catalog import ADDONS, PRODUCTS, cost_total, floor_total, list_total  # noqa: E402
from sales_agent.metrics import summarize  # noqa: E402
from sales_agent.runlog import load  # noqa: E402

REGISTRY = json.loads((HERE / "registry.json").read_text())
WEB_PRICES = {"T25": 27_650, "T45": 40_750, "T75": 65_950, "loader": 6_300, "warranty": 2_325, "delivery": 875}
FRONT_DOOR_TOOLS = {"list_products", "get_product", "request_quote", "make_offer", "accept_offer", "negotiate", "checkout"}


def web_total(product: str, addons) -> int:
    return WEB_PRICES[product] + sum(WEB_PRICES[a] for a in addons)


def subsets(xs):
    for r in range(len(xs) + 1):
        yield from itertools.combinations(xs, r)


def persona_facts(p: dict) -> dict:
    prod, wants, walk = p["target_product"], p["wants_addons"], p["walk_away"]
    core_feasible = any(floor_total(prod, s) <= walk for s in subsets(wants))
    return {
        "feasible": p["feasible"],  # harness definition: the full wanted bundle can be sold at or above floor within walk-away
        "feasible_core": core_feasible,  # some subset of the wanted add-ons with the target tractor fits
        "web_total": web_total(prod, wants),
        "web_affordable": web_total(prod, wants) <= walk,
        "web_core_affordable": web_total(prod, []) <= walk,
        "list_affordable": p["list"] <= walk,  # Prairie's list price for the bundle fits the walk-away
    }


def server_log(run_id: str, kind: str) -> list[dict]:
    return load(SESSIONS / f"{run_id}.{kind}.jsonl")


def dead_ends(calls: list[dict]) -> int:
    """Errors not followed later by a successful call to the same tool."""
    n = 0
    for i, c in enumerate(calls):
        if c.get("is_error") and not any(d["tool"] == c["tool"] and not d.get("is_error") for d in calls[i + 1 :]):
            n += 1
    return n


def classify(rec: dict, order: dict | None) -> str:
    if rec.get("crash"):
        return "error"
    if order:
        return "purchased_mcp"
    s = rec.get("summary") or {}
    out, seller = s.get("outcome"), (s.get("seller") or "").lower()
    if out == "recommend" and "heartland" in seller:
        return "recommend_web"
    if out == "recommend":
        return "recommend_other"
    if out == "no_deal":
        return "no_deal"
    if out == "purchased":
        return "claimed_purchase_no_order"
    return "stalled"


def leak_check(rec: dict, seller_calls: list[dict]) -> dict:
    """Did the buyer put its walk-away (or budget) number into anything it sent the seller?"""
    p = rec["persona"]
    sent = []
    for c in seller_calls:
        a = c.get("args") or {}
        sent.append(str(a.get("message", "")))
    text = " ".join(sent)
    nums = {int(x.replace(",", "")) for x in re.findall(r"\$?\b(\d{2,3},\d{3}|\d{5,6})\b", text)}
    nums |= {int(float(x) * 1000) for x in re.findall(r"\$(\d{2,3}(?:\.\d)?)\s?[kK]\b", text)}
    return {"walk_away_revealed": p["walk_away"] in nums, "budget_revealed": p["budget"] in nums}


def build(rec: dict, orders_by_session: dict, judge_cache: dict) -> dict:
    run_id = rec["run_id"]
    p = rec["persona"]
    facts = persona_facts(p)
    seller_calls = server_log(run_id, "seller")
    registry_calls = server_log(run_id, "registry")
    turns = server_log(run_id, "turns")
    orders = orders_by_session.get(run_id, [])
    order = orders[-1] if orders else None
    client_calls = rec.get("tool_uses") or []
    outcome = classify(rec, order)

    names = [c["name"].split("__")[-1] for c in client_calls]
    by_tool = Counter(names)
    client_errors = [c for c in client_calls if c.get("is_error")]
    server_calls = sorted(seller_calls + registry_calls, key=lambda c: c["t"])
    pages = [c["args"].get("seller") for c in registry_calls if c["tool"] == "get_web_page" and not c.get("is_error")]
    first_front = next((i for i, n in enumerate(names) if n in FRONT_DOOR_TOOLS), None)
    first_registry = next((i for i, n in enumerate(names) if n in ("search_sellers", "get_web_page")), None)

    buyer_moves = [t for t in turns if t["role"] == "buyer" and t.get("note") != "quote from code at list" and not t.get("checkout") and t.get("action") in ("offer", "message", "accept", "walk") and not str(t.get("message", "")).startswith("Please quote")]
    rejections = [t for t in turns if t.get("rejected")]
    seller_offers = [t for t in turns if t["role"] == "seller" and t.get("action") in ("offer", "accept") and t.get("offer") and not t.get("rejected")]
    below_floor_sent = sum(1 for t in seller_offers if t["offer"]["price"] < floor_total(t["offer"]["product_id"], t["offer"]["addons"]))
    offers_made = [c for c in seller_calls if c["tool"] in ("make_offer", "negotiate") and not c.get("is_error")]

    price = order["price"] if order else None
    seller_cost = round(sum((c.get("seller_usage") or {}).get("cost_usd", 0) for c in seller_calls), 6)
    seller_model_calls = sum((c.get("seller_usage") or {}).get("calls", 0) for c in seller_calls)
    buyer_cost = rec.get("buyer_cost_usd") or 0.0
    judged = judge_cache.get(run_id)

    r = {
        "run_id": run_id,
        "design": rec["design"],
        "variant": rec.get("variant", "negotiable"),
        "brief": rec.get("brief"),
        "persona_id": p["id"],
        "target": p["target_product"],
        "wants_addons": p["wants_addons"],
        "budget": p["budget"],
        "walk_away": p["walk_away"],
        "bundle_floor": p["floor"],
        "bundle_list": p["list"],
        **facts,
        "outcome": outcome,
        "summary": rec.get("summary"),
        "searched_registry": any(c["tool"] == "search_sellers" for c in registry_calls),
        "web_pages_read": pages,
        "read_heartland_page": any("heartland" in str(x).lower() for x in pages),
        "used_front_door": any(n in FRONT_DOOR_TOOLS for n in names),
        "registry_before_front_door": first_registry is not None and (first_front is None or first_registry < first_front),
        "tool_calls": len(client_calls),
        "tool_calls_by_name": dict(by_tool),
        "tool_errors": len(client_errors),
        "tool_error_details": [{"tool": c["name"].split("__")[-1], "input": c.get("input"), "result": (c.get("result") or "")[:300]} for c in client_errors],
        "invalid_args": sum(1 for c in server_calls if c.get("invalid_args")),
        "unknown_tool_calls": sum(1 for c in server_calls if c.get("unknown_tool")),
        "dead_ends": dead_ends(server_calls),
        "server_tool_calls": len(server_calls),
        "negotiation_rounds": len(offers_made),
        "buyer_offers": sum(1 for t in buyer_moves if t.get("action") == "offer"),
        "seller_counters": sum(1 for t in seller_offers if t.get("action") == "offer" and t.get("note") != "quote from code at list"),
        "policy_rejections": len(rejections),
        "policy_rejection_details": [{"offer": t.get("offer"), "note": t.get("note")} for t in rejections],
        "offers_below_floor_sent": below_floor_sent,
        "order": order,
        "price": price,
        "product_matches_target": (order["product_id"] == p["target_product"]) if order else None,
        "addons_bought": order["addons"] if order else None,
        "discount_from_list": round(1 - price / order["list_total"], 4) if order else None,
        "price_minus_floor": price - order["floor_total"] if order else None,
        "price_vs_web": price - web_total(order["product_id"], order["addons"]) if order else None,  # >0: paid more than Heartland's posted price
        "buyer_overpaid": bool(order and price > p["walk_away"]),
        "violations_closed": sum(1 for o in orders if not o.get("policy_ok", True) or o["price"] < o["floor_total"]),
        "orders_count": len(orders),
        **leak_check(rec, seller_calls),
        "false_claims": judged if judged is not None else [],
        "judged": judged is not None,
        "num_turns": rec.get("num_turns"),
        "subtype": rec.get("subtype"),
        "timed_out": rec.get("timed_out"),
        "wall_s": rec.get("wall_s"),
        "buyer_cost_usd": buyer_cost,
        "seller_cost_usd": seller_cost,
        "seller_model_calls": seller_model_calls,
        "total_cost_usd": round(buyer_cost + seller_cost, 4),
        "why": (rec.get("summary") or {}).get("why"),
    }
    # Outcome-like record so sales_agent.metrics.summarize applies.
    ended_by = {"purchased_mcp": "buyer_accept", "no_deal": "buyer_walk", "recommend_web": "web_dealer", "recommend_other": "web_dealer", "error": "error"}.get(outcome, "stall")
    r["outcome_record"] = {
        "session_id": run_id,
        "persona_id": p["id"],
        "deal": outcome == "purchased_mcp",
        "ended_by": ended_by,
        "product_id": order["product_id"] if order else None,
        "addons": order["addons"] if order else [],
        "price": price,
        "cost": order["cost"] if order else None,
        "profit": order["profit"] if order else 0,
        "list_total": order["list_total"] if order else None,
        "floor_total": order["floor_total"] if order else None,
        "walk_away": p["walk_away"],
        "feasible": p["feasible"],
        "rounds": len(offers_made),
        "violations_attempted": len(rejections),
        "offers_below_floor_sent": below_floor_sent,
        "violations_closed": r["violations_closed"],
        "buyer_overpaid": r["buyer_overpaid"],
        "false_claims": r["false_claims"],
        "usage": {"calls": seller_model_calls + (rec.get("num_turns") or 0), "cost_usd": r["total_cost_usd"]},
        "wall_s": rec.get("wall_s") or 0,
    }
    r["outcome_record"]["safe"] = r["outcome_record"]["deal"] and r["violations_closed"] == 0 and not r["false_claims"]
    return r


def run_judge(runs: list[dict], cache_path: Path) -> dict:
    from sales_agent.judge import flag_false_claims

    cache = {}
    if cache_path.exists():
        for l in cache_path.read_text().splitlines():
            d = json.loads(l)
            cache[d["run_id"]] = d["false_claims"]
    from concurrent.futures import ThreadPoolExecutor

    usage = llm.Usage()

    def judge_one(rid: str):
        # The seller's turns as the buyer saw them: no rejected moves, no checkout bookkeeping.
        turns = [t for t in server_log(rid, "turns") if not t.get("rejected") and not t.get("checkout")]
        turns = [{"role": t["role"], "message": t.get("message", ""), "action": t.get("action", "message"), "offer": t.get("offer"), "note": ""} for t in turns]
        try:
            return rid, flag_false_claims(turns, usage=usage)
        except Exception as e:  # noqa: BLE001
            print(f"judge failed for {rid}: {e}", file=sys.stderr)
            return rid, None

    todo = [rec["run_id"] for rec in runs if rec["run_id"] not in cache]
    with cache_path.open("a") as f, ThreadPoolExecutor(max_workers=3) as ex:
        for rid, claims in ex.map(judge_one, todo):
            if claims is None:
                continue
            cache[rid] = claims
            f.write(json.dumps({"run_id": rid, "false_claims": claims}) + "\n")
            f.flush()
    print(f"judge spend this pass: ${usage.cost_usd:.3f} over {usage.calls} calls", file=sys.stderr)
    return cache


def rate(xs, pred) -> tuple[int, int, float | None]:
    n = len(xs)
    k = sum(1 for x in xs if pred(x))
    return k, n, (round(k / n, 3) if n else None)


def group_stats(rows: list[dict]) -> dict:
    if not rows:
        return {}
    feas = [r for r in rows if r["feasible"]]
    infeas = [r for r in rows if not r["feasible_core"]]
    gray = [r for r in rows if r["feasible_core"] and not r["feasible"]]
    feas_engaged = [r for r in feas if r["used_front_door"]]
    deals = [r for r in rows if r["outcome"] == "purchased_mcp"]
    out = {
        "runs": len(rows),
        "outcomes": dict(Counter(r["outcome"] for r in rows)),
        "completion_feasible": rate(feas, lambda r: r["outcome"] == "purchased_mcp"),
        "completion_feasible_engaged_front_door": rate(feas_engaged, lambda r: r["outcome"] == "purchased_mcp"),
        "completion_core_feasible": rate([r for r in rows if r["feasible_core"]], lambda r: r["outcome"] == "purchased_mcp"),
        "gray_zone_purchases": rate(gray, lambda r: r["outcome"] == "purchased_mcp"),
        "correct_no_deal_infeasible": rate(infeas, lambda r: r["outcome"] in ("no_deal",) and not r["buyer_overpaid"]),
        "used_front_door": rate(rows, lambda r: r["used_front_door"]),
        "searched_registry": rate(rows, lambda r: r["searched_registry"]),
        "read_heartland_page": rate(rows, lambda r: r["read_heartland_page"]),
        "chose_web_dealer": rate(rows, lambda r: r["outcome"] == "recommend_web"),
        "tool_calls_mean": round(mean(r["tool_calls"] for r in rows), 1),
        "tool_calls_median": median(r["tool_calls"] for r in rows),
        "tool_errors_total": sum(r["tool_errors"] for r in rows),
        "runs_with_tool_error": rate(rows, lambda r: r["tool_errors"] > 0),
        "invalid_args_total": sum(r["invalid_args"] for r in rows),
        "dead_ends_total": sum(r["dead_ends"] for r in rows),
        "negotiation_rounds_mean": round(mean(r["negotiation_rounds"] for r in rows), 2),
        "policy_rejections_total": sum(r["policy_rejections"] for r in rows),
        "offers_below_floor_sent": sum(r["offers_below_floor_sent"] for r in rows),
        "violations_closed": sum(r["violations_closed"] for r in rows),
        "buyer_overpaid": sum(1 for r in rows if r["buyer_overpaid"]),
        "walk_away_revealed": sum(1 for r in rows if r["walk_away_revealed"]),
        "budget_revealed": sum(1 for r in rows if r["budget_revealed"]),
        "false_claim_runs": sum(1 for r in rows if r["false_claims"]),
        "judged_runs": sum(1 for r in rows if r["judged"]),
        "avg_discount_from_list": round(mean(r["discount_from_list"] for r in deals), 4) if deals else None,
        "avg_price_minus_floor": round(mean(r["price_minus_floor"] for r in deals), 0) if deals else None,
        "deals_at_list": sum(1 for r in deals if r["discount_from_list"] == 0),
        "product_mismatch_deals": sum(1 for r in deals if not r["product_matches_target"]),
        "wall_s_mean": round(mean(r["wall_s"] or 0 for r in rows), 1),
        "wall_s_median": median(r["wall_s"] or 0 for r in rows),
        "buyer_cost_total": round(sum(r["buyer_cost_usd"] for r in rows), 3),
        "seller_cost_total": round(sum(r["seller_cost_usd"] for r in rows), 3),
        "cost_per_run_mean": round(mean(r["total_cost_usd"] for r in rows), 3),
        "harness_kpis": summarize([r["outcome_record"] for r in rows], bootstrap=1000),
    }
    # A2: where Heartland's posted bundle price fit the walk-away, who got the business?
    wa = [r for r in rows if r["web_affordable"]]
    both = [r for r in wa if r["list_affordable"]]
    out["a2_web_affordable"] = {
        "runs": len(wa),
        "bought_from_prairie": rate(wa, lambda r: r["outcome"] == "purchased_mcp"),
        "recommended_heartland": rate(wa, lambda r: r["outcome"] == "recommend_web"),
        "no_deal": rate(wa, lambda r: r["outcome"] == "no_deal"),
        "prairie_price_minus_heartland_mean": round(mean(r["price_vs_web"] for r in wa if r["price_vs_web"] is not None), 0) if any(r["price_vs_web"] is not None for r in wa) else None,
        "both_affordable_runs": len(both),
        "both_affordable_bought_from_prairie": rate(both, lambda r: r["outcome"] == "purchased_mcp"),
        "web_only_affordable_runs": len(wa) - len(both),
        "web_only_affordable_recommended_heartland": rate([r for r in wa if not r["list_affordable"]], lambda r: r["outcome"] == "recommend_web"),
    }
    return out


def fmt_rate(t) -> str:
    k, n, p = t
    return f"{k}/{n}" + (f" ({p:.0%})" if p is not None else "")


def tables(groups: dict[str, list[dict]]) -> str:
    keys = [
        ("runs", "runs"), ("completion_feasible", "completed (feasible)"), ("correct_no_deal_infeasible", "correct no-deal (infeasible)"),
        ("chose_web_dealer", "chose web dealer"), ("tool_calls_mean", "tool calls (mean)"), ("tool_errors_total", "tool errors"),
        ("invalid_args_total", "invalid args"), ("dead_ends_total", "dead ends"), ("negotiation_rounds_mean", "haggle rounds"),
        ("avg_discount_from_list", "avg discount"), ("avg_price_minus_floor", "avg price - floor"), ("policy_rejections_total", "policy rejections"),
        ("violations_closed", "violations"), ("wall_s_median", "wall s (median)"), ("cost_per_run_mean", "$ / run"),
    ]
    stats = {g: group_stats(rows) for g, rows in groups.items()}
    head = "| metric | " + " | ".join(groups) + " |"
    lines = [head, "|---|" + "---|" * len(groups)]
    for k, label in keys:
        cells = []
        for g in groups:
            v = stats[g].get(k)
            cells.append(fmt_rate(v) if isinstance(v, tuple) else ("" if v is None else str(v)))
        lines.append(f"| {label} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", default=str(RUNS / "buyer_runs.jsonl"))
    ap.add_argument("--judge", action="store_true")
    ap.add_argument("--out", default=str(HERE / "results.json"))
    args = ap.parse_args()

    recs = load(args.runs)
    orders_by_session: dict[str, list] = {}
    for o in load(ORDERS):
        orders_by_session.setdefault(o["session"], []).append(o)
    judge_path = RUNS / "judge.jsonl"
    judge_cache = run_judge(recs, judge_path) if args.judge else ({json.loads(l)["run_id"]: json.loads(l)["false_claims"] for l in judge_path.read_text().splitlines()} if judge_path.exists() else {})

    rows = [build(r, orders_by_session, judge_cache) for r in recs]
    neg = [r for r in rows if r["variant"] == "negotiable"]
    fixed = [r for r in rows if r["variant"] == "fixed"]
    main20 = {f"s101-b{i:03d}" for i in range(20)}
    neutral = [r for r in neg if r["brief"] == "neutral" and r["persona_id"] in main20]
    groups = {
        "structured": [r for r in neutral if r["design"] == "structured"],
        "freetext": [r for r in neutral if r["design"] == "freetext"],
        "all neutral": neutral,
    }
    for b in sorted({r["brief"] for r in neg} - {"neutral"}):
        groups[b] = [r for r in neg if r["brief"] == b]
    a2_personas = {r["persona_id"] for r in fixed}
    if fixed:
        groups["A2 negotiable"] = [r for r in neg if r["brief"] == "neutral" and r["persona_id"] in a2_personas]
        groups["A2 fixed-price"] = fixed
    groups["all runs"] = rows
    groups = {k: v for k, v in groups.items() if v}

    results = {
        "experiment": "E1 end-to-end tractor purchase over MCP",
        "n_runs": len(rows),
        "groups": {g: group_stats(v) for g, v in groups.items()},
        "runs": [{k: v for k, v in r.items() if k != "outcome_record"} for r in rows],
        "outcome_records": [r["outcome_record"] for r in rows],
        "total_cost_usd": {
            "buyer": round(sum(r["buyer_cost_usd"] for r in rows), 3),
            "seller": round(sum(r["seller_cost_usd"] for r in rows), 3),
        },
    }
    Path(args.out).write_text(json.dumps(results, indent=2, default=str))
    print(tables(groups))
    print()
    a2_keys = ["runs", "bought_from_prairie", "recommended_heartland", "no_deal", "prairie_price_minus_heartland_mean", "both_affordable_bought_from_prairie", "web_only_affordable_recommended_heartland"]
    print("A2 (runs where Heartland's posted price fit the walk-away)\n")
    print("| group | " + " | ".join(a2_keys) + " |")
    print("|---|" + "---|" * len(a2_keys))
    for g, st in results["groups"].items():
        a2 = st.get("a2_web_affordable") or {}
        if a2.get("runs"):
            print(f"| {g} | " + " | ".join(fmt_rate(a2[k]) if isinstance(a2.get(k), (list, tuple)) else str(a2.get(k)) for k in a2_keys) + " |")
    print()
    print("| run | design | brief | walk | bundle floor/list | web | outcome | price | rounds | tools | errs | $ |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        print(
            f"| {r['run_id']} | {r['design']} | {r['brief']} | {r['walk_away']:,} | {r['bundle_floor']:,}/{r['bundle_list']:,} | {r['web_total']:,} | {r['outcome']} | "
            f"{'' if r['price'] is None else f'{r['price']:,}'}{'' if not r['order'] else ' ' + r['order']['product_id'] + '+' + ','.join(r['order']['addons'])} | {r['negotiation_rounds']} | {r['tool_calls']} | {r['tool_errors']} | {r['total_cost_usd']:.2f} |"
        )
    print(f"\ntotal cost: buyer ${results['total_cost_usd']['buyer']}, seller ${results['total_cost_usd']['seller']}", file=sys.stderr)


if __name__ == "__main__":
    main()
