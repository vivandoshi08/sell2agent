"""Quick in-process checks of the seller and registry MCP servers.

    uv run python experiments/e1_e2e_mcp/test_servers.py          # no model calls
    uv run python experiments/e1_e2e_mcp/test_servers.py --llm    # plus one make_offer and one negotiate (Opus seller)

Writes logs under runs/sessions/test-*.jsonl; delete them afterwards.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mcp import Client  # noqa: E402

import registry_server  # noqa: E402
import seller_server  # noqa: E402


OUT: list[str] = []


def say(*parts) -> None:
    OUT.append(" ".join(str(p) for p in parts))


def show(label, res):
    text = res.content[0].text if res.content else str(res)
    say(f"--- {label}  is_error={res.is_error}\n{text[:600]}\n")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


async def main(llm_calls: bool) -> None:
    srv = seller_server.build_server("structured", "test-structured", None, 12, 900)
    async with Client(srv) as c:
        tools = await c.list_tools()
        say("structured tools:", [t.name for t in tools.tools])
        show("list_products", await c.call_tool("list_products", {}))
        show("get_product bad id", await c.call_tool("get_product", {"product_id": "T99"}))
        show("make_offer bad price type", await c.call_tool("make_offer", {"product_id": "T45", "price": "about 38k"}))
        show("unknown tool", await c.call_tool("buy_now", {}))
        q = show("request_quote", await c.call_tool("request_quote", {"product_id": "t45", "addons": ["warranty"]}))
        qid = q["quote"]["offer_id"]
        show("accept_offer", await c.call_tool("accept_offer", {"offer_id": qid}))
        show("checkout bad id", await c.call_tool("checkout", {"offer_id": "off_nope"}))
        if llm_calls:
            show("make_offer", await c.call_tool("make_offer", {"product_id": "T45", "price": 37000, "addons": ["warranty"], "message": "Can you do 37k?"}))
        show("checkout quote", await c.call_tool("checkout", {"offer_id": qid}))
        show("checkout again", await c.call_tool("checkout", {"offer_id": qid}))

    srv = seller_server.build_server("freetext", "test-freetext", None, 12, 900)
    async with Client(srv) as c:
        tools = await c.list_tools()
        say("freetext tools:", [t.name for t in tools.tools])
        if llm_calls:
            r = show("negotiate", await c.call_tool("negotiate", {"message": "Hi, I'd like the T25 Compact with delivery. Would you take $24,800 total?"}))
            if r and r.get("offer"):
                show("checkout", await c.call_tool("checkout", {"offer_id": r["offer"]["offer_id"]}))

    srv = registry_server.build_server("test-registry")
    async with Client(srv) as c:
        r = show("search_sellers", await c.call_tool("search_sellers", {"query": "compact tractor dealer"}))
        say("sellers:", [x["name"] for x in r["results"]])
        show("get_web_page", await c.call_tool("get_web_page", {"seller": "Heartland Tractor Supply"}))
        show("get_web_page bad", await c.call_tool("get_web_page", {"seller": "acme"}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--llm", action="store_true")
    asyncio.run(main(ap.parse_args().llm))
    # Printing inside the in-process MCP session drops lines in mcp 2.3, so print at the end.
    print("\n".join(OUT))
