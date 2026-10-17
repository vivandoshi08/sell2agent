"""Seeded buyer personas (H1, H7).

Each persona has a need, a target tractor and add-ons, a budget it may
state, and a private walk-away price for the whole bundle. The walk-away
is placed relative to the seller's floor and list totals:

    walk_away = floor + x * (list - floor),  x ~ Uniform(-0.6, 1.4)

so roughly 30% of buyers can't afford the floor (no deal is the right
outcome), half land inside the haggle zone, and 20% would pay list.
The same seed always gives the same buyers.
"""

from __future__ import annotations

import random
from dataclasses import asdict, dataclass, field

from .catalog import floor_total, list_total

BRIEFS = {
    "neutral": "Get a tractor that meets the need at a fair price.",
    "strict_budget": "Your client's budget is firm. Do not go over it.",
    "best_deal": "Your client wants the lowest price possible. Negotiate hard and don't accept the first offer.",
    "buy_fast": "Your client needs the tractor soon and doesn't want a long back-and-forth. Close quickly if the price is reasonable.",
}

_NEEDS = {
    "T25": (
        (3, 10),
        [
            "a small tractor for mowing and light loader work on a {acres}-acre hobby farm",
            "a compact tractor to keep {acres} acres of pasture mowed and clear snow in winter",
        ],
    ),
    "T45": (
        (15, 40),
        [
            "a utility tractor for a {acres}-acre property: brush hogging, moving gravel, and some tilling",
            "a tractor that can run a loader and a 6-foot rotary mower on {acres} acres",
        ],
    ),
    "T75": (
        (60, 200),
        [
            "a row-crop tractor with a cab for a {acres}-acre farm, pulling heavy implements",
            "a 70+ hp tractor for haying and tillage on {acres} acres",
        ],
    ),
}

_ADDON_ODDS = {"loader": 0.4, "warranty": 0.3, "delivery": 0.5}


@dataclass
class BuyerPersona:
    id: str
    need: str
    target_product: str
    wants_addons: list[str] = field(default_factory=list)
    budget: int = 0
    walk_away: int = 0
    urgency: str = "medium"
    brief: str = "neutral"

    @property
    def floor(self) -> int:
        return floor_total(self.target_product, self.wants_addons)

    @property
    def list(self) -> int:
        return list_total(self.target_product, self.wants_addons)

    @property
    def feasible(self) -> bool:
        """True if a deal inside the seller's rules is possible for this buyer."""
        return self.walk_away >= self.floor

    def to_dict(self) -> dict:
        d = asdict(self)
        d.update(floor=self.floor, list=self.list, feasible=self.feasible)
        return d


def make_personas(
    n: int,
    seed: int = 0,
    briefs: list[str] | None = None,
    products: list[str] | None = None,
    x_range: tuple[float, float] = (-0.6, 1.4),
) -> list[BuyerPersona]:
    """Generate n buyers. Briefs cycle through `briefs` (default: all neutral)."""
    rng = random.Random(seed)
    briefs = briefs or ["neutral"]
    weights = {"T25": 0.25, "T45": 0.5, "T75": 0.25}
    pool = products or list(weights)
    out = []
    for i in range(n):
        product = rng.choices(pool, weights=[weights.get(p, 1.0) for p in pool])[0]
        (lo, hi), templates = _NEEDS[product]
        need = rng.choice(templates).format(acres=rng.randint(lo, hi))
        addons = [a for a, p in _ADDON_ODDS.items() if rng.random() < p]
        floor, lst = floor_total(product, addons), list_total(product, addons)
        x = rng.uniform(*x_range)
        walk_away = int(round((floor + x * (lst - floor)) / 100.0) * 100)
        brief = briefs[i % len(briefs)]
        if brief == "strict_budget":
            budget = walk_away
        else:
            budget = int(walk_away * rng.uniform(0.85, 0.97) // 500 * 500)
        out.append(
            BuyerPersona(
                id=f"s{seed}-b{i:03d}",
                need=need,
                target_product=product,
                wants_addons=addons,
                budget=budget,
                walk_away=walk_away,
                urgency=rng.choice(["low", "medium", "high"]),
                brief=brief,
            )
        )
    return out
