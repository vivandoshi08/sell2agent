"""E10 catalog extension: a quality dimension and capability specs.

Each tractor class gets a premium variant (cab, upgraded hydraulics with more
3-point lift, a 3-year standard warranty) at about 25% over the standard list,
with a similar or slightly better margin. Every tractor has capability specs
(hp, the largest property it suits, 3-point lift, cab) so "meets the need" is a
deterministic check.

How it plugs into the harness without editing it: `install()` adds the three
premium Items to the shared `sales_agent.catalog.PRODUCTS` dict in this
process only. The harness reads that dict everywhere it prices or checks an
offer (policy engine, offer parsing, `Offer.label`, list/floor/cost totals in
`run_negotiation`), so premium ids are priced and policy-checked like the
standard ones. Prompts don't use the harness catalog text: the buyer and seller
texts below carry the specs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from sales_agent import catalog as base
from sales_agent.catalog import ADDONS, SELLER_NAME, Item
from sales_agent.policy import Decision, Offer, PolicyEngine


@dataclass(frozen=True)
class Spec:
    hp: int
    max_acres: int  # largest property the tractor is suited to
    lift_lb: int  # 3-point hitch lift capacity
    cab: bool
    cab_desc: str
    warranty_years: int  # standard warranty
    tier: str  # "standard" or "premium"
    tractor_class: str  # "T25", "T45", "T75"


PREMIUM: dict[str, Item] = {
    p.id: p
    for p in [
        Item("T25P", "T25 Compact Premium", "25 hp compact with an enclosed heated cab, upgraded hydraulics, and a 3-year standard warranty.", 35_500, 30_500, 24_500),
        Item("T45P", "T45 Utility Premium", "45 hp utility with an enclosed heated cab, upgraded hydraulics, and a 3-year standard warranty.", 52_500, 45_500, 37_000),
        Item("T75P", "T75 Row-Crop Premium", "75 hp row-crop with a deluxe cab, upgraded hydraulics, and a 3-year standard warranty.", 84_000, 72_500, 61_500),
    ]
}

SPECS: dict[str, Spec] = {
    "T25": Spec(25, 10, 1_100, False, "open station, no cab", 1, "standard", "T25"),
    "T25P": Spec(25, 10, 1_500, True, "enclosed cab with heat and A/C", 3, "premium", "T25"),
    "T45": Spec(45, 50, 2_400, False, "open station, no cab", 1, "standard", "T45"),
    "T45P": Spec(45, 50, 3_300, True, "enclosed cab with heat and A/C", 3, "premium", "T45"),
    "T75": Spec(75, 300, 3_500, True, "enclosed cab with A/C", 1, "standard", "T75"),
    "T75P": Spec(75, 300, 4_800, True, "deluxe cab: air-ride seat, A/C, LED work lights", 3, "premium", "T75"),
}

TRACTORS = ["T25", "T25P", "T45", "T45P", "T75", "T75P"]
USES = {
    "T25": "Mowing, snow, light loader work.",
    "T45": "Brush hogging, loader work, tilling.",
    "T75": "Haying, tillage, heavy implements.",
}
WARRANTY_DESC = "Adds 3 years of parts and labor beyond the tractor's standard warranty."


def install() -> None:
    """Register the premium variants in the harness catalog (this process only). Idempotent."""
    for pid, item in PREMIUM.items():
        base.PRODUCTS.setdefault(pid, item)


install()

PRODUCTS = base.PRODUCTS  # same dict object, now with premium ids
list_total, floor_total, cost_total, describe = base.list_total, base.floor_total, base.cost_total, base.describe


def premium_of(pid: str) -> str:
    return SPECS[pid].tractor_class + "P"


def standard_of(pid: str) -> str:
    return SPECS[pid].tractor_class


def is_premium(pid: str) -> bool:
    return SPECS[pid].tier == "premium"


# ---------------------------------------------------------------- needs


@dataclass(frozen=True)
class Requirement:
    min_hp: int
    acres: int
    min_lift_lb: int
    cab: bool

    def text(self) -> str:
        cab = "an enclosed cab is required" if self.cab else "a cab is not required"
        return (f"at least {self.min_hp} hp, suited to at least {self.acres} acres, "
                f"at least {self.min_lift_lb:,} lb of 3-point lift capacity; {cab}")


def misses(pid: str, req: Requirement) -> list[str]:
    """Which stated requirements a tractor fails. Empty list = it meets the need."""
    s = SPECS[pid]
    out = []
    if s.hp < req.min_hp:
        out.append(f"hp {s.hp} < {req.min_hp}")
    if s.max_acres < req.acres:
        out.append(f"suited to {s.max_acres} acres < {req.acres}")
    if s.lift_lb < req.min_lift_lb:
        out.append(f"lift {s.lift_lb} < {req.min_lift_lb}")
    if req.cab and not s.cab:
        out.append("no cab")
    return out


def fits(pid: str, req: Requirement) -> bool:
    return not misses(pid, req)


def cheapest_fitting(req: Requirement) -> str:
    return min((p for p in TRACTORS if fits(p, req)), key=lambda p: PRODUCTS[p].list_price)


def premium_fitting(req: Requirement) -> str:
    """The premium variant of the smallest class that fits: the 'best quality that fits'."""
    return premium_of(cheapest_fitting(req))


# ---------------------------------------------------------------- catalog texts


def _spec_line(pid: str) -> str:
    s = SPECS[pid]
    return (f"{s.hp} hp; suited to properties up to {s.max_acres} acres; {s.lift_lb:,} lb 3-point lift"
            f"{' (upgraded hydraulics)' if s.tier == 'premium' else ''}; {s.cab_desc}; "
            f"{s.warranty_years}-year standard warranty.")


def public_catalog() -> str:
    """What a buyer sees: ids, specs, list prices."""
    lines = [f"{SELLER_NAME} catalog (list prices). Every tractor is 4WD. Premium trims (ids ending in P) are the same size class with a cab, upgraded hydraulics, and a 3-year standard warranty.", "Tractors:"]
    for pid in TRACTORS:
        p = PRODUCTS[pid]
        use = f" {USES[pid]}" if pid in USES else ""
        lines.append(f"- {pid}: {p.name}, ${p.list_price:,}. {_spec_line(pid)}{use}")
    lines.append("Add-ons (fit every tractor):")
    for a in ADDONS.values():
        desc = WARRANTY_DESC if a.id == "warranty" else a.description
        lines.append(f"- {a.id}: {a.name}, ${a.list_price:,}. {desc}")
    return "\n".join(lines)


def seller_catalog() -> str:
    """What the seller knows: specs, list, private floor, private cost."""
    lines = ["Tractors (id: name | list | floor | cost | specs):"]
    for pid in TRACTORS:
        p = PRODUCTS[pid]
        lines.append(f"- {pid}: {p.name} | list ${p.list_price:,} | floor ${p.floor_price:,} | cost ${p.cost:,} | {_spec_line(pid)}")
    lines.append("Add-ons (id: name | list | floor | cost), fit every tractor:")
    for a in ADDONS.values():
        desc = WARRANTY_DESC if a.id == "warranty" else a.description
        lines.append(f"- {a.id}: {a.name} | list ${a.list_price:,} | floor ${a.floor_price:,} | cost ${a.cost:,}. {desc}")
    lines.append("An offer's floor total is the tractor's floor plus each included add-on's floor.")
    return "\n".join(lines)


# ---------------------------------------------------------------- offers and policy


_PID_RE = re.compile(r"T\s*-?\s*(25|45|75)\s*-?\s*(PREMIUM|PREM|P(?![A-Z]))?")


def normalize_pid(raw) -> str:
    """'T45 Premium', 't45-p', 'T45P' -> 'T45P'; 'T45 Utility' -> 'T45'. Unknown -> unchanged."""
    up = str(raw or "").upper()
    m = _PID_RE.search(up)
    if not m:
        return up.strip()
    premium = bool(m.group(2)) or "PREMIUM" in up
    return f"T{m.group(1)}{'P' if premium else ''}"


class E10Policy(PolicyEngine):
    """The harness policy engine, checked against the extended catalog."""

    def check(self, offer: Offer) -> Decision:
        install()
        if offer.product_id not in SPECS:
            return Decision(False, [f"unknown product {offer.product_id!r}"])
        return super().check(offer)


if __name__ == "__main__":
    print(public_catalog())
    print()
    print(seller_catalog())
    for pid in TRACTORS:
        p = PRODUCTS[pid]
        print(f"{pid}: list margin {(p.list_price - p.cost) / p.list_price:.1%}, floor margin {(p.floor_price - p.cost) / p.floor_price:.1%}")
    for s in ["T45 Premium", "t45-p", "T45P", "T45 Utility", "T25", "T75P", "T75 Row-Crop Premium"]:
        print(s, "->", normalize_pid(s))
    print(E10Policy().check(Offer("T45P", 47_000, ["loader"])))
