"""E5 analysis: KPIs per strategy, comparisons, and the A6 / A10 verdicts.

    uv run python experiments/e5_strategies/analyze.py [--runs runs/main.jsonl]

Merges judge flags (runs/judge.jsonl) into the outcomes, writes results.json,
and writes the markdown tables to runs/analysis.txt.
"""

from __future__ import annotations

import argparse
import json
import random
import re
from collections import Counter
from pathlib import Path
from statistics import mean

from sales_agent.catalog import list_total
from sales_agent.metrics import compare, markdown_table, summarize
from sales_agent.runlog import load

from strategies import CONDITIONS

HERE = Path(__file__).resolve().parent
RUNS = HERE / "runs"
BOOT = 4000


def dedupe(records: list[dict]) -> tuple[list[dict], int]:
    """Keep the last finished record per (condition, persona); count error records."""
    best: dict[tuple[str, str], dict] = {}
    errors = 0
    for r in records:
        if r.get("ended_by") == "error":
            errors += 1
            continue
        best[(r["meta"]["condition"], r["persona_id"])] = r
    return list(best.values()), errors


CLAIM_PATTERNS = [
    # fixed_price is told "prices are fixed at list"; the judge only sees floors, so it flags the policy itself.
    ("fixed_policy_artifact", lambda c, t: c == "fixed_price" and re.search(r"fixed|firm|discount|bundle|waive|reduce|lower the total|negotiable|below list", t, re.I)),
    ("invented_bundle_policy", lambda c, t: c == "bundle_first" and re.search(r"warranty", t, re.I) and re.search(r"bundled|either way|comes with|take it out|per our pricing|includes", t, re.I)),
    ("limit_bluff", lambda c, t: re.search(r"as far as|best number|final|too far below|can't come down|below where|long way from|not able to lower|can.t go|below what we can|than we can go", t, re.I)),
    ("arithmetic", lambda c, t: re.search(r"arithmetic|off list|below the \$[\d,]+ list|overstated", t, re.I)),
]


def classify_claim(condition: str, text: str) -> str:
    for name, test in CLAIM_PATTERNS:
        if test(condition, text):
            return name
    return "other"


def merge_judge(records: list[dict], judged: list[dict]) -> None:
    flags = {j["session_id"]: j for j in judged if not j.get("error")}
    for r in records:
        j = flags.get(r["session_id"])
        r["judged"] = j is not None
        if j is not None:
            r["false_claims"] = j["false_claims"]
        r["safe"] = bool(r["deal"] and r["violations_closed"] == 0 and not r.get("false_claims"))
        r["claim_types"] = [classify_claim(r["meta"]["condition"], c) for c in r.get("false_claims") or []]
        real = [t for t in r["claim_types"] if t != "fixed_policy_artifact"]
        r["safe_adj"] = bool(r["deal"] and r["violations_closed"] == 0 and not real)


def paired(a: list[dict], b: list[dict], seed: int = 0) -> dict:
    """Paired bootstrap over personas present in both: b minus a."""
    pa = {r["persona_id"]: r for r in a}
    pb = {r["persona_id"]: r for r in b}
    ids = sorted(set(pa) & set(pb))
    if len(ids) < 2:
        return {}
    dp = [pb[i]["profit"] - pa[i]["profit"] for i in ids]
    dc = [int(pb[i]["deal"]) - int(pa[i]["deal"]) for i in ids]
    rng = random.Random(seed)
    bp, bc = [], []
    for _ in range(BOOT):
        idx = [rng.randrange(len(ids)) for _ in ids]
        bp.append(mean(dp[k] for k in idx))
        bc.append(mean(dc[k] for k in idx))
    bp.sort()
    bc.sort()
    lo, hi = int(0.025 * BOOT), int(0.975 * BOOT) - 1
    return {
        "pairs": len(ids),
        "profit_per_session_diff": round(mean(dp), 2),
        "profit_per_session_diff_ci95": [round(bp[lo], 2), round(bp[hi], 2)],
        "conversion_diff": round(mean(dc), 4),
        "conversion_diff_ci95": [round(bc[lo], 4), round(bc[hi], 4)],
        "share_bootstrap_diff_gt_0": round(sum(1 for x in bp if x > 0) / BOOT, 3),
    }


def extras(rs: list[dict]) -> dict:
    """Metrics beyond metrics.summarize: per-deal, token, latency, seller-only cost, judge, behavior."""
    n = len(rs)
    deals = [r for r in rs if r["deal"]]
    nd = len(deals)
    tok = sum(r["usage"].get("input_tokens", 0) + r["usage"].get("output_tokens", 0) for r in rs)
    cost = sum(r["usage"].get("cost_usd", 0) for r in rs)
    s_cost = sum(r["meta"].get("seller_usage", {}).get("cost_usd", 0) for r in rs)
    s_calls = sum(r["meta"].get("seller_usage", {}).get("calls", 0) for r in rs)
    judged = [r for r in rs if r.get("judged")]
    flagged = [r for r in judged if r.get("false_claims")]
    first_offer = []
    for r in rs:
        so = [t for t in r["transcript"] if t["role"] == "seller" and t["action"] == "offer" and t["offer"]]
        if so:
            o = so[0]["offer"]
            first_offer.append(o["price"] / list_total(o["product_id"], o["addons"]))
    free_addons = 0
    for r in deals:
        wanted = set(r["meta"]["persona"]["wants_addons"])
        if set(r["addons"]) - wanted:
            free_addons += 1
    return {
        "profit_per_deal": round(sum(r["profit"] for r in deals) / nd, 2) if nd else None,
        "model_calls_per_session": round(sum(r["usage"].get("calls", 0) for r in rs) / n, 2),
        "tokens_per_session": round(tok / n),
        "tokens_per_deal": round(tok / nd) if nd else None,
        "model_cost_per_session": round(cost / n, 4),
        "model_cost_per_deal": round(cost / nd, 4) if nd else None,
        "seller_calls_per_session": round(s_calls / n, 2),
        "seller_cost_per_session": round(s_cost / n, 4),
        "seller_cost_per_deal": round(s_cost / nd, 4) if nd else None,
        "latency_s_per_session": round(mean(r["wall_s"] for r in rs), 1),
        "latency_s_per_deal_session": round(mean(r["wall_s"] for r in deals), 1) if nd else None,
        "judged_sessions": len(judged),
        "sessions_with_false_claims": len(flagged),
        "false_claims_total": sum(len(r.get("false_claims") or []) for r in judged),
        "sessions_with_false_claims_excl_artifacts": sum(
            1 for r in judged if any(t != "fixed_policy_artifact" for t in r.get("claim_types", []))),
        "claim_types": dict(Counter(t for r in judged for t in r.get("claim_types", []))),
        "safe_conversion_adj": round(sum(1 for r in rs if r.get("safe_adj")) / n, 4),
        "first_offer_share_of_list": round(mean(first_offer), 4) if first_offer else None,
        "deals_with_unrequested_addons": free_addons,
        "ended_by": dict(Counter(r["ended_by"] for r in rs)),
    }


def fmt_ci(ci) -> str:
    return f"[{ci[0]}, {ci[1]}]" if ci else ""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", default=str(RUNS / "main.jsonl"))
    ap.add_argument("--out", default=str(HERE / "results.json"))
    ap.add_argument("--text", default=str(RUNS / "analysis.txt"))
    args = ap.parse_args()

    records, n_err = dedupe(load(args.runs))
    merge_judge(records, load(RUNS / "judge.jsonl"))
    order = [c for c in CONDITIONS if any(r["meta"]["condition"] == c for r in records)]
    groups = {c: sorted([r for r in records if r["meta"]["condition"] == c], key=lambda r: r["persona_id"]) for c in order}

    summary = {c: {**summarize(rs, bootstrap=BOOT), **extras(rs)} for c, rs in groups.items()}

    lines = []
    lines.append(markdown_table(groups, keys=[
        "sessions", "deals", "conversion", "feasible_conversion", "safe_conversion",
        "profit_per_session", "margin", "surplus_capture", "avg_discount_from_list", "avg_rounds",
    ]))
    lines.append("")
    head = ("| condition | profit/session [95% CI] | profit/deal | conv [95% CI] | calls/session | tokens/deal | "
            "cost/session | cost/deal | seller cost/deal | latency/session (s) | false-claim sessions | below-floor attempts | first offer / list |")
    lines += [head, "|---|" + "---|" * 12]
    for c in order:
        s = summary[c]
        lines.append(
            f"| {c} | {s['profit_per_session']} {fmt_ci(s.get('profit_per_session_ci95'))} | {s['profit_per_deal']} | "
            f"{s['conversion']} {fmt_ci(s.get('conversion_ci95'))} | {s['model_calls_per_session']} | {s['tokens_per_deal']} | "
            f"${s['model_cost_per_session']} | ${s['model_cost_per_deal']} | ${s['seller_cost_per_deal']} | "
            f"{s['latency_s_per_session']} | {s['sessions_with_false_claims']}/{s['judged_sessions']} | "
            f"{s['violations_attempted']} | {s['first_offer_share_of_list']} |"
        )

    lines += ["", "| condition | safe conversion (raw judge) | safe conversion (judge artifacts removed) | sessions with false claims (excl. artifacts) / judged | claim types |", "|---|---|---|---|---|"]
    for c in order:
        s = summary[c]
        lines.append(f"| {c} | {s['safe_conversion']} | {s['safe_conversion_adj']} | {s['sessions_with_false_claims_excl_artifacts']}/{s['judged_sessions']} | "
                     + ", ".join(f"{k}: {v}" for k, v in sorted(s["claim_types"].items())) + " |")

    # Profit per persona (rows) and condition (columns); x = no deal.
    personas = sorted({r["persona_id"] for r in records})
    lines += ["", "Profit per session by persona (x = no deal):", "",
              "| persona | brief | floor / list / walk-away | " + " | ".join(order) + " |",
              "|---|---|---|" + "---|" * len(order)]
    for pid in personas:
        rec = {c: next((r for r in groups[c] if r["persona_id"] == pid), None) for c in order}
        p = next(r for r in rec.values() if r)["meta"]["persona"]
        cells = ["" if r is None else (f"{r['profit']:,}" if r["deal"] else "x") for r in rec.values()]
        lines.append(f"| {pid} | {p['brief']} | {p['floor']:,} / {p['list']:,} / {p['walk_away']:,} | " + " | ".join(cells) + " |")

    # Comparisons vs the open LLM and vs fixed price.
    comps: dict[str, dict] = {}
    for base in ("open_llm", "fixed_price"):
        if base not in groups:
            continue
        comps[base] = {}
        lines += ["", f"Compared with {base} (b minus a; unpaired = metrics.compare, paired = bootstrap over the same personas):", "",
                  "| condition | profit/session diff | unpaired 95% CI | lift % | paired 95% CI | P(diff>0) | conv diff | paired conv 95% CI |",
                  "|---|---|---|---|---|---|---|---|"]
        for c in order:
            if c == base:
                continue
            u = compare(groups[base], groups[c], bootstrap=BOOT)
            p = paired(groups[base], groups[c])
            comps[base][c] = {"unpaired": u, "paired": p}
            lines.append(
                f"| {c} | {u['profit_per_session_diff']} | {fmt_ci(u['profit_per_session_diff_ci95'])} | {u['profit_per_session_lift_pct']} | "
                f"{fmt_ci(p.get('profit_per_session_diff_ci95'))} | {p.get('share_bootstrap_diff_gt_0')} | {u['conversion_diff']} | "
                f"{fmt_ci(p.get('conversion_diff_ci95'))} |"
            )

    # Named pairs: N6 (code picks price vs LLM does both), B2/N5 (framing and explicit strategy).
    pairs = [("boulware", "boulware_llm"), ("split_difference", "split_llm"), ("boulware", "bundle_first"),
             ("open_llm", "anchor_value"), ("conceder", "boulware"), ("split_difference", "tit_for_tat")]
    lines += ["", "Named pairs (b minus a, paired over personas):", "",
              "| a | b | profit/session diff | paired 95% CI | P(diff>0) | conv diff | margin a | margin b |", "|---|---|---|---|---|---|---|---|"]
    comps["pairs"] = {}
    for a, b in pairs:
        if a in groups and b in groups:
            p = paired(groups[a], groups[b])
            comps["pairs"][f"{b}_vs_{a}"] = p
            lines.append(f"| {a} | {b} | {p['profit_per_session_diff']} | {fmt_ci(p['profit_per_session_diff_ci95'])} | "
                         f"{p['share_bootstrap_diff_gt_0']} | {p['conversion_diff']} | {summary[a]['margin']} | {summary[b]['margin']} |")

    # A6: best strategy vs open_llm, >= 10% more profit/session at conversion within 5 points.
    verdicts = {}
    if "open_llm" in groups:
        cands = [c for c in order if c not in ("open_llm", "fixed_price")]
        best = max(cands, key=lambda c: summary[c]["profit_per_session"])
        u = comps["open_llm"][best]["unpaired"]
        p = comps["open_llm"][best]["paired"]
        meets = (u["profit_per_session_lift_pct"] or 0) >= 10 and u["conversion_diff"] >= -0.05
        ci_pos = p.get("profit_per_session_diff_ci95", [0, 0])[0] > 0
        passing = [c for c in cands
                   if (comps["open_llm"][c]["unpaired"]["profit_per_session_lift_pct"] or 0) >= 10
                   and comps["open_llm"][c]["unpaired"]["conversion_diff"] >= -0.05]
        verdicts["A6"] = {
            "best_strategy": best,
            "profit_per_session_lift_pct": u["profit_per_session_lift_pct"],
            "conversion_diff": u["conversion_diff"],
            "paired_profit_diff_ci95": p.get("profit_per_session_diff_ci95"),
            "unpaired_profit_diff_ci95": u["profit_per_session_diff_ci95"],
            "meets_bar_point_estimate": meets,
            "paired_ci_excludes_zero": ci_pos,
            "strategies_meeting_bar_point_estimate": passing,
        }

    # A10: model cost vs the profit gained over fixed-price selling.
    if "fixed_price" in groups:
        base_pps = summary["fixed_price"]["profit_per_session"]
        a10 = {}
        lines += ["", "A10: model cost vs profit gained over fixed price (per session; the ratio is the same per deal "
                      "when the gain is spread over the strategy's deals):", "",
                  "| condition | profit/session gain vs fixed | total cost/session | ratio (buyer+seller) | seller cost/session | ratio (seller only) |",
                  "|---|---|---|---|---|---|"]
        for c in order:
            if c == "fixed_price":
                continue
            s = summary[c]
            gain = s["profit_per_session"] - base_pps
            r_all = s["model_cost_per_session"] / gain if gain > 0 else None
            r_sel = s["seller_cost_per_session"] / gain if gain > 0 else None
            a10[c] = {
                "profit_per_session_gain": round(gain, 2),
                "model_cost_per_session": s["model_cost_per_session"],
                "seller_cost_per_session": s["seller_cost_per_session"],
                "ratio_total_cost": round(r_all, 5) if r_all is not None else None,
                "ratio_seller_cost": round(r_sel, 5) if r_sel is not None else None,
                "model_cost_per_deal": s["model_cost_per_deal"],
                "profit_gain_per_strategy_deal": round(gain * s["sessions"] / s["deals"], 2) if s["deals"] else None,
            }
            lines.append(
                f"| {c} | {gain:.0f} | ${s['model_cost_per_session']} | "
                f"{'' if r_all is None else f'{r_all:.2%}'} | ${s['seller_cost_per_session']} | {'' if r_sel is None else f'{r_sel:.2%}'} |"
            )
        verdicts["A10"] = a10

    total_cost = sum(r["usage"].get("cost_usd", 0) for r in records)
    judge_cost = sum(j["usage"].get("cost_usd", 0) for j in load(RUNS / "judge.jsonl"))
    result = {
        "experiment": "e5_strategies",
        "runs_file": Path(args.runs).name,
        "sessions": len(records),
        "error_records": n_err,
        "conditions": {c: {"kind": CONDITIONS[c].kind, "description": CONDITIONS[c].description} for c in order},
        "summary": summary,
        "comparisons": comps,
        "verdicts": verdicts,
        "negotiation_model_cost_usd": round(total_cost, 2),
        "judge_model_cost_usd": round(judge_cost, 2),
    }
    Path(args.out).write_text(json.dumps(result, indent=2))
    lines += ["", f"Negotiation model cost: ${total_cost:.2f}; judge: ${judge_cost:.2f}; error records: {n_err}",
              "", "Verdict inputs:", json.dumps(verdicts.get("A6", {}), indent=2)]
    Path(args.text).write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
