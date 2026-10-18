"""E6 seller MDP: state features, actions, and how an action becomes a priced move.

Everything here reads a harness `NegotiationState`, so the exact same code
drives the seller against scripted buyers (phase 1) and against LLM buyers
through `SellerAgent(strategy=...)` (phase 2).

State (R3), all discretized:
    round          1..8 (the harness cap is 8; the seller's round-8 offer can't be answered)
    ask room       (seller's standing ask - floor) / (list - floor) of the seller's bundle, 5 buckets
    buyer position (buyer's standing offer - floor) / (list - floor) of the buyer's bundle, 8 buckets
                   (one is "no offer yet"); together with ask room this is the gap between offers
    buyer step     buyer's last concession in the same room units, 5 buckets (one is "none yet")
    warranty       1 if "add warranty instead of a discount" is still possible
    final          1 if the seller already said "final offer"

Actions (R4):
    hold, concede 5% / 15% / 35% of the remaining room (ask - max(floor, buyer offer)),
    add the 3-year warranty instead of a discount (same price), final offer (floor + 5% of room,
    and the seller holds there for the rest of the session), accept the buyer's offer, walk.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from sales_agent.agents import NegotiationState, StrategyMove
from sales_agent.catalog import ADDONS, floor_total, list_total
from sales_agent.policy import Offer, PolicyEngine

WARRANTY = "warranty"
POLICY = PolicyEngine()

HOLD, C05, C15, C35, WARR, FINAL, ACCEPT, WALK = range(8)
ACTIONS = ["hold", "concede5", "concede15", "concede35", "add_warranty", "final", "accept", "walk"]
CONCEDE = {C05: 0.05, C15: 0.15, C35: 0.35}
FINAL_MARGIN = 0.05  # final offer = floor + 5% of (list - floor)

ASK_EDGES = (0.10, 0.25, 0.50, 0.75)
BUYER_EDGES = (-1.0, -0.5, 0.0, 0.25, 0.50, 0.75)
STEP_EDGES = (0.10, 0.30)


def _bucket(x: float, edges) -> int:
    for i, e in enumerate(edges):
        if x < e:
            return i
    return len(edges)


def _round50(x: float) -> int:
    return int(round(x / 50.0)) * 50


@dataclass
class Ctx:
    """The seller's view of the negotiation, in dollars and in room units."""

    round: int
    max_rounds: int
    product: str
    base_addons: list[str]  # the bundle the buyer is asking for
    seller_addons: list[str]  # base plus the warranty, if the seller added it
    list_s: int
    floor_s: int
    ask: int  # seller's standing ask, in seller-bundle terms (list if no offer yet)
    buyer_price: int | None
    buyer_floor: int | None  # floor of the buyer's offered bundle
    buyer_list: int | None
    buyer_u: list[float]  # each buyer offer in room units of its own bundle
    warranty_on: bool
    final_made: bool

    @property
    def room_s(self) -> int:
        return max(1, self.list_s - self.floor_s)

    @property
    def ask_u(self) -> float:
        return (self.ask - self.floor_s) / self.room_s

    @property
    def buyer_valid(self) -> bool:
        """The buyer's standing offer passes the policy engine (so accepting it is allowed)."""
        return self.buyer_price is not None and self.buyer_price >= self.buyer_floor

    @property
    def warranty_possible(self) -> bool:
        if self.final_made or self.warranty_on or WARRANTY in self.base_addons:
            return False
        return self.ask >= floor_total(self.product, self.base_addons + [WARRANTY])


def _with_warranty(addons: list[str]) -> list[str]:
    s = set(addons) | {WARRANTY}
    return [a for a in ADDONS if a in s]


def context(state: NegotiationState, base_hint: tuple[str, list[str]] | None = None) -> Ctx:
    buyer_turns = [t for t in state.transcript if t.role == "buyer" and t.action == "offer" and t.offer]
    seller_turns = [t for t in state.transcript if t.role == "seller" and t.action == "offer" and t.offer]
    if buyer_turns:
        b = buyer_turns[-1].offer
        product, base = b.product_id, list(b.addons)
    elif base_hint is not None:
        product, base = base_hint[0], list(base_hint[1])
    else:
        product, base = state.product_id, list(state.addons)

    warranty_on = WARRANTY not in base and any(WARRANTY in t.offer.addons for t in seller_turns)
    seller_addons = _with_warranty(base) if warranty_on else list(base)
    list_s, floor_s = list_total(product, seller_addons), floor_total(product, seller_addons)

    if seller_turns:
        last = seller_turns[-1].offer
        if last.product_id == product and sorted(last.addons) == sorted(seller_addons):
            ask = last.price
        else:  # the buyer changed the bundle: carry the ask over in room units
            lf, ll = floor_total(last.product_id, last.addons), list_total(last.product_id, last.addons)
            u = (last.price - lf) / max(1, ll - lf)
            ask = _round50(floor_s + max(0.0, min(1.0, u)) * (list_s - floor_s))
    else:
        ask = list_s

    buyer_u = []
    for t in buyer_turns:
        o = t.offer
        f, l = floor_total(o.product_id, o.addons), list_total(o.product_id, o.addons)
        buyer_u.append((o.price - f) / max(1, l - f))

    final_made = any("final" in (t.note or "") for t in state.transcript if t.role == "seller")
    if buyer_turns:
        o = buyer_turns[-1].offer
        bp, bf, bl = o.price, POLICY.floor_for(o), list_total(o.product_id, o.addons)
    else:
        bp = bf = bl = None
    return Ctx(
        round=state.round,
        max_rounds=state.max_rounds,
        product=product,
        base_addons=base,
        seller_addons=seller_addons,
        list_s=list_s,
        floor_s=floor_s,
        ask=ask,
        buyer_price=bp,
        buyer_floor=bf,
        buyer_list=bl,
        buyer_u=buyer_u,
        warranty_on=warranty_on,
        final_made=final_made,
    )


def features(c: Ctx, style: bool = True) -> tuple:
    """Discretized state. style=False drops the buyer-step feature (the R10 ablation)."""
    r = min(c.round, 8) - 1
    a = _bucket(c.ask_u, ASK_EDGES)
    b = 0 if not c.buyer_u else 1 + _bucket(c.buyer_u[-1], BUYER_EDGES)
    w = int(c.warranty_possible)
    f = int(c.final_made)
    if not style:
        return (r, a, b, w, f)
    if len(c.buyer_u) < 2:
        s = 0
    else:
        d = c.buyer_u[-1] - c.buyer_u[-2]
        s = 1 if d <= 1e-9 else 2 + _bucket(d, STEP_EDGES)
    return (r, a, b, s, w, f)


def valid_actions(c: Ctx, allow_bad_accept: bool = False) -> list[int]:
    """Moves the seller may pick. After a final offer it can only hold, accept, or walk.

    allow_bad_accept=True lets training try accepting a below-floor offer, which the
    policy engine rejects (that's where the R1 penalty comes from).
    """
    acts = [HOLD]
    if not c.final_made:
        acts += [C05, C15, C35]
        if c.warranty_possible:
            acts.append(WARR)
        acts.append(FINAL)
    if c.buyer_price is not None and (c.buyer_valid or allow_bad_accept):
        acts.append(ACCEPT)
    acts.append(WALK)
    return acts


def to_move(c: Ctx, a: int) -> StrategyMove:
    """Turn an action into the concrete move the harness enforces. Never prices below the floor."""
    name = ACTIONS[a]
    if a == ACCEPT:
        return StrategyMove("accept", note=name)
    if a == WALK:
        return StrategyMove("walk", note=name)
    addons, floor_s, ask = list(c.seller_addons), c.floor_s, c.ask
    if a == HOLD:
        price = ask
    elif a in CONCEDE:
        low = max(floor_s, c.buyer_price or 0)
        price = ask - CONCEDE[a] * max(0, ask - low)
    elif a == WARR:
        addons = _with_warranty(c.base_addons)
        floor_s = floor_total(c.product, addons)
        price = ask  # same price, more in the box
    elif a == FINAL:
        target = floor_s + FINAL_MARGIN * c.room_s
        if c.buyer_price is not None and c.buyer_price >= floor_s:
            target = max(target, c.buyer_price)
        price = min(ask, math.ceil(target / 50.0) * 50)
    else:
        raise ValueError(a)
    price = min(ask, max(floor_s, _round50(price)))
    move = StrategyMove("offer", price=int(price), addons=addons, product_id=c.product, note=name)
    assert POLICY.check(Offer(c.product, move.price, addons)).approved, (c, a, move)
    return move
