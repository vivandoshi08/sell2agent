"""Simulated seller registry (discovery) for E1.

    uv run python experiments/e1_e2e_mcp/registry_server.py --session <id>

Tools:
  search_sellers(query)  agent cards from registry.json that match the query
  get_web_page(seller)   the seller's public product page (plain text)

Every call is logged to runs/sessions/<session>.registry.jsonl.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import HERE, SESSIONS, LoggedServer, ToolError  # noqa: E402

REGISTRY = json.loads((HERE / "registry.json").read_text())


def apply_variant(variant: str) -> None:
    """'fixed': Prairie's card and page say fixed prices (A2 test: agent checkout at list vs. a cheaper web-only page)."""
    if variant != "fixed":
        return
    card = next(c for c in REGISTRY["agents"] if c["id"] == "prairie-equipment")
    card["description"] = card["description"].replace("quotes, negotiates, and takes payment", "quotes, and takes payment")
    card["capabilities"]["negotiable"] = False
    card["skills"] = [s for s in card["skills"] if s["id"] != "negotiate"] + [{"id": "quote", "name": "Quote", "description": "Formal quotes at our fixed list prices.", "tags": ["quote"]}]
    page = REGISTRY["web_pages"]["prairie-equipment"]
    page = page.replace("Our sales agent can quote, negotiate, and take payment", "Our sales agent can quote and take payment").replace("Ask it for a quote or make an offer.", "Ask it for a quote.")
    REGISTRY["web_pages"]["prairie-equipment"] = page.replace("Prices are list prices and may be negotiated.", "Prices are fixed. No haggling.")


def _resolve(seller: str) -> str:
    key = str(seller).strip().lower()
    pages = REGISTRY["web_pages"]
    for card in REGISTRY["agents"]:
        names = {card["id"], card["name"].lower(), card["url"].lower(), card.get("endpoints", {}).get("web", "").lower()}
        if key in names or key.rstrip("/") in names:
            return card["id"]
    for card in REGISTRY["agents"]:  # loose match: any distinctive word
        words = set(re.findall(r"[a-z]+", card["name"].lower())) - {"co", "supply", "tractor", "equipment", "the"}
        if words & set(re.findall(r"[a-z]+", key)):
            return card["id"]
    raise ToolError(f"No web page for seller {seller!r}. Known sellers: " + ", ".join(f"{c['id']} ({c['name']})" for c in REGISTRY["agents"] if c["id"] in pages))


def build_server(session: str) -> LoggedServer:
    srv = LoggedServer(
        "registry",
        log_path=SESSIONS / f"{session}.registry.jsonl",
        session_id=session,
        instructions="A directory of farm-equipment sellers (A2A-style agent cards). Search it to find sellers, and read a seller's public web page.",
    )

    @srv.tool()
    def search_sellers(query: str) -> dict:
        """Search the seller directory. Returns matching sellers' agent cards: description, capabilities, and endpoints."""
        words = set(re.findall(r"[a-z0-9]+", str(query).lower()))
        hits = []
        for card in REGISTRY["agents"]:
            text = json.dumps(card).lower()
            if not words or any(w in text for w in words):
                hits.append(card)
        if not hits:  # tiny directory: show everything rather than dead-end
            hits = REGISTRY["agents"]
        return {"registry": REGISTRY["registry"], "query": query, "results": hits}

    @srv.tool()
    def get_web_page(seller: str) -> dict:
        """Fetch a seller's public product web page as plain text. `seller` is the seller id or name from search_sellers."""
        sid = _resolve(seller)
        return {"seller_id": sid, "url": next(c for c in REGISTRY["agents"] if c["id"] == sid)["endpoints"]["web"], "page_text": REGISTRY["web_pages"][sid]}

    return srv


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--variant", default="negotiable", choices=["negotiable", "fixed"])
    args = ap.parse_args()
    apply_variant(args.variant)
    build_server(args.session).run()


if __name__ == "__main__":
    main()
