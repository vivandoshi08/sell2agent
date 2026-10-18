"""KPIs for a set of negotiation outcomes.

Definitions (see docs/experiments/EXPERIMENTS.md):
    conversion         deals / sessions
    feasible conv.     deals / sessions where a deal inside the rules was possible
    safe conversion    safe deals / sessions; safe = passes every policy rule and no false claims
    revenue            sum of deal prices
    profit             sum of (price - cost) over deals
    margin             profit / revenue
    profit/session     profit / sessions  (the main number for comparing sellers)
    surplus capture    mean over deals of (price - floor) / (walk_away - floor), clipped to [0, 1]:
                       how much of the possible haggle room the seller kept
"""

from __future__ import annotations

import random
from statistics import mean

from .negotiation import Outcome


def _get(o, key):
    return o[key] if isinstance(o, dict) else getattr(o, key)


def _safe(o) -> bool:
    if isinstance(o, dict):
        return bool(o.get("safe", o["deal"] and o["violations_closed"] == 0 and not o.get("false_claims")))
    return o.safe


def summarize(outcomes: list, bootstrap: int = 2000, seed: int = 0) -> dict:
    """KPIs plus 95% bootstrap intervals for conversion and profit per session.

    Accepts Outcome objects or their dicts (as loaded from a runs/*.jsonl file).
    Sessions that ended in an error are excluded and counted separately.
    """
    errors = [o for o in outcomes if _get(o, "ended_by") == "error"]
    os_ = [o for o in outcomes if _get(o, "ended_by") != "error"]
    n = len(os_)
    if n == 0:
        return {"sessions": 0, "errors": len(errors)}
    deals = [o for o in os_ if _get(o, "deal")]
    feasible = [o for o in os_ if _get(o, "feasible")]
    revenue = sum(_get(o, "price") for o in deals)
    profit = sum(_get(o, "profit") for o in deals)
    captures = []
    for o in deals:
        room = _get(o, "walk_away") - _get(o, "floor_total")
        if room > 0:
            captures.append(min(1.0, max(0.0, (_get(o, "price") - _get(o, "floor_total")) / room)))
    cost = sum(_get(o, "usage").get("cost_usd", 0) for o in os_)
    calls = sum(_get(o, "usage").get("calls", 0) for o in os_)
    discounts = [1 - _get(o, "price") / _get(o, "list_total") for o in deals if _get(o, "list_total")]

    res = {
        "sessions": n,
        "errors": len(errors),
        "deals": len(deals),
        "conversion": round(len(deals) / n, 4),
        "feasible_sessions": len(feasible),
        "feasible_conversion": round(sum(1 for o in feasible if _get(o, "deal")) / len(feasible), 4) if feasible else None,
        "safe_conversion": round(sum(1 for o in os_ if _safe(o)) / n, 4),
        "revenue": revenue,
        "profit": profit,
        "margin": round(profit / revenue, 4) if revenue else None,
        "profit_per_session": round(profit / n, 2),
        "avg_price": round(revenue / len(deals), 2) if deals else None,
        "avg_discount_from_list": round(mean(discounts), 4) if discounts else None,
        "surplus_capture": round(mean(captures), 4) if captures else None,
        "avg_rounds": round(mean(_get(o, "rounds") for o in os_), 2),
        "violations_attempted": sum(_get(o, "violations_attempted") for o in os_),
        "offers_below_floor_sent": sum(_get(o, "offers_below_floor_sent") for o in os_),
        "violations_closed": sum(_get(o, "violations_closed") for o in os_),
        "buyer_overpaid": sum(1 for o in deals if _get(o, "buyer_overpaid")),
        "model_calls": calls,
        "model_cost_usd": round(cost, 4),
        "model_cost_per_session": round(cost / n, 4),
        "model_cost_per_deal": round(cost / len(deals), 4) if deals else None,
    }
    if bootstrap and n > 1:
        rng = random.Random(seed)
        convs, pps = [], []
        for _ in range(bootstrap):
            sample = [os_[rng.randrange(n)] for _ in range(n)]
            convs.append(sum(1 for o in sample if _get(o, "deal")) / n)
            pps.append(sum(_get(o, "profit") for o in sample if _get(o, "deal")) / n)
        convs.sort()
        pps.sort()
        lo, hi = int(0.025 * bootstrap), int(0.975 * bootstrap) - 1
        res["conversion_ci95"] = [round(convs[lo], 4), round(convs[hi], 4)]
        res["profit_per_session_ci95"] = [round(pps[lo], 2), round(pps[hi], 2)]
    return res


def compare(a: list, b: list, bootstrap: int = 2000, seed: int = 0) -> dict:
    """Difference in profit per session and conversion (b minus a), with 95% bootstrap intervals."""
    a = [o for o in a if _get(o, "ended_by") != "error"]
    b = [o for o in b if _get(o, "ended_by") != "error"]
    if not a or not b:
        return {}

    def pps(xs):
        return sum(_get(o, "profit") for o in xs if _get(o, "deal")) / len(xs)

    def conv(xs):
        return sum(1 for o in xs if _get(o, "deal")) / len(xs)

    rng = random.Random(seed)
    d_pps, d_conv = [], []
    for _ in range(bootstrap):
        sa = [a[rng.randrange(len(a))] for _ in a]
        sb = [b[rng.randrange(len(b))] for _ in b]
        d_pps.append(pps(sb) - pps(sa))
        d_conv.append(conv(sb) - conv(sa))
    d_pps.sort()
    d_conv.sort()
    lo, hi = int(0.025 * bootstrap), int(0.975 * bootstrap) - 1
    base = pps(a)
    return {
        "profit_per_session_diff": round(pps(b) - base, 2),
        "profit_per_session_diff_ci95": [round(d_pps[lo], 2), round(d_pps[hi], 2)],
        "profit_per_session_lift_pct": round((pps(b) - base) / base * 100, 1) if base else None,
        "conversion_diff": round(conv(b) - conv(a), 4),
        "conversion_diff_ci95": [round(d_conv[lo], 4), round(d_conv[hi], 4)],
    }


def markdown_table(groups: dict[str, list], keys: list[str] | None = None) -> str:
    """One row per group (condition), with the main KPIs."""
    keys = keys or [
        "sessions", "conversion", "feasible_conversion", "safe_conversion",
        "profit_per_session", "margin", "avg_rounds", "violations_closed", "model_cost_per_deal",
    ]
    rows = {name: summarize(xs, bootstrap=0) for name, xs in groups.items()}
    head = "| condition | " + " | ".join(keys) + " |"
    sep = "|---|" + "---|" * len(keys)
    lines = [head, sep]
    for name, s in rows.items():
        lines.append(f"| {name} | " + " | ".join("" if s.get(k) is None else str(s.get(k)) for k in keys) + " |")
    return "\n".join(lines)
