"""E6 phase 1: train sellers against scripted buyers and compare them with fixed strategies.

    uv run python experiments/e6_rl_haggling/phase1.py [--episodes 300000] [--seeds 3] [--long 1000000]

Populations (bundles and walk-aways from make_personas, behavior from buyers.TYPES):
    train      --episodes buyers, seed 1001 (+ seed offset per training run)
    validation 2,000 buyers, seed 3003: learning curves, picking hyperparameters and the best fixed strategy
    held-out   5,000 buyers, seed 2002: the reported comparison
    shifted    5,000 buyers, seed 2003, tougher and less patient than training (robustness)

Writes qtable.json, qtable_nostyle.json, bandit.json, curves.csv, phase1_results.json,
and runs/phase1_examples.jsonl (sample learned-policy episodes for the R8 audit).
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from buyers import TYPES, evaluate, paired_diff, population, run_episode, summarize  # noqa: E402
from core import ACTIONS  # noqa: E402
from learn import BanditPolicy, train_bandit, train_q  # noqa: E402
from sales_agent.catalog import cost_total  # noqa: E402
from strategies import QPolicy, arm_name, arm_specs, fixed_by_name, make_arm, named_fixed  # noqa: E402


def e5_fixed() -> dict:
    """E5's code strategies (experiments/e5_strategies/strategies.py), imported read-only if present."""
    try:
        sys.path.insert(0, str(HERE.parents[1]))
        from experiments.e5_strategies.strategies import CONDITIONS  # type: ignore
    except Exception as e:  # noqa: BLE001
        print(f"  (E5 strategies not importable: {e})")
        return {}
    out = {}
    for name, cond in CONDITIONS.items():
        if cond.kind in ("code", "baseline") and cond.strategy is not None:
            out[f"e5:{name}"] = (lambda s=cond.strategy: s)  # E5 strategies are stateless
    return out


def add_e5() -> None:
    """Score E5's code strategies on the same validation, held-out and shifted buyers (same seeds as main)."""
    out = json.load(open(HERE / "phase1_results.json"))
    val, held, shifted = population(2000, seed=3003), population(5000, seed=2002), population(5000, seed=2003, shifted=True)
    best = fixed_by_name(out["best_fixed"])
    best_held, best_shift = evaluate(best, held, seed=11), evaluate(best, shifted, seed=13)
    for name, f in e5_fixed().items():
        out["fixed_validation_pps"][name] = summarize(evaluate(f, val, seed=7), boot=0)["profit_per_session"]
        h, s = evaluate(f, held, seed=11), evaluate(f, shifted, seed=13)
        out["held_out"][name], out["shifted"][name] = summarize(h), summarize(s)
        out["vs_best_fixed_held_out"][name] = paired_diff(best_held, h)
        out["vs_best_fixed_shifted"][name] = paired_diff(best_shift, s)
        print(f"  {name:28s} val {out['fixed_validation_pps'][name]:8.1f}  held-out {out['held_out'][name]['profit_per_session']:8.1f}  "
              f"vs best fixed {out['vs_best_fixed_held_out'][name]['lift_pct']}%")
    out["fixed_validation_pps"] = dict(sorted(out["fixed_validation_pps"].items(), key=lambda kv: -kv[1]))
    json.dump(out, open(HERE / "phase1_results.json", "w"), indent=1)


def oracle(buyers) -> float:
    """Upper bound: every feasible buyer pays min(walk-away, list)."""
    tot = 0
    for p, _ in buyers:
        if p.feasible:
            tot += min(p.walk_away, p.list) - cost_total(p.target_product, p.wants_addons)
    return round(tot / len(buyers), 1)


def by_type(results) -> dict:
    groups = defaultdict(list)
    for r in results:
        groups[r.btype].append(r)
    return {t: summarize(rs, boot=0) for t, rs in sorted(groups.items())}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodes", type=int, default=300_000)
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--eval-every", type=int, default=10_000)
    ap.add_argument("--long", type=int, default=1_000_000, help="one extra, longer Q-learning run for the learning curve (0 to skip)")
    ap.add_argument("--e5-only", action="store_true", help="only add E5's strategies to an existing phase1_results.json")
    args = ap.parse_args()
    t0 = time.time()
    if args.e5_only:
        return add_e5()

    val = population(2000, seed=3003)
    val_curve = val[:1000]
    held = population(5000, seed=2002)
    shifted = population(5000, seed=2003, shifted=True)
    out: dict = {"episodes": args.episodes, "seeds": args.seeds,
                 "oracle_pps": {"validation": oracle(val), "held_out": oracle(held), "shifted": oracle(shifted)}}

    # 1. Fixed strategies: named ones, plus every bandit arm, scored on validation.
    print("fixed strategies on validation...")
    fixed = dict(named_fixed())
    fixed.update(e5_fixed())
    for spec in arm_specs():
        fixed.setdefault(arm_name(spec), (lambda s=spec: make_arm(s)))
    val_scores = {name: summarize(evaluate(f, val, seed=7), boot=0)["profit_per_session"] for name, f in fixed.items()}
    best_fixed = max(val_scores, key=val_scores.get)
    best_named = max(named_fixed(), key=lambda n: val_scores[n])
    print(f"  best fixed on validation: {best_fixed} ({val_scores[best_fixed]}), best named: {best_named} ({val_scores[best_named]})")
    out["fixed_validation_pps"] = dict(sorted(val_scores.items(), key=lambda kv: -kv[1]))
    out["best_fixed"] = best_fixed
    out["best_named_fixed"] = best_named
    out["curve_reference_pps"] = {n: summarize(evaluate(fixed[n], val_curve, seed=99), boot=0)["profit_per_session"]
                                  for n in dict.fromkeys([best_fixed, best_named, "linear", "split_difference", "floor_now"])}

    # 2. Learners, several seeds each.
    curves = []
    learned = {}
    for seed in range(args.seeds):
        train = population(args.episodes, seed=1001 + seed)
        for label, kw in [("q", dict(style=True, method="q")), ("q_nostyle", dict(style=False, method="q")), ("mc", dict(style=True, method="mc"))]:
            table, curve = train_q(train, val_curve, seed=seed, eval_every=args.eval_every, **kw)
            curves += [dict(method=label, seed=seed, **row) for row in curve]
            learned.setdefault(label, []).append(table)
        for label, ctxl in [("bandit_ctx", True), ("bandit", False)]:
            b, curve = train_bandit(train, val_curve, contextual=ctxl, seed=seed, eval_every=args.eval_every)
            curves += [dict(method=label, seed=seed, **row) for row in curve]
            learned.setdefault(label, []).append(b)
        print(f"seed {seed} done at {time.time() - t0:.0f}s")

    if args.long:
        train = population(args.long, seed=1101)
        _, curve = train_q(train, val_curve, seed=100, eval_every=max(args.eval_every, args.long // 40))
        curves += [dict(method="q_long", seed=100, **row) for row in curve]
        print(f"long run done at {time.time() - t0:.0f}s")

    with open(HERE / "curves.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(curves[0].keys()))
        w.writeheader()
        w.writerows(curves)

    # 3. Pick each method's best seed on validation; report on held-out.
    def factory(label, obj, backoff=None):
        if label.startswith("bandit"):
            return lambda: BanditPolicy(obj)
        return lambda: QPolicy(obj, q_backoff=backoff, style=(label != "q_nostyle"))

    best_obj = {}
    seed_val = {}
    for label, objs in learned.items():
        scores = [summarize(evaluate(factory(label, o), val, seed=7), boot=0)["profit_per_session"] for o in objs]
        seed_val[label] = scores
        best_obj[label] = objs[int(np.argmax(scores))]
    out["learned_validation_pps_by_seed"] = seed_val

    print("held-out evaluation...")
    conds = {}
    for name in dict.fromkeys(list(named_fixed()) + [n for n in fixed if n.startswith("e5:")] + [best_fixed]):
        conds[name] = fixed[name]
    nostyle = best_obj["q_nostyle"]
    for label, obj in best_obj.items():
        conds[label] = factory(label, obj, backoff=nostyle if label in ("q", "mc") else None)

    held_res = {n: evaluate(f, held, seed=11) for n, f in conds.items()}
    shift_res = {n: evaluate(f, shifted, seed=13) for n, f in conds.items()}
    out["held_out"] = {n: summarize(r) for n, r in held_res.items()}
    out["shifted"] = {n: summarize(r) for n, r in shift_res.items()}
    out["held_out_by_type"] = {n: by_type(r) for n, r in held_res.items() if n in ("q", "bandit_ctx", best_fixed, best_named)}
    out["vs_best_fixed_held_out"] = {n: paired_diff(held_res[best_fixed], r) for n, r in held_res.items() if n != best_fixed}
    out["vs_best_fixed_shifted"] = {n: paired_diff(shift_res[best_fixed], r) for n, r in shift_res.items() if n != best_fixed}

    # 4. What the learned Q policy does: action mix by round, and per buyer type.
    mix = defaultdict(Counter)
    log: list = []
    qbest = best_obj["q"]
    examples = []
    rng_ex = random.Random(5)
    for i, (p, k) in enumerate(held[:2000]):
        pol = QPolicy(qbest, q_backoff=nostyle, log=[])
        res = run_episode(p, k, pol, random.Random(11 * 1_000_003 + i), keep_state=True)
        for e in pol.log:
            mix[e["round"]][e["action"]] += 1
            log.append(e["source"])
        if i < 60 or rng_ex.random() < 0.01:
            examples.append({
                "buyer": p.to_dict(), "params": k.to_dict(), **res.kpis(),
                "turns": [(t.role, t.action, t.offer.price if t.offer else None, list(t.offer.addons) if t.offer else None, t.note) for t in res.state.transcript],
            })
    out["q_action_mix_by_round"] = {r: dict(c) for r, c in sorted(mix.items())}
    out["q_state_source"] = dict(Counter(log))
    (HERE / "runs").mkdir(exist_ok=True)
    with open(HERE / "runs/phase1_examples.jsonl", "w") as f:
        for e in examples:
            f.write(json.dumps(e) + "\n")

    json.dump(best_obj["q"].to_json(), open(HERE / "qtable.json", "w"))
    json.dump(nostyle.to_json(), open(HERE / "qtable_nostyle.json", "w"))
    json.dump(best_obj["mc"].to_json(), open(HERE / "qtable_mc.json", "w"))
    json.dump({"contextual": best_obj["bandit_ctx"].to_json(), "pooled": best_obj["bandit"].to_json()}, open(HERE / "bandit.json", "w"), indent=1)
    out["runtime_s"] = round(time.time() - t0, 1)
    json.dump(out, open(HERE / "phase1_results.json", "w"), indent=1)

    print("\nheld-out (5,000 scripted buyers):")
    for n, s in out["held_out"].items():
        d = out["vs_best_fixed_held_out"].get(n, {})
        print(f"  {n:34s} pps {s['profit_per_session']:8.1f} {s['pps_ci95']}  conv {s['conversion']:.3f}  rounds {s['avg_rounds']}  vs best fixed {d.get('lift_pct')}% {d.get('diff_ci95')}")
    print("\nshifted:")
    for n, s in out["shifted"].items():
        d = out["vs_best_fixed_shifted"].get(n, {})
        print(f"  {n:34s} pps {s['profit_per_session']:8.1f}  conv {s['conversion']:.3f}  vs best fixed {d.get('lift_pct')}%")
    print(f"oracle: {out['oracle_pps']}  runtime {out['runtime_s']}s")


if __name__ == "__main__":
    main()
