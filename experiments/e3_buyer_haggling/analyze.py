"""Analyze E3 runs: per-cell behavior and KPIs, haggle-vs-fixed paired price
comparison, model sweep, budget-leak probe (B9), B8, and conversion vs rounds (N2).

    uv run python experiments/e3_buyer_haggling/analyze.py [--no-judge]

Writes results.json and results.md next to this file. The leak judge's verdicts are cached in
runs/leak_judgments.jsonl so re-running the analysis doesn't re-call the model.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import HERE, RUNS, classify_leaks, judge_leaks, load_judgments, session_behavior  # noqa: E402

from sales_agent import llm  # noqa: E402
from sales_agent.metrics import summarize  # noqa: E402
from sales_agent.runlog import RunLog, load, run_many  # noqa: E402

JUDGMENTS = RUNS / "leak_judgments.jsonl"


# ---------------------------------------------------------------- helpers

def ci_mean(xs, bootstrap=2000, seed=0):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None, [None, None]
    m = mean(xs)
    if len(xs) < 2:
        return round(m, 4), [None, None]
    rng = random.Random(seed)
    ms = sorted(mean(xs[rng.randrange(len(xs))] for _ in xs) for _ in range(bootstrap))
    return round(m, 4), [round(ms[int(0.025 * bootstrap)], 4), round(ms[int(0.975 * bootstrap) - 1], 4)]


def rate(rows, key):
    vals = [bool(r[key]) for r in rows if r.get(key) is not None]
    return round(sum(vals) / len(vals), 4) if vals else None


def load_part(name):
    by_key = {}
    for r in load(RUNS / f"{name}.jsonl"):
        if r.get("ended_by") == "error":
            by_key.setdefault(r["meta"]["key"], None)
            continue
        by_key[r["meta"]["key"]] = r
    rows = [r for r in by_key.values() if r is not None]
    errors = [k for k, r in by_key.items() if r is None]
    for r in rows:
        r["b"] = session_behavior(r)
    return rows, errors


def attach_leaks(rows, judge_all: bool, use_judge: bool, usage: llm.Usage):
    cache = load_judgments(JUDGMENTS)
    need = []
    for r in rows:
        k = r["meta"]["key"]
        cand = judge_all or r["b"]["num_near_walkaway"] or r["b"]["num_near_budget"]
        r["_judge"] = cand
        if cand and k not in cache and use_judge:
            need.append(r)
    if need:
        log = RunLog(JUDGMENTS)

        def job(r):
            u = llm.Usage()
            try:
                j = judge_leaks(r, usage=u)
            except Exception as e:  # noqa: BLE001
                return {"key": r["meta"]["key"], "error": str(e), "usage": u.as_dict()}
            return {"key": r["meta"]["key"], **j, "usage": u.as_dict()}

        for d in run_many(job, need, concurrency=3, log=log, label="leak-judge"):
            u = d.get("usage", {})
            usage.calls += u.get("calls", 0)
            usage.cost_usd += u.get("cost_usd", 0)
        cache = load_judgments(JUDGMENTS)
    for r in rows:
        j = cache.get(r["meta"]["key"]) if r["_judge"] else None
        if j and j.get("error"):
            j = None
        r["leak"] = classify_leaks(r, j)
        r["leak"]["judged"] = bool(j)


def cell_stats(rows):
    if not rows:
        return {"sessions": 0}
    s = summarize(rows, bootstrap=2000)
    B = [r["b"] for r in rows]
    deals = [r for r in rows if r["deal"]]
    surplus_m, surplus_ci = ci_mean([r["b"]["buyer_surplus"] for r in rows])
    disc_m, disc_ci = ci_mean([r["b"]["discount_pct"] for r in deals])
    out = {
        "sessions": s["sessions"],
        "deals": s["deals"],
        "conversion": s["conversion"],
        "conversion_ci95": s.get("conversion_ci95"),
        "feasible_sessions": s["feasible_sessions"],
        "feasible_conversion": s["feasible_conversion"],
        "counter_rate": rate(B, "counter"),
        "haggled_rate": rate(B, "haggled"),
        "asked_discount_rate": rate(B, "asked_discount"),
        "avg_rounds": s["avg_rounds"],
        "avg_buyer_offers": round(mean(b["n_buyer_offers"] for b in B), 2),
        "first_buyer_offer_pct_list": ci_mean([b["first_buyer_offer_pct_list"] for b in B])[0],
        "accepted_first_seller_offer_rate": rate(B, "accepted_first_seller_offer"),
        "avg_discount_pct": disc_m,
        "avg_discount_pct_ci95": disc_ci,
        "avg_price_over_walkaway": ci_mean([r["b"]["price_over_walkaway"] for r in deals])[0],
        "buyer_overpaid": s["buyer_overpaid"],
        "buyer_surplus_per_session": surplus_m,
        "buyer_surplus_per_session_ci95": surplus_ci,
        "seller_surplus_capture": s["surplus_capture"],
        "seller_profit_per_session": s["profit_per_session"],
        "seller_discounted_rate": rate(B, "seller_discounted"),
        "bundle_changed_deals": sum(1 for r in deals if r["b"]["bundle_changed"]),
        "paid_at_walkaway_rate": round(sum(1 for r in deals if r["price"] >= 0.99 * r["walk_away"]) / len(deals), 4) if deals else None,
        "ended_by": dict(Counter(r["ended_by"] for r in rows)),
        "model_cost_usd": s["model_cost_usd"],
    }
    if rows and "leak" in rows[0]:
        L = [r["leak"] for r in rows]
        out.update(
            walkaway_leak_rate=rate(L, "walkaway_leak"),
            budget_disclosed_rate=rate(L, "budget_disclosed"),
            any_leak_rate=rate(L, "any_leak"),
            stated_lower_limit_rate=rate(L, "stated_lower_limit"),
        )
    return out


def paired(neg_rows, fix_rows, keyf):
    """Haggle vs fixed on the same buyer. Price diff only where both closed."""
    fix = {keyf(r): r for r in fix_rows}
    pairs = [(n, fix[keyf(n)]) for n in neg_rows if keyf(n) in fix]
    both = [(n, f) for n, f in pairs if n["deal"] and f["deal"]]
    same = [(n, f) for n, f in both if n["product_id"] == f["product_id"] and sorted(n["addons"]) == sorted(f["addons"])]
    price_diff = [(n["price"] - f["price"]) / f["price"] for n, f in same]
    disc_diff = [n["b"]["discount_pct"] - f["b"]["discount_pct"] for n, f in both]
    surplus_diff = [n["b"]["buyer_surplus"] - f["b"]["buyer_surplus"] for n, f in pairs]
    conv_diff = [int(n["deal"]) - int(f["deal"]) for n, f in pairs]
    pd_m, pd_ci = ci_mean(price_diff)
    dd_m, dd_ci = ci_mean(disc_diff)
    sd_m, sd_ci = ci_mean(surplus_diff)
    cd_m, cd_ci = ci_mean(conv_diff)
    return {
        "pairs": len(pairs),
        "both_closed": len(both),
        "both_closed_same_bundle": len(same),
        "price_diff_pct_same_bundle": pd_m,  # negative = haggling paid less
        "price_diff_pct_ci95": pd_ci,
        "n_haggle_cheaper": sum(1 for x in price_diff if x < 0),
        "n_equal": sum(1 for x in price_diff if x == 0),
        "discount_diff_pp": dd_m,  # positive = bigger discount off list when haggling
        "discount_diff_ci95": dd_ci,
        "buyer_surplus_diff_per_session": sd_m,
        "buyer_surplus_diff_ci95": sd_ci,
        "conversion_diff": cd_m,
        "conversion_diff_ci95": cd_ci,
    }


def n2_table(rows):
    """Conversion against the round a session ended in."""
    by_round = defaultdict(lambda: Counter())
    for r in rows:
        c = by_round[r["rounds"]]
        c["sessions"] += 1
        c["deals"] += int(r["deal"])
        c["feasible"] += int(bool(r["feasible"]))
        c["feasible_deals"] += int(bool(r["feasible"]) and r["deal"])
        c[r["ended_by"]] += 1
    total_deals = sum(int(r["deal"]) for r in rows)
    cum = 0
    out = []
    for rnd in sorted(by_round):
        c = by_round[rnd]
        cum += c["deals"]
        reached = sum(1 for r in rows if r["rounds"] >= rnd)
        still_open_deals = sum(1 for r in rows if r["rounds"] >= rnd and r["deal"])
        out.append({
            "round": rnd,
            "ended_here": c["sessions"],
            "deals_here": c["deals"],
            "no_deal_here": c["sessions"] - c["deals"],
            "conversion_if_ended_here": round(c["deals"] / c["sessions"], 3),
            "feasible_conv_if_ended_here": round(c["feasible_deals"] / c["feasible"], 3) if c["feasible"] else None,
            "reached_round": reached,
            "conv_given_reached": round(still_open_deals / reached, 3) if reached else None,
            "cum_share_of_deals": round(cum / total_deals, 3) if total_deals else None,
            "ended_by": {k: v for k, v in c.items() if k not in ("sessions", "deals", "feasible", "feasible_deals")},
        })
    return out


# ---------------------------------------------------------------- markdown

COLS = [
    ("n", "sessions"), ("counter", "counter_rate"), ("haggled", "haggled_rate"), ("rounds", "avg_rounds"),
    ("open % list", "first_buyer_offer_pct_list"), ("conv", "conversion"), ("feas. conv", "feasible_conversion"), ("disc. off list", "avg_discount_pct"),
    ("price/walk-away", "avg_price_over_walkaway"), ("overpaid", "buyer_overpaid"),
    ("buyer surplus/session", "buyer_surplus_per_session"), ("took 1st offer", "accepted_first_seller_offer_rate"),
    ("seller disc.", "seller_discounted_rate"), ("paid >=99% walk-away", "paid_at_walkaway_rate"),
    ("bundle changed", "bundle_changed_deals"),
]


def persona_table(grid):
    """Per buyer: fixed outcome vs negotiable outcomes (pooled over briefs)."""
    lines = ["| buyer | bundle | floor | list | walk-away | zone | fixed: deals/4, price | negotiable: deals/8 | negotiable avg price | avg price % list | avg price / walk-away |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    out = {}
    for pid in sorted({r["persona_id"] for r in grid}):
        rs = [r for r in grid if r["persona_id"] == pid]
        p = rs[0]["meta"]["persona"]
        zone = "below floor" if p["walk_away"] < p["floor"] else ("in zone" if p["walk_away"] < p["list"] else "pays list")
        fx = [r for r in rs if r["meta"]["availability"] == "fixed"]
        ng = [r for r in rs if r["meta"]["availability"] != "fixed"]
        fx_d = [r for r in fx if r["deal"]]
        ng_d = [r for r in ng if r["deal"]]
        avg = lambda xs: round(mean(xs)) if xs else None  # noqa: E731
        row = {"zone": zone, "fixed_deals": len(fx_d), "fixed_n": len(fx), "fixed_avg_price": avg([r["price"] for r in fx_d]),
               "neg_deals": len(ng_d), "neg_n": len(ng), "neg_avg_price": avg([r["price"] for r in ng_d]),
               "neg_price_pct_list": round(mean(r["price"] / r["list_total"] for r in ng_d), 3) if ng_d else None,
               "neg_price_over_walkaway": round(mean(r["price"] / r["walk_away"] for r in ng_d), 3) if ng_d else None}
        out[pid] = row
        bundle = "+".join([p["target_product"]] + p["wants_addons"])
        lines.append(f"| {pid} | {bundle} | {p['floor']:,} | {p['list']:,} | {p['walk_away']:,} | {zone} | {row['fixed_deals']}/{row['fixed_n']}, {fmt(row['fixed_avg_price'])} | "
                     f"{row['neg_deals']}/{row['neg_n']} | {fmt(row['neg_avg_price'])} | {fmt(row['neg_price_pct_list'])} | {fmt(row['neg_price_over_walkaway'])} |")
    return out, "\n".join(lines)


def fmt(v):
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:.2f}" if abs(v) <= 1.5 else f"{v:,.0f}"
    if isinstance(v, int) and abs(v) >= 1000:
        return f"{v:,}"
    return str(v)


def _ci(m, ci, pct=False):
    if m is None:
        return ""
    f = (lambda v: f"{v*100:+.1f}%") if pct else (lambda v: f"{v:+,.2f}" if abs(v) < 2 else f"{v:+,.0f}")
    if ci and ci[0] is not None:
        return f"{f(m)} [{f(ci[0])}, {f(ci[1])}]"
    return f(m)


def md_pair_table(pairs: dict):
    lines = ["| comparison | pairs | both closed (same bundle) | price diff, same bundle [95% CI] | haggle cheaper / equal | "
             "discount diff, pp [CI] | conversion diff [CI] | buyer surplus diff/session [CI] |",
             "|---|---|---|---|---|---|---|---|"]
    for name, d in pairs.items():
        if not d.get("pairs"):
            continue
        lines.append(
            f"| {name} | {d['pairs']} | {d['both_closed']} ({d['both_closed_same_bundle']}) | "
            f"{_ci(d['price_diff_pct_same_bundle'], d['price_diff_pct_ci95'], True)} | "
            f"{d['n_haggle_cheaper']} / {d['n_equal']} | {_ci(d['discount_diff_pp'], d['discount_diff_ci95'], True)} | "
            f"{_ci(d['conversion_diff'], d['conversion_diff_ci95'], True)} | "
            f"{_ci(d['buyer_surplus_diff_per_session'], d['buyer_surplus_diff_ci95'])} |")
    return "\n".join(lines)


def md_table(cells: dict, cols=COLS):
    lines = ["| cell | " + " | ".join(c for c, _ in cols) + " |", "|---|" + "---|" * len(cols)]
    for name, s in cells.items():
        lines.append(f"| {name} | " + " | ".join(fmt(s.get(k)) for _, k in cols) + " |")
    return "\n".join(lines)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-judge", action="store_true")
    args = ap.parse_args()
    use_judge = not args.no_judge
    judge_usage = llm.Usage()

    parts = {}
    errors = {}
    for name in ("grid", "models", "leak", "b8"):
        rows, errs = load_part(name)
        parts[name] = rows
        errors[name] = errs
    for name, rows in parts.items():
        attach_leaks(rows, judge_all=name in ("leak", "b8"), use_judge=use_judge, usage=judge_usage)

    res = {"errors_unresolved": errors}
    md = []

    # ---- main grid
    grid = parts["grid"]
    cells = {}
    for a in ("advertised", "available", "fixed"):
        for b in ("neutral", "strict_budget", "best_deal", "buy_fast"):
            rows = [r for r in grid if r["meta"]["availability"] == a and r["meta"]["brief"] == b]
            if rows:
                cells[f"{a} / {b}"] = cell_stats(rows)
    by_avail = {a: cell_stats([r for r in grid if r["meta"]["availability"] == a]) for a in ("advertised", "available", "fixed")}
    neg = [r for r in grid if r["meta"]["availability"] != "fixed"]
    by_brief_neg = {b: cell_stats([r for r in neg if r["meta"]["brief"] == b]) for b in ("neutral", "strict_budget", "best_deal", "buy_fast")}
    by_brief_fixed = {b: cell_stats([r for r in grid if r["meta"]["availability"] == "fixed" and r["meta"]["brief"] == b]) for b in ("neutral", "strict_budget", "best_deal", "buy_fast")}
    neg_all = cell_stats(neg)
    k = lambda r: (r["persona_id"], r["meta"]["brief"])  # noqa: E731
    fixed_rows = [r for r in grid if r["meta"]["availability"] == "fixed"]
    pair = {
        "advertised_vs_fixed": paired([r for r in grid if r["meta"]["availability"] == "advertised"], fixed_rows, k),
        "available_vs_fixed": paired([r for r in grid if r["meta"]["availability"] == "available"], fixed_rows, k),
        "negotiable_vs_fixed": paired(neg, fixed_rows, k),
    }
    pair_by_brief = {
        b: paired([r for r in neg if r["meta"]["brief"] == b], [r for r in fixed_rows if r["meta"]["brief"] == b], k)
        for b in ("neutral", "strict_budget", "best_deal", "buy_fast")
    }
    ptab, ptab_md = persona_table(grid)
    res["grid"] = {"per_persona": ptab, "cells": cells, "by_availability": by_avail, "negotiable_pooled": neg_all,
                   "by_brief_negotiable": by_brief_neg, "by_brief_fixed": by_brief_fixed,
                   "paired_vs_fixed": pair, "paired_vs_fixed_by_brief": pair_by_brief}
    md += ["## Main grid (Opus buyers, seed 303)", "", md_table(cells), "", "### By availability (pooled over briefs)", "",
           md_table({**by_avail, "negotiable (adv+avail)": neg_all}), "",
           "### By brief, negotiable conditions (advertised + available)", "", md_table(by_brief_neg), "",
           "### By brief, fixed", "", md_table(by_brief_fixed), "",
           "### Per buyer", "", ptab_md, "",
           "### Haggle vs fixed, same buyer and brief (negative price diff = haggling paid less)", "",
           md_pair_table({**pair, **{f"negotiable vs fixed, {b}": v for b, v in pair_by_brief.items()}}), ""]

    # ---- model sweep
    ms = parts["models"]
    mcells, mpair = {}, {}
    for m in ("opus", "sonnet", "haiku"):
        for a in ("advertised", "fixed"):
            rows = [r for r in ms if r["meta"]["buyer_model"] == m and r["meta"]["availability"] == a]
            if rows:
                mcells[f"{m} / {a}"] = cell_stats(rows)
        adv = [r for r in ms if r["meta"]["buyer_model"] == m and r["meta"]["availability"] == "advertised"]
        fix = [r for r in ms if r["meta"]["buyer_model"] == m and r["meta"]["availability"] == "fixed"]
        if adv and fix:
            mpair[m] = paired(adv, fix, lambda r: r["persona_id"])
    res["models"] = {"cells": mcells, "paired_advertised_vs_fixed": mpair}
    md += ["## Model sweep (seed 304, neutral brief, Opus seller)", "", md_table(mcells), "",
           "### Advertised vs fixed, same buyer, per model", "", md_pair_table(mpair), ""]

    # ---- leak probe + baseline
    LCOLS = [("n", "sessions"), ("walk-away leak", "walkaway_leak_rate"), ("budget disclosed", "budget_disclosed_rate"),
             ("any leak", "any_leak_rate"), ("stated lower limit", "stated_lower_limit_rate"), ("conv", "conversion"),
             ("price/walk-away", "avg_price_over_walkaway"), ("overpaid", "buyer_overpaid"),
             ("buyer surplus/session", "buyer_surplus_per_session"), ("rounds", "avg_rounds")]
    lk = parts["leak"]
    lcells = {}
    for m in ("opus", "sonnet", "haiku"):
        rows = [r for r in lk if r["meta"]["buyer_model"] == m]
        if rows:
            st = cell_stats(rows)
            st["seller_asked_rate"] = rate([r["leak"] for r in rows], "judge_seller_asked")
            st["buyer_declined_rate"] = rate([r["leak"] for r in rows], "buyer_declined")
            lcells[f"ask budget / {m}"] = st
    base = {}
    for m in ("opus", "sonnet", "haiku"):
        rows = [r for r in grid + ms if r["meta"]["buyer_model"] == m and r["meta"]["availability"] != "fixed"
                and r["meta"]["brief"] != "strict_budget"]
        if rows:
            base[f"no ask (grid+sweep) / {m}"] = cell_stats(rows)
    # leakers vs non-leakers (price impact)
    leak_split = {}
    for name, rows in (("leakers", [r for r in lk if r["leak"]["walkaway_leak"]]), ("non-leakers", [r for r in lk if not r["leak"]["walkaway_leak"]])):
        deals = [r for r in rows if r["deal"]]
        leak_split[name] = {"sessions": len(rows), "deals": len(deals),
                            "avg_price_over_walkaway": ci_mean([r["b"]["price_over_walkaway"] for r in deals])[0],
                            "seller_surplus_capture": summarize(rows, bootstrap=0).get("surplus_capture") if rows else None}
    res["leak"] = {"cells": lcells, "baseline_no_ask": base, "walkaway_leakers_vs_not": leak_split,
                   "examples": [{"key": r["meta"]["key"], "walk_away": r["meta"]["persona"]["walk_away"],
                                 "budget": r["meta"]["persona"]["budget"], **r["leak"]}
                                for r in lk if r["leak"]["any_leak"]]}
    md += ["## Budget-leak probe (seller asks for budget; seed 305; available, neutral)", "",
           md_table({**lcells, **base}, LCOLS), "",
           "Seller asked / buyer declined: " + ", ".join(f"{k}: asked {v.get('seller_asked_rate')}, declined {v.get('buyer_declined_rate')}" for k, v in lcells.items()), "",
           "Walk-away leakers vs not: " + json.dumps(leak_split), ""]

    # ---- B8
    b8 = parts["b8"]
    if b8:
        lk_opus = [r for r in lk if r["meta"]["buyer_model"] == "opus"]
        b8cells = {"default (budget + private walk-away)": cell_stats(lk_opus), "budget only (= walk-away)": cell_stats(b8)}
        # In the budget-only arm the stated budget IS the walk-away, so "budget disclosed" == walk-away disclosed.
        b8pair = paired(b8, lk_opus, lambda r: r["persona_id"])
        res["b8"] = {"cells": b8cells, "paired_budget_only_minus_default": b8pair}
        md += ["## B8: stated budget only vs private walk-away (Opus buyers, seller asks)", "",
               md_table(b8cells, LCOLS), "", "Paired, budget-only minus default (price diff > 0 = budget-only paid more):", "",
               md_pair_table({"budget-only vs default": b8pair}), ""]

    # ---- N2
    n2_rows = [r for r in grid + ms + lk + b8 if r["meta"]["availability"] != "fixed"]
    res["n2"] = {"negotiable_sessions": len(n2_rows), "table": n2_table(n2_rows),
                 "grid_negotiable_table": n2_table(neg)}
    md += ["## N2: conversion vs. round the session ended (all negotiable sessions)", "",
           "| round | ended here | deals | no deal | conv. if ended here | reached round | conv. given reached | cum. share of deals |",
           "|---|---|---|---|---|---|---|---|"]
    for t in res["n2"]["table"]:
        md.append(f"| {t['round']} | {t['ended_here']} | {t['deals_here']} | {t['no_deal_here']} | {t['conversion_if_ended_here']} | {t['reached_round']} | {t['conv_given_reached']} | {t['cum_share_of_deals']} |")
    md.append("")

    # ---- cost
    all_rows = grid + ms + lk + b8
    cost = {name: round(sum(r["usage"].get("cost_usd", 0) for r in rows), 2) for name, rows in parts.items()}
    judged = load_judgments(JUDGMENTS)
    cost["leak_judge"] = round(sum(d.get("usage", {}).get("cost_usd", 0) for d in judged.values()), 2)
    raw_all = sum(r.get("usage", {}).get("cost_usd", 0) for name in parts for r in load(RUNS / f"{name}.jsonl"))
    cost["all_logged_sessions_incl_errors"] = round(raw_all, 2)
    cost["total"] = round(raw_all + cost["leak_judge"], 2)
    res["cost_usd"] = cost
    res["sessions"] = {name: len(rows) for name, rows in parts.items()}
    md += ["## Cost", "", "```", json.dumps(cost, indent=1), "```", ""]

    (HERE / "results.json").write_text(json.dumps(res, indent=1, default=str))
    (HERE / "results.md").write_text("\n".join(md))
    print("\n".join(md))


if __name__ == "__main__":
    main()
