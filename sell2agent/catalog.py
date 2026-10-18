"""The test catalog: three tractors and three add-ons (H3).

Every item has a list price (what the seller advertises), a floor (the
lowest the seller may go, enforced by the policy engine), and a cost.
Offers are priced as one total for the tractor plus its add-ons.
"""

from __future__ import annotations

from dataclasses import dataclass

SELLER_NAME = "Prairie Equipment Co."


@dataclass(frozen=True)
class Item:
    id: str
    name: str
    description: str
    list_price: int
    floor_price: int
    cost: int


PRODUCTS: dict[str, Item] = {
    p.id: p
    for p in [
        Item("T25", "T25 Compact", "25 hp, 4WD, hydrostatic transmission. For under 10 acres: mowing, snow, light loader work.", 28_500, 24_500, 20_000),
        Item("T45", "T45 Utility", "45 hp, 4WD, Cat I/II 3-point hitch, 540 PTO. For 10-50 acres: brush hogging, loader work, tilling.", 42_000, 36_500, 30_500),
        Item("T75", "T75 Row-Crop", "75 hp, enclosed cab with A/C, 4WD. For 50+ acres: haying, tillage, heavy implements.", 68_000, 59_000, 51_000),
    ]
}

ADDONS: dict[str, Item] = {
    a.id: a
    for a in [
        Item("loader", "Front loader", "Quick-attach front loader with 60-inch bucket.", 6_500, 5_200, 4_100),
        Item("warranty", "3-year extended warranty", "Parts and labor for 3 years beyond the standard 1-year warranty.", 2_400, 1_200, 600),
        Item("delivery", "Delivery and setup", "Delivered within 150 miles, set up, and walked through on site.", 900, 500, 400),
    ]
}


def _sum(product_id: str, addons: list[str] | tuple[str, ...], attr: str) -> int:
    total = getattr(PRODUCTS[product_id], attr)
    for a in addons:
        total += getattr(ADDONS[a], attr)
    return total


def list_total(product_id: str, addons=()) -> int:
    return _sum(product_id, addons, "list_price")


def floor_total(product_id: str, addons=()) -> int:
    return _sum(product_id, addons, "floor_price")


def cost_total(product_id: str, addons=()) -> int:
    return _sum(product_id, addons, "cost")


def describe(product_id: str, addons=()) -> str:
    """Human-readable name for a product plus add-ons, e.g. 'T45 Utility + Front loader'."""
    parts = [PRODUCTS[product_id].name] + [ADDONS[a].name for a in addons]
    return " + ".join(parts)


def public_catalog() -> str:
    """What a buyer can see: ids, specs, and list prices."""
    lines = [f"{SELLER_NAME} catalog (list prices):", "Tractors:"]
    for p in PRODUCTS.values():
        lines.append(f"- {p.id}: {p.name}, ${p.list_price:,}. {p.description}")
    lines.append("Add-ons:")
    for a in ADDONS.values():
        lines.append(f"- {a.id}: {a.name}, ${a.list_price:,}. {a.description}")
    return "\n".join(lines)


def seller_catalog() -> str:
    """What the seller knows: list price, private floor, and private cost."""
    lines = ["Tractors (id: name | list | floor | cost):"]
    for p in PRODUCTS.values():
        lines.append(f"- {p.id}: {p.name} | list ${p.list_price:,} | floor ${p.floor_price:,} | cost ${p.cost:,}. {p.description}")
    lines.append("Add-ons (id: name | list | floor | cost):")
    for a in ADDONS.values():
        lines.append(f"- {a.id}: {a.name} | list ${a.list_price:,} | floor ${a.floor_price:,} | cost ${a.cost:,}. {a.description}")
    lines.append("An offer's floor total is the tractor's floor plus each included add-on's floor.")
    return "\n".join(lines)
