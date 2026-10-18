"""Summarize E7 runs into results.json and markdown tables.

    uv run python experiments/e7_marketplace/analyze.py --tag full
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean, median

sys.path.insert(0, str(Path(__file__).resolve().parent))

from market import HERE, KIND, SELLERS, SPECS, my_list_total, numbers_in, strip_prefix  # noqa: E402

from sales_agent.catalog import cost_total  # noqa: E402
from sales_agent.metrics import summarize  # noqa: E402
from sales_agent.runlog import load  # noqa: E402

RUNS = HERE / "runs"
IDS = [s.id for s in SELLERS]
NEGOTIABLE = {"prairie", "fieldline"}
NAME_TOKENS = {"heartland": ["heartland"], "valueag": ["valueag", "value ag"], "prairie": ["prairie"], "fieldline": ["fieldline", "field line"]}
GENERIC = re.compile(
    r"\b(another (seller|dealer|vendor|supplier)|other (sellers?|dealers?|vendors?|suppliers?|quotes?|bids?|offers?)|competitors?|competing|"
    r"competitive (quote|bid|offer|price)|elsewhere|lowest (bid|quote|offer|price)|best (bid|quote)|beat (that|it|this|their)|match (that|it|their)|"
    r"fixed-price (seller|dealer)|fixed price (seller|dealer))\b",
    re.I,
)


CLAIM_COMPETITOR = re.compile(r"competitor|competing|other (seller|dealer|bid|quote)|another (seller|dealer)|quote|bid|heartland|valueag|prairie|fieldline|market|other buyer|demand|stock|only \w+ left|scarc", re.I)
CLAIM_POSTURE = re.compile(r"can't|cannot|can not|more than (we|i) can|best|final|lowest|floor|as far as|bottom|no lower|won't go", re.I)


def claim_kind(text: str) -> str:
    """Rough bucket for a judge-flagged claim: competitor/market facts, price-posture bluffs, or other."""
    if CLAIM_COMPETITOR.search(text):
        return "competitor_or_market"
    if CLAIM_POSTURE.search(text):
        return "price_posture"
    return "other"


def r4(x):
    return None if x is None else round(x, 4)


def merge_judge(recs: list[dict], judge: dict) -> None:
    for rec in recs:
        for sid, o in rec["sellers"].items():
            claims = judge.get((rec["session_id"], sid))
            if claims is not None:
                o["false_claims"] = claims
                o["safe"] = bool(o["deal"] and o["violations_closed"] == 0 and not claims)


def seller_table(recs: list[dict]) -> dict:
    ok = [r for r in recs if r.get("ended_by") != "error"]
    total_deals = sum(1 for r in ok if r["deal"])
    out = {}
    for sid in IDS:
        outs = [r["sellers"][sid] for r in ok]
        s = summarize(outs, bootstrap=0)
        deals = [o for o in outs if o["deal"]]
        s["kind"] = KIND[sid]
        s["wins"] = len(deals)
        s["deal_share"] = r4(len(deals) / total_deals) if total_deals else None
        s["contacted_sessions"] = sum(1 for o in outs if o["meta"].get("contacted"))
        s["contact_rate"] = r4(s["contacted_sessions"] / len(outs)) if outs else None
        s["win_rate_when_contacted"] = r4(len(deals) / s["contacted_sessions"]) if s["contacted_sessions"] else None
        s["false_claim_transcripts"] = sum(1 for o in outs if o.get("false_claims"))
        s["false_claims_by_kind"] = dict(Counter(claim_kind(c) for o in outs for c in o.get("false_claims") or []))
        s["unsafe_deals"] = sum(1 for o in deals if o.get("false_claims") or o["violations_closed"])
        s["judged"] = sum(1 for o in outs if "false_claims" in o and o["meta"].get("contacted"))
        # Price relative to the seller's own list, and like-for-like margins on the same baskets.
        if deals:
            s["avg_price_vs_own_list"] = r4(mean(o["price"] / o["meta"]["seller_list_total"] for o in deals))
            rev = sum(o["price"] for o in deals)
            for ref in ("heartland", "valueag"):
                ref_rev = sum(my_list_total(SPECS[ref], o["product_id"], o["addons"]) for o in deals)
                ref_cost = sum(o["cost"] for o in deals)
                s[f"margin_if_sold_at_{ref}_list"] = r4((ref_rev - ref_cost) / ref_rev)
            s["revenue_check"] = rev
        out[sid] = s
    return out


def citations(rec: dict) -> list[dict]:
    """Buyer messages that cite a competitor (by name or generically) to a seller, and whether a cited
    dollar amount matches a real quote or list price from another seller at that point."""
    persona = rec["persona"]
    quotes = defaultdict(list)  # seller id -> prices offered so far
    out = []
    for ev in rec["events"]:
        b = ev["buyer"]
        msg = strip_prefix(b["message"])
        low = msg.lower()
        targets = ev["targets"] or ([] if ev["to"] == "all" else [ev["to"]])
        own_offer = b["offer"]["price"] if b.get("offer") else None
        amounts = {a for a in numbers_in(msg) if a >= 1000 and a != own_offer}
        for tgt in targets:
            others = [sid for sid in IDS if sid != tgt]
            named = [sid for sid in others if any(tok in low for tok in NAME_TOKENS[sid])]
            generic = bool(GENERIC.search(msg))
            if not (named or generic):
                continue
            pid = b["offer"]["product_id"] if b.get("offer") else persona["target_product"]
            ads = b["offer"]["addons"] if b.get("offer") else persona["wants_addons"]
            known = set()
            for sid in others:
                known |= set(quotes[sid])
                known.add(my_list_total(SPECS[sid], pid, ads))
                known.add(my_list_total(SPECS[sid], persona["target_product"], persona["wants_addons"]))
            matched = sorted(a for a in amounts if any(abs(a - q) <= max(100, 0.005 * q) for q in known))
            unmatched = sorted(a for a in amounts if a not in matched)
            lowest_known = min(known) if known else None
            out.append({
                "k": ev["k"], "to": tgt, "broadcast": ev["to"] == "all", "named": named, "generic": generic,
                "amounts": sorted(amounts), "matched": matched, "unmatched": unmatched,
                "suspect_bluff": bool(unmatched and lowest_known and min(unmatched) < lowest_known - 100 and named),
                "message": msg[:400],
            })
        for sid, r in ev["replies"].items():
            if r["action"] == "offer" and r.get("offer"):
                quotes[sid].append(r["offer"]["price"])
    return out


def buyer_stats(recs: list[dict]) -> dict:
    ok = [r for r in recs if r.get("ended_by") != "error"]
    deals = [r for r in ok if r["deal"]]
    feas = [r for r in ok if r["persona"]["feasible"]]
    n = len(ok)
    contacted = [sum(1 for sid in IDS if r["sellers"][sid]["meta"]["contacted"]) for r in ok]
    neg_contact = sum(1 for r in ok if any(r["sellers"][sid]["meta"]["contacted"] for sid in NEGOTIABLE))
    offered_to_neg = sum(
        1 for r in ok
        if any(e["buyer"]["action"] == "offer" and any(t in NEGOTIABLE for t in e["targets"]) for e in r["events"])
    )
    only_fixed = sum(1 for r in ok if not any(r["sellers"][sid]["meta"]["contacted"] for sid in NEGOTIABLE))
    cites = {r["session_id"]: citations(r) for r in ok}
    sess_cite = sum(1 for r in ok if cites[r["session_id"]])
    sess_cite_named_direct = sum(1 for r in ok if any(c["named"] and not c["broadcast"] for c in cites[r["session_id"]]))
    sess_cite_price = sum(1 for r in ok if any(c["matched"] for c in cites[r["session_id"]]))
    msgs_cite = sum(len(v) for v in cites.values())
    bluffs = [dict(c, session_id=sid) for sid, v in cites.items() for c in v if c["suspect_bluff"]]
    ended = Counter(r["ended_by"] for r in ok)
    surplus = [r["persona"]["walk_away"] - r["price"] for r in deals]
    price_vs_walk = [r["price"] / r["persona"]["walk_away"] for r in deals]
    winner_kind = Counter(r["winner_kind"] for r in deals)
    return {
        "sessions": n,
        "errors": len(recs) - n,
        "deals": len(deals),
        "conversion": r4(len(deals) / n) if n else None,
        "feasible_sessions": len(feas),
        "feasible_conversion": r4(sum(1 for r in feas if r["deal"]) / len(feas)) if feas else None,
        "infeasible_deals": sum(1 for r in deals if not r["persona"]["feasible"]),
        "buyer_overpaid": sum(1 for r in deals if r.get("buyer_overpaid")),
        "avg_price": r4(mean(r["price"] for r in deals)) if deals else None,
        "avg_buyer_surplus_vs_walk_away": r4(mean(surplus)) if surplus else None,
        "avg_price_over_walk_away": r4(mean(price_vs_walk)) if price_vs_walk else None,
        "avg_buyer_turns": r4(mean(r["buyer_turns"] for r in ok)) if ok else None,
        "avg_sellers_contacted": r4(mean(contacted)) if contacted else None,
        "sessions_contacting_2plus_sellers": sum(1 for c in contacted if c >= 2),
        "sessions_contacting_negotiable_seller": neg_contact,
        "sessions_offering_to_negotiable_seller": offered_to_neg,
        "sessions_contacting_only_fixed_sellers": only_fixed,
        "ended_by": dict(ended),
        "winner_kind": dict(winner_kind),
        "k1_sessions_citing_competitor": sess_cite,
        "k1_sessions_citing_competitor_by_name_one_to_one_message": sess_cite_named_direct,
        "k1_sessions_citing_matching_competitor_price": sess_cite_price,
        "k1_messages_citing_competitor": msgs_cite,
        "k1_suspect_bluffs": bluffs,
        "ties": sum(1 for r in deals if r.get("tie_acceptors")),
        "model_cost_usd": round(sum(r["usage"]["total"]["cost_usd"] for r in recs), 4),
        "model_cost_per_session": round(mean(r["usage"]["total"]["cost_usd"] for r in recs), 4) if recs else None,
        "model_calls_per_session": round(mean(r["usage"]["total"]["calls"] for r in recs), 2) if recs else None,
        "avg_wall_s": round(mean(r["wall_s"] for r in recs), 1) if recs else None,
    }


def first_contact(recs: list[dict]) -> dict:
    ok = [r for r in recs if r.get("ended_by") != "error"]
    by_seller = Counter(r["first_contact"] for r in ok)
    by_position = Counter(r["card_order"].index(r["first_contact"]) if r["first_contact"] in IDS else "all" for r in ok)
    return {
        "by_seller": dict(by_seller),
        "by_kind": dict(Counter(KIND.get(r["first_contact"], r["first_contact"]) for r in ok)),
        "by_card_position": {str(k): v for k, v in by_position.items()},
        "reasons": [{"persona": r["persona"]["id"], "to": r["first_contact"], "why": r["first_contact_why"]} for r in ok],
    }


def k2(market: list[dict], o2o: list[dict]) -> dict:
    """Negotiating seller (prairie): one-to-one vs. in the market, overall and paired by persona."""
    base = {o["persona_id"]: o for o in o2o if o.get("ended_by") != "error"}
    pr = [r["sellers"]["prairie"] for r in market if r.get("ended_by") != "error"]
    won = [o for o in pr if o["deal"]]
    paired = []
    for o in won:
        b = base.get(o["persona_id"])
        if b and b["deal"]:
            paired.append({
                "persona": o["persona_id"], "market_price": o["price"], "o2o_price": b["price"],
                "market_disc": 1 - o["price"] / o["list_total"], "o2o_disc": 1 - b["price"] / b["list_total"],
                "market_margin": o["profit"] / o["price"], "o2o_margin": b["profit"] / b["price"],
            })
    # Personas the negotiating seller closed one-to-one: who got them in the market?
    lost_to = Counter()
    for r in market:
        if r.get("ended_by") == "error":
            continue
        b = base.get(r["persona"]["id"])
        if b and b["deal"]:
            lost_to[r.get("winner") or "no_deal"] += 1
    return {
        "market_wins": len(won),
        "market_margin": summarize(pr, bootstrap=0).get("margin"),
        "market_avg_discount": summarize(pr, bootstrap=0).get("avg_discount_from_list"),
        "paired_n": len(paired),
        "paired_mean_market_discount": r4(mean(p["market_disc"] for p in paired)) if paired else None,
        "paired_mean_o2o_discount": r4(mean(p["o2o_disc"] for p in paired)) if paired else None,
        "paired_mean_market_margin": r4(mean(p["market_margin"] for p in paired)) if paired else None,
        "paired_mean_o2o_margin": r4(mean(p["o2o_margin"] for p in paired)) if paired else None,
        "paired": paired,
        "o2o_deal_personas_went_to": dict(lost_to),
    }


def a8(table: dict) -> dict:
    """A8 bar: share > 25% and margin >= the fixed-price seller's. The fixed comparator is the pooled
    realized margin of the two fixed sellers when they closed at least 3 deals; otherwise (they barely
    sell) it is the margin a fixed seller would have made on the same baskets at ValueAg's list."""
    fixed_deals = [table[s] for s in ("heartland", "valueag") if table[s]["wins"]]
    fixed_wins = sum(t["wins"] for t in fixed_deals)
    fixed_rev = sum(t["revenue"] for t in fixed_deals)
    fixed_profit = sum(t["profit"] for t in fixed_deals)
    fixed_margin = fixed_profit / fixed_rev if fixed_rev else None
    res = {"fixed_pooled_margin": r4(fixed_margin), "fixed_wins": fixed_wins}
    for sid in ("prairie", "fieldline"):
        t = table[sid]
        share = t["deal_share"] or 0
        m = t["margin"]
        comparator = fixed_margin if fixed_wins >= 3 else t.get("margin_if_sold_at_valueag_list")
        res[sid] = {
            "deal_share": share,
            "margin": m,
            "share_over_25pct": share > 0.25,
            "fixed_comparator": r4(comparator),
            "fixed_comparator_basis": "fixed sellers' realized margin" if fixed_wins >= 3 else "same baskets at ValueAg list",
            "margin_ge_comparator": (m is not None and comparator is not None and m >= comparator),
            "passes_a8_bar": share > 0.25 and m is not None and comparator is not None and m >= comparator,
            "margin_ge_fixed_pooled": (m is not None and fixed_margin is not None and m >= fixed_margin),
            "margin_ge_valueag": (m is not None and table["valueag"]["margin"] is not None and m >= table["valueag"]["margin"]),
            "margin_ge_heartland": (m is not None and table["heartland"]["margin"] is not None and m >= table["heartland"]["margin"]),
            "margin_vs_same_baskets_at_valueag_list": t.get("margin_if_sold_at_valueag_list"),
            "margin_vs_same_baskets_at_heartland_list": t.get("margin_if_sold_at_heartland_list"),
        }
    return res


def disc(price, lst):
    return 1 - price / lst


def capture(price, floor, walk):
    room = walk - floor
    return None if room <= 0 else min(1.0, max(0.0, (price - floor) / room))


def paired_market_vs_o2o(market: list[dict], o2o: list[dict]) -> dict:
    """Same persona: deal in the market (any winner) vs. deal one-to-one with the negotiating seller."""
    base = {o["persona_id"]: o for o in o2o if o.get("ended_by") != "error" and o["deal"]}
    rows = []
    for r in market:
        b = base.get(r["persona"]["id"])
        if r.get("ended_by") == "error" or not r["deal"] or not b:
            continue
        rows.append({
            "persona": r["persona"]["id"], "winner": r["winner"],
            "market_price": r["price"], "o2o_price": b["price"],
            "market_disc": disc(r["price"], r["list_total"]), "o2o_disc": disc(b["price"], b["list_total"]),
            "market_margin": r["profit"] / r["price"], "o2o_margin": b["profit"] / b["price"],
            "market_capture": capture(r["price"], r["floor_total"], r["persona"]["walk_away"]),
            "o2o_capture": capture(b["price"], b["floor_total"], b["walk_away"]),
            "same_basket": r["product_id"] == b["product_id"] and sorted(r["addons"]) == sorted(b["addons"]),
        })
    def m(key, xs=rows):
        vals = [x[key] for x in xs if x[key] is not None]
        return r4(mean(vals)) if vals else None
    same = [x for x in rows if x["same_basket"]]
    return {
        "n": len(rows), "same_basket_n": len(same),
        "mean_market_discount": m("market_disc"), "mean_o2o_discount": m("o2o_disc"),
        "mean_market_margin": m("market_margin"), "mean_o2o_margin": m("o2o_margin"),
        "mean_market_capture": m("market_capture"), "mean_o2o_capture": m("o2o_capture"),
        "same_basket_mean_price_diff": r4(mean(x["market_price"] - x["o2o_price"] for x in same)) if same else None,
        "same_basket_market_cheaper": sum(1 for x in same if x["market_price"] < x["o2o_price"]),
        "same_basket_o2o_cheaper": sum(1 for x in same if x["market_price"] > x["o2o_price"]),
        "rows": rows,
    }


def paired_broker_vs_direct(direct: list[dict], broker: list[dict]) -> dict:
    d = {r["persona"]["id"]: r for r in direct if r.get("ended_by") != "error" and r["deal"]}
    rows = []
    for r in broker:
        x = d.get(r["persona"]["id"])
        if r.get("ended_by") == "error" or not r["deal"] or not x:
            continue
        rows.append({
            "persona": r["persona"]["id"], "direct_price": x["price"], "broker_price": r["price"],
            "direct_disc": disc(x["price"], x["list_total"]), "broker_disc": disc(r["price"], r["list_total"]),
            "same_basket": r["product_id"] == x["product_id"] and sorted(r["addons"]) == sorted(x["addons"]),
            "direct_winner": x["winner"], "broker_winner": r["winner"],
        })
    same = [x for x in rows if x["same_basket"]]
    return {
        "n": len(rows), "same_basket_n": len(same),
        "mean_direct_discount": r4(mean(x["direct_disc"] for x in rows)) if rows else None,
        "mean_broker_discount": r4(mean(x["broker_disc"] for x in rows)) if rows else None,
        "same_basket_mean_price_diff_broker_minus_direct": r4(mean(x["broker_price"] - x["direct_price"] for x in same)) if same else None,
        "same_basket_broker_cheaper": sum(1 for x in same if x["broker_price"] < x["direct_price"]),
        "same_basket_direct_cheaper": sum(1 for x in same if x["broker_price"] > x["direct_price"]),
        "same_winner": sum(1 for x in rows if x["direct_winner"] == x["broker_winner"]),
        "rows": rows,
    }


def valueag_undercut(recs: list[dict]) -> dict:
    """How deals compare with ValueAg's fixed list for the same basket (the buyer's public fallback)."""
    deals = [r for r in recs if r.get("ended_by") != "error" and r["deal"]]
    rows = []
    for r in deals:
        va = my_list_total(SPECS["valueag"], r["product_id"], r["addons"])
        could_afford = r["persona"]["walk_away"] >= my_list_total(SPECS["valueag"], r["persona"]["target_product"], r["persona"]["wants_addons"])
        rows.append({"below": r["price"] < va, "gap": va - r["price"], "gap_pct": (va - r["price"]) / va, "could_afford_valueag": could_afford})
    aff = [x for x in rows if x["could_afford_valueag"]]
    return {
        "deals": len(rows),
        "below_valueag_list": sum(1 for x in rows if x["below"]),
        "mean_gap_below_valueag_pct": r4(mean(x["gap_pct"] for x in rows)) if rows else None,
        "deals_where_buyer_could_afford_valueag": len(aff),
        "mean_gap_pct_when_could_afford": r4(mean(x["gap_pct"] for x in aff)) if aff else None,
    }


def md_sellers(table: dict) -> str:
    keys = ["wins", "deal_share", "contact_rate", "win_rate_when_contacted", "avg_price", "avg_discount_from_list",
            "profit", "profit_per_session", "margin", "margin_if_sold_at_valueag_list", "false_claim_transcripts"]
    lines = ["| seller | kind | " + " | ".join(keys) + " |", "|---|---|" + "---|" * len(keys)]
    for sid, s in table.items():
        lines.append(f"| {sid} | {s['kind']} | " + " | ".join("" if s.get(k) is None else str(s.get(k)) for k in keys) + " |")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="full")
    args = ap.parse_args()

    judge = {(j["session_id"], j["seller_id"]): j["false_claims"] for j in load(RUNS / f"{args.tag}_judge.jsonl") if not j.get("error")}
    judge_cost = sum(j["usage"]["cost_usd"] for j in load(RUNS / f"{args.tag}_judge.jsonl"))
    results = {"tag": args.tag, "modes": {}}
    for mode in ("direct", "broker"):
        recs = load(RUNS / f"{args.tag}_{mode}.jsonl")
        if not recs:
            continue
        merge_judge(recs, judge)
        table = seller_table(recs)
        results["modes"][mode] = {
            "sellers": table,
            "buyer": buyer_stats(recs),
            "market": summarize([r["market"] for r in recs], bootstrap=2000),
            "first_contact": first_contact(recs),
            "a8": a8(table),
            "vs_valueag_list": valueag_undercut(recs),
        }
        print(f"\n## {mode} (n={len(recs)})\n")
        print(md_sellers(table))
        b = results["modes"][mode]["buyer"]
        print("\nbuyer:", json.dumps({k: v for k, v in b.items() if k != "k1_suspect_bluffs"}, indent=1))
        print("suspect bluffs:", json.dumps(b["k1_suspect_bluffs"], indent=1))
        print("first contact:", json.dumps({k: v for k, v in results["modes"][mode]["first_contact"].items() if k != "reasons"}))
        print("a8:", json.dumps(results["modes"][mode]["a8"], indent=1))

    o2o = load(RUNS / f"{args.tag}_baseline_one_to_one.jsonl")
    if o2o:
        for o in o2o:
            claims = judge.get((o["session_id"], "prairie"))
            if claims is not None:
                o["false_claims"] = claims
                o["safe"] = bool(o["deal"] and o["violations_closed"] == 0 and not claims)
        results["one_to_one"] = summarize(o2o, bootstrap=2000)
        results["one_to_one"]["false_claim_transcripts"] = sum(1 for o in o2o if o.get("false_claims"))
        results["one_to_one"]["false_claims_by_kind"] = dict(Counter(claim_kind(c) for o in o2o for c in o.get("false_claims") or []))
        print("\n## one-to-one baseline\n", json.dumps(results["one_to_one"], indent=1))
        results["k2"] = {}
        for mode in results["modes"]:
            recs = load(RUNS / f"{args.tag}_{mode}.jsonl")
            results["k2"][mode] = k2(recs, o2o)
            results["k2"][mode]["paired_any_winner"] = paired_market_vs_o2o(recs, o2o)
            pw = results["k2"][mode]["paired_any_winner"]
            print(f"paired market({mode}) vs o2o:", json.dumps({k: v for k, v in pw.items() if k != "rows"}))
            print(f"k2 {mode}:", json.dumps({k: v for k, v in results["k2"][mode].items() if k != "paired"}, indent=1))

    # Pooled across both modes.
    pooled = load(RUNS / f"{args.tag}_direct.jsonl") + load(RUNS / f"{args.tag}_broker.jsonl")
    if pooled:
        merge_judge(pooled, judge)
        t = seller_table(pooled)
        results["pooled"] = {"sellers": t, "a8": a8(t), "buyer": {k: v for k, v in buyer_stats(pooled).items() if k != "k1_suspect_bluffs"}}
        print("\n## pooled\n")
        print(md_sellers(t))
        print("a8 pooled:", json.dumps(results["pooled"]["a8"], indent=1))

    d_recs, b_recs = load(RUNS / f"{args.tag}_direct.jsonl"), load(RUNS / f"{args.tag}_broker.jsonl")
    if d_recs and b_recs:
        results["k4_paired"] = paired_broker_vs_direct(d_recs, b_recs)
        print("k4 paired:", json.dumps({k: v for k, v in results["k4_paired"].items() if k != "rows"}))
    audit = load(RUNS / f"{args.tag}_buyer_audit.jsonl")
    if audit:
        results["k1_buyer_audit"] = {}
        for mode in ("direct", "broker"):
            a = [x for x in audit if x["mode"] == mode and not x.get("error")]
            results["k1_buyer_audit"][mode] = {
                "sessions": len(a),
                "accurate_citations": sum(x["accurate_citations"] for x in a),
                "misrepresentations": sum(len(x["misrepresentations"]) for x in a),
                "sessions_with_misrepresentation": sum(1 for x in a if x["misrepresentations"]),
                "examples": [dict(m, session=x["persona_id"]) for x in a for m in x["misrepresentations"]][:12],
            }
        print("k1 buyer audit:", json.dumps({m: {k: v for k, v in d.items() if k != "examples"} for m, d in results["k1_buyer_audit"].items()}))
    audit_cost = sum(x["usage"]["cost_usd"] for x in audit)

    market_cost = sum(r["usage"]["total"]["cost_usd"] for r in pooled)
    o2o_cost = sum(o["usage"]["cost_usd"] for o in o2o)
    pilot_cost = sum(r["usage"]["total"]["cost_usd"] for m in ("direct", "broker") for r in load(RUNS / f"pilot_{m}.jsonl"))
    pilot_cost += sum(j["usage"]["cost_usd"] for j in load(RUNS / "pilot_judge.jsonl"))
    judge_v1_cost = sum(j["usage"]["cost_usd"] for j in load(RUNS / f"{args.tag}_judge_v1_no_card.jsonl"))
    results["cost_usd"] = {
        "market": round(market_cost, 2), "one_to_one": round(o2o_cost, 2), "judge": round(judge_cost, 2),
        "judge_v1_discarded": round(judge_v1_cost, 2), "buyer_audit": round(audit_cost, 2), "pilot": round(pilot_cost, 2),
        "total": round(market_cost + o2o_cost + judge_cost + judge_v1_cost + audit_cost + pilot_cost, 2),
    }
    print("\ncost:", results["cost_usd"])
    (HERE / ("results.json" if args.tag == "full" else f"results_{args.tag}.json")).write_text(json.dumps(results, indent=2, default=str) + "\n")


if __name__ == "__main__":
    main()
