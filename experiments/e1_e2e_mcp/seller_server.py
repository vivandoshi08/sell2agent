"""Prairie Equipment Co.'s MCP front door (E1).

    uv run python experiments/e1_e2e_mcp/seller_server.py --design structured --session <id>
    uv run python experiments/e1_e2e_mcp/seller_server.py --design freetext --session <id>

Runs over stdio, one process per buyer session. Behind the tools: the harness
SellerAgent (Opus) and PolicyEngine, with per-session state in FrontDoor.
Every tool call is logged to runs/sessions/<session>.seller.jsonl, every
negotiation turn to runs/sessions/<session>.turns.jsonl, and paid orders to
runs/orders.jsonl.

Designs:
  structured  list_products, get_product, request_quote, make_offer, accept_offer, checkout
  freetext    list_products, negotiate, checkout
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import SESSIONS, JsonlLog, LoggedServer, ToolError  # noqa: E402
from front_door import FrontDoor  # noqa: E402

from sales_agent.catalog import ADDONS, PRODUCTS, SELLER_NAME  # noqa: E402

INSTRUCTIONS = {
    "structured": (
        f"{SELLER_NAME} sells compact, utility and row-crop tractors with optional add-ons. "
        "Browse with list_products and get_product, get a list-price quote with request_quote, negotiate with make_offer "
        "(our sales agent answers with an acceptance or a counteroffer), accept a seller offer with accept_offer, "
        "and pay with checkout. All prices are in US dollars; offers are one total for the tractor plus add-ons."
    ),
    "freetext": (
        f"{SELLER_NAME} sells compact, utility and row-crop tractors with optional add-ons. "
        "Browse with list_products. Talk to our sales agent with negotiate: ask questions, request a quote, or make an offer "
        "in plain language. When the agent makes or agrees to an offer you get an offer_id; pay for it with checkout. "
        "All prices are in US dollars; offers are one total for the tractor plus add-ons."
    ),
}


FIXED_PRICING = "Prices are fixed at list. No haggling. Request a quote and pay with checkout."


def catalog_listing(design: str, fixed_price: bool = False) -> dict:
    how = FIXED_PRICING if fixed_price else (
        "Prices are negotiable. Use request_quote for a formal quote and make_offer to propose your own price."
        if design == "structured"
        else "Prices are negotiable. Use negotiate to talk to our sales agent."
    )
    return {
        "seller": SELLER_NAME,
        "currency": "USD",
        "products": [{"product_id": p.id, "name": p.name, "list_price_usd": p.list_price, "summary": p.description} for p in PRODUCTS.values()],
        "addons": [{"addon_id": a.id, "name": a.name, "list_price_usd": a.list_price, "summary": a.description} for a in ADDONS.values()],
        "pricing": how,
        "payment": "Pay in full at checkout (card or ACH). No financing.",
    }


def build_server(design: str, session: str, model: str | None, max_rounds: int, offer_ttl_s: int, fixed_price: bool = False) -> LoggedServer:
    fd = FrontDoor(
        session_id=session,
        design=design,
        transcript_log=JsonlLog(SESSIONS / f"{session}.turns.jsonl"),
        model=model,
        max_rounds=max_rounds,
        offer_ttl_s=offer_ttl_s,
        fixed_price=fixed_price,
    )
    srv = LoggedServer(
        "prairie_equipment",
        log_path=SESSIONS / f"{session}.seller.jsonl",
        session_id=session,
        design=design,
        usage_fn=fd.usage_snapshot,
        instructions=INSTRUCTIONS[design] + (" " + FIXED_PRICING if fixed_price else ""),
    )
    srv.front_door = fd  # type: ignore[attr-defined]

    @srv.tool()
    def list_products() -> dict:
        """List the tractors and add-ons we sell, with list prices in US dollars."""
        return catalog_listing(design, fixed_price)

    @srv.tool()
    def checkout(offer_id: str) -> dict:
        """Pay for an offer from our sales agent (a quote, a counteroffer, or an accepted deal) using its offer_id.

        Charges the agreed total and returns the completed Stripe checkout session (amount in cents)."""
        return fd.checkout(offer_id)

    if design == "structured":

        @srv.tool()
        def get_product(product_id: str) -> dict:
            """Get details for one tractor (e.g. "T45"): specs, list price, and the add-ons available with it."""
            pid = fd.validate_product(product_id)
            p = PRODUCTS[pid]
            return {
                "product_id": p.id,
                "name": p.name,
                "list_price_usd": p.list_price,
                "description": p.description,
                "warranty": "1-year standard parts and labor warranty included.",
                "available_addons": [{"addon_id": a.id, "name": a.name, "list_price_usd": a.list_price, "summary": a.description} for a in ADDONS.values()],
                "in_stock": True,
                "pricing": FIXED_PRICING if fixed_price else "Negotiable. Use request_quote for a formal quote or make_offer to propose a price.",
            }

        @srv.tool()
        def request_quote(product_id: str, addons: list[str] | None = None) -> dict:
            """Get a formal quote at list price for a tractor plus optional add-on ids (e.g. ["loader", "delivery"]).

            Returns a quote with an offer_id you can accept or pay with, and an expiry time."""
            return fd.quote(product_id, addons or [])

        @srv.tool()
        def make_offer(product_id: str, price: int, addons: list[str] | None = None, message: str = "") -> dict:
            """Propose a price to our sales agent: one total in whole US dollars for the tractor plus the listed add-on ids.

            Optionally include a short message. The sales agent replies by accepting (you get an offer_id to pay with)
            or with a counteroffer (an offer_id you can accept or counter again)."""
            return fd.buyer_offer(product_id, price, addons or [], message)

        @srv.tool()
        def accept_offer(offer_id: str) -> dict:
            """Accept an offer from our sales agent (a quote or counteroffer) by its offer_id. Then pay with checkout."""
            return fd.accept(offer_id)

    elif design == "freetext":

        @srv.tool()
        def negotiate(message: str) -> dict:
            """Send a message to our sales agent: ask about products, request a quote, or make an offer in plain language.

            Returns the agent's reply and, when there is one, the current offer with its offer_id and total price."""
            return fd.negotiate(message)

    else:
        raise SystemExit(f"unknown design {design!r}")

    return srv


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--design", choices=["structured", "freetext"], required=True)
    ap.add_argument("--session", required=True)
    ap.add_argument("--model", default=None, help="seller model (default: harness default, Opus)")
    ap.add_argument("--max-rounds", type=int, default=12)
    ap.add_argument("--offer-ttl", type=int, default=900, help="seconds before an offer expires")
    ap.add_argument("--fixed-price", action="store_true", help="A2 variant: the seller sells at list only (prompt + policy engine)")
    args = ap.parse_args()
    build_server(args.design, args.session, args.model, args.max_rounds, args.offer_ttl, args.fixed_price).run()


if __name__ == "__main__":
    main()
