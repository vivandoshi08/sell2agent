"""E10 analysis: KPIs per cell and per priority, needs-fit, over-selling, the dial, verdicts.

    uv run python experiments/e10_priorities/analyze.py [--runs runs/main.jsonl] [--judge runs/judge.jsonl]

Writes results.json, dial.csv, dial.json, and runs/analysis.txt.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import re
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean

from sales_agent import metrics
from sales_agent.runlog import load

import catalog_ext as cx
from buyers import TYPES
from catalog_ext import Requirement
from run import seller_notes
from sellers import PRIORITIES

HERE = Path(__file__).resolve().parent
PRIOS = list(PRIORITIES)


# ---------------------------------------------------------------- per-session derived fields


def premium_first_mentioned_by(r: dict) -> str | None:
    """Who first named the premium trim of the class that was sold: 'buyer', 'seller', or None."""
    pid = r["product_id"]
    pat = re.compile(rf"\b{pid}\b|{cx.PRODUCTS[pid].name}|\bpremium\b", re.I)
    for t in r["transcript"]:
        off = t.get("offer") or {}
        if off.get("product_id") == pid or pat.search(t.get("message", "")):
            return t["role"]
    return None


def derive(r: dict, claims: dict) -> dict:
    p = r["meta"]["persona"]
    req = Requirement(**p["req"])
    d = {
        "session_id": r["session_id"],
        "persona_id": r["persona_id"],
        "need_id": p["need_id"],
        "priority": r["meta"]["priority"],
        "buyer_type": p["buyer_type"],
        "deal": r["deal"],
        "ended_by": r["ended_by"],
        "rounds": r["rounds"],
        "walk_away": p["walk_away"],
        "std_product": p["std_product"],
        "prem_product": p["prem_product"],
        "wants": p["wants_addons"],
        "cost_usd": r["usage"].get("cost_usd", 0),
        "seller_cost_usd": r["meta"].get("seller_usage", {}).get("cost_usd", 0),
        "classifier_cost_usd": r["meta"].get("classifier_usage", {}).get("cost_usd", 0),
        "false_claims": claims.get(r["session_id"], []),
    }
    notes = seller_notes(r["transcript"])
    d["llm_price_overrides"] = sum(1 for n in notes if "llm_price" in n)
    d["seller_offers"] = sum(1 for t in r["transcript"] if t["role"] == "seller" and t["action"] == "offer")
    d["warranty_free_offers"] = sum(1 for n in notes if n.get("warranty_free"))
    d["fallbacks"] = sum(1 for n in notes if "fallback" in n or "retried" in n)
    reads = [n["inferred_type"] for n in notes if "inferred_type" in n]
    d["reads"] = reads
    d["tactics"] = [n["tactic"] for n in notes]
    # what the seller first offered: product mix of the pitch, deal or not
    first = next((t["offer"] for t in r["transcript"] if t["role"] == "seller" and t.get("offer")), None)
    d["first_offer_product"] = first["product_id"] if first else None
    d["first_offer_premium"] = bool(first) and cx.is_premium(first["product_id"])
    d["seller_offered_premium"] = any(
        t["role"] == "seller" and t.get("offer") and cx.is_premium(t["offer"]["product_id"]) for t in r["transcript"]
    )
    seller_offers = [t["offer"] for t in r["transcript"] if t["role"] == "seller" and t.get("offer")]
    d["under_spec_offers"] = sum(1 for o in seller_offers if not cx.fits(o["product_id"], req))
    d["premium_pitched_std_fits"] = (not cx.is_premium(p["std_product"])) and any(cx.is_premium(o["product_id"]) for o in seller_offers)
    d["std_fits"] = not cx.is_premium(p["std_product"])
    if r["deal"]:
        pid, addons = r["product_id"], r["addons"]
        d.update(
            product=pid, addons=addons, price=r["price"], profit=r["profit"], cost=r["cost"],
            list_total=r["list_total"], floor_total=r["floor_total"],
            premium=cx.is_premium(pid), tractor_class=cx.SPECS[pid].tractor_class,
            misses=cx.misses(pid, req), needs_fit=cx.fits(pid, req),
            extra_addons=[a for a in addons if a not in p["wants_addons"]],
            dropped_addons=[a for a in p["wants_addons"] if a not in addons],
            surplus=p["walk_away"] - r["price"],
            discount=1 - r["price"] / r["list_total"],
        )
        premium_needed = cx.is_premium(p["std_product"])
        d["premium_when_standard_fits"] = d["premium"] and not premium_needed
        d["bigger_than_needed"] = cx.PRODUCTS[pid].list_price > cx.PRODUCTS[p["std_product"]].list_price and not d["premium_when_standard_fits"]
        d["premium_mentioned_first_by"] = premium_first_mentioned_by(r) if d["premium_when_standard_fits"] else None
        # Over-selling: a price-first buyer sold more than its need: a premium trim the need doesn't require,
        # a bigger tractor than the cheapest that fits, or add-ons it didn't ask for.
        d["oversold"] = p["buyer_type"] == "price_first" and (
            d["premium_when_standard_fits"] or d["bigger_than_needed"] or bool(d["extra_addons"])
        )
        # Free warranty: the buyer accepted a seller offer that included the warranty at no charge.
        d["free_warranty_deal"] = r["ended_by"] == "buyer_accept" and bool(notes) and bool(notes[-1].get("warranty_free"))
        paid_extra = [a for a in d["extra_addons"] if not (a == "warranty" and d["free_warranty_deal"])]
        d["oversold_paid"] = p["buyer_type"] == "price_first" and (
            d["premium_when_standard_fits"] or d["bigger_than_needed"] or bool(paid_extra)
        )
        d["premium_unasked_pf"] = (
            p["buyer_type"] == "price_first" and d["premium_when_standard_fits"] and d["premium_mentioned_first_by"] != "buyer"
        )
    return d


# ---------------------------------------------------------------- accept mismatches

# The buyer accepted an alternative the seller quoted in its message text ("the T75 alone is $64,700
# this round"), but the harness closes on the seller's structured standing offer, so the deal was
# recorded on a different bundle at a higher price, above the buyer's walk-away. Both alternatives
# were quoted by the seller from that round's price table. Headline numbers re-score these deals to
# the bundle and price the buyer named; --no-corrections gives the literal harness record.
CORRECTIONS = {
    ("adaptive", "n5-qf"): ("T45", ["loader", "warranty", "delivery"], 49_150),
    ("profit", "n6-pf"): ("T75", [], 64_700),
}


def accept_mismatches(raws: list[dict]) -> list[dict]:
    """Buyer accepts whose message names a dollar amount other than the standing seller offer."""
    out = []
    for r in raws:
        if r["ended_by"] != "buyer_accept":
            continue
        standing = [t["offer"] for t in r["transcript"] if t["role"] == "seller" and t.get("offer")][-1]
        amounts = [int(a.replace(",", "")) for a in re.findall(r"\$([\d,]{5,})", r["transcript"][-1]["message"])]
        if amounts and standing["price"] not in amounts:
            out.append({"priority": r["meta"]["priority"], "persona_id": r["persona_id"], "recorded_price": standing["price"],
                        "recorded_bundle": cx.describe(standing["product_id"], standing["addons"]), "buyer_named": amounts,
                        "walk_away": r["walk_away"], "corrected": (r["meta"]["priority"], r["persona_id"]) in CORRECTIONS})
    return out


def corrected(r: dict) -> dict:
    key = (r["meta"]["priority"], r["persona_id"])
    if key not in CORRECTIONS:
        return r
    pid, addons, price = CORRECTIONS[key]
    r = json.loads(json.dumps(r))
    r["meta"]["accept_corrected"] = {"from": [r["product_id"], r["addons"], r["price"]], "to": [pid, addons, price]}
    r.update(product_id=pid, addons=addons, price=price, cost=cx.cost_total(pid, addons),
             list_total=cx.list_total(pid, addons), floor_total=cx.floor_total(pid, addons),
             buyer_overpaid=price > r["walk_away"])
    r["profit"] = price - r["cost"]
    return r


# ---------------------------------------------------------------- aggregation


def _rate(xs, key):
    xs = [x for x in xs if key in x]
    return round(sum(1 for x in xs if x[key]) / len(xs), 4) if xs else None


def summarize_group(rows: list[dict], raws: list[dict]) -> dict:
    n = len(rows)
    deals = [x for x in rows if x["deal"]]
    s = metrics.summarize(raws, bootstrap=0)
    revenue = sum(x["price"] for x in deals)
    out = {
        "sessions": n,
        "deals": len(deals),
        "conversion": s.get("conversion"),
        "safe_conversion": round(sum(1 for x in deals if not x["false_claims"]) / n, 4) if n else None,
        "profit_per_session": s.get("profit_per_session"),
        "revenue_per_session": round(revenue / n, 2) if n else None,
        "margin": s.get("margin"),
        "avg_price": s.get("avg_price"),
        "avg_discount_from_list": s.get("avg_discount_from_list"),
        "premium_share": _rate(deals, "premium"),
        "premium_when_standard_fits": sum(1 for x in deals if x.get("premium_when_standard_fits")),
        "premium_upsell_rate": _rate([x for x in deals if not cx.is_premium(x["std_product"])], "premium"),
        "surplus_capture": s.get("surplus_capture"),
        "addons_per_deal": round(mean(len(x["addons"]) for x in deals), 2) if deals else None,
        "extra_addon_deals": sum(1 for x in deals if x["extra_addons"]),
        "dropped_addon_deals": sum(1 for x in deals if x["dropped_addons"]),
        "needs_fit_rate": _rate(deals, "needs_fit"),
        "under_spec_deals": sum(1 for x in deals if not x["needs_fit"]),
        "pf_deals": sum(1 for x in deals if x["buyer_type"] == "price_first"),
        "pf_oversold": sum(1 for x in deals if x.get("oversold")),
        "pf_oversold_rate": _rate([x for x in deals if x["buyer_type"] == "price_first"], "oversold"),
        "pf_oversold_paid": sum(1 for x in deals if x.get("oversold_paid")),
        "free_warranty_deals": sum(1 for x in deals if x.get("free_warranty_deal")),
        "warranty_free_offers": sum(x["warranty_free_offers"] for x in rows),
        "pf_premium_unasked": sum(1 for x in deals if x.get("premium_unasked_pf")),
        "buyer_surplus_mean": round(mean(x["surplus"] for x in deals), 1) if deals else None,
        "avg_rounds": s.get("avg_rounds"),
        "first_offer_premium_rate": _rate(rows, "first_offer_premium"),
        "premium_pitch_rate_std_fits": _rate([x for x in rows if x["std_fits"]], "premium_pitched_std_fits"),
        "under_spec_offer_sessions": sum(1 for x in rows if x["under_spec_offers"]),
        "false_claim_sessions": sum(1 for x in rows if x["false_claims"]),
        "violations_closed": s.get("violations_closed"),
        "llm_price_override_rate": round(sum(x["llm_price_overrides"] for x in rows) / max(1, sum(x["seller_offers"] for x in rows)), 4),
        "model_cost_usd": s.get("model_cost_usd"),
        "model_cost_per_session": s.get("model_cost_per_session"),
        "seller_cost_per_session": round(sum(x["seller_cost_usd"] for x in rows) / n, 4) if n else None,
        "product_mix": dict(Counter(x["product"] for x in deals)),
    }
    return out


def paired_diff(rows: list[dict], a: str, b: str, key: str, boot: int = 4000, seed: int = 0) -> dict:
    """b minus a on the same buyers, resampling buyers. key: 'profit' (per session), 'deal' (conversion), 'margin'."""
    by = defaultdict(dict)
    for x in rows:
        by[x["persona_id"]][x["priority"]] = x
    ids = sorted(i for i, v in by.items() if a in v and b in v)
    if not ids:
        return {}

    def stat(sample, prio):
        xs = [by[i][prio] for i in sample]
        if key == "deal":
            return sum(1 for x in xs if x["deal"]) / len(xs)
        if key == "profit":
            return sum(x.get("profit", 0) for x in xs if x["deal"]) / len(xs)
        rev = sum(x["price"] for x in xs if x["deal"])
        return sum(x["profit"] for x in xs if x["deal"]) / rev if rev else 0.0

    point = stat(ids, b) - stat(ids, a)
    rng = random.Random(seed)
    diffs = sorted(stat(s, b) - stat(s, a) for s in ([ids[rng.randrange(len(ids))] for _ in ids] for _ in range(boot)))
    return {"diff": round(point, 4), "ci95": [round(diffs[int(0.025 * boot)], 4), round(diffs[int(0.975 * boot) - 1], 4)], "n_buyers": len(ids)}


def inference_stats(rows: list[dict]) -> dict:
    ad = [x for x in rows if x["priority"] == "adaptive" and x["reads"]]
    if not ad:
        return {}
    turns = [(x["buyer_type"], r) for x in ad for r in x["reads"]]
    first = [(x["buyer_type"], x["reads"][0]) for x in ad]
    last = [(x["buyer_type"], x["reads"][-1]) for x in ad]

    def acc(pairs):
        return round(sum(1 for t, r in pairs if t == r) / len(pairs), 4) if pairs else None

    tactic_ok = []
    for x in ad:
        want = {"price_first": "adaptive/price_first", "quality_first": "adaptive/quality_first", "balanced": "adaptive/balanced"}[x["buyer_type"]]
        tactic_ok.append(sum(1 for t in x["tactics"] if t == want) / len(x["tactics"]))
    confusion = {t: dict(Counter(r for tt, r in turns if tt == t)) for t in TYPES}
    by_type = {t: {"per_turn": acc([p for p in turns if p[0] == t]), "first": acc([p for p in first if p[0] == t]), "last": acc([p for p in last if p[0] == t])} for t in TYPES}
    switches = sum(1 for x in ad if len(set(x["reads"])) > 1)
    return {
        "sessions": len(ad),
        "seller_turns": len(turns),
        "accuracy_per_turn": acc(turns),
        "accuracy_first_turn": acc(first),
        "accuracy_last_turn": acc(last),
        "tactic_matches_true_type_per_turn": round(mean(tactic_ok), 4),
        "by_true_type": by_type,
        "confusion_true_to_read": confusion,
        "sessions_where_read_changed": switches,
    }


def table(rows_by: dict[str, dict], keys: list[str]) -> str:
    head = "| group | " + " | ".join(keys) + " |"
    lines = [head, "|---|" + "---|" * len(keys)]
    for name, s in rows_by.items():
        lines.append(f"| {name} | " + " | ".join("" if s.get(k) is None else str(s.get(k)) for k in keys) + " |")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", nargs="+", default=[str(HERE / "runs" / "main.jsonl")])
    ap.add_argument("--judge", default=str(HERE / "runs" / "judge.jsonl"))
    ap.add_argument("--out", default=str(HERE / "results.json"))
    ap.add_argument("--no-corrections", action="store_true", help="score the literal harness record (see CORRECTIONS)")
    args = ap.parse_args()

    raw = {}
    for path in args.runs:
        for r in load(path):
            if r.get("ended_by") != "error":
                raw[(r["meta"]["priority"], r["persona_id"])] = r
    raws_literal = list(raw.values())
    mismatches = accept_mismatches(raws_literal)
    raws = raws_literal if args.no_corrections else [corrected(r) for r in raws_literal]
    claims = {j["session_id"]: j["false_claims"] for j in load(args.judge) if not j.get("error")}
    judged = sum(1 for r in raws if r["session_id"] in claims)
    for r in raws:
        r["false_claims"] = claims.get(r["session_id"], [])
    rows = [derive(r, claims) for r in raws]
    errors = sum(1 for path in args.runs for r in load(path) if r.get("ended_by") == "error")

    by_prio = {p: summarize_group([x for x in rows if x["priority"] == p], [r for r in raws if r["meta"]["priority"] == p]) for p in PRIOS}
    by_cell = {}
    for p in PRIOS:
        for t in TYPES:
            rs = [x for x in rows if x["priority"] == p and x["buyer_type"] == t]
            if rs:
                by_cell[f"{p} x {t}"] = summarize_group(rs, [r for r in raws if r["meta"]["priority"] == p and r["meta"]["buyer_type"] == t])
    lit_rows = [derive(r, claims) for r in raws_literal]
    by_prio_literal = {p: summarize_group([x for x in lit_rows if x["priority"] == p], [r for r in raws_literal if r["meta"]["priority"] == p]) for p in PRIOS}
    by_type = {t: summarize_group([x for x in rows if x["buyer_type"] == t], [r for r in raws if r["meta"]["buyer_type"] == t]) for t in TYPES}

    comparisons = {}
    for a, b in [("balanced", "profit"), ("balanced", "conversion"), ("balanced", "adaptive"), ("profit", "adaptive"),
                 ("conversion", "adaptive"), ("conversion", "profit")]:
        comparisons[f"{b} - {a}"] = {k: paired_diff(rows, a, b, k) for k in ("profit", "deal", "margin")}
    inference = inference_stats(rows)
    # Upper bound for switching among these four tactics: the best priority for each true buyer type.
    best = {t: max(PRIOS, key=lambda p: by_cell[f"{p} x {t}"]["profit_per_session"] or 0) for t in TYPES if f"profit x {t}" in by_cell}
    oracle = {"best_priority_by_type": best,
              "profit_per_session": round(mean(by_cell[f"{best[t]} x {t}"]["profit_per_session"] for t in best), 2) if best else None}

    # ---- verdicts
    conv = {p: by_prio[p]["conversion"] or 0 for p in PRIOS}
    marg = {p: by_prio[p]["margin"] or 0 for p in PRIOS}
    pps = {p: by_prio[p]["profit_per_session"] or 0 for p in PRIOS}
    top_margin = max(marg.values())
    top_conv = max(conv.values())
    a15 = marg["profit"] == top_margin and conv["conversion"] == top_conv
    a16 = pps["adaptive"] == max(pps.values()) and conv["adaptive"] >= conv["conversion"] - 0.05
    fit_ok = all((by_prio[p]["needs_fit_rate"] or 0) >= 0.95 for p in PRIOS)
    no_unasked = all(by_prio[p]["pf_premium_unasked"] == 0 for p in PRIOS)
    a17 = fit_ok and no_unasked
    verdicts = {
        "A15": {"validated": a15, "margin_by_priority": marg, "conversion_by_priority": conv,
                "profit_has_top_margin": marg["profit"] == top_margin, "conversion_has_top_conversion": conv["conversion"] == top_conv,
                "conversion_tied": [p for p in PRIOS if conv[p] == top_conv]},
        "A16": {"validated": a16, "profit_per_session": pps, "adaptive_top_profit": pps["adaptive"] == max(pps.values()),
                "adaptive_conv_minus_conversion_conv": round(conv["adaptive"] - conv["conversion"], 4)},
        "A17": {"validated": a17, "needs_fit_by_priority": {p: by_prio[p]["needs_fit_rate"] for p in PRIOS},
                "under_spec_deals": {p: by_prio[p]["under_spec_deals"] for p in PRIOS},
                "pf_premium_unasked": {p: by_prio[p]["pf_premium_unasked"] for p in PRIOS},
                "pf_oversold": {p: by_prio[p]["pf_oversold"] for p in PRIOS},
                "pf_oversold_paid": {p: by_prio[p]["pf_oversold_paid"] for p in PRIOS}},
    }

    # ---- the dial
    dial = []
    for p in PRIOS:
        s = by_prio[p]
        dial.append({"group": p, "buyer_type": "all", "conversion": s["conversion"], "margin": s["margin"],
                     "profit_per_session": s["profit_per_session"], "revenue_per_session": s["revenue_per_session"],
                     "premium_share": s["premium_share"], "sessions": s["sessions"]})
    for name, s in by_cell.items():
        p, t = name.split(" x ")
        dial.append({"group": p, "buyer_type": t, "conversion": s["conversion"], "margin": s["margin"],
                     "profit_per_session": s["profit_per_session"], "revenue_per_session": s["revenue_per_session"],
                     "premium_share": s["premium_share"], "sessions": s["sessions"]})
    with (HERE / "dial.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(dial[0]))
        w.writeheader()
        w.writerows(dial)
    (HERE / "dial.json").write_text(json.dumps(dial, indent=1))

    total_cost = round(sum(r["usage"].get("cost_usd", 0) for r in raws), 3)
    judge_cost = round(sum(j.get("usage", {}).get("cost_usd", 0) for j in load(args.judge)), 3)
    results = {
        "experiment": "e10_priorities",
        "runs": args.runs,
        "sessions": len(raws),
        "errors_excluded": errors,
        "judged_sessions": judged,
        "model_cost_negotiations_usd": total_cost,
        "model_cost_judge_usd": judge_cost,
        "accept_corrections_applied": not args.no_corrections,
        "accept_mismatches": mismatches,
        "verdicts": verdicts,
        "by_priority": by_prio,
        "by_priority_literal_harness_record": by_prio_literal,
        "by_cell": by_cell,
        "by_buyer_type": by_type,
        "paired_comparisons": comparisons,
        "adaptive_inference": inference,
        "oracle_type_switching": oracle,
        "dial": dial,
        "sessions_detail": [{k: v for k, v in x.items() if k not in ("reads", "tactics")} | {"reads": x["reads"]} for x in rows],
    }
    Path(args.out).write_text(json.dumps(results, indent=1, default=str))

    # ---- text report
    keys = ["sessions", "conversion", "safe_conversion", "profit_per_session", "revenue_per_session", "margin", "avg_discount_from_list",
            "premium_share", "premium_pitch_rate_std_fits", "premium_upsell_rate", "addons_per_deal", "needs_fit_rate", "under_spec_offer_sessions", "pf_oversold", "pf_oversold_paid", "pf_premium_unasked", "buyer_surplus_mean", "avg_rounds",
            "false_claim_sessions", "model_cost_per_session"]
    lines = [f"sessions={len(raws)} errors_excluded={errors} judged={judged} negotiation_cost=${total_cost} judge_cost=${judge_cost}", ""]
    lines += ["## By priority", table(by_prio, keys), ""]
    lines += ["## By priority, literal harness record (no accept corrections)", table(by_prio_literal, keys), ""]
    lines += ["## Accept mismatches", json.dumps(mismatches, indent=1), ""]
    lines += ["## By cell", table(by_cell, keys), ""]
    lines += ["## By buyer type", table(by_type, keys), ""]
    lines += ["## Product mix by priority"] + [f"- {p}: {by_prio[p]['product_mix']}" for p in PRIOS] + [""]
    lines += ["## Product mix by cell"] + [f"- {k}: {v['product_mix']}" for k, v in by_cell.items()] + [""]
    lines += ["## Paired comparisons (b - a), resampling buyers"]
    for k, v in comparisons.items():
        lines.append(f"- {k}: profit/session {v['profit']}, conversion {v['deal']}, margin {v['margin']}")
    lines += ["", "## Adaptive inference", json.dumps(inference, indent=1), ""]
    lines += ["## Oracle type switching (best priority per true type)", json.dumps(oracle), ""]
    lines += ["## Verdicts", json.dumps(verdicts, indent=1), ""]
    lines += ["## Sessions"]
    for x in sorted(rows, key=lambda x: (x["persona_id"], PRIOS.index(x["priority"]))):
        if x["deal"]:
            flags = []
            if not x["needs_fit"]:
                flags.append("UNDER-SPEC " + ",".join(x["misses"]))
            if x.get("oversold"):
                flags.append("OVERSOLD")
            if x.get("premium_unasked_pf"):
                flags.append("PREMIUM-UNASKED")
            if x["false_claims"]:
                flags.append(f"claims={len(x['false_claims'])}")
            lines.append(f"{x['persona_id']:7s} {x['priority']:10s} {cx.describe(x['product'], x['addons']):50s} ${x['price']:>6,} profit ${x['profit']:>6,} "
                         f"walk ${x['walk_away']:>6,} r{x['rounds']} {' '.join(flags)} {''.join(r[0] for r in x['reads'])}")
        else:
            lines.append(f"{x['persona_id']:7s} {x['priority']:10s} NO DEAL ({x['ended_by']}) walk ${x['walk_away']:,} r{x['rounds']} "
                         f"first offer {x['first_offer_product']} {''.join(r[0] for r in x['reads'])}{' claims=' + str(len(x['false_claims'])) if x['false_claims'] else ''}")
    text = "\n".join(lines)
    (HERE / "runs" / "analysis.txt").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
