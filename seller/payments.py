"""Payment gateways for pay_deal.

Stub written by the coordinator so the front door can be built in parallel.
Builder B owns this file from here on and adds the Stripe gateways
(Shared Payment Token -> PaymentIntent, and a test-card fallback) behind the
same interface.

Contract:
    gateway = get_gateway()
    result = gateway.pay(deal, credential)   # -> PaymentResult

`credential` is whatever the buyer passed to pay_deal: None, a bare token
string ("spt_..."), or a UCP-style instrument
{"credential": {"type": "stripe_payment_token", "token": "spt_..."}}.
The amount always comes from `deal`, never from the credential.
"""

from __future__ import annotations

import os
import secrets
import threading
from typing import Protocol

from .types import Deal, PaymentResult


def token_from_credential(credential) -> str | None:
    if credential is None:
        return None
    if isinstance(credential, str):
        return credential.strip() or None
    if isinstance(credential, dict):
        inner = credential.get("credential", credential)
        if isinstance(inner, dict):
            tok = inner.get("token")
            return str(tok).strip() if tok else None
    return None


class PaymentGateway(Protocol):
    name: str

    def pay(self, deal: Deal, credential) -> PaymentResult: ...


class MockGateway:
    """No Stripe key: records a fake, clearly labelled payment. Idempotent per deal."""

    name = "mock"

    def __init__(self):
        self._paid: dict[str, PaymentResult] = {}
        self._lock = threading.Lock()

    def pay(self, deal: Deal, credential) -> PaymentResult:
        with self._lock:
            if deal.deal_id in self._paid:
                prev = self._paid[deal.deal_id]
                return PaymentResult(**{**prev.__dict__, "already_paid": True})
            if deal.expired():
                return PaymentResult("refused", deal.deal_id, reasons=["deal expired"],
                                     fix="Start a new negotiation with make_offer.", gateway=self.name)
            res = PaymentResult(
                "succeeded",
                deal.deal_id,
                payment_id="pi_mock_" + secrets.token_urlsafe(10),
                amount_cents=deal.amount_cents,
                card="mock card (no Stripe key configured)",
                gateway=self.name,
            )
            self._paid[deal.deal_id] = res
            return res


_gateway: PaymentGateway | None = None


def get_gateway() -> PaymentGateway:
    """Pick the gateway from the environment. Builder B adds the Stripe ones."""
    global _gateway
    if _gateway is None:
        _gateway = MockGateway()
        if os.environ.get("STRIPE_SECRET_KEY"):
            pass  # Builder B: return StripeSPTGateway / StripeCardGateway here
    return _gateway
