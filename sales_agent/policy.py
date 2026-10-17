"""Offers and the policy engine (P1, P2).

The policy engine is plain code. It checks an offer against the seller's
rules and returns a decision with reasons. It never calls a model, so a
buyer can't talk it into anything.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from .catalog import ADDONS, PRODUCTS, describe, floor_total, list_total

ALLOWED_TERMS = {"pay_now"}


@dataclass
class Offer:
    product_id: str
    price: int  # total for the tractor plus add-ons, in dollars
    addons: list[str] = field(default_factory=list)
    terms: str = "pay_now"

    def label(self) -> str:
        return f"{describe(self.product_id, self.addons)}, ${self.price:,}"

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Decision:
    approved: bool
    reasons: list[str] = field(default_factory=list)


@dataclass
class SellerRules:
    """What the seller allows. Defaults: the catalog floors, any add-on, pay at checkout."""

    max_discount_pct: float | None = None  # max discount off the list total, e.g. 0.15
    allowed_addons: set[str] = field(default_factory=lambda: set(ADDONS))
    allowed_terms: set[str] = field(default_factory=lambda: set(ALLOWED_TERMS))
    floor_overrides: dict[str, int] = field(default_factory=dict)  # product id -> floor


class PolicyEngine:
    def __init__(self, rules: SellerRules | None = None):
        self.rules = rules or SellerRules()

    def floor_for(self, offer: Offer) -> int:
        floor = floor_total(offer.product_id, offer.addons)
        if offer.product_id in self.rules.floor_overrides:
            floor += self.rules.floor_overrides[offer.product_id] - PRODUCTS[offer.product_id].floor_price
        return floor

    def check(self, offer: Offer) -> Decision:
        reasons = []
        if offer.product_id not in PRODUCTS:
            return Decision(False, [f"unknown product {offer.product_id!r}"])
        bad = [a for a in offer.addons if a not in ADDONS or a not in self.rules.allowed_addons]
        if bad:
            reasons.append(f"add-ons not allowed: {', '.join(bad)}")
        if not bad:
            floor = self.floor_for(offer)
            if offer.price < floor:
                reasons.append(f"price ${offer.price:,} is below the floor total ${floor:,}")
            if self.rules.max_discount_pct is not None:
                lst = list_total(offer.product_id, offer.addons)
                if offer.price < lst * (1 - self.rules.max_discount_pct):
                    reasons.append(f"discount is more than {self.rules.max_discount_pct:.0%} off list")
        if offer.terms not in self.rules.allowed_terms:
            reasons.append(f"payment terms {offer.terms!r} not allowed")
        return Decision(not reasons, reasons)
