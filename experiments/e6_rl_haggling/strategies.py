"""Seller strategies for E6, all implementing the harness's SellerStrategy protocol.

Fixed strategies (reimplemented simply here so E6 doesn't depend on E5):
    TimeDependent(beta)   ask(t) = reserve + (list - reserve) * (1 - (t/6)^(1/beta)), t = round - 1,
                          reaching the reserve at round 7. beta < 1 is Boulware (concede late),
                          beta = 1 linear, beta > 1 Conceder (concede early).
    SplitDifference       anchor at list, then meet the buyer halfway each round.
    TitForTat             anchor at list, then match the buyer's last dollar concession.
    StaticList            always list; only accepts list (a static price page, for reference).
    FloorNow              offers the floor at once (gives everything away; lower bound).

Every fixed strategy uses the same acceptance rule: accept the buyer's offer if it passes the
floor and is within 0.5% of list of the ask it would make this round, or if it's the last round
(an offer in round 8 can't be answered, so any deal above the floor beats none).

Learned strategies:
    QPolicy               greedy over a Q-table keyed by core.features (with a back-off chain).
    ArmPolicy             a bandit arm: a TimeDependent schedule picked per session.
"""

from __future__ import annotations

from sell2agent.agents import NegotiationState, StrategyMove
from sell2agent.catalog import floor_total

from core import ACCEPT, ACTIONS, C15, Ctx, HOLD, WARR, _round50, _with_warranty, context, features, to_move, valid_actions

ACCEPT_TOL = 0.005


class _Cached:
    """Base: remembers the buyer's first bundle and caches one decision per seller turn
    (the harness may call decide() again for the same turn after a policy rejection)."""

    def __init__(self):
        self._base = None
        self._cache: dict[int, StrategyMove] = {}

    def ctx(self, state: NegotiationState) -> Ctx:
        if self._base is None:
            self._base = (state.product_id, list(state.addons))
        return context(state, self._base)

    def decide(self, state: NegotiationState) -> StrategyMove:
        key = len(state.transcript)
        if key not in self._cache:
            self._cache[key] = self._decide(state)
        return self._cache[key]

    def _decide(self, state: NegotiationState) -> StrategyMove:  # pragma: no cover
        raise NotImplementedError


def _accept_rule(c: Ctx, next_ask: int) -> bool:
    if not c.buyer_valid:
        return False
    if c.round >= c.max_rounds:
        return True
    return c.buyer_price >= next_ask - ACCEPT_TOL * c.list_s


def _offer(c: Ctx, price: float, note: str, addons=None) -> StrategyMove:
    addons = list(addons if addons is not None else c.seller_addons)
    floor = floor_total(c.product, addons)
    price = int(max(floor, min(c.ask, _round50(price))))
    return StrategyMove("offer", price=price, addons=addons, product_id=c.product, note=note)


class TimeDependent(_Cached):
    def __init__(self, beta: float = 1.0, reserve: float = 0.0, warranty_round: int | None = None, name: str | None = None):
        super().__init__()
        self.beta, self.reserve, self.warranty_round = beta, reserve, warranty_round
        self.name = name or f"td(b={beta},m={reserve}{',w' + str(warranty_round) if warranty_round else ''})"

    def _decide(self, state):
        c = self.ctx(state)
        if self.warranty_round and c.round == self.warranty_round and c.warranty_possible:
            # Sweeten instead of cutting the price this round.
            if c.buyer_valid and c.buyer_price >= c.ask - ACCEPT_TOL * c.list_s:
                return StrategyMove("accept", note=self.name)
            return to_move(c, WARR)
        res = c.floor_s + self.reserve * (c.list_s - c.floor_s)
        t = min(1.0, (c.round - 1) / max(1, c.max_rounds - 2))
        target = res + (c.list_s - res) * (1 - t ** (1 / self.beta))
        ask = int(max(c.floor_s, min(c.ask, _round50(target))))
        if _accept_rule(c, ask):
            return StrategyMove("accept", note=self.name)
        return _offer(c, ask, self.name)


class SplitDifference(_Cached):
    name = "split_difference"

    def _decide(self, state):
        c = self.ctx(state)
        if c.buyer_price is None or c.round == 1:
            ask = c.ask
        else:
            ask = max(c.floor_s, (c.ask + c.buyer_price) / 2)
        ask = int(max(c.floor_s, min(c.ask, _round50(ask))))
        if _accept_rule(c, ask):
            return StrategyMove("accept", note=self.name)
        return _offer(c, ask, self.name)


class TitForTat(_Cached):
    name = "tit_for_tat"

    def _decide(self, state):
        c = self.ctx(state)
        offers = state.offers("buyer")
        step = offers[-1].price - offers[-2].price if len(offers) >= 2 else 0
        ask = c.ask - max(0, step) if c.round > 1 else c.ask
        ask = int(max(c.floor_s, min(c.ask, _round50(ask))))
        if _accept_rule(c, ask):
            return StrategyMove("accept", note=self.name)
        return _offer(c, ask, self.name)


class StaticList(_Cached):
    name = "static_list"

    def _decide(self, state):
        c = self.ctx(state)
        if c.buyer_valid and c.buyer_price >= c.list_s:
            return StrategyMove("accept", note=self.name)
        return _offer(c, c.list_s, self.name)


class FloorNow(_Cached):
    name = "floor_now"

    def _decide(self, state):
        c = self.ctx(state)
        if c.buyer_valid:
            return StrategyMove("accept", note=self.name)
        return _offer(c, c.floor_s, self.name)


def named_fixed() -> dict:
    """The canonical fixed strategies, as factories (one fresh strategy per session)."""
    return {
        "boulware": lambda: TimeDependent(0.3, name="boulware"),
        "linear": lambda: TimeDependent(1.0, name="linear"),
        "conceder": lambda: TimeDependent(3.0, name="conceder"),
        "split_difference": SplitDifference,
        "tit_for_tat": TitForTat,
        "static_list": StaticList,
        "floor_now": FloorNow,
    }


BETAS = (0.2, 0.35, 0.5, 0.75, 1.0, 1.5, 2.5, 4.0)
RESERVES = (0.0, 0.15, 0.3)


def arm_specs() -> list[dict]:
    """The bandit's arms: concession schedules it can pick per session."""
    arms = [dict(kind="td", beta=b, reserve=m, warranty_round=w) for b in BETAS for m in RESERVES for w in (None, 3)]
    arms += [dict(kind="split"), dict(kind="tft")]
    return arms


def make_arm(spec: dict):
    if spec["kind"] == "td":
        return TimeDependent(spec["beta"], spec["reserve"], spec["warranty_round"])
    return SplitDifference() if spec["kind"] == "split" else TitForTat()


def arm_name(spec: dict) -> str:
    if spec["kind"] == "td":
        w = ",warranty@r3" if spec["warranty_round"] else ""
        return f"td(beta={spec['beta']},reserve={spec['reserve']}{w})"
    return {"split": "split_difference", "tft": "tit_for_tat"}[spec["kind"]]


class QPolicy(_Cached):
    """Greedy policy over a learned Q-table. Back-off for unseen states: the no-style table, then concede 15%.

    It never prices below the floor (core.to_move clamps and asserts) and only accepts offers that
    pass the policy engine (valid_actions masks the rest)."""

    name = "q_learned"

    def __init__(self, q: dict, q_backoff: dict | None = None, style: bool = True, log: list | None = None):
        super().__init__()
        self.q, self.q_backoff, self.style = q, q_backoff, style
        self.log = log if log is not None else []

    def _decide(self, state):
        c = self.ctx(state)
        acts = valid_actions(c)
        s = features(c, self.style)
        src = "q"
        vals = self.q.get(s)
        if vals is None and self.q_backoff is not None:
            vals, src = self.q_backoff.get(features(c, False)), "backoff"
        if vals is None:
            a, src = (C15 if C15 in acts else HOLD), "default"
        else:
            a = max(acts, key=lambda x: vals[x])
        self.log.append({"round": c.round, "state": list(s), "action": ACTIONS[a], "source": src})
        return to_move(c, a)


def fixed_by_name(name: str):
    """Factory for a fixed strategy by the name phase 1 reports (a named strategy or a bandit arm)."""
    named = named_fixed()
    if name in named:
        return named[name]
    if name.startswith("e5:"):
        return lambda: e5_condition(name).strategy
    for spec in arm_specs():
        if arm_name(spec) == name:
            return lambda s=spec: make_arm(s)
    raise KeyError(name)


def e5_condition(name: str):
    """An E5 condition by its phase-1 name ('e5:<condition>'), imported read-only from experiments/e5_strategies."""
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from experiments.e5_strategies.strategies import CONDITIONS  # type: ignore

    return CONDITIONS[name.split(":", 1)[1]]
