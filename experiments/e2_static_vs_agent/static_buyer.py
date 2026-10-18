"""A buyer agent facing a fixed-price storefront (E2 arms a and b).

The buyer gets the same persona information as the harness BuyerAgent
(need, wanted add-ons, budget, private walk-away, brief, urgency), reads the
raw storefront (HTML page or JSON feed), and makes ONE decision: buy a
tractor plus add-ons at the list total, or don't buy. No negotiation.

The result is a harness Outcome, so metrics.summarize/compare treat these
sessions exactly like negotiated ones.
"""

from __future__ import annotations

import re
import time
import uuid

from sell2agent import llm
from sell2agent.catalog import ADDONS, PRODUCTS, cost_total, floor_total, list_total
from sell2agent.negotiation import Outcome
from sell2agent.personas import BRIEFS, BuyerPersona
from sell2agent.policy import Offer, PolicyEngine

DECISION_FORMAT = """Reply with one JSON object and nothing else:
{"decision": "buy" | "no_buy", "product_id": "<tractor id from the store, or null>", "addons": ["<add-on id>", ...], "expected_total": <integer dollars you will pay, or null>, "reason": "<one or two sentences>"}"""

SOURCES = {
    "html": ("You opened the seller's website. This is the raw HTML of its tractor page", "https://prairie-equipment.example/tractors"),
    "feed": ("You fetched the seller's product feed. This is the raw JSON", "https://prairie-equipment.example/feeds/products.json"),
}


def system_prompt(p: BuyerPersona) -> str:
    """Mirrors BuyerAgent.system_prompt, minus the negotiation actions."""
    wants = ", ".join(ADDONS[a].name for a in p.wants_addons) or "none"
    parts = [
        "You are a purchasing agent buying equipment for your client. You are shopping at a seller's online store.",
        f"Your client's need: {p.need}.",
        f"Add-ons your client wants if the price works: {wants}.",
        f"Budget your client mentioned: ${p.budget:,}.",
        f"Your walk-away price: ${p.walk_away:,} total. Never agree to pay more than this.",
        BRIEFS.get(p.brief, BRIEFS["neutral"]),
        f"Your client's urgency: {p.urgency}.",
        "This store sells at its listed prices. There is no salesperson to talk to and no way to negotiate or make an offer: "
        "you can buy now at the listed prices, or not buy.",
        "Only buy if the total is at or below your walk-away price.",
        DECISION_FORMAT,
    ]
    return "\n\n".join(parts)


def user_prompt(source: str, content: str) -> str:
    intro, url = SOURCES[source]
    return f"{intro} ({url}):\n\n{content}\n\nMake your decision."


_ADDON_ALIASES = {"loader": "loader", "bucket": "loader", "warrant": "warranty", "deliver": "delivery", "setup": "delivery"}


def parse_product(raw) -> str | None:
    if raw is None:
        return None
    m = re.search(r"T\s*-?\s*(25|45|75)", str(raw).upper())
    if m:
        return f"T{m.group(1)}"
    s = str(raw).lower()
    for pid, p in PRODUCTS.items():
        if p.name.lower() in s:
            return pid
    return None


def parse_addons(raw) -> list[str]:
    out = []
    for item in raw or []:
        s = str(item).lower()
        for key, aid in _ADDON_ALIASES.items():
            if key in s and aid not in out:
                out.append(aid)
                break
    return sorted(out, key=list(ADDONS).index)


def zone(p: BuyerPersona) -> str:
    """Where the walk-away sits against the wanted bundle's floor and list totals."""
    if p.walk_away < p.floor:
        return "below_floor"
    if p.walk_away >= p.list:
        return "above_list"
    return "haggle_zone"


def run_static(persona: BuyerPersona, source: str, content: str, *, arm: str, model: str | None = None,
               effort: str | None = None, session_id: str | None = None) -> Outcome:
    usage = llm.Usage()
    start = time.monotonic()
    out = Outcome(
        session_id=session_id or uuid.uuid4().hex[:12],
        persona_id=persona.id,
        deal=False,
        ended_by="buyer_no_buy",
        walk_away=persona.walk_away,
        feasible=persona.feasible,
        rounds=1,
        meta={"experiment": "e2_static_vs_agent", "arm": arm, "source": source, "zone": zone(persona),
              "model": model or llm.DEFAULT_MODEL},
    )
    try:
        reply, comp = llm.complete_json(system_prompt(persona), user_prompt(source, content), model=model, effort=effort, usage=usage)
    except (llm.LLMError, ValueError) as e:
        out.ended_by, out.error = "error", str(e)
        out.usage = usage.as_dict()
        out.wall_s = round(time.monotonic() - start, 2)
        return out

    decision = str(reply.get("decision", "")).strip().lower().replace("-", "_").replace(" ", "_")
    product = parse_product(reply.get("product_id"))
    addons = parse_addons(reply.get("addons"))
    reason = str(reply.get("reason") or "").strip()
    out.meta["raw_decision"] = reply
    note = ""
    if decision == "buy" and product is None:
        note = "buy with no recognizable product; treated as no_buy"
        decision = "no_buy"

    if decision == "buy":
        offer = Offer(product_id=product, price=list_total(product, addons), addons=addons)
        out.deal = True
        out.ended_by = "buyer_buy"
        out.product_id = product
        out.addons = addons
        out.price = offer.price
        out.cost = cost_total(product, addons)
        out.profit = offer.price - out.cost
        out.list_total = offer.price
        out.floor_total = floor_total(product, addons)
        out.violations_closed = 0 if PolicyEngine().check(offer).approved else 1
        out.buyer_overpaid = offer.price > persona.walk_away
        exp = reply.get("expected_total")
        try:
            out.meta["expected_total"] = int(round(float(str(exp).replace("$", "").replace(",", "")))) if exp is not None else None
        except ValueError:
            out.meta["expected_total"] = None
        out.meta["arithmetic_error"] = out.meta["expected_total"] is not None and out.meta["expected_total"] != offer.price
        out.meta["bundle_vs_wanted"] = _bundle_change(persona, product, addons)
        turn = {"role": "buyer", "message": reason, "action": "buy", "offer": offer.to_dict(), "note": note}
    else:
        turn = {"role": "buyer", "message": reason, "action": "no_buy", "offer": None, "note": note}

    out.transcript = [turn]
    out.usage = usage.as_dict()
    out.wall_s = round(time.monotonic() - start, 2)
    return out


def _bundle_change(p: BuyerPersona, product: str, addons: list[str]) -> str:
    if product != p.target_product:
        return "other_tractor"
    wanted, got = set(p.wants_addons), set(addons)
    if got == wanted:
        return "as_wanted"
    if got < wanted:
        return "dropped_addons"
    return "changed_addons"
