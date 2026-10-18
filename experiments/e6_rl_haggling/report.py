"""Assemble results.json for E6 from the phase outputs and print the tables the README uses.

    uv run python experiments/e6_rl_haggling/report.py
"""

from __future__ import annotations

import csv
import json
import random
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from sales_agent.metrics import compare, summarize  # noqa: E402
from sales_agent.runlog import load  # noqa: E402

RUNS = HERE / "runs"
KEYS = ("sessions", "errors", "conversion", "conversion_ci95", "feasible_conversion", "profit_per_session",
        "profit_per_session_ci95", "margin", "avg_discount_from_list", "surplus_capture", "avg_rounds",
        "violations_attempted", "violations_closed", "model_cost_usd", "model_cost_per_session")


def paired(rows_a: list[dict], rows_b: list[dict], boot: int = 4000, seed: int = 0) -> dict:
    """b - a on the personas both conditions ran, with a persona-level bootstrap CI."""
    a = {o["persona_id"]: o for o in rows_a if o["ended_by"] != "error"}
    b = {o["persona_id"]: o for o in rows_b if o["ended_by"] != "error"}
    ids = sorted(set(a) & set(b))
    if not ids:
        return {}
    d = [b[i]["profit"] - a[i]["profit"] for i in ids]
    base = sum(a[i]["profit"] for i in ids) / len(ids)
    rng = random.Random(seed)
    means = sorted(sum(d[rng.randrange(len(d))] for _ in d) / len(d) for _ in range(boot))
    wins = sum(x > 0 for x in d)
    losses = sum(x < 0 for x in d)
    return {
        "personas": len(ids),
        "diff_pps": round(sum(d) / len(d), 1),
        "diff_ci95": [round(means[int(0.025 * boot)], 1), round(means[int(0.975 * boot) - 1], 1)],
        "lift_pct": round(sum(d) / len(d) / base * 100, 1) if base else None,
        "persona_wins_losses_ties": [wins, losses, len(d) - wins - losses],
    }


def pick(s: dict) -> dict:
    return {k: s.get(k) for k in KEYS if k in s}


def curve_table(path: Path) -> dict:
    rows = list(csv.DictReader(open(path)))
    by = defaultdict(lambda: defaultdict(list))
    for r in rows:
        by[r["method"]][int(r["episode"])].append(float(r["eval_pps"]))
    return {m: {ep: round(sum(v) / len(v), 1) for ep, v in sorted(d.items())} for m, d in by.items()}


def usage_of(rows) -> float:
    return sum((o.get("usage") or {}).get("cost_usd", 0) for o in rows)


def main():
    res: dict = {"experiment": "E6 seller learns to haggle (RL)"}
    p1 = json.load(open(HERE / "phase1_results.json"))
    best = p1["best_fixed"]
    res["phase1"] = {
        "best_fixed": best,
        "oracle_pps": p1["oracle_pps"],
        "held_out": p1["held_out"],
        "shifted": p1["shifted"],
        "vs_best_fixed_held_out": p1["vs_best_fixed_held_out"],
        "vs_best_fixed_shifted": p1["vs_best_fixed_shifted"],
        "held_out_by_type": p1["held_out_by_type"],
        "learning_curves_mean_eval_pps": curve_table(HERE / "curves.csv"),
        "curve_reference_pps": p1.get("curve_reference_pps"),
    }

    cost = {}
    p2 = load(RUNS / "phase2.jsonl")
    if p2:
        res["phase2"] = {}
        for buyer in ("opus", "haiku"):
            g = {c: [o for o in p2 if o["meta"]["buyer"] == buyer and o["meta"]["condition"] == c] for c in ("learned", "best_fixed")}
            if not g["learned"]:
                continue
            res["phase2"][buyer] = {
                "learned": pick(summarize(g["learned"])),
                "best_fixed": pick(summarize(g["best_fixed"])),
                "paired_learned_minus_fixed": paired(g["best_fixed"], g["learned"]),
                "unpaired_compare": compare(g["best_fixed"], g["learned"]),
            }
        # Same 10 personas: Opus vs Haiku buyers, per condition.
        ids10 = {o["persona_id"] for o in p2 if o["meta"]["buyer"] == "haiku"}
        res["phase2"]["opus_on_haiku_personas"] = {
            c: pick(summarize([o for o in p2 if o["meta"]["buyer"] == "opus" and o["meta"]["condition"] == c and o["persona_id"] in ids10]))
            for c in ("learned", "best_fixed")
        }
        res["phase2"]["opus_on_haiku_personas"]["paired_learned_minus_fixed"] = paired(
            [o for o in p2 if o["meta"]["buyer"] == "opus" and o["meta"]["condition"] == "best_fixed" and o["persona_id"] in ids10],
            [o for o in p2 if o["meta"]["buyer"] == "opus" and o["meta"]["condition"] == "learned" and o["persona_id"] in ids10],
        )
        # What the learned policy actually did against LLM buyers.
        acts = defaultdict(int)
        srcs = defaultdict(int)
        for o in p2:
            for e in o["meta"].get("strategy_log", []):
                acts[e["action"]] += 1
                srcs[e["source"]] += 1
        res["phase2"]["learned_action_counts"] = dict(acts)
        res["phase2"]["learned_state_source"] = dict(srcs)
        cost["phase2"] = usage_of(p2)

    p3 = load(RUNS / "phase3.jsonl")
    if p3:
        res["phase3"] = {"eval": {}, "train": {}}
        versions = sorted({o["meta"]["version"] for o in p3})
        for v in versions:
            for split in ("eval", "train"):
                xs = [o for o in p3 if o["meta"]["version"] == v and o["meta"]["split"] == split]
                if xs:
                    res["phase3"][split][v] = pick(summarize(xs))
        ev = {v: [o for o in p3 if o["meta"]["version"] == v and o["meta"]["split"] == "eval"] for v in versions}
        res["phase3"]["paired_vs_v0"] = {v: paired(ev["v0"], ev[v]) for v in versions if v != "v0" and ev.get(v)}
        books = json.load(open(HERE / "playbooks.json")) if (HERE / "playbooks.json").exists() else {}
        res["phase3"]["playbooks"] = {k: v for k, v in books.items() if k.startswith("v")}
        cost["phase3"] = usage_of(p3) + (books.get("_rewrite_usage") or {}).get("cost_usd", 0)

    pilots = load(RUNS / "phase2_pilot.jsonl") + load(RUNS / "phase3_pilot.jsonl")
    cost["pilots"] = usage_of(pilots)
    if (HERE / "audit_results.json").exists():
        a = json.load(open(HERE / "audit_results.json"))
        res["audit"] = {k: v for k, v in a.items() if k != "r8_top_states"}
        cost["judge"] = a.get("judge_cost_usd", 0)
    cost["total"] = sum(cost.values())
    res["model_cost_usd"] = {k: round(v, 2) for k, v in cost.items()}

    json.dump(res, open(HERE / "results.json", "w"), indent=1)
    print(json.dumps({k: res[k] for k in res if k in ("phase2", "model_cost_usd")}, indent=1))
    if "phase3" in res:
        print(json.dumps({k: res["phase3"][k] for k in ("eval", "train", "paired_vs_v0")}, indent=1))


if __name__ == "__main__":
    main()
