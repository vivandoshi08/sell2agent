"""Seller negotiation strategies for E5, and the fixed baselines E6 compares against.

Two kinds:

* Code strategies implement `sell2agent.agents.SellerStrategy`. Each seller turn
  they read the NegotiationState and return a StrategyMove (offer a price and
  add-ons, or accept). The LLM only writes the message; the harness enforces
  the move. They are stateless: every decision is derived from the transcript,
  so one instance can be shared across sessions and threads.
* Prompt-only strategies have no code. They are instructions appended to the
  seller's system prompt, and the LLM picks both the price and the words.

Shared rules for code strategies:
    t = round / max_rounds
    list, floor = list_total / floor_total of the bundle under discussion
    accept the buyer's standing offer if its profit >= the profit of the offer
    we would make next (same bundle: price >= our next price), or, in the final
    round, if it is at or above its floor total. Never offer below the floor.

Use from another experiment:

    import sys, pathlib
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))  # repo root
    from experiments.e5_strategies.strategies import CONDITIONS, make_seller, Boulware

    seller = make_seller("boulware")            # SellerAgent with the strategy attached
    move = Boulware().decide(state)             # or call a strategy directly
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sell2agent.agents import NegotiationState, SellerAgent, SellerStrategy, StrategyMove
from sell2agent.catalog import ADDONS, cost_total, floor_total, list_total
from sell2agent.policy import Offer

ROUND_TO = 100  # offers are rounded to the nearest $100
_ADDON_ORDER = list(ADDONS)


# ---------------------------------------------------------------- helpers


def time_frac(state: NegotiationState) -> float:
    return min(1.0, state.round / state.max_rounds)


def is_final_round(state: NegotiationState) -> bool:
    return state.round >= state.max_rounds


def sort_addons(addons) -> list[str]:
    return sorted(set(addons), key=_ADDON_ORDER.index)


def profit(offer: Offer) -> int:
    return offer.price - cost_total(offer.product_id, offer.addons)


def concession_frac(offer: Offer) -> float:
    """How far an offer sits from list toward floor on its own bundle: 0 = list, 1 = floor.

    Buyer lowballs below the floor give values above 1. Used to carry a price
    position across a change of bundle.
    """
    lst, flo = list_total(offer.product_id, offer.addons), floor_total(offer.product_id, offer.addons)
    return (lst - offer.price) / (lst - flo)


def price_at_frac(product_id: str, addons, frac: float) -> float:
    lst, flo = list_total(product_id, addons), floor_total(product_id, addons)
    return lst - frac * (lst - flo)


def price_on_bundle(offer: Offer, product_id: str, addons) -> float:
    """An offer's price, translated to another bundle at the same concession fraction."""
    if offer.product_id == product_id and list(offer.addons) == list(addons):
        return float(offer.price)
    return price_at_frac(product_id, addons, concession_frac(offer))


def clip_price(product_id: str, addons, price: float) -> int:
    """Round to $100 and keep inside [floor total, list total]."""
    lo, hi = floor_total(product_id, addons), list_total(product_id, addons)
    p = int(round(price / ROUND_TO) * ROUND_TO)
    return max(lo, min(hi, p))


# ---------------------------------------------------------------- code strategies


class CodeStrategy:
    """Base class: subclasses define `target`, the offer they'd make next."""

    name = "code"

    def target(self, state: NegotiationState) -> Offer:
        raise NotImplementedError

    def accepts(self, state: NegotiationState, buyer: Offer, nxt: Offer) -> bool:
        if buyer.price < floor_total(buyer.product_id, buyer.addons):
            return False
        if is_final_round(state):
            return True
        return profit(buyer) >= profit(nxt)

    def decide(self, state: NegotiationState) -> StrategyMove:
        nxt = self.target(state)
        # Never ask more for a bundle than we already offered it for.
        prev = [o.price for o in state.offers("seller") if o.product_id == nxt.product_id and list(o.addons) == list(nxt.addons)]
        if prev and nxt.price > min(prev):
            nxt = Offer(nxt.product_id, min(prev), list(nxt.addons))
        buyer = state.standing_offer("buyer")
        if buyer is not None and self.accepts(state, buyer, nxt):
            return StrategyMove("accept", note=f"{self.name}: accept ${buyer.price:,} (next offer would be ${nxt.price:,})")
        return StrategyMove(
            "offer",
            price=nxt.price,
            addons=list(nxt.addons),
            product_id=nxt.product_id,
            note=f"{self.name}: round {state.round}, offer ${nxt.price:,}",
        )


@dataclass
class TimeDependent(CodeStrategy):
    """offer = list - (list - floor) * t^exponent.

    exponent > 1 concedes slowly then fast near the deadline (Boulware);
    exponent < 1 concedes early (Conceder); exponent = 1 is linear.
    """

    exponent: float = 3.0
    name: str = "time_dependent"
    # 0 = reach the floor in the last round (what E5 ran). 1 = reach it one round
    # earlier: the seller's offer in the last round can never be answered, and the
    # buyer moves first in that round and may walk, so round max_rounds - 1 is the
    # seller's real deadline. Untested against LLM buyers; see README.
    horizon_offset: int = 0

    def target(self, state: NegotiationState) -> Offer:
        pid, addons = state.product_id, sort_addons(state.addons)
        frac = min(1.0, state.round / max(1, state.max_rounds - self.horizon_offset)) ** self.exponent
        return Offer(pid, clip_price(pid, addons, price_at_frac(pid, addons, frac)), addons)


def Boulware() -> TimeDependent:  # noqa: N802 (reads like a class at call sites)
    return TimeDependent(exponent=3.0, name="boulware")


def Conceder() -> TimeDependent:  # noqa: N802
    return TimeDependent(exponent=1 / 3, name="conceder")


def BoulwareDeadline() -> TimeDependent:  # noqa: N802
    """Boulware that reaches the floor at the seller's last answerable turn (not run in E5)."""
    return TimeDependent(exponent=3.0, name="boulware_deadline", horizon_offset=1)


@dataclass
class TitForTat(CodeStrategy):
    """Start at list. Each round, concede the same dollar amount the buyer conceded
    in its latest counteroffer, capped at `max_step` of the list-floor gap.

    The buyer's first counteroffer gets a small cooperative step (`opening_step`
    of the gap), since there's no earlier offer to measure a concession against.
    No new buyer offer this round, or a buyer that moved backwards: no concession.
    """

    opening_step: float = 0.10
    max_step: float = 0.30
    name: str = "tit_for_tat"

    def target(self, state: NegotiationState) -> Offer:
        pid, addons = state.product_id, sort_addons(state.addons)
        gap = list_total(pid, addons) - floor_total(pid, addons)
        mine = state.offers("seller")
        if not mine:
            return Offer(pid, list_total(pid, addons), addons)
        ours = price_on_bundle(mine[-1], pid, addons)
        step = 0.0
        latest = state.transcript[-1] if state.transcript else None
        theirs = state.offers("buyer")
        if latest is not None and latest.role == "buyer" and latest.action == "offer":
            if len(theirs) >= 2:
                prev, cur = theirs[-2], theirs[-1]
                step = price_on_bundle(cur, pid, addons) - price_on_bundle(prev, pid, addons)
            else:
                step = self.opening_step * gap
        step = max(0.0, min(step, self.max_step * gap))
        return Offer(pid, clip_price(pid, addons, ours - step), addons)


@dataclass
class SplitDifference(CodeStrategy):
    """Start at list. Then offer the midpoint of our last offer and the buyer's
    latest offer, never below the floor. No buyer offer yet: hold."""

    name: str = "split_difference"

    def target(self, state: NegotiationState) -> Offer:
        pid, addons = state.product_id, sort_addons(state.addons)
        mine = state.offers("seller")
        if not mine:
            return Offer(pid, list_total(pid, addons), addons)
        ours = price_on_bundle(mine[-1], pid, addons)
        buyer = state.standing_offer("buyer")
        if buyer is None:
            return Offer(pid, clip_price(pid, addons, ours), addons)
        theirs = price_on_bundle(buyer, pid, addons)
        return Offer(pid, clip_price(pid, addons, min(ours, (ours + theirs) / 2)), addons)


@dataclass
class BundleFirst(CodeStrategy):
    """When the buyer pushes, add value before discounting.

    First offer: what the buyer asked for, at list. Each later offer adds one
    free add-on the buyer didn't ask for, at the same price (warranty first:
    $2,400 list for $600 cost; then delivery: $900 list for $400 cost). Once
    those are in, discount slowly on the Boulware curve, from the list total
    of the core bundle toward the floor of the enlarged bundle.

    "Free" add-ons are the extras that weren't in our first offer (what the
    buyer asked for). The core bundle is the buyer's latest offer minus the
    free add-ons, so a buyer that strips the extras out gets them added back,
    and a buyer that writes them into its counteroffer isn't charged list for them.
    """

    extras_order: tuple[str, ...] = ("warranty", "delivery")
    exponent: float = 3.0
    name: str = "bundle_first"

    def target(self, state: NegotiationState) -> Offer:
        mine = state.offers("seller")
        requested = set(mine[0].addons) if mine else set(state.addons)
        free = [a for a in self.extras_order if a not in requested]
        src = state.standing_offer("buyer") or (mine[0] if mine else None)
        pid = src.product_id if src else state.product_id
        core = sort_addons(a for a in (src.addons if src else state.addons) if a not in free)
        step = len(mine)  # every seller turn after the first answers a push
        addons = sort_addons(core + free[: min(step, len(free))])
        anchor = list_total(pid, core)
        if step <= len(free):
            price = anchor  # value-add step: same price, more in the box
        else:
            frac = time_frac(state) ** self.exponent
            price = anchor - frac * (anchor - floor_total(pid, addons))
        return Offer(pid, clip_price(pid, addons, min(price, anchor)), addons)


@dataclass
class FixedList(CodeStrategy):
    """Fixed-price baseline: always offer the list total; accept only at or above list."""

    name: str = "fixed_list"

    def target(self, state: NegotiationState) -> Offer:
        pid, addons = state.product_id, sort_addons(state.addons)
        return Offer(pid, list_total(pid, addons), addons)

    def accepts(self, state: NegotiationState, buyer: Offer, nxt: Offer) -> bool:
        return buyer.price >= list_total(buyer.product_id, buyer.addons)


# ---------------------------------------------------------------- prompt-only strategies

ANCHOR_VALUE = """Negotiation approach: anchor on value.
- Open at the list total and back it with value: connect the tractor's real specs (from the catalog) to the buyer's stated need, and explain what each add-on does for them.
- When the buyer pushes on price, answer with value first (what the tractor and add-ons do for their property, what the 3-year parts-and-labor warranty covers) before you move on price.
- When you do concede, concede in small, shrinking steps, and ask for a commitment in return.
- Be honest. Use only facts from the catalog. No invented scarcity, other buyers, competitor prices, or specs, and don't say a price expires unless it really does."""

BOULWARE_LLM = """Negotiation approach: Boulware (concede slowly, then fast near the deadline).
- Open at the list total for what the buyer wants.
- Let g be the gap between the list total and the floor total, and t = round / max rounds. Each round, offer about: list total - g * t^3. With 8 rounds that means almost no movement in rounds 1-3 (under 6% of g), about 12% of g by round 4, 25% by round 5, 40% by round 6, two thirds by round 7, and the floor only in the final round.
- Accept the buyer's offer if it is at or above the price you'd offer next. In the final round, accept any offer at or above the floor total.
- Never go below the floor total."""

SPLIT_LLM = """Negotiation approach: split the difference.
- Open at the list total for what the buyer wants.
- After that, each time you counter, offer the midpoint between your last offer and the buyer's latest offer, rounded to the nearest $100, but never below the floor total.
- Accept the buyer's offer if it is at or above the price you'd offer next. In the final round, accept any offer at or above the floor total."""

BUNDLE_FIRST_NOTE = """When your pricing system's offer includes an add-on the buyer didn't ask for, present it as added value instead of a discount: say it's included at no extra cost. Describe add-ons only with facts from the catalog."""


# ---------------------------------------------------------------- conditions


@dataclass(frozen=True)
class Condition:
    name: str
    kind: str  # "llm" (prompt only), "code" (code picks the move), "baseline"
    description: str
    strategy: SellerStrategy | None = None
    instructions: str = ""
    negotiable: bool = True
    tags: tuple[str, ...] = field(default_factory=tuple)

    def seller_kwargs(self) -> dict:
        return {"strategy": self.strategy, "extra_instructions": self.instructions, "negotiable": self.negotiable}


CONDITIONS: dict[str, Condition] = {
    c.name: c
    for c in [
        Condition("open_llm", "llm", "Default seller prompt: close at the highest price you can."),
        Condition("anchor_value", "llm", "LLM anchors on value with honest framing; small shrinking concessions.", instructions=ANCHOR_VALUE),
        Condition("boulware_llm", "llm", "Boulware described in words; the LLM picks prices.", instructions=BOULWARE_LLM),
        Condition("split_llm", "llm", "Split-the-difference described in words; the LLM picks prices.", instructions=SPLIT_LLM),
        Condition("boulware", "code", "list - gap * t^3: concede slowly, then fast near the deadline.", strategy=Boulware()),
        Condition("conceder", "code", "list - gap * t^(1/3): concede early.", strategy=Conceder()),
        Condition("tit_for_tat", "code", "Mirror the buyer's last dollar concession (opening step 10% of gap, cap 30%).", strategy=TitForTat()),
        Condition("split_difference", "code", "Midpoint of our last offer and the buyer's last offer, floor-bounded.", strategy=SplitDifference()),
        Condition("bundle_first", "code", "Add warranty, then delivery, at the same price before discounting on the Boulware curve.", strategy=BundleFirst(), instructions=BUNDLE_FIRST_NOTE),
        Condition("fixed_price", "baseline", "List price only; the seller never discounts (negotiable=False plus a list-only strategy).", strategy=FixedList(), negotiable=False),
    ]
}


def make_seller(name: str, *, model: str | None = None, effort: str | None = None, cls=SellerAgent) -> SellerAgent:
    """A SellerAgent for a named condition."""
    return cls(model=model, effort=effort, **CONDITIONS[name].seller_kwargs())


# ---------------------------------------------------------------- offline demo (no model calls)


def _demo() -> None:
    """Play each code strategy against a scripted buyer and print the offers."""
    from sell2agent.agents import Turn

    def scripted_buyer(rnd: int, walk_away: int, start: int, step: int) -> Offer:
        return Offer("T45", min(walk_away, start + step * (rnd - 1)), ["loader"])

    for name, cond in CONDITIONS.items():
        if cond.strategy is None:
            continue
        state = NegotiationState(round=1, max_rounds=8, product_id="T45", addons=["loader"])
        line = []
        for rnd in range(1, 9):
            state.round = rnd
            b = scripted_buyer(rnd, walk_away=44_000, start=38_000, step=1_000)
            state.transcript.append(Turn("buyer", "", "offer", b))
            state.product_id, state.addons = b.product_id, list(b.addons)
            move = cond.strategy.decide(state)
            if move.action == "accept":
                line.append(f"r{rnd}: ACCEPT {b.price:,}")
                break
            o = Offer(move.product_id, move.price, move.addons)
            state.transcript.append(Turn("seller", "", "offer", o))
            state.product_id, state.addons = o.product_id, list(o.addons)
            extra = "+" + "+".join(a[0] for a in o.addons if a != "loader") if len(o.addons) > 1 else ""
            line.append(f"r{rnd}: b{b.price // 100 / 10:g}k s{o.price // 100 / 10:g}k{extra}")
        print(f"{name:17s} " + " | ".join(line))


if __name__ == "__main__":
    print("T45 + loader: list 48,500, floor 41,700, cost 34,600. Buyer opens 38k, +1k/round, walk-away 44k.")
    _demo()
