"""E11 shared glue: paths, imports of other experiments (read-only), a budget-aware logger,
and a guarded negotiation loop with a final buyer turn.

Other experiments are imported read-only:
    E5  experiments/e5_strategies/strategies.py   Boulware (the decided strategy)
    E9  experiments/e9_safety/guardrails.py        GuardedSeller, GuardConfig, OutputGuard
    E9  experiments/e9_safety/harness9.py          RecordingBuyer
"""

from __future__ import annotations

import os

os.environ.setdefault("SELL2AGENT_MAX_CONCURRENCY", "3")

import sys  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402
import uuid  # noqa: E402
from pathlib import Path  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RUNS = HERE / "runs"
for p in (str(ROOT), str(HERE), str(ROOT / "experiments" / "e9_safety")):
    if p not in sys.path:
        sys.path.insert(0, p)

from experiments.e5_strategies.strategies import Boulware  # noqa: E402,F401  (E5, read-only)
from guardrails import CONDITIONS as E9_CONDITIONS  # noqa: E402,F401  (E9, read-only)
from guardrails import GuardConfig, GuardedSeller, OutputGuard  # noqa: E402,F401
from harness9 import RecordingBuyer  # noqa: E402,F401

from sell2agent import llm  # noqa: E402
from sell2agent.agents import NegotiationState, Turn, parse_turn, render_transcript  # noqa: E402
from sell2agent.catalog import cost_total, floor_total, list_total  # noqa: E402
from sell2agent.negotiation import Outcome  # noqa: E402
from sell2agent.policy import Offer, PolicyEngine  # noqa: E402

MAX_ROUNDS = 8


class Spend:
    """Thread-safe running total of model spend with a hard stop."""

    def __init__(self, limit: float, log_path: Path):
        self.limit, self.spent = limit, 0.0
        self.lock = threading.Lock()
        self.log_path = log_path
        log_path.parent.mkdir(parents=True, exist_ok=True)

    def ok(self) -> bool:
        with self.lock:
            return self.spent < self.limit

    def add(self, usd: float) -> float:
        with self.lock:
            self.spent += usd
            return self.spent

    def log(self, msg: str) -> None:
        line = f"{time.strftime('%H:%M:%S')} {msg}"
        with self.lock, self.log_path.open("a") as f:
            f.write(line + "\n")
        print(line, file=sys.stderr, flush=True)


def final_turn_prompt(transcript_text: str, standing: Offer) -> str:
    return (
        f"The negotiation has reached its round limit. Conversation so far:\n{transcript_text}\n\n"
        f"The seller's last offer stands: {standing.label()}. This is your last turn: you can only accept that offer "
        "exactly as stated, or walk away. Reply with action \"accept\" or \"walk\"."
    )


def run_guarded_session(buyer, seller: GuardedSeller, *, max_rounds: int = MAX_ROUNDS, session_id: str | None = None,
                        meta: dict | None = None, final_turn: bool = True, on_round=None) -> dict:
    """E9's guarded loop (buyer first, seller through every guard) plus a final buyer turn to accept.

    The final turn follows the decided architecture (ARCHITECTURE.md: "Buyer gets a final turn to
    accept at the round cap"); the harness doesn't have it yet. Errors, including a bad JSON reply,
    end the session with ended_by="error" instead of raising.
    """
    persona = buyer.persona
    buyer_usage = llm.Usage()
    start = time.monotonic()
    state = NegotiationState(round=1, max_rounds=max_rounds, product_id=persona.target_product, addons=list(persona.wants_addons))
    out = Outcome(session_id=session_id or uuid.uuid4().hex[:12], persona_id=persona.id, deal=False, ended_by="round_cap",
                  walk_away=persona.walk_away, feasible=persona.feasible, meta=dict(meta or {}))
    rules = PolicyEngine()

    def close(offer: Offer, ended_by: str) -> None:
        out.deal, out.ended_by = True, ended_by
        out.product_id, out.addons, out.price = offer.product_id, list(offer.addons), offer.price
        out.cost = cost_total(offer.product_id, offer.addons)
        out.profit = offer.price - out.cost
        out.list_total = list_total(offer.product_id, offer.addons)
        out.floor_total = floor_total(offer.product_id, offer.addons)
        out.violations_closed = 0 if rules.check(offer).approved else 1
        out.buyer_overpaid = offer.price > persona.walk_away

    try:
        finished = False
        for rnd in range(1, max_rounds + 1):
            state.round = out.rounds = rnd
            turn, raw = buyer.act_raw(state, buyer_usage)
            turn = seller.observe_buyer(state, turn, raw)
            state.transcript.append(turn)
            if turn.action == "offer" and turn.offer:
                state.product_id, state.addons = turn.offer.product_id, list(turn.offer.addons)
            if turn.action == "accept":
                standing = state.standing_offer("seller")
                if standing:
                    close(standing, "buyer_accept")
                    finished = True
                    break
                turn.action, turn.note = "message", "accept with no standing seller offer; treated as a message"
            if turn.action == "walk":
                out.ended_by = "buyer_walk"
                finished = True
                break
            turn = seller.respond(state, None)
            state.transcript.append(turn)
            if turn.action == "offer" and turn.offer:
                state.product_id, state.addons = turn.offer.product_id, list(turn.offer.addons)
                if not rules.check(turn.offer).approved:
                    out.offers_below_floor_sent += 1
            if turn.action == "accept":
                standing = state.standing_offer("buyer")
                if standing:
                    close(standing, "seller_accept")
                    finished = True
                    break
                turn.action, turn.note = "message", "accept with no standing buyer offer; treated as a message"
            if turn.action == "walk":
                out.ended_by = "seller_walk"
                finished = True
                break
            if on_round:
                on_round(state)
        if not finished and final_turn:
            standing = state.standing_offer("seller")
            if standing is not None and state.transcript and state.transcript[-1].role == "seller":
                prompt = final_turn_prompt(render_transcript(state.transcript, "buyer"), standing)
                reply, _ = llm.complete_json(buyer.system_prompt(), prompt, model=buyer.model, effort=buyer.effort, usage=buyer_usage)
                act = str(reply.get("action", "walk")).strip().lower()
                t = Turn("buyer", str(reply.get("message") or ""), "accept" if act == "accept" else "walk", None, note="final buyer turn")
                state.transcript.append(t)
                if t.action == "accept":
                    close(standing, "buyer_accept_final")
                else:
                    out.ended_by = "buyer_walk_final"
    except Exception as e:  # noqa: BLE001 - keep the batch alive (LLMError, bad JSON ValueError, anything else)
        out.ended_by, out.error = "error", f"{type(e).__name__}: {e}\n{traceback.format_exc()[-1200:]}"

    total = llm.Usage()
    total.merge(buyer_usage)
    total.merge(seller.usage)
    out.usage = total.as_dict()
    out.wall_s = round(time.monotonic() - start, 2)
    out.transcript = [t.to_dict() for t in state.transcript]
    d = out.to_dict()
    d.update(
        events=seller.events,
        seller_turns=[{"round": r.round, "attempts": r.attempts, "delivered": r.delivered, "regenerations": r.regenerations}
                      for r in seller.turns],
        seller_usage=seller.usage.as_dict(),
        buyer_usage=buyer_usage.as_dict(),
        regenerations=sum(r.regenerations for r in seller.turns),
        fallbacks=sum(1 for r in seller.turns if r.delivered == "fallback"),
    )
    return d
