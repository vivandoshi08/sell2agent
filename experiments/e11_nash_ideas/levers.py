"""Levers before discounts (E11 Part 2, A19).

Generalizes "warranty before discount" into a merchant-configured lever menu.
Written so it can move into `sales_agent/` for the build:

    Lever, LEVERS     the menu: each lever has a seller cost and a buyer-facing value.
    LeverOffer        an Offer with a `levers` list. Levers live in the structured
                      offer, never only in words.
    LeverPolicy       the policy engine plus lever rules: known levers, no lever that
                      duplicates a priced add-on, a cap on total lever cost, and
                      price >= floor total + lever costs (the margin after lever costs
                      stays at or above the floor's margin).
    lever_text_findings  deterministic check that every lever or add-on the message
                      promises is in the structured offer.
    LeverBoulware     the levers-first strategy: hold price and add one lever per
                      seller turn (best value-to-cost first), then concede price on
                      E5's Boulware curve toward floor + lever costs.

Economics: profit = price - cost(tractor + priced add-ons) - sum(lever costs).
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

from sales_agent.agents import NegotiationState
from sales_agent.catalog import ADDONS, PRODUCTS, cost_total, describe, floor_total, list_total
from sales_agent.policy import Decision, Offer, PolicyEngine

# ============================================================== the menu


@dataclass(frozen=True)
class Lever:
    id: str
    name: str
    cost: int  # what it costs the seller
    value: int  # buyer-facing value: what it would cost the buyer to get separately
    description: str
    excludes_addon: str | None = None  # can't be combined with this priced add-on (same thing)
    needs_buyer_trade_in: bool = False  # only when the buyer has equipment to trade
    pattern: str = ""  # regex that names the lever in text

    @property
    def ratio(self) -> float:
        return self.value / self.cost


LEVERS: dict[str, Lever] = {
    lv.id: lv
    for lv in [
        Lever("warranty_3yr", "3-year extended warranty included", 600, 2_400,
              "Parts and labor for 3 years beyond the standard 1-year warranty, at no charge.", excludes_addon="warranty",
              pattern=r"\b(extended|3[- ]year|three[- ]year)\s+(extended\s+)?warrant\w*|\bwarranty\b"),
        Lever("expedited", "Expedited prep", 250, 750,
              "Tractor prepped and ready (for pickup or delivery) within 5 business days instead of the standard 2-3 weeks.",
              pattern=r"\bexpedit\w*|\brush(ed)?\b|\bpriority (prep|delivery|scheduling)|\b5 business days|\bfive business days"),
        Lever("training", "Operator training session", 150, 400,
              "A 2-hour on-site session with a technician: safe operation, daily checks, implement hookup.",
              pattern=r"\btraining\b|\btrain (you|your)|\bwalk[- ]?through session|\btechnician session"),
        Lever("implement", "Extra implement: 5-ft box blade", 450, 1_100,
              "A 5-foot box blade for grading and driveway work, included.",
              pattern=r"\bbox[- ]blade\b|\bextra implement\b|\bimplement included\b"),
        Lever("delivery_setup", "Free delivery and setup", 400, 900,
              "Delivered within 150 miles, set up, and walked through on site, at no charge.", excludes_addon="delivery",
              pattern=r"\b(free|complimentary|included|no[- ]charge)\s+(delivery|setup|set[- ]up)|\bdelivery and set[- ]?up\b|\bdeliver(y|ed)\b"),
        Lever("trade_in", "Trade-in credit", 400, 1_000,
              "$1,000 credit for one running used tractor or implement the buyer trades in (our net cost after resale is about $400).",
              needs_buyer_trade_in=True, pattern=r"\btrade[- ]?in\b"),
    ]
}
LEVER_ORDER = sorted((lv for lv in LEVERS.values() if not lv.needs_buyer_trade_in), key=lambda lv: -lv.ratio)


def lever_cost(levers) -> int:
    return sum(LEVERS[x].cost for x in levers)


def lever_value(levers) -> int:
    return sum(LEVERS[x].value for x in levers)


def menu_text(with_costs: bool) -> str:
    lines = []
    for lv in LEVERS.values():
        extra = f" | our cost ${lv.cost:,} | worth ${lv.value:,} to the buyer" if with_costs else f" (worth ${lv.value:,} to the buyer)"
        cond = []
        if lv.excludes_addon:
            cond.append(f"not with the priced {ADDONS[lv.excludes_addon].name.lower()} add-on")
        if lv.needs_buyer_trade_in:
            cond.append("only if the buyer says it has equipment to trade in")
        c = f" [{'; '.join(cond)}]" if cond else ""
        lines.append(f"- {lv.id}: {lv.name}. {lv.description}{extra}{c}")
    return "\n".join(lines)


# ============================================================== offers and policy


@dataclass
class LeverOffer(Offer):
    levers: list[str] = field(default_factory=list)

    def label(self) -> str:
        base = describe(self.product_id, self.addons) if self.product_id in PRODUCTS else self.product_id
        if self.levers:
            base += " + included extras: " + ", ".join(f"{LEVERS[x].name} ({x})" for x in self.levers if x in LEVERS)
        return f"{base}, ${self.price:,}"

    def to_dict(self) -> dict:
        return asdict(self)


def as_lever_offer(o: Offer | None) -> LeverOffer | None:
    if o is None or isinstance(o, LeverOffer):
        return o
    return LeverOffer(o.product_id, o.price, list(o.addons), o.terms, [])


def sort_levers(levers) -> list[str]:
    order = list(LEVERS)
    return sorted({x for x in levers if x in LEVERS}, key=order.index)


@dataclass
class LeverRules:
    max_lever_cost: int = 1_500  # total lever cost per deal
    max_levers: int = 4


class LeverPolicy(PolicyEngine):
    """PolicyEngine plus lever rules. The effective floor is floor total + lever costs."""

    def __init__(self, lever_rules: LeverRules | None = None, **kw):
        super().__init__(**kw)
        self.lever_rules = lever_rules or LeverRules()

    def effective_floor(self, offer: Offer) -> int:
        lv = getattr(offer, "levers", []) or []
        return self.floor_for(offer) + lever_cost([x for x in lv if x in LEVERS])

    def check(self, offer: Offer) -> Decision:
        d = super().check(offer)
        reasons = list(d.reasons)
        lv = list(getattr(offer, "levers", []) or [])
        unknown = [x for x in lv if x not in LEVERS]
        if unknown:
            reasons.append(f"unknown levers: {', '.join(unknown)}")
        known = [x for x in lv if x in LEVERS]
        dup = [x for x in known if LEVERS[x].excludes_addon and LEVERS[x].excludes_addon in offer.addons]
        if dup:
            reasons.append(f"levers duplicate a priced add-on: {', '.join(dup)}")
        if len(set(known)) > self.lever_rules.max_levers:
            reasons.append(f"more than {self.lever_rules.max_levers} levers")
        if lever_cost(set(known)) > self.lever_rules.max_lever_cost:
            reasons.append(f"lever cost ${lever_cost(set(known)):,} is over the ${self.lever_rules.max_lever_cost:,} cap")
        if known and offer.product_id in PRODUCTS and not any("add-ons not allowed" in r for r in reasons):
            eff = self.effective_floor(offer)
            if offer.price < eff:
                reasons.append(f"price ${offer.price:,} is below the floor total plus lever costs ${eff:,}")
        return Decision(not reasons, reasons)


def profit(offer: Offer) -> int:
    return offer.price - cost_total(offer.product_id, offer.addons) - lever_cost(getattr(offer, "levers", []) or [])


# ============================================================== text check

_NEG = re.compile(r"\b(not|no|never|can't|cannot|can not|won't|unable|without|isn't|aren't|don't|doesn't|instead of|rather than|exclud\w*)\b", re.I)
# A promise: the seller commits to giving something ("I'll include", "at no charge", "free", "comes with", "included").
_PROMISE = re.compile(r"\b(i'll|we'll|i will|we will|i'm|we're|i am|we are)\s+(also\s+)?(includ\w*|throw\w* in|add\w*|giv\w*|toss\w* in|put\w* in)\b|"
                      r"\bat no (extra |additional )?(charge|cost)\b|\bno[- ]charge\b|\bfree\b|\bcomplimentary\b|\bon us\b|\bon the house\b|"
                      r"\bcomes? with\b|\bincluded\b|\bincludes\b|\bincluding\b|\bthrown in\b|\bthrow(ing)? in\b|\bbundled in\b", re.I)
_PRICED = re.compile(r"\bfor (an? )?(extra|additional)\b|\b(add|adding) (it|that|them|the \w+) for\b|\bat \$|\bfor \$|\b(costs?|runs?|is) \$|\bplus \$|\+\s*\$", re.I)
_FREE_PHRASES = re.compile(r"\b(at )?no[- ](extra |additional )?(charge|cost)\b|\bno[- ]charge\b|\bfor no (extra |additional )?(charge|cost)\b", re.I)
_STD_WARRANTY = re.compile(r"\b(standard|factory|base|basic)\s+(1[- ]year\s+|one[- ]year\s+)?warrant\w*|\b(1|one)[- ]year\s+(standard\s+|factory\s+)?warrant\w*", re.I)
# Offering an option or a quote is not a promise ("I can also add delivery", "if your client decides to add the loader later").
_OPTION = re.compile(r"\b(can|could|would be happy to|happy to|glad to)\s+(also\s+|still\s+)?(add|quote|price|include)\b|"
                     r"\b(decides?|wants?|chooses?|like|prefer)\s+to\s+add\b|\blater\b|\bif you('d| would) like\b|\bwould you like\b|"
                     r"\bdo you want\b|\bwant me to\b|\binterested in\b|\boption(al|s)?\b|\bquote\b", re.I)
_STRONG = re.compile(r"\b(i'll|we'll|i will|we will)\s+(also\s+)?(includ\w*|throw\w* in|add\w*|giv\w*)\b|\bat no (extra |additional )?(charge|cost)\b|\bfree\b", re.I)
_ADDON_PATTERNS = {
    "loader": r"\bloader\b|\bbucket\b",
    "warranty": r"\bwarrant\w*",
    "delivery": r"\bdeliver\w*|\bdelivery and set[- ]?up\b",
}


def _clauses(text: str) -> list[str]:
    out = []
    for s in re.split(r"(?<=[.!?])\s+|\n+", text):
        out += [c for c in re.split(r";|\bbut\b|\bhowever\b", s, flags=re.I) if c.strip()]
    return out


def lever_text_findings(message: str, offer: Offer | None) -> list[dict]:
    """Flag levers or add-ons promised in words that the structured offer doesn't contain.

    A promise is a clause with commitment wording ("I'll include", "at no charge", "free",
    "comes with", "included"), not negated, not a priced option ("for an extra $900"), not a
    question, and not an offer to add or quote it ("I can also add delivery") unless it also
    has strong commitment wording.
    `offer` is the seller's structured offer this turn (or its standing offer).
    """
    if not message:
        return []
    in_levers = set(getattr(offer, "levers", []) or []) if offer else set()
    in_addons = set(offer.addons) if offer else set()
    covered = set(in_levers)
    for x in in_levers:  # a lever covers its add-on's words (e.g. warranty_3yr covers "warranty")
        if LEVERS[x].excludes_addon:
            covered.add("addon:" + LEVERS[x].excludes_addon)
    for a in in_addons:
        covered.add("addon:" + a)
    findings = []
    for c in _clauses(message):
        c = _STD_WARRANTY.sub(" ", c)  # the standard 1-year warranty is not a lever
        pm = _PROMISE.search(c)
        if not pm:
            continue
        rest = _FREE_PHRASES.sub(" ", c.replace(pm.group(0), " "))  # "at no charge" is a promise, not a negation
        if _NEG.search(rest) or _PRICED.search(c) or c.strip().endswith("?"):
            continue
        if _OPTION.search(c) and not _STRONG.search(c):
            continue
        for lid, lv in LEVERS.items():
            if lid in covered or not re.search(lv.pattern, c, re.I):
                continue
            # A priced add-on in the offer covers the same words (e.g. warranty add-on vs warranty lever).
            if lv.excludes_addon and ("addon:" + lv.excludes_addon) in covered:
                continue
            findings.append({"rule": "lever_not_in_offer", "lever": lid, "span": c.strip()[:200]})
        for aid, pat in _ADDON_PATTERNS.items():
            if ("addon:" + aid) in covered or not re.search(pat, c, re.I):
                continue
            lv_for = [lid for lid, lv in LEVERS.items() if lv.excludes_addon == aid]
            if any(x in covered for x in lv_for):
                continue
            if any(f["span"] == c.strip()[:200] for f in findings):
                continue
            findings.append({"rule": "addon_not_in_offer", "addon": aid, "span": c.strip()[:200]})
    return findings


# ============================================================== strategies


@dataclass
class LeverMove:
    action: str  # "offer", "accept", "walk", "free"
    offer: LeverOffer | None = None
    note: str = ""


def _std_addons(addons) -> list[str]:
    order = list(ADDONS)
    return sorted(set(addons), key=order.index)


class PriceBoulware:
    """E5's Boulware (list - gap * t^3, floor at round 8), no levers. Accept if the buyer's offer earns at
    least our next offer, or in the final round if it covers its effective floor."""

    name = "price_only"
    exponent = 3.0

    def __init__(self, policy: LeverPolicy | None = None):
        self.policy = policy or LeverPolicy()

    def _price(self, pid, addons, rnd, max_rounds, extra_floor=0) -> int:
        lst, flo = list_total(pid, addons), floor_total(pid, addons) + extra_floor
        frac = min(1.0, rnd / max_rounds) ** self.exponent
        p = lst - frac * (lst - flo)
        return max(flo, min(max(lst, flo), int(round(p / 100.0) * 100)))

    def target(self, state: NegotiationState) -> LeverOffer:
        pid, addons = state.product_id, _std_addons(state.addons)
        return LeverOffer(pid, self._price(pid, addons, state.round, state.max_rounds), addons, levers=[])

    def _clamp_prev(self, state, nxt: LeverOffer) -> LeverOffer:
        prev = [o.price for o in state.offers("seller") if o.product_id == nxt.product_id and list(o.addons) == list(nxt.addons)
                and sorted(getattr(o, "levers", []) or []) == sorted(nxt.levers)]
        if prev and nxt.price > min(prev):
            nxt = LeverOffer(nxt.product_id, min(prev), list(nxt.addons), levers=list(nxt.levers))
        return nxt

    def decide(self, state: NegotiationState) -> LeverMove:
        nxt = self._clamp_prev(state, self.target(state))
        buyer = as_lever_offer(state.standing_offer("buyer"))
        if buyer is not None and self.policy.check(buyer).approved:
            if profit(buyer) >= profit(nxt) or state.round >= state.max_rounds:
                return LeverMove("accept", note=f"{self.name}: accept ${buyer.price:,} (next ${nxt.price:,})")
        return LeverMove("offer", nxt, note=f"{self.name}: round {state.round}, offer ${nxt.price:,} levers={nxt.levers}")


class LeverBoulware(PriceBoulware):
    """Levers first: from the second seller turn, add one lever per turn (best value-to-cost first) and
    hold the price; once `max_levers` are in, concede on the Boulware curve toward floor + lever costs.
    Levers already in the buyer's counteroffer are kept. In the final round, if the buyer's standing price
    is below the floor plus lever costs, strip the levers and offer the bare bundle on the plain curve."""

    name = "levers_first"

    def __init__(self, policy: LeverPolicy | None = None, max_levers: int = 3):
        super().__init__(policy)
        self.max_levers = max_levers

    def target(self, state: NegotiationState) -> LeverOffer:
        pid, addons = state.product_id, _std_addons(state.addons)
        mine = [as_lever_offer(o) for o in state.offers("seller")]
        held = list(mine[-1].levers) if mine else []
        avail = [lv.id for lv in LEVER_ORDER if lv.id not in held and not (lv.excludes_addon and lv.excludes_addon in addons)]
        lst = list_total(pid, addons)
        if not mine:
            return LeverOffer(pid, lst, addons, levers=[])
        if len(held) < self.max_levers and avail and lever_cost(held + avail[:1]) <= self.policy.lever_rules.max_lever_cost:
            # Lever step: same price as our last offer, one more extra in the box.
            levers = sort_levers(held + avail[:1])
            price = max(mine[-1].price, floor_total(pid, addons) + lever_cost(levers))
            return LeverOffer(pid, min(price, max(lst, floor_total(pid, addons) + lever_cost(levers))), addons, levers=levers)
        levers = sort_levers(held)
        buyer = as_lever_offer(state.standing_offer("buyer"))
        if state.round >= state.max_rounds and buyer is not None and buyer.price < floor_total(pid, addons) + lever_cost(levers):
            return LeverOffer(pid, self._price(pid, addons, state.round, state.max_rounds), addons, levers=[])
        return LeverOffer(pid, self._price(pid, addons, state.round, state.max_rounds, extra_floor=lever_cost(levers)), addons, levers=levers)
