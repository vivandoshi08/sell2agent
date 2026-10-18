"""E5 runner: every seller condition against the same seeded buyers.

    SELL2AGENT_MAX_CONCURRENCY=3 uv run python experiments/e5_strategies/run.py --phase pilot --personas 2
    SELL2AGENT_MAX_CONCURRENCY=3 uv run python experiments/e5_strategies/run.py --phase main --personas 20

Writes one outcome per line to runs/<phase>.jsonl and progress to runs/<phase>.log.
Re-running skips (condition, persona) pairs that already finished without an
error, so a killed job can be resumed. --reuse adds pairs from other run files
whose seller would behave identically under the current code: same seller
prompt, and for code strategies, replaying the transcript through the current
strategy reproduces every recorded seller move (e.g. pilot runs).
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import threading
import time
from pathlib import Path

from sell2agent import llm
from sell2agent.agents import BuyerAgent, NegotiationState, SellerAgent, Turn
from sell2agent.negotiation import run_negotiation
from sell2agent.personas import make_personas
from sell2agent.policy import Offer, PolicyEngine
from sell2agent.runlog import RunLog, load, run_many

from strategies import CONDITIONS, make_seller

HERE = Path(__file__).resolve().parent
RUNS = HERE / "runs"
SEED = 505
BRIEFS = ["neutral", "best_deal"]
MAX_ROUNDS = 8
STRATEGIES_SHA = hashlib.sha1((HERE / "strategies.py").read_bytes()).hexdigest()[:10]
PROMPT_SHA = {c: hashlib.sha1(make_seller(c).system_prompt().encode()).hexdigest()[:10] for c in CONDITIONS}


def replay_matches(record: dict) -> bool:
    """True if the current code would make exactly the seller moves recorded in this session."""
    cond = CONDITIONS[record["meta"]["condition"]]
    if record["meta"].get("prompt_sha") != PROMPT_SHA[cond.name]:
        return False
    if cond.strategy is None:
        return True
    p = record["meta"]["persona"]
    state = NegotiationState(round=1, max_rounds=MAX_ROUNDS, product_id=p["target_product"], addons=list(p["wants_addons"]))
    for i, t in enumerate(record["transcript"]):
        state.round = i // 2 + 1
        if t["role"] == "seller":
            move = cond.strategy.decide(state)
            if move.action != t["action"]:
                return False
            if move.action == "offer" and (move.product_id, move.price, list(move.addons)) != (
                t["offer"]["product_id"], t["offer"]["price"], list(t["offer"]["addons"])
            ):
                return False
        offer = Offer(**t["offer"]) if t["offer"] else None
        state.transcript.append(Turn(t["role"], t["message"], t["action"], offer, t["note"]))
        if t["action"] == "offer" and offer:
            state.product_id, state.addons = offer.product_id, list(offer.addons)
    return True


class _Tee:
    """Passed as `usage` to the seller so its calls count toward the session and the seller."""

    def __init__(self, *targets: llm.Usage | None):
        self.targets = [t for t in targets if t is not None]

    def add(self, c: llm.Completion) -> None:
        for t in self.targets:
            t.add(c)


class TrackedSeller(SellerAgent):
    """SellerAgent that also keeps its own usage, so we can split seller cost from buyer cost."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.own = llm.Usage()

    def act(self, state, usage=None, feedback=""):
        return super().act(state, _Tee(usage, self.own), feedback)


class Logger:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()

    def __call__(self, msg: str) -> None:
        line = f"{time.strftime('%H:%M:%S')} {msg}"
        with self.lock:
            print(line, flush=True)
            with self.path.open("a") as f:
                f.write(line + "\n")


def done_pairs(records: list[dict], sha: str | None = None) -> set[tuple[str, str]]:
    return {
        (r["meta"]["condition"], r["persona_id"])
        for r in records
        if r.get("ended_by") != "error" and (sha is None or r["meta"].get("strategies_sha") == sha)
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", default="pilot")
    ap.add_argument("--personas", type=int, default=2, help="use the first N of the 20 seeded buyers")
    ap.add_argument("--conditions", nargs="*", default=list(CONDITIONS))
    ap.add_argument("--budget", type=float, default=25.0, help="stop starting sessions past this spend (USD)")
    ap.add_argument("--concurrency", type=int, default=3)
    ap.add_argument("--reuse", nargs="*", default=[], help="other run files to copy matching finished pairs from")
    args = ap.parse_args()

    RUNS.mkdir(exist_ok=True)
    out_path = RUNS / f"{args.phase}.jsonl"
    log = Logger(RUNS / f"{args.phase}.log")
    runlog = RunLog(out_path)
    personas = make_personas(20, seed=SEED, briefs=BRIEFS)[: args.personas]

    existing = load(out_path)
    have = done_pairs(existing)
    for path in args.reuse:
        for r in load(path):
            key = (r["meta"]["condition"], r["persona_id"])
            if r.get("ended_by") != "error" and key not in have and replay_matches(r):
                r["meta"]["reused_from"] = Path(path).name
                runlog.write(r)
                have.add(key)
                log(f"reused {key} from {path}")
            elif r.get("ended_by") != "error" and key not in have:
                log(f"not reusable (behavior changed): {key} from {path}")

    # Persona-major order, so a run stopped early is still balanced across conditions.
    todo = [(c, p) for p in personas for c in args.conditions if (c, p.id) not in have]
    log(f"phase={args.phase} personas={len(personas)} conditions={len(args.conditions)} todo={len(todo)} "
        f"sha={STRATEGIES_SHA} model={llm.DEFAULT_MODEL} effort={llm.DEFAULT_EFFORT} max_conc={llm.MAX_CONCURRENCY}")

    spent = [0.0]
    lock = threading.Lock()

    def one(item):
        cond_name, persona = item
        with lock:
            if spent[0] >= args.budget:
                return None
        seller = TrackedSeller(**CONDITIONS[cond_name].seller_kwargs())
        out = run_negotiation(
            BuyerAgent(persona),
            seller,
            policy=PolicyEngine(),
            max_rounds=MAX_ROUNDS,
            meta={
                "experiment": "e5_strategies",
                "phase": args.phase,
                "condition": cond_name,
                "kind": CONDITIONS[cond_name].kind,
                "strategies_sha": STRATEGIES_SHA,
                "prompt_sha": PROMPT_SHA[cond_name],
                "model": llm.DEFAULT_MODEL,
                "effort": llm.DEFAULT_EFFORT,
                "persona": persona.to_dict(),
            },
        )
        out.meta["seller_usage"] = seller.own.as_dict()
        runlog.write(out)
        with lock:
            spent[0] += out.usage.get("cost_usd", 0)
            total = spent[0]
        log(f"{cond_name:17s} {persona.id} {persona.brief:9s} {out.ended_by:13s} deal={out.deal!s:5s} "
            f"price={out.price} profit={out.profit} walk={persona.walk_away} floor={persona.floor} "
            f"rounds={out.rounds} cost=${out.usage.get('cost_usd', 0):.3f} wall={out.wall_s:.0f}s "
            f"total=${total:.2f}{' ERR ' + out.error[:120] if out.error else ''}")
        return out

    run_many(one, todo, concurrency=args.concurrency, label=f"e5-{args.phase}")
    log(f"finished phase={args.phase} spent=${spent[0]:.2f}")


if __name__ == "__main__":
    sys.exit(main())
