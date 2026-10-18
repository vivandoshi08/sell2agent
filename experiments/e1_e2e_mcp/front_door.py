"""Negotiation state behind the MCP front door (F4, P2, C2).

One FrontDoor per buyer session. It holds the haggle transcript, the
seller-issued offers (quotes, counters, accepted deals) with ids and expiry,
and the orders. The seller's moves come from the harness SellerAgent (Opus),
and every seller offer, and every buyer offer the seller tries to accept, is
checked by the harness PolicyEngine before it leaves the seller. Checkout
re-checks the offer once more.

Kept free of MCP so it can be unit-tested directly.
"""

from __future__ import annotations

import secrets
import string
import threading
import time
from dataclasses import dataclass, field

from common import ORDERS, JsonlLog, ToolError, now_iso  # noqa: F401  (sys.path set in common)

from sell2agent import llm
from sell2agent.agents import NegotiationState, SellerAgent, Turn, render_transcript
from sell2agent.catalog import ADDONS, PRODUCTS, SELLER_NAME, cost_total, describe, floor_total, list_total
from sell2agent.policy import Offer, PolicyEngine, SellerRules

FRONT_DOOR_NOTE = (
    "You are answering through the company's agent endpoint: the buyer's agent reaches you through tool calls, "
    "and your reply is sent back as the tool result. When you offer or accept, the system issues the buyer an "
    "offer id they can pay with at checkout, so state prices exactly."
)

PARSER_SYSTEM = """You read one message that a buyer's purchasing agent sent to a tractor dealer's sales agent, and extract the buyer's move.

Catalog ids. Tractors: {products}. Add-ons: {addons}.
Product currently under discussion: {product}. Add-ons under discussion: {cur_addons}.
The seller's latest offer: {standing}.

Classify the message as exactly one action:
- "offer": the buyer proposes a specific total price (or says what they would pay) for a product with add-ons. Give the total in dollars for the tractor plus add-ons. If the buyer prices items separately, add them up. If the buyer doesn't name a product or add-ons, use the ones under discussion.
- "accept": the buyer clearly accepts the seller's latest offer as stated, without asking for changes.
- "walk": the buyer ends the conversation without a deal.
- "message": anything else (questions, requests for a quote, comments, counter-requests with no number).

Reply with one JSON object and nothing else:
{{"action": "offer" | "accept" | "walk" | "message", "offer": {{"product_id": "<id>", "price": <integer dollars>, "addons": ["<add-on id>", ...]}} or null}}"""


def _rand(n: int) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


@dataclass
class SellerOffer:
    offer_id: str
    offer: Offer
    kind: str  # "quote" (list price, from code), "counter" (seller LLM offer), "accepted_buyer_offer"
    status: str  # "open", "accepted", "paid", "superseded"
    created: float
    expires: float
    checkout_session_id: str | None = None

    def public(self) -> dict:
        o = self.offer
        return {
            "offer_id": self.offer_id,
            "product_id": o.product_id,
            "addons": list(o.addons),
            "description": describe(o.product_id, o.addons),
            "total_usd": o.price,
            "list_total_usd": list_total(o.product_id, o.addons),
            "status": self.status,
            "expires_at": now_iso(self.expires),
        }


@dataclass
class FrontDoor:
    session_id: str
    design: str
    transcript_log: JsonlLog
    model: str | None = None
    parser_model: str = llm.SONNET
    max_rounds: int = 12
    offer_ttl_s: int = 900
    policy_retries: int = 2
    fixed_price: bool = False  # A2 variant: list price only, no haggling (prompt and policy engine)

    def __post_init__(self) -> None:
        if self.fixed_price:
            self.seller = SellerAgent(model=self.model, negotiable=False, extra_instructions=FRONT_DOOR_NOTE)
            self.policy = PolicyEngine(SellerRules(max_discount_pct=0.0))
        else:
            self.seller = SellerAgent(model=self.model, extra_instructions=FRONT_DOOR_NOTE)
            self.policy = PolicyEngine()
        self.state = NegotiationState(round=0, max_rounds=self.max_rounds, product_id="T45", addons=[])
        self.offers: dict[str, SellerOffer] = {}
        self.usage = llm.Usage()
        self.parser_usage = llm.Usage()
        self.lock = threading.RLock()
        self.policy_rejections: list[dict] = []
        self.closed = False
        self.orders: list[dict] = []
        self.orders_log = JsonlLog(ORDERS)

    # ----- helpers -------------------------------------------------------

    def usage_snapshot(self) -> dict:
        a, b = self.usage.as_dict(), self.parser_usage.as_dict()
        return {k: a[k] + b[k] for k in ("calls", "input_tokens", "output_tokens", "cost_usd")}

    def _log_turn(self, turn: Turn, extra: dict | None = None) -> None:
        rec = {"ts": now_iso(), "session": self.session_id, "round": self.state.round, **turn.to_dict()}
        if extra:
            rec.update(extra)
        self.transcript_log.write(rec)

    def _append(self, turn: Turn, extra: dict | None = None) -> None:
        self.state.transcript.append(turn)
        if turn.offer:
            self.state.product_id, self.state.addons = turn.offer.product_id, list(turn.offer.addons)
        self._log_turn(turn, extra)

    @staticmethod
    def validate_product(product_id: str) -> str:
        pid = str(product_id).strip().upper()
        if pid not in PRODUCTS:
            raise ToolError(f"Unknown product_id {product_id!r}. Valid ids: {', '.join(PRODUCTS)}.")
        return pid

    @staticmethod
    def validate_addons(addons) -> list[str]:
        addons = list(addons or [])
        clean = []
        for a in addons:
            aid = str(a).strip().lower()
            if aid not in ADDONS:
                raise ToolError(f"Unknown add-on {a!r}. Valid add-on ids: {', '.join(ADDONS)}.")
            if aid not in clean:
                clean.append(aid)
        return sorted(clean, key=list(ADDONS).index)

    def _issue(self, offer: Offer, kind: str, status: str = "open") -> SellerOffer:
        prefix = "qt_" if kind == "quote" else "off_"
        now = time.time()
        # Supersede earlier open offers: only the latest seller offer is live.
        for so in self.offers.values():
            if so.status == "open":
                so.status = "superseded"
        so = SellerOffer(prefix + _rand(14), offer, kind, status, now, now + self.offer_ttl_s)
        self.offers[so.offer_id] = so
        return so

    def standing_seller_offer(self) -> SellerOffer | None:
        live = [so for so in self.offers.values() if so.status in ("open", "accepted") and so.expires > time.time()]
        return max(live, key=lambda s: s.created) if live else None

    def get_offer(self, offer_id: str) -> SellerOffer:
        oid = str(offer_id).strip()
        so = self.offers.get(oid)
        if so is None:
            known = ", ".join(self.offers) or "none yet"
            raise ToolError(f"No offer with id {offer_id!r} in this session. Offer ids issued so far: {known}.")
        if so.status == "superseded":
            cur = self.standing_seller_offer()
            hint = f" The current offer is {cur.offer_id}." if cur else ""
            raise ToolError(f"Offer {oid} was replaced by a newer offer and is no longer valid.{hint}")
        if so.status == "paid":
            raise ToolError(f"Offer {oid} is already paid (checkout session {so.checkout_session_id}).")
        if so.expires <= time.time():
            raise ToolError(f"Offer {oid} expired at {now_iso(so.expires)}. Ask for a fresh quote or offer.")
        return so

    # ----- seller move with policy checks --------------------------------

    def _seller_turn(self) -> Turn:
        """Mirror of sell2agent.negotiation._seller_turn, logging every rejection with its reasons."""
        feedback = ""
        for attempt in range(self.policy_retries + 1):
            turn = self.seller.act(self.state, self.usage, feedback=feedback)
            target = None
            if turn.action == "offer":
                target = turn.offer
            elif turn.action == "accept":
                target = self.state.standing_offer("buyer")
            if target is None:
                return turn
            decision = self.policy.check(target)
            if decision.approved:
                return turn
            self.policy_rejections.append(
                {
                    "ts": now_iso(),
                    "round": self.state.round,
                    "attempt": attempt,
                    "action": turn.action,
                    "offer": target.to_dict(),
                    "floor_total": self.policy.floor_for(target) if target.product_id in PRODUCTS else None,
                    "reasons": decision.reasons,
                    "message": turn.message,
                }
            )
            self._log_turn(Turn("seller", turn.message, turn.action, target, note="REJECTED by policy engine: " + "; ".join(decision.reasons)), {"rejected": True})
            feedback = "Your pricing system rejected that move: " + "; ".join(decision.reasons) + ". Make a different move that stays within your rules."
        last = self.state.standing_offer("seller")
        if last is None or not self.policy.check(last).approved:
            last = Offer(self.state.product_id, list_total(self.state.product_id, self.state.addons), list(self.state.addons))
        return Turn("seller", f"I can't go lower than that. My offer stands at ${last.price:,}.", "offer", last, note="policy engine: retries exhausted, restated last valid offer")

    def _respond(self) -> dict:
        """Run one seller turn after a buyer turn and turn it into a tool result."""
        turn = self._seller_turn()
        result: dict = {"seller_message": turn.message}
        if turn.action == "offer" and turn.offer:
            so = self._issue(turn.offer, "counter")
            self._append(turn, {"offer_id": so.offer_id})
            result.update(status="counter_offer", offer=so.public())
        elif turn.action == "accept" and self.state.standing_offer("buyer") is None:
            turn.action, turn.note = "message", "accept with no standing buyer offer; treated as a message"
            self._append(turn)
            result["status"] = "message"
            cur = self.standing_seller_offer()
            if cur:
                result["offer"] = cur.public()
        elif turn.action == "accept":
            buyer_offer = self.state.standing_offer("buyer")
            so = self._issue(buyer_offer, "accepted_buyer_offer", status="accepted")
            self._append(Turn("seller", turn.message, "accept", buyer_offer, note=turn.note), {"offer_id": so.offer_id})
            result.update(status="accepted", offer=so.public(), next_step=f"Deal agreed. Call checkout with offer_id {so.offer_id} to pay.")
        elif turn.action == "walk":
            self._append(turn)
            self.closed = True
            cur = self.standing_seller_offer()
            result.update(status="seller_ended_negotiation")
            if cur:
                result["offer"] = cur.public()
                result["note"] = f"The seller won't negotiate further, but offer {cur.offer_id} can still be accepted until it expires."
        else:
            self._append(turn)
            result["status"] = "message"
            cur = self.standing_seller_offer()
            if cur:
                result["offer"] = cur.public()
        return result

    def _round_guard(self) -> dict | None:
        if self.closed or self.state.round >= self.max_rounds:
            cur = self.standing_seller_offer()
            res = {
                "status": "negotiation_closed",
                "seller_message": "We've reached the end of what we can negotiate in this session. Our latest offer stands." if not self.closed else "The seller has ended the negotiation.",
            }
            if cur:
                res["offer"] = cur.public()
                res["next_step"] = f"Accept or check out offer {cur.offer_id}, or stop here."
            return res
        return None

    # ----- buyer moves ---------------------------------------------------

    def quote(self, product_id: str, addons) -> dict:
        with self.lock:
            pid = self.validate_product(product_id)
            ads = self.validate_addons(addons)
            offer = Offer(pid, list_total(pid, ads), ads)
            self._append(Turn("buyer", f"Please quote {describe(pid, ads)}.", "message"))
            so = self._issue(offer, "quote")
            self._append(Turn("seller", f"Quote at list price: {offer.label()}.", "offer", offer, note="quote from code at list"), {"offer_id": so.offer_id})
            lines = [{"item_id": pid, "description": PRODUCTS[pid].name, "list_price_usd": PRODUCTS[pid].list_price}]
            lines += [{"item_id": a, "description": ADDONS[a].name, "list_price_usd": ADDONS[a].list_price} for a in ads]
            return {
                "quote": so.public(),
                "line_items": lines,
                "note": "This is our list price and our prices are fixed. You can accept it or check out with it." if self.fixed_price else "This is our list price. You can accept it, check out with it, or make a counteroffer with make_offer.",
            }

    def buyer_offer(self, product_id: str, price: int, addons, message: str = "") -> dict:
        with self.lock:
            pid = self.validate_product(product_id)
            ads = self.validate_addons(addons)
            if price <= 0:
                raise ToolError("price must be a positive whole number of US dollars (total for the tractor plus add-ons).")
            guard = self._round_guard()
            if guard:
                return guard
            self.state.round += 1
            offer = Offer(pid, int(price), ads)
            msg = message.strip() or f"I offer ${int(price):,} total for {describe(pid, ads)}."
            self._append(Turn("buyer", msg, "offer", offer))
            res = self._respond()
            res["rounds_used"] = self.state.round
            res["rounds_max"] = self.max_rounds
            return res

    def accept(self, offer_id: str) -> dict:
        with self.lock:
            so = self.get_offer(offer_id)
            if so.status == "open":
                so.status = "accepted"
                self._append(Turn("buyer", f"I accept offer {so.offer_id}.", "accept"), {"offer_id": so.offer_id})
            return {"status": "accepted", "offer": so.public(), "next_step": f"Call checkout with offer_id {so.offer_id} to pay."}

    def parse_message(self, message: str) -> Turn:
        cur = self.standing_seller_offer()
        system = PARSER_SYSTEM.format(
            products=", ".join(f"{p.id} ({p.name})" for p in PRODUCTS.values()),
            addons=", ".join(f"{a.id} ({a.name})" for a in ADDONS.values()),
            product=self.state.product_id,
            cur_addons=", ".join(self.state.addons) or "none",
            standing=cur.offer.label() if cur else "none yet",
        )
        prompt = "Recent conversation:\n" + render_transcript(self.state.transcript[-6:], viewer="none") + f"\n\nBuyer's new message:\n{message}"
        try:
            reply, _ = llm.complete_json(system, prompt, model=self.parser_model, effort="low", usage=self.parser_usage)
        except (ValueError, llm.LLMError):
            reply = {"action": "message"}
        from sell2agent.agents import parse_turn

        return parse_turn("buyer", reply, self.state) if isinstance(reply, dict) else Turn("buyer", message, "message")

    def negotiate(self, message: str) -> dict:
        with self.lock:
            if not str(message).strip():
                raise ToolError("message is empty. Write what you'd like to say to our sales agent.")
            guard = self._round_guard()
            if guard:
                return guard
            self.state.round += 1
            parsed = self.parse_message(message)
            turn = Turn("buyer", message.strip(), parsed.action, parsed.offer, note="parsed from free text")
            cur = self.standing_seller_offer()
            if turn.action == "accept" and cur is not None:
                if cur.status == "open":
                    cur.status = "accepted"
                self._append(turn, {"offer_id": cur.offer_id})
                text = f"Deal. Offer {cur.offer_id}: {cur.offer.label()}. Call checkout with this offer_id to pay."
                self._log_turn(Turn("seller", text, "message", note="confirmation from code"))
                return {"seller_message": text, "status": "accepted", "offer": cur.public(), "rounds_used": self.state.round, "rounds_max": self.max_rounds}
            if turn.action == "accept":
                turn.action, turn.note = "message", "accept with no standing seller offer; treated as a message"
            if turn.action == "walk":
                self._append(turn)
                self.closed = True
                return {"seller_message": "Understood. Thanks for considering Prairie Equipment.", "status": "buyer_ended_negotiation"}
            self._append(turn)
            res = self._respond()
            res["rounds_used"] = self.state.round
            res["rounds_max"] = self.max_rounds
            return res

    # ----- checkout (mock Stripe) ----------------------------------------

    def checkout(self, offer_id: str) -> dict:
        with self.lock:
            so = self.get_offer(offer_id)
            decision = self.policy.check(so.offer)
            if not decision.approved:  # defense in depth; should never fire
                self.policy_rejections.append({"ts": now_iso(), "stage": "checkout", "offer": so.offer.to_dict(), "reasons": decision.reasons})
                raise ToolError("This offer can't be processed: " + "; ".join(decision.reasons))
            accepted_first = so.status == "accepted"
            session = mock_checkout_session(so, self.session_id)
            so.status = "paid"
            so.checkout_session_id = session["id"]
            o = so.offer
            order = {
                "ts": now_iso(),
                "session": self.session_id,
                "design": self.design,
                "offer_id": so.offer_id,
                "offer_kind": so.kind,
                "accepted_before_checkout": accepted_first,
                "checkout_session_id": session["id"],
                "product_id": o.product_id,
                "addons": list(o.addons),
                "price": o.price,
                "list_total": list_total(o.product_id, o.addons),
                "floor_total": floor_total(o.product_id, o.addons),
                "cost": cost_total(o.product_id, o.addons),
                "profit": o.price - cost_total(o.product_id, o.addons),
                "policy_ok": decision.approved,
            }
            self.orders.append(order)
            self.orders_log.write(order)
            self._log_turn(Turn("buyer", f"Checkout {so.offer_id}", "accept", o, note=f"PAID {session['id']}"), {"offer_id": so.offer_id, "checkout": True})
            return session


def mock_checkout_session(so: SellerOffer, session_id: str) -> dict:
    """A Stripe Checkout Session object as it looks after a successful payment (mocked)."""
    o = so.offer
    items = [(o.product_id, PRODUCTS[o.product_id])] + [(a, ADDONS[a]) for a in o.addons]
    subtotal = sum(it.list_price for _, it in items) * 100
    total = o.price * 100
    discount = subtotal - total
    data, allocated = [], 0
    for i, (iid, it) in enumerate(items):
        sub = it.list_price * 100
        disc = round(discount * sub / subtotal) if i else 0
        data.append({"id": "li_" + _rand(24), "object": "item", "description": it.name, "quantity": 1, "currency": "usd",
                     "price": {"id": "price_" + _rand(24), "object": "price", "unit_amount": sub, "currency": "usd", "product": f"prod_{iid}"},
                     "amount_subtotal": sub, "amount_discount": disc, "amount_tax": 0, "amount_total": sub - disc})
        allocated += disc
    data[0]["amount_discount"] = discount - allocated  # the tractor line takes the rounding remainder
    data[0]["amount_total"] = data[0]["amount_subtotal"] - data[0]["amount_discount"]
    created = int(time.time())
    return {
        "id": "cs_test_" + _rand(58),
        "object": "checkout.session",
        "mode": "payment",
        "status": "complete",
        "payment_status": "paid",
        "currency": "usd",
        "amount_subtotal": subtotal,
        "amount_total": total,
        "total_details": {"amount_discount": discount, "amount_shipping": 0, "amount_tax": 0},
        "line_items": {"object": "list", "data": data, "has_more": False},
        "payment_intent": "pi_" + _rand(24),
        "client_reference_id": session_id,
        "created": created,
        "livemode": False,
        "metadata": {"offer_id": so.offer_id, "seller": SELLER_NAME},
        "url": None,
    }
