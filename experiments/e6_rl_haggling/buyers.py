"""E6 phase 1: fast scripted buyers (no LLM) and an episode loop that mirrors the harness.

A scripted buyer has the persona's bundle and private walk-away w (taken straight from
`make_personas`, so the walk-away distribution matches phase 2), plus behavior drawn
from one of five buyer types (R10):

    open_frac   opening offer = w * open_frac, open_frac within U(0.70, 0.88) overall
    c           concedes this share of the remaining gap to w each round (shrinking steps)
    rho         reciprocity: mirrors this share of the seller's last dollar concession
    patience    "stubborn" seller rounds it tolerates before walking (or closing, if it can)
    stub_k      a seller concession of stub_k * list fully avoids a stubborn mark; smaller
                concessions get a mark with probability 1 - concession / (stub_k * list)
    tol         accepts when the seller's ask is within tol * list of its own next offer
    appetite    values an added warranty at appetite * $2,400 (it never pays more than w total)
    deadline    'deadline' buyers close or walk after this round
    split       'anchored' buyers move toward the seller's ask (split the difference) instead of
                toward their own walk-away, so a high seller anchor pulls them up
    p_first     'anchored' buyers sometimes take the seller's first offer if it's under w
                (first-proposal bias reported for LLM buyers; see docs/research/rl-negotiation.md)

It never pays more than w. It accepts an ask <= w when the ask is at or below its next planned
offer (within tol), when the seller says "final offer" (85%), when its patience is spent, at its
deadline, or on the last round. Turn order, the 8-round cap, and the policy engine's handling
of rejected seller moves follow sell2agent/negotiation.py.
"""

from __future__ import annotations

import random
from dataclasses import asdict, dataclass

from sell2agent.agents import NegotiationState, StrategyMove, Turn
from sell2agent.catalog import ADDONS, cost_total, list_total
from sell2agent.personas import BuyerPersona, make_personas
from sell2agent.policy import Offer, PolicyEngine

POLICY = PolicyEngine()
WARRANTY_LIST = ADDONS["warranty"].list_price

# Parameter ranges per buyer type: (lo, hi) for floats, list for ints.
TYPES: dict[str, dict] = {
    # Looks like the LLM buyers in E0/E3: opens ~12-18% under its walk-away, closes the gap by a third or so each round.
    "steady": dict(open=(0.78, 0.88), c=(0.25, 0.50), rho=(0.0, 0.3), patience=[3, 4, 5], stub_k=(0.005, 0.015), tol=(0.003, 0.010), appetite=(0.0, 0.5), deadline=None),
    "hardball": dict(open=(0.70, 0.78), c=(0.10, 0.25), rho=(0.0, 0.2), patience=[2, 3], stub_k=(0.010, 0.020), tol=(0.0, 0.004), appetite=(0.0, 0.3), deadline=None),
    "eager": dict(open=(0.82, 0.88), c=(0.45, 0.70), rho=(0.0, 0.3), patience=[4, 5, 6], stub_k=(0.003, 0.010), tol=(0.010, 0.020), appetite=(0.2, 0.8), deadline=None),
    "reciprocator": dict(open=(0.74, 0.85), c=(0.08, 0.20), rho=(0.6, 1.0), patience=[3, 4, 5], stub_k=(0.005, 0.015), tol=(0.003, 0.010), appetite=(0.0, 0.6), deadline=None),
    "deadline": dict(open=(0.80, 0.88), c=(0.30, 0.50), rho=(0.0, 0.2), patience=[3, 4], stub_k=(0.005, 0.015), tol=(0.010, 0.030), appetite=(0.2, 0.6), deadline=[3, 4, 5]),
    # LLM-like per the E8 literature review: anchors on the seller's ask, splits the difference, some first-offer acceptance.
    "anchored": dict(open=(0.76, 0.88), c=(0.30, 0.50), rho=(0.0, 0.0), patience=[3, 4, 5], stub_k=(0.005, 0.015), tol=(0.010, 0.030), appetite=(0.2, 0.7), deadline=None, split=True, p_first=(0.0, 0.3)),
}

# A shifted population for a robustness check: tougher, less patient, wider openings.
SHIFT = dict(open=(0.65, 0.90), c_mult=0.7, patience_delta=-1, stub_mult=1.5, appetite_mult=0.5)


@dataclass
class BuyerParams:
    type: str
    open_frac: float
    c: float
    rho: float
    patience: int
    stub_k: float
    tol: float
    appetite: float
    p_msg_open: float
    deadline: int | None
    noise: float
    split: bool = False
    p_first: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


def sample_params(rng: random.Random, btype: str | None = None, shifted: bool = False) -> BuyerParams:
    btype = btype or rng.choice(list(TYPES))
    t = TYPES[btype]
    u = lambda lo_hi: rng.uniform(*lo_hi)  # noqa: E731
    p = BuyerParams(
        type=btype,
        open_frac=u(t["open"]),
        c=u(t["c"]),
        rho=u(t["rho"]),
        patience=rng.choice(t["patience"]),
        stub_k=u(t["stub_k"]),
        tol=u(t["tol"]),
        appetite=u(t["appetite"]),
        p_msg_open=0.15,
        deadline=rng.choice(t["deadline"]) if t["deadline"] else None,
        noise=0.004,
        split=bool(t.get("split", False)),
        p_first=u(t["p_first"]) if "p_first" in t else 0.0,
    )
    if shifted:
        p.open_frac = u(SHIFT["open"])
        p.c *= SHIFT["c_mult"]
        p.patience = max(1, p.patience + SHIFT["patience_delta"])
        p.stub_k *= SHIFT["stub_mult"]
        p.appetite *= SHIFT["appetite_mult"]
    return p


class ScriptedBuyer:
    role = "buyer"

    def __init__(self, persona: BuyerPersona, params: BuyerParams, rng: random.Random):
        self.persona, self.k, self.rng = persona, params, rng
        self.w = persona.walk_away
        self.product = persona.target_product
        self.addons = list(persona.wants_addons)
        self.list = persona.list
        self.v_warranty = 0.0 if "warranty" in self.addons else params.appetite * WARRANTY_LIST
        self.b: int | None = None
        self.frustration = 0
        self.prev_eff: float | None = None  # seller's previous ask, net of add-on value

    def _offer(self, price: int, msg: str) -> Turn:
        self.b = int(price)
        return Turn("buyer", msg, "offer", Offer(self.product, self.b, list(self.addons)))

    def _eff(self, o: Offer) -> float:
        added = "warranty" in o.addons and "warranty" not in self.addons
        return o.price - (self.v_warranty if added else 0.0)

    def act(self, state: NegotiationState) -> Turn:
        k, rng, r = self.k, self.rng, state.round
        seller_turns = [t for t in state.transcript if t.role == "seller"]
        if not seller_turns:
            if rng.random() < k.p_msg_open:
                return Turn("buyer", "Can you tell me more about pricing?", "message")
            return self._offer(round(self.w * k.open_frac / 100) * 100, "opening offer")

        last = seller_turns[-1]
        ask = state.standing_offer("seller")
        if ask is None:  # seller only talked; keep going
            return self._offer(self._next_offer(0.0, None), "counter")
        final = "final" in (last.note or "")
        eff = self._eff(ask)
        prev = self.prev_eff if self.prev_eff is not None else float(self.list)
        conc = max(0.0, prev - eff)
        self.prev_eff = eff
        # Slow seller concessions use up patience (probabilistically, so there's no sharp threshold to game).
        p_stub = max(0.0, min(1.0, 1.0 - conc / (k.stub_k * self.list)))
        if rng.random() < p_stub:
            self.frustration += 1

        b_next = self._next_offer(conc, eff)
        if len(seller_turns) == 1 and ask.price <= self.w and rng.random() < k.p_first:
            return Turn("buyer", "accept (first_offer)", "accept")
        out_of_patience = self.frustration >= k.patience
        at_deadline = k.deadline is not None and r >= k.deadline
        # The message records why it accepted or walked (for the R8 audit); the order matters for the RNG.
        if ask.price <= self.w:
            reason = None
            if eff <= b_next + k.tol * self.list:
                reason = "gap"
            elif final and rng.random() < 0.85:
                reason = "final"
            elif out_of_patience:
                reason = "patience"
            elif at_deadline:
                reason = "deadline"
            elif r >= state.max_rounds:
                reason = "last_round"
            if reason:
                return Turn("buyer", f"accept ({reason})", "accept")
        else:
            reason = None
            if final and rng.random() < 0.6:
                reason = "final"
            elif out_of_patience:
                reason = "patience"
            elif at_deadline:
                reason = "deadline"
            if reason:
                return Turn("buyer", f"walk ({reason})", "walk")
        return self._offer(b_next, "counter")

    def _next_offer(self, seller_conc: float, ask_eff: float | None) -> int:
        k = self.k
        if self.b is None:
            return int(round(self.w * k.open_frac / 100) * 100)
        target = min(self.w, ask_eff) if (k.split and ask_eff is not None) else self.w
        gap = max(0.0, target - self.b)
        step = k.c * gap + k.rho * seller_conc + self.rng.gauss(0, k.noise * self.list)
        nxt = self.b + max(0.0, step)
        nxt = min(self.w, int(round(nxt / 100) * 100))
        return max(self.b, nxt)


@dataclass
class EpisodeResult:
    deal: bool
    ended_by: str
    price: int | None
    profit: int
    rounds: int
    penalties: int
    walk_away: int
    floor_total: int
    list_total: int
    feasible: bool
    btype: str
    addons_added: bool  # the deal includes a warranty the buyer didn't ask for
    state: NegotiationState | None = None

    def kpis(self) -> dict:
        d = asdict(self)
        d.pop("state")
        return d


def run_episode(
    persona: BuyerPersona,
    params: BuyerParams,
    strategy,
    rng: random.Random,
    max_rounds: int = 8,
    keep_state: bool = False,
) -> EpisodeResult:
    """One haggle between a scripted buyer and any SellerStrategy, with harness turn order and policy checks."""
    buyer = ScriptedBuyer(persona, params, rng)
    state = NegotiationState(round=1, max_rounds=max_rounds, product_id=persona.target_product, addons=list(persona.wants_addons))
    penalties = 0
    deal_offer, ended_by, rounds = None, "round_cap", 0

    for rnd in range(1, max_rounds + 1):
        state.round = rounds = rnd
        t = buyer.act(state)
        state.transcript.append(t)
        if t.action == "offer" and t.offer:
            state.product_id, state.addons = t.offer.product_id, list(t.offer.addons)
        if t.action == "accept":
            standing = state.standing_offer("seller")
            if standing:
                deal_offer, ended_by = standing, "buyer_accept"
                break
        if t.action == "walk":
            ended_by = "buyer_walk"
            break

        move: StrategyMove = strategy.decide(state)
        turn = _apply(move, state)
        target = turn.offer if turn.action == "offer" else (state.standing_offer("buyer") if turn.action == "accept" else None)
        if turn.action == "accept" and target is None:
            turn = Turn("seller", "", "message", None, note="accept with nothing to accept")
        elif target is not None and not POLICY.check(target).approved:
            penalties += 1
            if hasattr(strategy, "on_rejected"):
                strategy.on_rejected()
            last = state.standing_offer("seller")
            if last is None or not POLICY.check(last).approved:
                last = Offer(state.product_id, list_total(state.product_id, state.addons), list(state.addons))
            turn = Turn("seller", "", "offer", last, note="policy engine: retries exhausted, restated last valid offer")
        state.transcript.append(turn)
        if turn.action == "offer" and turn.offer:
            state.product_id, state.addons = turn.offer.product_id, list(turn.offer.addons)
        if turn.action == "accept":
            deal_offer, ended_by = state.standing_offer("buyer"), "seller_accept"
            break
        if turn.action == "walk":
            ended_by = "seller_walk"
            break

    if deal_offer is not None:
        profit = deal_offer.price - cost_total(deal_offer.product_id, deal_offer.addons)
        price = deal_offer.price
        added = "warranty" in deal_offer.addons and "warranty" not in persona.wants_addons
    else:
        profit, price, added = 0, None, False
    return EpisodeResult(
        deal=deal_offer is not None,
        ended_by=ended_by,
        price=price,
        profit=profit,
        rounds=rounds,
        penalties=penalties,
        walk_away=persona.walk_away,
        floor_total=persona.floor,
        list_total=persona.list,
        feasible=persona.feasible,
        btype=params.type,
        addons_added=added,
        state=state if keep_state else None,
    )


def _apply(move: StrategyMove, state: NegotiationState) -> Turn:
    """Same as the harness's _enforce_move: the strategy's move is what gets played."""
    note = f"strategy: {move.note}".strip()
    if move.action == "offer" and move.price is not None:
        addons = list(move.addons if move.addons is not None else state.addons)
        return Turn("seller", "", "offer", Offer(move.product_id or state.product_id, int(move.price), addons), note=note)
    if move.action in ("accept", "walk"):
        return Turn("seller", "", move.action, None, note=note)
    # "free" has no meaning without an LLM: hold the last offer.
    last = state.standing_offer("seller") or Offer(state.product_id, list_total(state.product_id, state.addons), list(state.addons))
    return Turn("seller", "", "offer", last, note=note)


def population(n: int, seed: int, shifted: bool = False, btype: str | None = None) -> list[tuple[BuyerPersona, BuyerParams]]:
    """n scripted buyers: persona bundles and walk-aways from make_personas, behavior from the buyer types."""
    personas = make_personas(n, seed=seed)
    rng = random.Random(seed * 7919 + 17)
    return [(p, sample_params(rng, btype, shifted)) for p in personas]


def evaluate(strategy_factory, buyers, seed: int = 0) -> list[EpisodeResult]:
    """Each buyer gets its own random stream, so strategies are compared on common random numbers."""
    return [run_episode(p, k, strategy_factory(), random.Random(seed * 1_000_003 + i)) for i, (p, k) in enumerate(buyers)]


def summarize(results: list[EpisodeResult], boot: int = 1000, seed: int = 0) -> dict:
    import numpy as np

    profits = np.array([r.profit for r in results], dtype=float)
    deals = np.array([r.deal for r in results], dtype=float)
    n = len(results)
    if boot:
        rs = np.random.default_rng(seed)
        pps_b = profits[rs.integers(0, n, size=(boot, n))].mean(axis=1)
        ci = [round(float(np.percentile(pps_b, 2.5)), 1), round(float(np.percentile(pps_b, 97.5)), 1)]
    else:
        ci = None
    feas = [r for r in results if r.feasible]
    dl = [r for r in results if r.deal]
    capture = [min(1.0, max(0.0, (r.price - r.floor_total) / (r.walk_away - r.floor_total))) for r in dl if r.walk_away > r.floor_total]
    return {
        "n": n,
        "profit_per_session": round(float(profits.mean()), 1),
        "pps_ci95": ci,
        "conversion": round(float(deals.mean()), 4),
        "feasible_conversion": round(sum(r.deal for r in feas) / len(feas), 4) if feas else None,
        "surplus_capture": round(float(np.mean(capture)), 4) if capture else None,
        "avg_rounds": round(float(np.mean([r.rounds for r in results])), 2),
        "rejected_moves": int(sum(r.penalties for r in results)),
        "warranty_deals": int(sum(r.addons_added for r in results)),
    }


def paired_diff(a: list[EpisodeResult], b: list[EpisodeResult], boot: int = 2000, seed: int = 0) -> dict:
    """Profit-per-session difference b - a on the same buyers, with a paired bootstrap CI."""
    import numpy as np

    pa = np.array([r.profit for r in a], dtype=float)
    pb = np.array([r.profit for r in b], dtype=float)
    d = pb - pa
    rs = np.random.default_rng(seed)
    idx = rs.integers(0, len(d), size=(boot, len(d)))
    db = d[idx].mean(axis=1)
    return {
        "diff": round(float(d.mean()), 1),
        "diff_ci95": [round(float(np.percentile(db, 2.5)), 1), round(float(np.percentile(db, 97.5)), 1)],
        "lift_pct": round(float(d.mean() / pa.mean() * 100), 2) if pa.mean() else None,
    }
