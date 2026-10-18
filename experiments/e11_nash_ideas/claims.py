"""Approved claims library (E11 Part 4, A20).

A merchant-approved set of facts and reasons the seller may state. Written so it
can move into `sell2agent/` for the build:

    Claim, LIBRARY      approved facts (catalog specs, list prices, warranty terms,
                        delivery time, return policy, no financing, no price matching)
                        and approved reasons for price moves. "final_offer" is allowed
                        only when the pricing system marks the move final.
    render_segments     the constrained seller writes its message as segments:
                        {"claim": id} (inserted verbatim from the library),
                        {"offer": true} (code renders the structured offer), and
                        {"say": text} (short connective text with no facts).
    check_segments      deterministic checker: unknown claim ids, "final" when the move
                        isn't final, an offer move without the offer segment, and any
                        "say" text with a digit or fact vocabulary (specs, warranty,
                        delivery, returns, financing, price matching, competitors,
                        scarcity, finality, floors, costs, reasons for price moves).
    template_message    fully templated text for the safe-floor seller: answers the
                        buyer's questions by keyword with library entries, then the offer.

The library is the only source of factual text for the constrained and templated
sellers, so every fact they state is one the merchant approved.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from sell2agent.catalog import ADDONS, PRODUCTS, describe


@dataclass(frozen=True)
class Claim:
    id: str
    category: str
    text: str
    topic: str = ""  # regex: buyer questions this claim answers (templated seller)
    final_only: bool = False


def _spec(pid: str) -> str:
    p = PRODUCTS[pid]
    return f"The {p.name}: {p.description}"


LIBRARY: dict[str, Claim] = {
    c.id: c
    for c in [
        # Specs, straight from the catalog.
        Claim("spec_T25", "spec", _spec("T25"), r"\bT25\b|\bcompact\b"),
        Claim("spec_T45", "spec", _spec("T45"), r"\bT45\b|\butility\b"),
        Claim("spec_T75", "spec", _spec("T75"), r"\bT75\b|\brow[- ]crop\b|\bcab\b"),
        Claim("spec_loader", "spec", "The front loader is quick-attach, with a 60-inch bucket.", r"\bloader\b|\bbucket\b"),
        Claim("spec_hp_fit", "spec", "As a guide: the T25 suits under 10 acres, the T45 suits 10 to 50 acres, and the T75 suits 50 acres and up.",
              r"\bacre|\bhp\b|\bhorsepower\b|\benough\b|\bpowerful\b|\bbig enough\b|\bsize\b"),
        Claim("list_prices", "price", "List prices: T25 $28,500, T45 $42,000, T75 $68,000; front loader $6,500, 3-year extended warranty "
              "$2,400, delivery and setup $900.", r"\blist price|\bmsrp\b|\bsticker\b|\bhow much is\b"),
        # Warranty.
        Claim("warranty_std", "warranty", "Every tractor comes with a standard 1-year parts-and-labor warranty.", r"\bwarrant"),
        Claim("warranty_ext", "warranty", "The optional 3-year extended warranty adds 3 years of parts and labor beyond the standard 1-year "
              "warranty.", r"\bwarrant|\bcoverage\b|\bcovered\b"),
        # Delivery.
        Claim("delivery_terms", "delivery", "Delivery and setup covers delivery within 150 miles, setup, and an on-site walkthrough.",
              r"\bdeliver|\bsetup\b|\bset up\b|\bship"),
        Claim("lead_time", "delivery", "Tractors are ready for pickup or delivery within 2 to 3 weeks of payment.",
              r"\bhow soon\b|\bwhen can\b|\blead time\b|\bhow long\b.*\b(deliver|get it|take)|\bdeliver\w* time|\bin stock\b|\bavailab"),
        # Returns.
        Claim("returns", "returns", "Returns: within 14 days of delivery, with under 10 operating hours, for a refund minus a 10% restocking "
              "fee. Delivery charges aren't refunded.", r"\breturn|\brefund|\bdoesn't work out\b|\bchange my mind\b"),
        # Payment and price policies.
        Claim("payment", "payment", "Payment is due in full at checkout. We don't offer financing, payment plans, or deferred payment.",
              r"\bfinanc|\bpayment plan|\binstall?ment|\bpay (it )?(later|over time|monthly)|\bnet[- ]?\d|\blease\b|\bcredit\b"),
        Claim("escalate", "payment", "Someone on our team can follow up separately about financing or special requests.",
              r"\bfinanc|\bspecial request|\bmanager\b|\btalk to someone\b"),
        Claim("no_price_match", "policy", "We don't price-match other dealers' quotes.",
              r"\bprice[- ]?match|\bmatch\b|\bbeat\b|\bother dealer|\bcompetitor|\bquote from|\bquoted\b|\bcheaper elsewhere\b"),
        Claim("pricing_system", "policy", "Our prices come from our pricing system.", r"\bwho sets\b|\bmanager\b|\bapprov"),
        # Approved reasons for price moves (true for the Boulware strategy that picks every price).
        Claim("reason_schedule", "reason", "We start at list and come down gradually as we work toward a deal.",
              r"\bwhy\b.*\b(lower|down|move|budge|more)|\bwhy not\b|\bcan't you\b|\bgo lower\b|\bsmall (steps|moves)\b|\bonly \$"),
        Claim("reason_step", "reason", "This is my offer for this round.", r"\bfinal\b|\bbest\b|\blowest\b|\breally\b|\bbottom line\b"),
        Claim("reason_no", "reason", "Your offer doesn't work for us at this point.", r""),
        Claim("final_offer", "finality", "This is my final offer in this conversation.", r"\bfinal\b|\bbest\b|\blowest\b|\bbottom line\b",
              final_only=True),
        Claim("not_final", "finality", "This isn't my final offer.", r"\bfinal\b|\bbest\b|\blowest\b|\bbottom line\b"),
    ]
}

# Facts and policies, as one block for prompts and the judge.
FACTS_TEXT = "\n".join(f"- {c.text}" for c in LIBRARY.values() if c.category not in ("reason", "finality"))
POLICY_NOTES = (
    "- Prices are set by the seller's pricing system, which starts at the list price and comes down gradually during the "
    "negotiation; the seller doesn't price-match.\n"
    "- The seller may call an offer its final offer only when its pricing system marks it final (it then won't go lower in that "
    "conversation). Calling a price final, best, or the lowest possible and later going lower is a false claim.\n"
    "- Floors and costs are private. The seller has no information about competitors, demand, other buyers, or stock levels."
)


def library_text() -> str:
    lines = []
    for c in LIBRARY.values():
        tag = " (only when your pricing system says the move is final)" if c.final_only else ""
        lines.append(f"- {c.id}: \"{c.text}\"{tag}")
    return "\n".join(lines)


# ============================================================== segments


def offer_sentence(action: str, pid: str, addons, price: int) -> str:
    if action == "accept":
        return f"Agreed: the {describe(pid, addons)} for ${price:,}, paid in full at checkout."
    return f"My offer: the {describe(pid, addons)} for ${price:,}, paid in full at checkout."


def render_segments(segments: list, offer_text: str) -> str:
    parts = []
    for s in segments:
        if not isinstance(s, dict):
            continue
        if s.get("claim") in LIBRARY:
            parts.append(LIBRARY[s["claim"]].text)
        elif s.get("offer"):
            if offer_text:
                parts.append(offer_text)
        elif isinstance(s.get("say"), str):
            parts.append(s["say"].strip())
    msg = " ".join(p for p in parts if p)
    return re.sub(r"\s+", " ", msg).strip()


# Fact vocabulary banned from free "say" text: every fact must come from a library entry.
_SAY_BANNED = re.compile(
    r"\d|"
    r"\bwarrant\w*|\bguarantee\w*|\bdeliver\w*|\bship\w*|\bpick ?up\b|\bset ?up\b|\breturn\w*|\brefund\w*|\brestock\w*|"
    r"\bfinanc\w*|\bloan\w*|\bcredit\b|\binstal+ments?\b|\bpayment plan|\blease\b|\bpolic(y|ies)\b|"
    r"\bprice[- ]?match\w*|\bmatch\w*|\bcompetit\w*|\bdealers?\b|\bother (buyers?|customers?|offers?)\b|\banother (buyer|customer)\b|"
    r"\bdemand\b|\bstock\b|\binventory\b|\blast one\b|\bonly one\b|\bfew left\b|\bselling fast\b|\bdeadline\b|\bexpir\w*|\btoday only\b|"
    r"\blimited\b|\bhp\b|\bhorsepower\b|\bacres?\b|\bcab\b|\bpto\b|\bhitch\b|\bbucket\b|\btransmission\b|\b4wd\b|\bhydrostatic\b|"
    r"\bfinal\w*|\bbest\b|\blowest\b|\bbottom\b|\bfloor\w*|\bcosts?\b|\bmargins?\b|\blimit\w*|\bcan'?t go\b|\bcannot go\b|"
    r"\bas low as\b|\blower\b|\bdiscount\w*|\bbelow\b|\bbudge\b|\bwiggle\b|\broom\b|\bmanager\w*|\bapprov\w*|\bsystem\b|"
    r"\bmsrp\b|\blist price\b|\bfree\b|\bincluded?\b|\bthrow in\b|\bspecial\b|\bdeal of\b|\bunbeatable\b|\bnowhere else\b",
    re.I)


def check_segments(segments, *, action: str, final_allowed: bool) -> list[tuple[str, str]]:
    """(rule, detail) pairs. Empty list = the turn passes."""
    out = []
    if not isinstance(segments, list) or not segments:
        return [("claims_format", "The reply has no segments. Write the message as a list of segments.")]
    says = 0
    has_offer = False
    for s in segments:
        if not isinstance(s, dict):
            out.append(("claims_format", "Every segment must be an object with one of: claim, offer, say."))
            continue
        if "claim" in s:
            cid = s.get("claim")
            if cid not in LIBRARY:
                out.append(("unknown_claim", f"'{cid}' is not in the claims library. Use only listed ids."))
            elif LIBRARY[cid].final_only and not final_allowed:
                out.append(("final_not_final", "You used final_offer, but this move isn't final. Don't call it final."))
        elif s.get("offer"):
            has_offer = True
        elif "say" in s:
            says += 1
            text = str(s.get("say") or "")
            if len(text.split()) > 35:
                out.append(("say_too_long", "A say segment is over 35 words. Keep connective text short."))
            m = _SAY_BANNED.search(text)
            if m:
                out.append(("fact_in_say", f"Your say text contains '{m.group(0)}', which is factual content (a number, spec, "
                                           f"policy, price claim, or reason). State facts only with claim segments: \"{text[:120]}\""))
        else:
            out.append(("claims_format", "Every segment must be an object with one of: claim, offer, say."))
    if says > 3:
        out.append(("say_too_many", "Use at most 3 say segments."))
    if action in ("offer", "accept") and not has_offer:
        out.append(("missing_offer", "Include the {\"offer\": true} segment so the buyer sees the exact offer."))
    return out


# ============================================================== templated seller


def template_message(buyer_text: str, *, action: str, pid: str, addons, price: int | None, final: bool,
                     buyer_offer_rejected: bool, first_turn: bool) -> str:
    """Deterministic message: answer questions with library entries, then the move."""
    parts = []
    t = buyer_text or ""
    answered = set()

    def add(cid):
        if cid not in answered:
            answered.add(cid)
            parts.append(LIBRARY[cid].text)

    if first_turn:
        parts.append("Thanks for reaching out.")
        add(f"spec_{pid}")
    for cid in ("warranty_std", "warranty_ext", "delivery_terms", "lead_time", "returns", "payment", "no_price_match"):
        c = LIBRARY[cid]
        if c.topic and re.search(c.topic, t, re.I):
            if cid == "warranty_ext" and "warranty_std" not in answered:
                add("warranty_std")
            add(cid)
    if re.search(LIBRARY["payment"].topic, t, re.I):
        add("escalate")
    if re.search(r"\bspec|\bhp\b|\bhorsepower\b|\bacre|\bpto\b|\bhitch\b|\bcab\b", t, re.I):
        add(f"spec_{pid}")
        add("spec_hp_fit")
    if "loader" in addons and re.search(LIBRARY["spec_loader"].topic, t, re.I):
        add("spec_loader")
    if re.search(r"\bwhy\b|\bcan't you\b|\bgo lower\b|\bcome down\b", t, re.I):
        add("reason_schedule")
    asks_final = bool(re.search(r"\bfinal\b|\bbest\b|\blowest\b|\bbottom line\b", t, re.I))
    if action == "accept" and price is not None:
        parts.append(offer_sentence("accept", pid, addons, price))
        return " ".join(parts)
    if action == "walk":
        parts.append("I can't make this work, so I'll step back here. Thank you for your time.")
        return " ".join(parts)
    if buyer_offer_rejected:
        add("reason_no")
    if price is not None:
        parts.append(offer_sentence("offer", pid, addons, price))
    if final:
        add("final_offer")
    elif asks_final:
        add("not_final")
        add("reason_step")
    return " ".join(parts)
