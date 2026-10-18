"""E10 buyers: 8 underlying needs x 3 buyer types (price-first, quality-first, balanced).

Every need states a capability requirement (minimum hp, acreage, 3-point
lift, cab or not) that `catalog_ext.fits` can check. The same need, wanted
add-ons, urgency, and position in the price range (x) are used for all three
types, so the types differ only in what the client values and how much it will
pay. Walk-aways:

    std  = cheapest tractor that meets the requirement + wanted add-ons
    prem = premium trim of that class + wanted add-ons
    price-first   walk = floor(std)  + x          * (list(std)  - floor(std))
    quality-first walk = floor(prem) + (x + 0.25) * (list(prem) - floor(prem))
    balanced      walk = halfway between the two

x is stratified over [-0.2, 1.15], so about one need in eight can't afford its
wanted bundle at the floor as a price-first buyer (it may still afford the bare
tractor), and most land inside the haggle zone.
"""

from __future__ import annotations

import random
from dataclasses import asdict, dataclass, field

from sell2agent import llm
from sell2agent.agents import BuyerAgent, NegotiationState, parse_turn, render_transcript, Turn
from sell2agent.personas import BuyerPersona

import catalog_ext as cx
from catalog_ext import Requirement

SEED = 1010
TYPES = ["price_first", "quality_first", "balanced"]
TYPE_SHORT = {"price_first": "pf", "quality_first": "qf", "balanced": "bal"}
X_VALUES = [-0.2, 0.05, 0.25, 0.4, 0.55, 0.7, 0.9, 1.15]


@dataclass(frozen=True)
class Need:
    id: str
    text: str
    req: Requirement
    wants: tuple[str, ...]


NEEDS: list[Need] = [
    Need("n0", "a compact tractor for mowing and light loader work on a 6-acre hobby farm",
         Requirement(min_hp=20, acres=6, min_lift_lb=800, cab=False), ("loader",)),
    Need("n1", "a compact tractor to clear snow from a long driveway and mow 8 acres; your client works outside all winter and insists on an enclosed, heated cab",
         Requirement(min_hp=20, acres=8, min_lift_lb=800, cab=True), ("delivery",)),
    Need("n2", "a utility tractor for a 25-acre property: brush hogging, moving gravel, and some tilling",
         Requirement(min_hp=40, acres=25, min_lift_lb=1_800, cab=False), ("loader",)),
    Need("n3", "a tractor that can run a front loader and a 6-foot rotary mower on 35 acres",
         Requirement(min_hp=40, acres=35, min_lift_lb=2_000, cab=False), ("loader", "warranty")),
    Need("n4", "a tractor for a 40-acre tree farm that runs a 3-point tree spade and a heavy box blade; the implements need at least 2,800 lb of 3-point lift",
         Requirement(min_hp=45, acres=40, min_lift_lb=2_800, cab=False), ("delivery",)),
    Need("n5", "a tractor to mow and maintain 15 acres of pasture, move hay bales with a loader, and clear snow",
         Requirement(min_hp=30, acres=15, min_lift_lb=1_200, cab=False), ("loader", "delivery")),
    Need("n6", "a row-crop tractor for haying and tillage on a 120-acre farm, pulling heavy implements",
         Requirement(min_hp=70, acres=120, min_lift_lb=3_000, cab=False), ("warranty",)),
    Need("n7", "a 70+ hp tractor for haying on 80 acres, pulling a round baler and a disc mower",
         Requirement(min_hp=70, acres=80, min_lift_lb=3_000, cab=False), ("delivery",)),
]

TYPE_INSTRUCTIONS = {
    "price_first": (
        "Your client's priority is PRICE. Buy the cheapest option that meets every stated requirement. "
        "Don't pay for a premium trim, a bigger tractor, or add-ons the requirements don't call for, unless the add-on is on your client's list and the price works. "
        "A cheaper tractor that meets every requirement beats a nicer one."
    ),
    "quality_first": (
        "Your client's priority is QUALITY. Buy the best-quality option that fits the need: your client values an enclosed cab, stronger hydraulics, "
        "and a longer warranty, and would rather pay more for a better machine. Price matters little as long as the total stays within your walk-away. "
        "The tractor must still meet every stated requirement."
    ),
    "balanced": (
        "Your client's priority is VALUE. Weigh price against quality: pay more for an upgrade (a premium trim or an add-on) only if it's worth the money for this need. "
        "The tractor must meet every stated requirement."
    ),
}


@dataclass
class E10Persona(BuyerPersona):
    buyer_type: str = "balanced"
    need_id: str = ""
    req: dict = field(default_factory=dict)
    x: float = 0.0
    std_product: str = ""  # cheapest tractor that meets the requirement
    prem_product: str = ""  # premium trim of that class

    @property
    def requirement(self) -> Requirement:
        return Requirement(**self.req)

    def to_dict(self) -> dict:
        d = asdict(self)
        d.update(
            floor=self.floor, list=self.list, feasible=self.feasible,
            std_floor=cx.floor_total(self.std_product, self.wants_addons),
            std_list=cx.list_total(self.std_product, self.wants_addons),
            prem_floor=cx.floor_total(self.prem_product, self.wants_addons),
            prem_list=cx.list_total(self.prem_product, self.wants_addons),
            bare_floor=cx.floor_total(self.std_product, []),
            feasible_bare=self.walk_away >= cx.floor_total(self.std_product, []),
        )
        return d


def _round100(v: float) -> int:
    return int(round(v / 100.0) * 100)


def make_buyers(seed: int = SEED) -> list[E10Persona]:
    """24 buyers: each of the 8 needs as each of the 3 types. Deterministic."""
    rng = random.Random(seed)
    xs = X_VALUES[:]
    rng.shuffle(xs)
    out = []
    for need, x in zip(NEEDS, xs):
        std = cx.cheapest_fitting(need.req)
        prem = cx.premium_fitting(need.req)
        wants = list(need.wants)
        sf, sl = cx.floor_total(std, wants), cx.list_total(std, wants)
        pf_, pl = cx.floor_total(prem, wants), cx.list_total(prem, wants)
        walk = {
            "price_first": sf + x * (sl - sf),
            "quality_first": pf_ + (x + 0.25) * (pl - pf_),
        }
        walk["balanced"] = (walk["price_first"] + walk["quality_first"]) / 2
        budget_ratio = rng.uniform(0.85, 0.97)
        urgency = rng.choice(["low", "medium", "high"])
        for t in TYPES:
            w = _round100(walk[t])
            need_text = f"{need.text}. Requirements: {need.req.text()}"
            out.append(
                E10Persona(
                    id=f"{need.id}-{TYPE_SHORT[t]}",
                    need=need_text,
                    target_product=prem if t == "quality_first" else std,
                    wants_addons=wants,
                    budget=int(w * budget_ratio // 500 * 500),
                    walk_away=w,
                    urgency=urgency,
                    brief="neutral",
                    buyer_type=t,
                    need_id=need.id,
                    req=asdict(need.req),
                    x=x,
                    std_product=std,
                    prem_product=prem,
                )
            )
    return out


def _normalize_reply(reply: dict) -> dict:
    off = reply.get("offer")
    if isinstance(off, dict) and off.get("product_id"):
        off["product_id"] = cx.normalize_pid(off["product_id"])
    return reply


class E10Buyer(BuyerAgent):
    """Harness BuyerAgent with the extended catalog text, the type instructions, and premium-id parsing."""

    def __init__(self, persona: E10Persona, **kw):
        super().__init__(persona, catalog_text=cx.public_catalog(), extra_instructions=TYPE_INSTRUCTIONS[persona.buyer_type], **kw)

    def act(self, state: NegotiationState, usage: llm.Usage | None = None) -> Turn:
        prompt = (
            f"Round {state.round} of at most {state.max_rounds}.\n\n"
            f"Conversation so far:\n{render_transcript(state.transcript, 'buyer')}\n\n"
            "Your turn."
        )
        reply, _ = llm.complete_json(self.system_prompt(), prompt, model=self.model, effort=self.effort, usage=usage)
        return parse_turn("buyer", _normalize_reply(reply), state)


if __name__ == "__main__":
    for p in make_buyers():
        d = p.to_dict()
        print(f"{p.id:7s} x={p.x:5.2f} std={p.std_product:4s} prem={p.prem_product:4s} wants={','.join(p.wants_addons):17s} "
              f"walk={p.walk_away:>6,} budget={p.budget:>6,} std[{d['std_floor']:,}-{d['std_list']:,}] prem[{d['prem_floor']:,}-{d['prem_list']:,}] "
              f"feasible={p.feasible} bare={d['feasible_bare']}")
