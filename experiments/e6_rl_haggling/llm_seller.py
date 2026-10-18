"""Phase 2/3 glue: run a code strategy with LLM-written messages against LLM buyers.

HintedSeller is SellerAgent plus one line of framing for the two moves whose meaning lives in
the words: a "final offer" (the policy really does hold there afterwards, so saying so is true)
and "add the warranty instead of a discount". The price and add-ons are still enforced by the
harness exactly as the strategy decided. All other moves get no extra instruction.
"""

from __future__ import annotations

import os

os.environ.setdefault("SELL2AGENT_MAX_CONCURRENCY", "3")

import traceback  # noqa: E402

from sell2agent.agents import BuyerAgent, SellerAgent  # noqa: E402
from sell2agent.negotiation import Outcome, run_negotiation  # noqa: E402
from sell2agent.policy import PolicyEngine  # noqa: E402

HINTS = {
    "final": "This is your final offer. Say so plainly: you will not go lower in this conversation.",
    "add_warranty": "Instead of cutting the price, you are adding the 3-year extended warranty (list $2,400) "
    "at no extra charge. Make that clear.",
}


class HintedSeller(SellerAgent):
    def act(self, state, usage=None, feedback: str = ""):
        if self.strategy is not None:
            move = self.strategy.decide(state)  # strategies cache per turn, so super().act gets the same move
            hint = HINTS.get((move.note or "").strip())
            if hint:
                feedback = (feedback + "\n\n" + hint).strip()
        return super().act(state, usage, feedback=feedback)


def safe_run(persona, seller, *, buyer_model=None, meta=None, max_rounds=8) -> Outcome:
    """run_negotiation, but any unexpected exception becomes an error outcome instead of killing the batch."""
    try:
        return run_negotiation(
            BuyerAgent(persona, model=buyer_model), seller, policy=PolicyEngine(), max_rounds=max_rounds, meta=meta
        )
    except Exception as e:  # noqa: BLE001
        return Outcome(session_id="err", persona_id=persona.id, deal=False, ended_by="error",
                       walk_away=persona.walk_away, feasible=persona.feasible, meta=dict(meta or {}),
                       error=f"{type(e).__name__}: {e}\n{traceback.format_exc()[-800:]}")
