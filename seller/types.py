"""Records shared between the front door and payments.

A Deal is created only by the server, from an offer the policy engine
approved, and never changes afterwards. Payments read the amount from the
Deal, never from the buyer.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class Deal:
    deal_id: str
    negotiation_id: str
    product_id: str
    addons: tuple[str, ...]
    amount_cents: int
    currency: str
    list_total_cents: int
    floor_total_cents: int
    description: str
    created_at: float
    expires_at: float

    @property
    def amount_usd(self) -> int:
        return self.amount_cents // 100

    def expired(self, now: float | None = None) -> bool:
        return (now if now is not None else time.time()) >= self.expires_at

    def to_dict(self) -> dict:
        d = asdict(self)
        d["addons"] = list(self.addons)
        d["amount_usd"] = self.amount_usd
        return d


@dataclass
class PaymentResult:
    status: str  # succeeded | processing | requires_action | refused | declined | error
    deal_id: str
    payment_id: str | None = None
    amount_cents: int | None = None
    card: str | None = None
    reasons: list[str] = field(default_factory=list)
    fix: str | None = None
    already_paid: bool = False
    gateway: str = ""
    raw: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status in ("succeeded", "processing")

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("raw", None)
        if self.amount_cents is not None:
            d["amount_usd"] = self.amount_cents // 100
        return d
